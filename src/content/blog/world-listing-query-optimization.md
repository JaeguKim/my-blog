---
title: 'NestJS 월드 리스팅 쿼리 7배 개선: N+1에서 단일 JOIN까지'
description: 'listWorlds API가 왜 느린지 파악하고, N+1 → 배치 → 단일 JOIN 세 단계로 개선하는 과정. live 환경과 동일한 데이터 규모로 측정 환경을 만들어 검증한 방법까지.'
pubDate: 'May 20 2026'
---

## 문제

`listWorlds` API가 지속적으로 느렸다. 로그를 보면 요청 하나에 2~3초. 현재 published world는 45개밖에 없는데도 그랬다.

코드를 열어보면 이유가 바로 보인다.

```typescript
// world.service.ts — 최적화 전
async getPublishedWorldsForListing(filter) {
  const worlds = await this.worldRepo.findManyWorlds(filter)  // 모든 world + place + version fetch
  
  return Promise.all(
    worlds
      .filter(world => !world.isBanned && world.accessStatus !== 'PRIVATE' && world.ownerGroupId)
      .map(async (world) => {
        const group = await this.groupService.getGroupById(world.ownerGroupId)  // gRPC ×N
        const place = await this.placeService.getMainPlace(world.id)             // DB ×N
        const version = await this.placeRepo.findLatestPublished(place.id)       // DB ×N
        return { ...world, ownerGroup: group, publishedVersion: version }
      })
  )
}
```

N=45 기준으로 외부 호출이 `1 + 3×45 = 136회`. 더 심각한 건 banned/private world도 DB에서 전부 fetch하고 나서 앱에서 드롭한다는 점이다.

## 세 단계 최적화

### 1단계: 배치 쿼리

N번 호출을 1번으로 줄이는 것부터 시작했다.

```
이전: gRPC getGroupById() ×N  →  이후: gRPC getGroupsByIds() ×1
이전: DB getMainPlace() ×N    →  이후: DB getPublishedVersionsByPlaceIds() ×1
```

DB 호출 횟수는 `1 + 3N → 3`으로 줄었다. 하지만 두 가지 문제가 남았다.

첫째, 초기 `findManyWorlds()`가 여전히 모든 world × 모든 place × 모든 version을 fetch한다. banned/private 필터링은 여전히 앱에서 한다.

둘째, `enrichVersionMeta` (CDN에서 mapName, maxPlayerCount를 읽어오는 작업)가 `Promise.all`로 N개 동시 호출된다. concurrency cap 없음.

### 2단계: 단일 JOIN (현재)

필터를 DB WHERE 절로 내리고, 필요한 데이터만 한 번에 JOIN해서 가져온다.

```typescript
// world.db-client.ts
async findPublishedForListing(filter, orderBy?) {
  return this.prisma.world.findMany({
    where: {
      isDraft: false,
      accessStatus: { not: 'PRIVATE' },
      ownerGroupId: { not: null },
      OR: [
        { inspectionReport: null },
        { inspectionReport: { status: { not: 'BANNED' } } },
      ],
      places: {
        some: {
          isMainPlace: true,
          versions: { some: { status: 'PUBLISHED' } },
        },
      },
      ...(filter.categories && { categories: { hasSome: filter.categories } }),
    },
    include: {
      ownerGroup: true,
      places: {
        where: { isMainPlace: true },
        include: {
          versions: {
            where: { status: 'PUBLISHED' },
            orderBy: { version: 'desc' },
            take: 1,           // 최신 published version 1개만
          },
        },
      },
      inspectionReport: true,
    },
    orderBy: orderBy ?? { updatedAt: 'desc' },
  })
}
```

DB 호출 1회. banned/private world는 아예 fetch하지 않는다. gRPC 호출은 0회 (ownerGroup을 JOIN으로 포함).

`enrichVersionMeta`는 유지했다. CDN에서 읽는 mapName/maxPlayerCount는 쿠킹이 완료된 시점에만 알 수 있고, 현재는 Redis에 1일 TTL로 캐싱한다. concurrency cap 20으로 제한해서 uncapped 문제도 해결.

