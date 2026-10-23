---
title: '매퍼가 버린 필드 때문에 월드 진입마다 RPC를 두 번 불렀다'
description: '월드 진입 다운로드 정보 조회가 외부 백엔드를 두 번 부르던 이유는 데이터가 없어서가 아니라 변환 코드가 받아 놓고 버렸기 때문이었다. 호출을 1회로 줄여 서버 지연 p50을 58% 낮춘 과정, 리뷰가 잡아낸 두 개의 실제 결함, 그리고 머지와 배포가 17일 차이라 측정 창부터 다시 잡아야 했던 이야기.'
pubDate: 'Oct 22 2026'
---

## 문제

월드에 진입할 때 클라이언트는 `GetDownloadInfo`를 부른다. 어떤 빌드를 내려받아야 하는지 묻는 API다. 이 핸들러가 외부 크리에이터 백엔드(Eterno)를 **두 번** 불렀다.

```go
// 개선 전
world, err := e.world.Get(ctx, worldID, locale)        // Eterno GetWorld
// ...
place, err := e.world.GetPlace(ctx, world.Desc.MainPlaceID, false)  // Eterno GetPlace
```

월드를 읽고, 그 월드의 메인 플레이스를 또 읽는다. 두 호출은 직렬이고, 진입 핫패스다.

두 번째 호출을 없앨 수 있는지 보려고 Eterno의 `GetWorld` 응답을 떠봤다. 그런데 응답에 이미 들어 있었다.

```
World.main_place_meta = {
  placeId: 2827, version: 17, isPublished: true,
  buildFilePath: "assets/place/cook/live/2827/17",
  mapName: "/User/99_2827_17/99_2827_17", maxPlayerCount: 10
}
```

`version`과 `buildFilePath`. 다운로드 정보에 필요한 값이 전부 거기 있다.

## 왜 두 번이었나

두 번째 호출이 필요했던 것은 응답에 값이 없어서가 아니다. **도메인 변환이 받아 놓고 버렸기 때문**이다.

```go
// BackendWorldDescMapper.FromProto(world, meta)
MaxPlayerCount: int64(meta.GetMaxPlayerCount()),
MainPlaceID:    desc.GetMainPlaceId(),
UpdatedAt:      meta.GetUpdatedAt().AsTime(),
// version, buildFilePath 는 여기서 버려진다 ← GetPlace 를 다시 부른 유일한 이유
```

매퍼가 세 필드만 꺼내고 나머지를 흘린다. 버려진 `version`·`buildFilePath`가 곧 다운로드 정보의 `ClientPlaceVer`/`ServerPlaceVer`와 `Client/ServerMapResourcePath`다.

이력을 보면 의도적인 설계가 아니라 부산물이다. 월드 1단 구조를 월드-플레이스 2단 구조로 바꾼 작업이 있었고, 같은 날 IDL에 `main_place_meta`가 추가됐다. 그런데 그 필드는 **목록·상세 API가 플레이스를 따로 읽지 않게 하려고** 끼운 것이었고, 다운로드 경로는 원래 규칙인 "플레이스는 플레이스에서 읽는다"를 그대로 따랐다.

같은 응답에 이미 값이 있다는 사실이 **매퍼 안을 열어봐야 보이는 상태**였다는 게 이 버그의 본질이다. 호출부만 읽으면 두 번째 조회가 당연해 보인다.

## 그 전에: 트래픽부터 확인하라

고백할 게 있다. 나는 처음에 이 API가 아니라 `GetManyDownloadInfos`를 개선하려 했다. 여러 월드의 다운로드 정보를 한 번에 주는 벌크 API이고, 핸들러가 월드마다 단건 로직을 직렬로 돌린다. 월드 20개면 Eterno 호출 40회. 코드에도 `// NOTE: 필요시에 배치 처리할 수 있는 로직으로 변경 필요` 주석이 달려 있었다.

계획을 세우고 구현까지 들어갔다. 그러고 나서 호출량을 쟀다.

**prod·staging·dev 24시간 동안 0건이었다.**

이미 단서가 있었는데 교차 확인을 안 했다. 앱 코드 조사 리포트에 "RN에서 미사용, 디버그 카탈로그에만 등장"이라고 적혀 있었다. 그걸 읽고도 "홈·목록 응답성에 영향"이라는 내 가정을 버리지 않았다.

**개선 제안 전에 프로덕션 호출량을 먼저 확인한다.** 쿼리 한 번이면 끝나는 일이고, 그걸 건너뛰면 아무도 부르지 않는 코드를 최적화한다.

