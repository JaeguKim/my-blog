---
title: 'Turborepo 모노레포에서 코드 생성 속도 68% 개선하기'
description: 'NestJS + Turborepo 모노레포에서 codegen 파이프라인의 불필요한 의존성과 중복 빌드를 제거하여 80초를 26초로 줄인 과정'
pubDate: 'Feb 13 2026'
---

## 배경

NestJS + Turborepo 기반 모노레포에서 코드 생성(`gen:api`, `gen:prisma`, `gen:proto`) 속도가 느려 개발 흐름이 자주 끊겼다. 특히 `pnpm gen:api`가 80초나 걸리고 있었는데, 분석해보니 대부분이 불필요한 작업이었다.

모노레포 구조는 다음과 같다:

```
├── backend/              # NestJS monorepo (eterno, hiker 두 앱)
├── frontend/             # React/Next.js 프론트엔드들
├── packages/
│   ├── smart-contracts/  # Solidity 컨트랙트 (hardhat)
│   ├── chain-config/     # 블록체인 설정
│   ├── error-codes/      # 에러 코드 정의
│   └── service-settings/ # 서비스 설정
└── scripts/
    └── gen.sh            # 코드 생성 오케스트레이터
```

## 문제 분석: gen:api는 왜 80초나 걸렸나

Turbo의 `--dry` 옵션으로 태스크 그래프를 시각화하면 문제가 보인다:

```bash
npx turbo run gen:api --filter=backend --dry=json
```

기존 태스크 체인:

```
gen:api
  → depends on backend#build
    → depends on build:eterno-backend (tsc && nest build eterno-backend)
    → depends on build:hiker-backend  (tsc && nest build hiker-backend)
      → both depend on ^build (upstream 패키지 전체 빌드)
        → smart-contracts#build (hardhat compile --force && tsc) ← 20초
        → chain-config, error-codes, service-settings 빌드
```

세 가지 문제를 발견했다:

1. **`gen:api`가 `backend#build`에 의존** — `nest start api-generator`는 자체 tsconfig으로 독립 컴파일하므로 `backend#build`의 결과물(`dist/`)을 사용하지 않음
2. **`smart-contracts`가 매번 전체 재컴파일** — `--force` 플래그 + turbo 캐시 비활성화 + `prebuild: rm -rf dist`로 3중 캐시 무효화
3. **`gen.sh`에서 중복 빌드 + 순차 실행** — `build_backend()`를 별도로 호출한 뒤 `turbo run gen:api`가 또 upstream을 빌드

## 개선 1: 불필요한 backend#build 의존성 제거

`nest start api-generator`가 실제로 무엇을 컴파일하는지 확인했다:

```json
// scripts/api-generator/tsconfig.app.json
{
  "include": [
    "../../apps/eterno-backend/**/*",
    "../../apps/hiker-backend/**/*",
    "../../libs/**/*",
    "../../scripts/**/*"
  ]
}
```

backend 소스코드 전체를 **자체적으로 컴파일**한다. `backend#build`가 생성하는 `dist/`를 사용하지 않고, 출력도 별도 경로(`dist/scripts/api-generator/`)에 생성한다.

반면 upstream workspace 패키지들(`smart-contracts`, `chain-config` 등)은 `main: "./dist/index.js"`로 빌드 결과물을 export하므로, 이들의 `dist/`가 없으면 TypeScript 컴파일이 실패한다.

따라서 `backend#build`(backend 자체 빌드) 대신 `^build`(upstream 패키지만 빌드)로 변경:

```diff
// turbo.json
"gen:api": {
  "cache": false,
- "dependsOn": ["clean:api", "backend#build"]
+ "dependsOn": ["clean:api", "^build"]
}
```

Turbo에서 `^`는 "현재 패키지가 의존하는 upstream 패키지들의 해당 태스크"를 의미한다.

이 한 줄로 `tsc × 2 + nest build × 2` 체인이 제거되었다:

| | Before | After |
| --- | --- | --- |
| `pnpm gen:api` | 80초 | 56초 |
| 태스크 수 | 8개 | 6개 |

## 개선 2: smart-contracts 빌드 캐시 활성화

56초 중 ~20초를 `smart-contracts#build`가 차지하고 있었다. 세 겹의 캐시 무효화가 문제:

```json
// packages/smart-contracts/package.json
{
  "prebuild": "rm -rf dist",              // 1. dist 매번 삭제
  "build": "hardhat compile --force && tsc" // 2. --force로 hardhat 캐시 무시
}

// turbo.json
"build": { "cache": false }                // 3. turbo 캐시 비활성화
```

