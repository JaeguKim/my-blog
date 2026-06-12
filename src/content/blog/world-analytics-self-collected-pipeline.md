---
title: '외부 분석 API를 자체 수집 파이프라인으로: Kafka + Redis로 월드 애널리틱스 직접 굴리기'
description: '월드 방문/플레이타임/DAU/D1 리텐션을 외부 분석 API(Squirrel)에서 가져오던 읽기 경로를, Kafka 이벤트 → Redis 버퍼 → 일일 flush → DB 파이프라인으로 교체한 이야기. 읽기 100배, 그 과정에서 부딪힌 Kafka 멱등성·Redis Cluster 교집합·날짜 귀속 문제와 그 트레이드오프까지.'
pubDate: 'Jun 12 2026'
---

## 배경: 읽기 경로가 외부 API에 묶여 있었다

월드 애널리틱스(방문 수, 플레이타임, DAU, D1 리텐션)를 사내 분석 API인 **Squirrel**에서 HTTP로 가져오고 있었다. Squirrel은 Snowflake 데이터 마트 위에 얹힌 분석 서버다.

문제는 읽기 경로가 통째로 외부 호출이라는 점이었다.

- typical latency는 ~230ms였지만 **tail은 4초+**.
- total-summary 뷰는 Squirrel을 **2회 순차 호출**해서, 관측 latency가 5~7초까지 튀었다.
- 외부 시스템의 지연·장애에 우리 제품 페이지가 그대로 노출됐다.
- 무엇보다, 읽기 로직이 외부에 있으니 우리가 손댈 수가 없었다.

그래서 결정했다. **이벤트를 직접 수집해서 우리 DB에 쌓고, 읽기는 DB에서 한다.** Squirrel은 정합성이 검증될 때까지만 비교용으로 남겨두고 걷어낸다.

## 아키텍처: 이벤트 → Redis 버퍼 → 일일 flush → DB

```
UserWorldEntered / UserWorldDisconnected (Kafka)
        │
        ▼
  Kafka consumer ──► Redis 실시간 집계 (3일 TTL)
                       · stat hash   : visit / play  (HINCRBY)
                       · DAU set     : accountId      (SADD)
                       · worlds set  : 그날 활동한 worldId (SADD, flush 인덱스)
        │
        ▼  daily cron (00:01 UTC, "어제")
  world_daily_stats (upsert)  ──►  읽기 API (PK 단순 조회)
```

이벤트마다 DB에 쓰면 write가 폭발한다. 그래서 Redis에 실시간 누적해두고 하루 한 번 일괄 flush하는, 기존 costume analytics와 같은 패턴을 따랐다.

Redis에 쌓는 건 세 가지다.

- **stat hash** — `HINCRBY`로 visit/play를 누적
- **DAU set** — `SADD`로 그날 접속한 accountId를 모음
- **worlds set** — 그날 이벤트가 있었던 worldId를 모으는 **flush 대상 인덱스**

flush 잡은 매일 00:01 UTC에 "어제" worlds set을 순회하면서 각 월드를 `world_daily_stats`에 upsert한다. 다중 pod가 동시에 돌지 않도록 `SET NX` 락을 잡는다.

여기까지는 평범하다. 까다로웠던 건 그 다음 결정들이었다.

## 결정 1: Kafka 멱등성과 "한 번만 세기"

Kafka는 at-least-once다. 컨슈머 재시작이나 리밸런스, producer 재전송 때문에 **같은 이벤트가 또 온다.** 그런데 `HINCRBY`는 비멱등이다 — 재전달이 그대로 중복 집계된다.

방문/플레이는 세션 유일키인 `entryId` 기준으로 dedup했다.

```typescript
async incrementVisit(worldId: bigint, date: Date, entryId?: string): Promise<void> {
  if (entryId) {
    const firstSeen = await this.redis.setNx(
      RedisKeyOf.WorldAnalyticsVisitDedup(entryId), '1', ENTRY_DEDUP_TTL, // 1h
    )
    if (!firstSeen) return // 이미 본 entryId → skip
  }
  await this.redis.hashIncrBy(statKey, STAT_VISIT_FIELD, 1) // 처음일 때만 카운트
  await this.redis.expire(statKey, WORLD_ANALYTICS_TTL)
}
```

`SET NX EX`는 "이 entryId 처음 봤어?"를 한 번의 원자적 왕복으로 판별하는 dedup 마커다. 분산 락처럼 보이지만 release(DEL)하지 않고 TTL로만 만료된다는 게 다르다 — 목적이 상호배제가 아니라 **재전달 중복 방지**다. dedup 키 TTL은 재전달 윈도(리밸런스/재시작 = 초~분)만 넘기면 되므로 stat 버퍼(3일)보다 훨씬 짧은 **1시간**으로 잡아 키 개수를 억제했다.

DAU는 다르다. `SADD`는 set이라 같은 accountId를 몇 번 넣어도 멱등이다. accountId 자체가 dedup 키 역할을 하므로 별도 마커가 필요 없다.

그럼 **Redis 쓰기가 실패하면?** 여기서 의식적인 트레이드오프를 했다. 실패를 rethrow해서 Kafka 재처리를 유도하면 (a) 장애 시 consumer lag이 급증하고 (b) 재처리 시점에 dedup TTL이 만료돼 있으면 오히려 중복 계상된다. 분석 데이터는 비금융 UX 지표라 ±소량 오차가 의사결정을 바꾸지 않는다. 그래서:

> **at-most-once 채택.** 실패는 삼키되 `world_analytics_write_failures_total` 메트릭으로 노출하고, 이상이 감지되면 Squirrel 백필로 덮어쓴다.

## 결정 2: Redis Cluster에서 D1 리텐션 = 교집합