## 변경

실제로 쓰이는 경로로 방향을 돌렸다. 세 조각이다.

**1. 매퍼가 메타를 플레이스로 옮긴다.** 기존 UGC 플레이스 변환과 규칙을 공유해야 하는데, 두 proto 메시지가 같은 빌드 필드를 다른 타입으로 담고 있다. 인터페이스로 묶었다.

```go
// placeBuild 는 eterno Place 와 World.MainPlaceMeta 가 같은 이름으로 담고 있는 빌드 필드다.
type placeBuild interface {
	GetVersion() int32
	GetBuildFilePath() string
	GetMapName() string
	GetMaxPlayerCount() int32
}

func placeFromBuild(worldID, placeID int64, build placeBuild) model.Place { ... }
```

위치 인자 6개보다 이쪽이 낫다. `int` 계열이 둘 붙어 있으면 순서를 바꿔 넣어도 컴파일된다.

**2. 어댑터가 `GetWorld` 1회로 월드와 플레이스를 함께 돌려준다.** 기존 `GetWorld`는 공통부를 공유하되 매핑 비용을 지지 않게 분리했다. 이 부분을 처음에 잘못 만들어서, 목록·카탈로그 경로가 쓰지도 않는 플레이스 맵을 만들고 버리는 회귀를 넣었다. 자체 리뷰에서 잡혔다.

**3. 인터랙터가 라우팅을 소유한다.**

```go
worldType := enum.GetWorldType(worldID)

switch {
case needsVersionedPlace(worldType, placeVersion):
	// 특정 버전 요청은 메타로 안 된다 — 메타는 배포된 버전만 담는다
	place, err := c.GetPlaceByVersion(ctx, world.Desc.MainPlaceID, placeVersion)
	...
case mainPlace == nil:
	// 배포된 main place 가 없는 월드는 메타가 없다 (READY_FOR_PUBLISHING 등)
	...
case worldType == enum.WorldTypeNative:
	return world, c.applyNativeVersionSettings(mainPlace), nil
default:
	return world, mainPlace, nil   // 1회로 끝
}
```

라이브 요청 500건을 떠서 분포를 봤다.

| 케이스 | 비중 | Eterno 호출 |
|---|---|---|
| 네이티브, 버전 미지정 | 51% | 1회 |
| 네이티브, 버전 지정 | 17% | 1회 (네이티브는 버전을 무시한다) |
| UGC, 버전 미지정 | 7% | 1회 |
| UGC, 버전 지정 | 21% | 2회 유지 |
| placeId 지정 | 3% | 이미 1회 |

**75%가 1회 경로**로 내려온다. 남은 21%는 후속 작업으로 뺐다.

## 리뷰가 잡은 두 개의 실제 결함

"행동 보존 리팩터"라고 믿고 있었다. 다각도 리뷰를 돌렸고 두 개가 나왔다. 둘 다 1회 경로가 2회 경로와 **다른 답**을 내는 지점이었다.

### 미배포 빌드를 성공 응답으로 내주고 있었다

"배포된 메인 플레이스가 있나"를 `place.ID == 0`으로 판정했다. 메타의 유무를 본 것이다. 그런데 `MainPlaceMeta`에는 `is_published`가 따로 있다.

메타가 실려 오면서 미배포인 경우를 따라가 보면:

- 매퍼가 `version: 0`, `buildFilePath: ""`로 매핑한다
- `Place.GetMeta()`가 빈 버전 키로 폴백해 **성공**을 돌려준다
- 클라이언트는 버전 `"0"`과 빈 다운로드 URL을 **200으로** 받는다

종전 코드는 이 경우 실제 플레이스 레코드를 읽어 제대로 된 빌드를 줬다. 가드를 `is_published`로 바꿔 종전 동작으로 되돌렸다.

여기서 한 가지를 솔직히 말해야 한다. Eterno가 미배포 메타를 실어 보내는지 로그로 확인하려 했는데 **서버가 그 필드를 로그에 남기지 않는다**(12시간 0건). 내 검색은 아무것도 증명하지 못했다. 그래서 "일어나지 않는다"에 기대지 않고, 일어나도 종전 동작으로 떨어지는 가드를 넣는 쪽을 택했다.

### 선다운로드가 노출 검사 전에 에러로 빠져나갔다