```typescript
// world.service.ts
async getPublishedWorldsForListing(filter) {
  const worlds = await this.worldRepo.findPublishedWorldsForListing(filter)
  const tasks = worlds.map((world) => async () => ({
    ...world,
    publishedVersion: await this.placeService.enrichVersionMeta(world.publishedVersion),
  }))
  const results = await executeWithConcurrencyAllSettled(tasks, 20)
  return results.filter(isFulfilled).map((r) => r.value)
}
```

변경 전후 비교:

| 항목 | 원본 N+1 | 배치 | **단일 JOIN** |
|---|---|---|---|
| DB 쿼리 수 | `1 + 3N` | `3` | **`1`** |
| gRPC 호출 수 | `N` | `1` | **`0`** |
| fetch되는 version row | 전체 | 전체 | **최신 1개** |
| banned/private fetch | O | O | **X** |
| CDN 동시 요청 cap | 없음 | 없음 | **20** |

## 측정 환경 구성

코드가 얼마나 빨라졌는지 확인하려면 live와 유사한 데이터 규모에서 측정해야 한다. 개발 환경에 live 규모 데이터를 넣은 격리 환경(`query-opt` 네임스페이스)을 사용했다.

### live 데이터 규모 파악

먼저 live에 데이터가 얼마나 있는지 확인했다.

| 항목 | 수량 |
|---|---|
| 전체 world | 3,031 |
| draft | 1,954 |
| non-draft PUBLIC | 578 |
| non-draft PRIVATE | 490 |
| non-draft PAUSE | 9 |
| published (listing 대상) | 45 |
| 전체 place | 3,031 (world당 1개) |
| 전체 place_version | 9,244 |

버전 분포도 중요했다. 단순히 총 개수만 맞추는 게 아니라 실제 분포(대부분 1~2개, 소수가 수십~백 개 이상)를 재현해야 쿼리 플래너가 live와 비슷하게 동작한다.

live에서 place별 version 수 누적 분포를 뽑아서 seed SQL에 62개 구간 CASE 표현식으로 박았다.

```sql
-- place_versions 시드 (live 분포 재현)
INSERT INTO place_versions (place_id, version, ...)
SELECT vc.place_id, v, ...
FROM (
  SELECT
    p.id AS place_id,
    w.is_draft,
    (name BETWEEN 1955 AND 1999) AS is_published,
    CASE
      WHEN rn <=  2501 THEN  1   -- 82.5% of places: 1 version
      WHEN rn <=  2646 THEN  2
      WHEN rn <=  2710 THEN  3
      -- ...62개 구간...
      ELSE 198                   -- 상위 이상치
    END AS max_ver
  FROM (
    SELECT p.id, ROW_NUMBER() OVER (ORDER BY p.id) AS rn
    FROM places p WHERE ...
  ) p
  JOIN worlds w ON w.id = p.world_id
) vc
CROSS JOIN generate_series(1, vc.max_ver) AS v;
```

결과적으로 world 3,031개, place_version 8,630개(live 9,244에서 이상치 2개 제외)가 세팅됐다.

### CDN 고정

`enrichVersionMeta`는 CDN에서 `metadata.json`을 읽는다. dev 환경에서 live CDN에 접근이 가능한지 불확실하고, CDN은 애초에 병목이 아니다. 그래서 dev 환경에서 실제로 존재하는 CDN URL 하나를 고정해서 세팅했다.

```sql
-- published world의 last version에만 cooked_build_file 세팅
cooked_build_file = 'assets/place/cook/place/32/1'  -- dev에서 실존하는 경로
```

Redis 캐시가 warm되면 CDN 호출은 발생하지 않는다. cold 상태에서의 측정이 필요할 경우엔 Redis flush 후 측정하면 된다.

### 측정 스크립트

