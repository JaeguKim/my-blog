---
title: 'Turborepo 모노레포 빌드 최적화: codegen 68% + 빌드 98% 개선 + Package Configurations'
description: 'NestJS + Turborepo 모노레포에서 codegen 파이프라인 최적화(80초→26초), 전체 빌드 캐싱 전면 적용(4분→6초), Package Configurations로 설정 분산까지의 과정'
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

1. **`gen:api`가 `backend#build`에 의존** — `nest start api-generator`는 자체 tsconfig으로 독립 컴파일하므로 `backend#build`가 생성하는 `dist/`는 사용하지 않고, upstream workspace 패키지(`smart-contracts`, `chain-config` 등)의 빌드 결과물만 필요
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

backend 소스코드 전체를 **자체적으로 컴파일**한다. `backend#build`가 생성하는 `dist/`는 사용하지 않고, 출력도 별도 경로(`dist/scripts/api-generator/`)에 생성한다.

하지만 backend 소스가 `import ... from 'smart-contracts'`처럼 upstream workspace 패키지를 import하고, 이 패키지들은 `main: "./dist/index.js"`로 빌드 결과물을 export한다. 따라서 이들의 `dist/`가 없으면 TypeScript 컴파일이 실패한다. 즉, **backend 자체 빌드 결과물은 불필요하고 upstream 패키지 빌드 결과물만 필요**하므로 `backend#build` → `^build`로 변경할 수 있다.

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

## 개선 4: 전체 빌드 캐싱 전면 적용

codegen 파이프라인 개선 이후, `pnpm build` 전체에도 같은 캐싱 전략을 확장했다. 기존에는 모든 빌드 태스크가 `cache: false`(smart-contracts 제외)여서, 소스 변경이 없어도 매번 전체 재빌드가 실행되고 있었다.

### outputs 설정 버그 발견

캐싱을 활성화하기 전에 기존 `outputs` 설정을 점검했는데, 두 가지 버그를 발견했다:

```json
// turbo.json — 기존 설정
"build:eterno-backend": {
  "outputs": ["dist/**"]  // ❌ backend/dist/를 가리킴
}
// 실제 nest build 출력: backend/apps/eterno-backend/dist/

"hiker#build": {
  // outputs 미설정 → 기본값 dist/** 사용
}
// 실제 vite 출력: frontend/hiker/build/  (vite.config.ts의 outDir)
```

`cache: false`였기 때문에 outputs가 틀려도 문제가 드러나지 않았다. 하지만 `cache: true`로 전환하면 turbo가 캐시 HIT 시 이 경로에서 파일을 복원하므로, 잘못된 outputs는 빌드 결과물 누락으로 이어진다. 이것이 과거 `cache: true` 적용 시 겪었던 문제의 원인이었을 가능성이 높다.

### 수정 내용

```diff
// turbo.json
"build": {
-  "cache": false,
+  "cache": true,
   "dependsOn": ["^build"],
   "outputs": ["dist/**"]
}

"build:eterno-backend": {
  "cache": true,
- "outputs": ["dist/**"]
+ "outputs": ["apps/eterno-backend/dist/**"]
}

"hiker#build": {
  "cache": true,
+ "outputs": ["build/**"]
}
```

**`inputs` 전략**: 대부분의 패키지에서 `inputs`를 명시하지 않았다. turbo는 `inputs`가 없으면 패키지 내 모든 파일을 해싱하는데, 이것이 명시적 `inputs` 목록보다 안전하다. 새 파일이 추가될 때 `inputs`에 빠뜨릴 위험이 없기 때문이다. 예외적으로 backend 빌드 태스크(`build:eterno-backend`, `build:hiker-backend`)만 `inputs`를 명시했는데, 같은 패키지 내에서 앱별 소스를 구분해야 하기 때문이다.

### 캐시 검증

캐싱이 올바르게 동작하는지 12개 시나리오를 자동 검증하는 스크립트를 작성했다:

```bash
./scripts/verify-turbo-cache.sh
```

각 시나리오는: 파일 변경 → `turbo run build --dry=json`으로 캐시 상태 확인 → `git checkout`으로 복원. 예를 들어:

| 시나리오 | 변경 | Expected MISS | Expected HIT |
| --- | --- | --- | --- |
| chain-config 변경 | `packages/chain-config/index.ts` | chain-config, backend×2, eterno, ovdr-official | hiker, odds, smart-contracts |
| eterno-backend만 변경 | `backend/apps/eterno-backend/src/main.ts` | build:eterno-backend | build:hiker-backend, 전체 프론트 |
| prisma 생성코드 변경 | `backend/prisma/_generated/` | build:eterno-backend, build:hiker-backend | 전체 패키지, 전체 프론트 |