`GetWorldPreloadInfo`는 앱 실행마다 불리는 비인증 엔드포인트다. 배너에 편성된 월드가 노출 불가 상태인 것을 "받아둘 것이 없음"으로 흡수하도록 되어 있었다.

```go
// 배너에 편성된 월드가 노출 불가 상태인 것은 운영 데이터 문제다. 비인증 호출자에게
// 다운로드 URL 을 내주지 않되, 앱 입장에서는 받아둘 것이 없는 것과 같으므로 에러가 아니다.
if err := ensureWorldExposed(world.Desc); err != nil {
	return nil, nil
}
```

이 주석은 내가 쓴 것이다. 그리고 내가 깼다. 월드와 플레이스를 한 번에 읽게 되면서 플레이스 조회가 **노출 검사보다 먼저** 일어났고, 메인 플레이스가 배정되지 않은 월드(`MainPlaceID == 0`)에서 place id 검증이 실패해 에러가 그대로 올라갔다. 배너 하나 잘못 편성되면 그 나라 전체 선다운로드가 깨진다.

메인 플레이스 id가 없으면 플레이스를 nil로 두고 노출 검사가 흡수하게 고쳤다.

### mutation testing이 잡은 가짜 테스트

덤으로 하나 더. 테스트 리뷰가 mutation testing을 돌렸고, 내 테스트의 단정 하나가 **어떤 변경으로도 깨지지 않는다**는 걸 증명했다.

```go
func (f *fakeWorldCatalog) GetWithPlace(
	_ context.Context, _ int64, placeVersion string, _ string,  // ← worldID 를 버린다
) (*model.World, *model.Place, error) {
	return f.world, f.place, nil   // 고정값
}
```

`require.Equal(t, openTestWorldID, got.WorldID)`가 통과하는 이유는 프로덕션 코드가 맞아서가 아니라 **fake가 픽스처를 돌려주기 때문**이었다. 호출부에 엉뚱한 world id를 박아도 통과한다. 인자를 기록하게 고치고, 그 mutation이 실제로 잡히는지 확인했다.

## 측정: 머지 ≠ 배포

두 PR이 머지되고 라이브 배포까지 기다렸다 측정에 들어갔다. 여기서 두 번 막혔다.

**첫째, 변화 지점이 머지 시점이 아니었다.** 머지는 10/2와 10/8인데 지표는 10/19까지 평평했다. release 브랜치 컷(10/15) 후 롤아웃(10/19 13:32)까지 더 걸린다. **머지일로 before/after 창을 자르면 개선이 안 보인다.** k8s ReplicaSet 생성 시각과 메트릭 step이 독립적으로 일치하는 것으로 배포 시점을 확정했다.

**둘째, 로그로는 못 쟀다.** Elasticsearch 보존이 7~10일이라 배포 전(20일 전)에 닿지 않는다. 데이터 웨어하우스에는 서버 RPC 지연 테이블이 없다. 결국 Prometheus(VictoriaMetrics, 보존 30일)로 갔다. 다음에 또 헤맬 함정이라 적어둔다 — **배포 전후 서버 지표 비교는 메트릭 스토어로 한다.**

```promql
# 요청당 외부 호출 수 (일별)
sum(increase(ovdr_server_rpc_caller_requests_total{
  namespace="live", app_service="world_service",
  rpc_service="backend.apis.eterno.v1.EternoAPI", rpc_method="GetPlace"}[24h]))

# 핸들러 지연
histogram_quantile(0.5, sum by (le) (rate(
  ovdr_server_rpc_handler_request_duration_seconds_bucket{
  namespace="live", app_service="world_service", rpc_method="GetDownloadInfo"}[24h])))
```

절대 호출량은 트래픽에 따라 변하므로 **요청당 호출 수**로 정규화했다.

## 결과

### 외부 호출: −67.6%

| | GetPlace/요청 | GetPlace/일 |
|---|---|---|
| 배포 전 (23일) | **2.69** (범위 2.64~2.76) | ~78,000 |
| 배포 후 | **0.89** | ~20,000 |

동일 트래픽 환산 **하루 44,000~55,000건 감소**.

### 서버 지연: p50 −58%

| | p50 | p90 | p99 |
|---|---|---|---|
| 배포 전 | 23.4ms | 77.8ms | 188.5ms |
| 배포 후 | **9.8ms** | **44.8ms** | **97.2ms** |
| | −58% | −42% | −48% |

일별 재현성이 높다 (배포 전 23.6 / 23.4 / 23.0 → 후 9.8 / 9.8).