두 가지를 수정했다:

**hardhat compile에서 `--force` 제거:**

```diff
- "build": "hardhat compile --force && tsc"
+ "build": "hardhat compile && tsc"
```

`--force`가 없으면 hardhat은 `artifacts/`와 `cache/`를 확인하여 Solidity 소스가 변경되지 않았으면 컴파일을 스킵한다.

**turbo.json에서 smart-contracts만 선택적으로 캐시 활성화:**

```json
"smart-contracts#build": {
  "cache": true,
  "inputs": ["contracts/**", "src/**", "hardhat.config.ts", "tsconfig.json", "package.json"],
  "outputs": ["dist/**", "typechain-types/**", "artifacts/**"]
}
```

기본 `build` 태스크가 `cache: false`이므로, 패키지별 오버라이드(`smart-contracts#build`)로 이 패키지만 캐시를 켰다. `inputs`에 정의된 파일이 변경되지 않으면 turbo가 빌드 스크립트 실행 자체를 스킵하고 `outputs`를 캐시에서 복원한다.

두 캐시는 레이어가 다르다:

```
gen:api 실행
  → turbo: smart-contracts 입력 파일 변경됨?
    → NO → 캐시에서 outputs 복원 (0초)
    → YES → prebuild + hardhat compile 실행
             → hardhat: Solidity 소스 변경됨?
               → NO → 컴파일 스킵 (2초)
               → YES → 전체 컴파일 (20초)
```

| | Before | After (1st run) | After (2nd run) |
| --- | --- | --- | --- |
| `pnpm gen:api` | 59초 | 29초 | 26초 |

## 개선 3: gen.sh 중복 빌드 제거 + 병렬화

`gen.sh`를 보니 `generate_api()` 함수 안에서 `build_backend()`를 별도로 호출하고 있었다:

```bash
function generate_api() {
  build_backend    # turbo run build --filter backend (tsc×2 + nest build×2)
  turbo run clean:api
  turbo run gen:api  # ^build로 upstream 또 빌드 → 중복!
}

generate_prisma    # 순차 실행
generate_proto     # 순차 실행
generate_api
```

두 가지 문제:
- `build_backend()`가 turbo.json의 `gen:api → ^build` 의존성과 중복
- `prisma`와 `proto`가 독립적인데 순차 실행

수정:

```bash
function generate_api() {
  # build_backend 제거 — turbo가 ^build로 자동 처리
  turbo run gen:api
}

generate_prisma &   # 백그라운드 실행
generate_proto &    # 백그라운드 실행
wait                # 둘 다 완료 대기
generate_api        # prisma 타입이 필요하므로 이후 실행
```

| | Before | After |
| --- | --- | --- |
| `pnpm gen` (전체) | 139초 | 94초 |

## 최종 결과

### 개별 커밋

| 커밋 | 변경 내용 | 대상 | Before | After | 개선 |
| --- | --- | --- | --- | --- | --- |
| 1 | `gen:api` 의존성 `backend#build` → `^build` | `pnpm gen:api` | 80초 | 56초 | -24초 (30%) |
| 2 | smart-contracts 캐시 활성화 + `--force` 제거 | `pnpm gen:api` | 59초 | 26초 | -33초 (56%) |
| 3 | gen.sh `build_backend` 제거 + prisma/proto 병렬화 | `pnpm gen` | 139초 | 94초 | -45초 (32%) |

### 누적 효과

| 대상 | 최초 Before | 최종 After | 총 개선 |
| --- | --- | --- | --- |
| `pnpm gen:api` | 80초 | 26초 | **-54초 (68%)** |
| `pnpm gen` (전체) | 139초 | 94초 | **-45초 (32%)** |

## 배운 것

**`turbo --dry`로 태스크 그래프를 먼저 확인하라.** 실행 전에 어떤 태스크가 왜 실행되는지 보면 불필요한 의존성을 바로 발견할 수 있다.

**빌드 도구의 자체 캐시를 존중하라.** `--force` 플래그나 `rm -rf dist`를 습관적으로 넣으면 도구가 제공하는 캐시 메커니즘을 무력화한다. 캐시 무효화는 의도적으로, 필요할 때만 해야 한다.

**"이 빌드 결과를 누가 사용하는가?"를 추적하라.** `backend#build`의 `dist/`를 `gen:api`가 사용하지 않는다는 걸 확인하는 데 가장 중요한 건 tsconfig의 `include` 범위와 출력 경로를 비교하는 것이었다.