12개 시나리오 전부 PASS.

### 결과

| 시나리오 | Before (캐시 없음) | After (캐시 적용) | 개선 |
| --- | --- | --- | --- |
| `pnpm build` 1회차 (cold) | 4분 42초 | 4분 38초 | 동일 |
| `pnpm build` 2회차 (변경 없음) | 4분 5초 | **6초** | **-98%** |

cold build는 동일하지만, 소스 변경이 없는 2회차 빌드가 4분 → 6초로 단축되었다. 실제 개발 시에는 변경된 패키지만 rebuild되고 나머지는 캐시에서 복원되므로, 대부분의 빌드에서 큰 시간 절감 효과가 있다.

## 개선 5: Package Configurations로 설정 분산

전체 빌드 캐싱을 적용하면서 루트 `turbo.json`에 패키지별 오버라이드가 9개나 쌓였다:

```json
// turbo.json — 비대해진 루트 설정
{
  "tasks": {
    "build": { ... },
    "backend#build": { ... },
    "build:eterno-backend": { ... },
    "build:hiker-backend": { ... },
    "smart-contracts#build": { ... },
    "@ovdr/odds#build": { ... },
    "eterno#build": { ... },
    "hiker#build": { ... },
    "ovdr-official#build": { ... },
    "ovdr-webview#build": { ... }
  }
}
```