p50이 13.6ms 줄었는데 제거한 호출 1회는 약 5ms다. "p50에서 한 번 뺀 값"이 아니라 **분포가 이동한 결과**다. 2회 호출 케이스가 중위값 위에 몰려 있었고, 그 대부분이 1회로 바뀌면서 중위값 자체가 아래 분위로 내려갔다.

## 예측이 틀린 쪽

측정에서 제일 배운 건 결과가 아니라 **내 예측이 왜 틀렸는가**다.

**감소량을 4~5배 과소 예측했다.** 나는 하루 1만 건 감소를 적었는데 실제는 44,000~55,000건이었다. 공개 RPC 두 개의 호출량만 세고 각각 1회씩 줄어든다고 계산했다. 그런데 실측 비율이 요청당 2.69였다. 진입·조인·텔레포트가 내부적으로 같은 코드를 재사용하고, 그 inbound는 내 분모에 들어가지 않았다. **변경의 영향 범위가 내가 본 범위보다 넓었다.**

**선다운로드는 개선이 없었다.** `GetWorldPreloadInfo` p50은 18.3 → 18.0ms로 사실상 그대로다. p90이 25ms로 분포가 매우 좁아, 이 경로는 배너에 월드가 없어 조기 반환되거나 다른 비용이 지배하는 것으로 보인다.

**전체 외부 호출량은 거의 줄지 않았다.** 요청당 23.86 → 23.29로 −0.57뿐이다. GetPlace가 −1.85인데 총합이 그만큼 줄지 않은 이유는 같은 릴리스의 다른 변경이다.

| 메서드 | 전/요청 | 후/요청 | 일 변화 |
|---|---|---|---|
| ListWorldEvents | 0 | 0.963 | +22,771 |
| GetManyWorlds | 0.053 | 0.176 | +2,595 |
| **GetPlace** | **2.732** | **0.885** | **−60,051** |

같은 릴리스에 들어간 월드 이벤트 기능이 요청당 외부 호출을 0.96개 새로 추가했다. 내 작업과 무관하지만, "외부 백엔드 부하를 줄였다"고 말하려면 이 사실을 같이 말해야 한다. 지표 하나를 들고 공을 주장하기 전에 같은 창에 들어온 다른 변경을 세어보는 게 맞다.

## 회귀는 없었다, 다만 놀랐다

배포 후 25시간 동안 `WORLD_VERSION_MISMATCH`가 46건 떴다. 베이스라인은 0~4건/일이다. 리뷰에서 경고받은 실패 모드와 **같은 에러 코드**였다.

추측으로 넘기지 않고 로그를 전수 집계했다.

| 건수 | 클라이언트 버전 |
|---|---|
| 40 | `40.2.0-release-40.*` — 직전 릴리스 클라이언트 |
| 3 | `42.0.0-feature-*-test` |
| 2 | `41.0.0-release-41.*` — 베이스라인 노이즈 범위 |
| 1 | `41.0.0-*-renewal` |

87%가 릴리스 전환기의 구 클라이언트였다. 네이티브 월드의 버전 집합은 dynamic config가 클라이언트 버전으로 키잉하고 그 로직은 변경 전후 동일하므로, 등록되지 않은 버전이 맞지 않는 것은 정상 동작이다. 코드 결함이라면 계속 발생했을 텐데 그 뒤로 0건이다.

부수적으로 알게 된 것: 제거하고 남은 `GetPlace`의 지연 자체는 올랐다(p50 4.8 → 7.5ms). 회귀가 아니라 선택 효과다. 싸게 끝나던 호출이 사라지고 버전 조회·폴백만 남았다.

---

두 가지가 남는다.

진입 핫패스의 외부 호출 하나를 줄이는 데 들어간 코드 변경은 400줄이 안 된다. 그걸 찾는 데 든 것은 **매퍼 안을 열어본 것** 하나다. 호출부를 읽으면 두 번째 조회가 당연해 보이고, 응답 proto를 떠보면 거기 값이 있다. 중복 호출을 의심할 때 "데이터가 없어서 다시 부르나"와 "받아 놓고 버리나"는 다른 질문이고, 후자를 안 묻는 쪽이 더 흔하다.

그리고 측정은 개선보다 품이 많이 들었다. 배포 시점을 잘못 잡으면 개선이 0으로 보이고, 같은 릴리스의 다른 변경을 안 세면 자기 공을 과대 계상한다. 둘 다 내가 처음에 틀렸다.