```bash
#!/usr/bin/env bash
ENDPOINT="https://eterno-query-opt.ovdr.io/backend/overdare/listUgcWorlds"
N="${1:-30}"

for i in $(seq 1 "$N"); do
  ms=$(curl -s -o /dev/null -w "%{time_total}" \
    -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d '{"category":null}' \
    | awk '{ printf "%.0f\n", $1 * 1000 }')
  echo "[$i/$N] ${ms}ms"
done
```

## 결과

live 동일 규모 데이터, Redis warm 상태, 30회 측정.

| 지표 | main (before) | fix (after) | 개선율 |
|------|:---:|:---:|:---:|
| p50 | 2,804 ms | **400 ms** | **-85.7%** |
| p95 | 3,022 ms | **436 ms** | **-85.6%** |
| p99 | 3,436 ms | **441 ms** | **-87.2%** |
| avg | 2,906 ms | **406 ms** | **-86.0%** |

7배 이상 개선. p50 기준 2.8초 → 400ms.

## 데이터가 더 늘어난다면

현재 published world가 45개라서 `enrichVersionMeta` 45회 호출이 빠르게 끝난다. published world가 500개, 5,000개로 늘어나면 어디서 병목이 생길까.

### 문제 1: `enrichVersionMeta`가 O(N)

concurrency cap 20으로 막혀 있다. cold 상태에서 published world 500개라면:

```
500개 ÷ 20 동시 × CDN 평균 응답시간 ~500ms = 12.5초
```

warm 상태에서는 Redis 접근이므로 괜찮지만, 배포 직후나 Redis 재시작 시에는 cold hit이 발생한다.

**해결책**: `mapName`과 `maxPlayerCount`를 `place_versions` 테이블에 저장한다. 쿠킹 완료 시점에 이 값을 알 수 있으므로, 쿠킹 완료 이벤트 핸들러에서 DB에 기록하면 된다. listing 쿼리에서 CDN/Redis 호출 없이 JOIN 한 번으로 모든 데이터를 가져올 수 있게 된다.

### 문제 2: `findPublishedForListing`에 pagination 없음

현재 `findMany`에 `take`/`skip`이 없다. published world가 5,000개면 5,000개를 한꺼번에 fetch한다.

**해결책**: cursor-based pagination 도입.

```typescript
async findPublishedForListing(filter: {
  categories?: string[]
  cursor?: bigint    // 마지막으로 받은 world.id
  take?: number      // 페이지 크기
}) {
  return this.prisma.world.findMany({
    where: { ... },
    cursor: filter.cursor ? { id: filter.cursor } : undefined,
    take: filter.take ?? 50,
    skip: filter.cursor ? 1 : 0,
    orderBy: { id: 'desc' },
  })
}
```

`updatedAt` 기준 정렬이라면 중복 값 가능성 때문에 cursor key로 `id`를 쓰는 게 안전하다.

### 문제 3: worlds 테이블 인덱스

현재 `worlds` 테이블에는 `@@index(ownerGroupId)`만 있다. WHERE 절의 `isDraft`, `accessStatus` 컬럼에는 인덱스가 없다.

published world 수가 늘어나면 플래너가 sequential scan을 선택할 수 있다.

```prisma
// 추가 권장 인덱스
@@index([isDraft, accessStatus])         // worlds 필터
```

`places` 테이블은 `@@index([worldId])` 있지만, EXISTS 서브쿼리가 `WHERE world_id=? AND is_main_place=true`를 쓰므로 복합 인덱스가 더 효율적이다.

```prisma
@@index([worldId, isMainPlace])          // places EXISTS 서브쿼리
```

`place_versions`도 마찬가지.

```prisma
@@index([placeId, status])               // place_versions EXISTS 서브쿼리
```

---

현 규모(published 45개)에서는 단일 JOIN만으로 7배 개선이 됐다. published world가 수백 개 이상으로 늘어나는 시점이 오면, pagination + DB 컬럼 저장(enrichVersionMeta 제거)이 다음 개선 포인트가 될 것이다.