어떤 패키지가 어떤 설정을 사용하는지 파악하려면 루트 파일을 뒤져야 한다. Turborepo는 이 문제를 해결하는 [Package Configurations](https://turborepo.dev/docs/reference/package-configurations) 기능을 제공한다 — 각 패키지에 `turbo.json`을 두고 `"extends": ["//"]`로 루트 설정을 상속받는 방식이다.

### 발견 경로: Turborepo Claude Skill

이 리팩토링 아이디어는 Vercel이 공식 제공하는 [Turborepo Claude Skill](https://skills.sh/vercel/turborepo/turborepo)에서 왔다. `npx skills` CLI로 설치할 수 있다:

```bash
$ npx skills search turborepo

vercel/turborepo@turborepo  7.7K installs
antfu/skills@turborepo      2.9K installs
wshobson/agents@turborepo-caching  2.2K installs

$ npx skills add vercel/turborepo@turborepo --yes
```

설치하면 `.claude/skills/turborepo/`에 symlink가 생기고, 이후 turbo 관련 작업 시 Claude가 자동으로 참조한다. 이 skill의 Anti-Patterns 섹션에 다음 내용이 있다:

> **Package-Specific Task Overrides in Root turbo.json**
> When multiple packages need different task configurations, use **Package Configurations** (`turbo.json` in each package) instead of cluttering root `turbo.json` with `package#task` overrides.

### 적용

각 패키지에 `turbo.json`을 생성하고, 해당 패키지의 `build` 설정만 오버라이드:

```json
// frontend/eterno/turbo.json
{
  "extends": ["//"],
  "tasks": {
    "build": {
      "cache": true,
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**"],
      "env": ["NEXT_PUBLIC_*"]
    }
  }
}
```

```json
// frontend/hiker/turbo.json
{
  "extends": ["//"],
  "tasks": {
    "build": {
      "cache": true,
      "dependsOn": ["^build"],
      "outputs": ["build/**"]
    }
  }
}
```

```json
// backend/turbo.json
{
  "extends": ["//"],
  "tasks": {
    "build": {
      "cache": false,
      "dependsOn": ["build:eterno-backend", "build:hiker-backend"]
    },
    "build:eterno-backend": {
      "cache": true,
      "dependsOn": ["^build"],
      "inputs": ["apps/eterno-backend/src/**", "libs/**", "prisma/_generated/**", "..."],
      "outputs": ["apps/eterno-backend/dist/**"]
    },
    "build:hiker-backend": { "..." }
  }
}
```

루트 `turbo.json`은 공통 태스크 정의만 남겼다:

```json
// turbo.json — 정리된 루트 설정
{
  "globalDependencies": ["pnpm-lock.yaml"],
  "tasks": {
    "build": {
      "cache": true,
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "prisma-generator-nestjs-dto#build": {
      "cache": true,
      "outputs": ["dist/**"]
    },
    "clean": { "cache": false },
    "lint": { "dependsOn": ["^build"], "outputs": [] },
    "gen:api": { "cache": false, "dependsOn": ["clean:api", "^build"] },
    "..."
  }
}
```

`prisma-generator-nestjs-dto#build`만 루트에 남겼다 — git 서브모듈이라 패키지 내에 `turbo.json`을 추가하려면 서브모듈 레포를 수정해야 하기 때문이다.

### 검증

기존 검증 스크립트(13개 시나리오)를 그대로 실행하여 캐시 동작이 동일한지 확인했다:

```
═══════════════════════════════════════════
 Results
═══════════════════════════════════════════
  ✓ No changes (all HIT)
  ✓ chain-config 변경 → backend/eterno/ovdr-official MISS
  ✓ error-codes 변경 → backend/eterno/ovdr-official MISS
  ✓ @ovdr/odds 변경 → eterno/ovdr-official MISS, backend HIT
  ...
  ✓ pnpm-lock.yaml 변경 → 전체 MISS (globalDependencies)

Total: 13 passed, 0 failed
═══════════════════════════════════════════
```

동작은 완전히 동일하면서, 설정이 해당 패키지 가까이에 위치하게 되었다.

## 최종 결과

### 개별 커밋

| 커밋 | 변경 내용 | 대상 | Before | After | 개선 |
| --- | --- | --- | --- | --- | --- |
| 1 | `gen:api` 의존성 `backend#build` → `^build` | `pnpm gen:api` | 80초 | 56초 | -24초 (30%) |
| 2 | smart-contracts 캐시 활성화 + `--force` 제거 | `pnpm gen:api` | 59초 | 26초 | -33초 (56%) |
| 3 | gen.sh `build_backend` 제거 + prisma/proto 병렬화 | `pnpm gen` | 139초 | 94초 | -45초 (32%) |
| 4 | 전체 빌드 캐싱 전면 적용 | `pnpm build` (2회차) | 4분 5초 | 6초 | -98% |

### 누적 효과

| 대상 | 최초 Before | 최종 After | 총 개선 |
| --- | --- | --- | --- |
| `pnpm gen:api` | 80초 | 26초 | **-54초 (68%)** |
| `pnpm gen` (전체) | 139초 | 94초 | **-45초 (32%)** |
| `pnpm build` (2회차) | 4분 5초 | 6초 | **-98%** |

## 배운 것

**`turbo --dry`로 태스크 그래프를 먼저 확인하라.** 실행 전에 어떤 태스크가 왜 실행되는지 보면 불필요한 의존성을 바로 발견할 수 있다.

**빌드 도구의 자체 캐시를 존중하라.** `--force` 플래그나 `rm -rf dist`를 습관적으로 넣으면 도구가 제공하는 캐시 메커니즘을 무력화한다. 캐시 무효화는 의도적으로, 필요할 때만 해야 한다.

**"이 빌드 결과를 누가 사용하는가?"를 추적하라.** `backend#build`의 `dist/`를 `gen:api`가 사용하지 않는다는 걸 확인하는 데 가장 중요한 건 tsconfig의 `include` 범위와 출력 경로를 비교하는 것이었다.

**`outputs`가 정확하지 않으면 캐싱은 독이 된다.** 캐시 HIT 시 turbo는 빌드를 스킵하고 `outputs`에 명시된 파일만 복원한다. `outputs`가 실제 빌드 결과물과 다르면 파일이 누락되어 의존 태스크가 실패한다. `cache: false`일 때는 매번 빌드가 실행되므로 `outputs` 오류가 드러나지 않는다.

**`inputs`는 명시하지 않는 편이 안전하다.** turbo는 `inputs`가 없으면 패키지 내 모든 파일을 해싱한다. 명시적 `inputs` 목록은 새 파일 추가 시 빠뜨릴 위험이 있다. 같은 패키지 내에서 서로 다른 태스크의 소스를 구분해야 할 때만 `inputs`를 사용하면 된다.

**설정은 코드 가까이에 두라.** 패키지별 빌드 설정이 루트 `turbo.json`에 모여 있으면, 어떤 패키지가 어떤 outputs를 쓰는지 파악하기 어렵다. Package Configurations(`패키지/turbo.json` + `"extends": ["//"]`)로 분산하면 해당 패키지를 열었을 때 설정을 바로 확인할 수 있다.

**도구의 공식 스킬/문서를 활용하라.** Turborepo의 Claude Skill(`npx skills add vercel/turborepo@turborepo`)은 anti-pattern 목록과 decision tree를 제공한다. 작업 중 자동으로 참조되어 Package Configurations 같은 개선 포인트를 발견할 수 있었다.