D1 리텐션은 정의상 교집합이다.

```
D1 = (전날 DAU ∩ 당일 DAU) / 전날 DAU
```

DAU를 set으로 들고 있으니 자연스러운 구현은 `SINTERCARD(어제, 오늘)` 한 줄이다. **그런데 안 된다.**

배포된 Redis가 Cluster 모드다. 두 DAU set은 키가 달라 서로 **다른 hash slot**에 들어간다(hash tag를 안 붙였으므로). Cluster에서 여러 slot에 걸친 cross-key 연산은 `CROSSSLOT` 에러로 실패한다. 게다가 dev의 Redis 6.2.7은 `SINTERCARD` 명령 자체가 없다(7.0+ 전용).

해결은 단순하다. **단일 키 `SMEMBERS`는 cluster-safe하니, 두 set을 각각 가져와서 앱에서 교집합을 구한다.** 작은 쪽으로 lookup Set을 만들어 큰 쪽을 훑는다.

```typescript
async getDauIntersectCount(worldId, dateStr1, dateStr2): Promise<number> {
  // SINTERCARD/SINTER 금지: Cluster cross-slot은 CROSSSLOT으로 깨지고 6.2.7엔 없음.
  const [a, b] = await Promise.all([
    this.getDauMembers(worldId, dateStr1), // SMEMBERS (단일 키, 안전)
    this.getDauMembers(worldId, dateStr2),
  ])
  const [small, large] = a.length <= b.length ? [a, b] : [b, a]
  const seen = new Set(small)
  let count = 0
  for (const member of large) if (seen.has(member)) count++
  return count
}
```

교훈: 인프라에서는 "되는 명령"이 아니라 **"배포 환경에서 되는 명령"**으로 설계해야 한다. 로컬 단일 Redis에서 잘 돌던 `SINTERCARD`가 Cluster에선 통째로 막힌다.

## 결정 3: 플레이타임을 어느 날짜에 귀속할까

플레이 시간은 disconnect 이벤트에 누적값으로 담겨 온다. 그런데 세션이 **UTC 자정을 넘으면?** 입장은 어제(23:55), 퇴장은 오늘(00:10)이다.

flush 잡은 각 날짜를 정확히 한 번 마감하고 다시 읽지 않는다. 그래서 **이미 flush된 과거 날짜에 increment하면 그 값은 영구 손실**된다.

그래서 play_sec을 **세션 시작일이 아니라 disconnect 날짜에 귀속**시켰다. disconnect 날짜의 flush는 항상 이 이벤트보다 뒤에 도므로 캡처가 보장된다.

```typescript
// 세션 길이와 무관하게 "지금(=disconnect 시각)"의 날짜에 귀속
const date = toUtcDateOnly(new Date())
await this.cacheRepo.addPlaySec(BigInt(worldId), date, accessTimeSeconds, entryId)
```

트레이드오프는 명확하다. 자정을 넘는 세션은 **play는 퇴장일, visit/DAU는 입장일**로 갈린다. 작고 한정된 일일 skew라 데이터 손실을 피하는 대가로 수용했다.

## 읽기 경로: 외부 HTTP → DB

D1과 DAU는 flush 시점에 이미 `world_daily_stats`에 스냅샷으로 저장해둔다. 그래서 읽기는 PK `(world_id, date)`로 때리는 단순 조회로 끝난다. JOIN도, 외부 호출도 없다.

이 PR이 바꾼 건 **읽기 소스**(외부 Squirrel HTTP → 로컬 DB)다. 그 교체된 컴포넌트만 보면:

| 호출 | Before (Squirrel HTTP) | After (DB) | 개선 |
|---|---|---|---|
| 단일 조회 | typical ~230ms, **tail 4초+** | **~2ms** (PK index) | ~100배 |
| total-summary | 2회 순차 → 관측 5~7초 | ~2ms | tail ~1,000배+ |

## 안전장치: convergence 검증으로 갈아끼우기

외부 API를 바로 걷어내는 건 무섭다. 그래서 자체 수집값과 Squirrel을 **배치로 비교하는 convergence 잡**을 뒀다. 매일 전날 전 월드를 비교해서 `converged / mismatched`를 리포트한다. visit·DAU는 정확 일치, playtime은 ±5% 허용(집계 주기 차이).

이 검증 덕에 운영 중 재밌는 걸 잡았다. **Squirrel의 D1이 최근 날짜에선 `null`로 온다.** 상류 Snowflake 마트의 D1 산출이 dev에서 지연/정체돼 있어서다. 이걸 자체값(예: 1.0)과 `0`으로 비교하면 매번 거짓 mismatch가 잡힌다. 그래서 **Squirrel d1이 null이면 비교에서 제외(`d1NotComparable`)** 하도록 보정했다 — "아직 계산 안 됨"은 "불일치"가 아니다.

## 정리하며

세 가지가 남았다.

- **외부 의존을 걷어내면 latency만 좋아지는 게 아니다.** 읽기 로직이 비로소 "우리가 손댈 수 있는 코드"가 된다. 100배 빨라진 것보다 이게 더 컸다.
- **완전 멱등(at-least-once)은 공짜가 아니다.** 비금융 지표라면 at-most-once + 실패 메트릭 + 백필 복구의 조합이 비용 대비 합리적이다. 어디까지 정확해야 하는지를 먼저 정하면 설계가 단순해진다.
- **인프라 제약은 설계 입력값이다.** Redis Cluster의 CROSSSLOT, 버전별 명령 부재(SINTERCARD), Kafka의 at-least-once, flush의 단일 마감 — 이것들을 우회하는 게 아니라 전제로 깔고 설계해야 나중에 안 터진다.
