---
title: 'Backend 테스트 3.5배 빠르게: ts-jest에서 @swc/jest로 전환하기'
description: 'NestJS + Jest 백엔드 테스트에서 ts-jest를 @swc/jest로 교체하여 로컬 테스트 실행 시간을 45초에서 13초로 단축한 과정. CI 병렬화도 시도했지만 효과가 미미했던 이유까지.'
pubDate: 'Apr 06 2026'
---

## 배경

모노레포의 백엔드 테스트가 느렸다. 78개 test suite, 643개 테스트를 돌리는 데 로컬에서 45초, CI에서는 `--runInBand` 강제 직렬 실행으로 더 오래 걸렸다.

테스트가 느리면 개발 루프가 늦어진다. TDD를 하든, 변경 후 확인을 하든, 45초는 집중이 끊기기 충분한 시간이다.

## 병목 분석

### 1. ts-jest의 transform 비용

Jest는 `.ts` 파일을 실행 전에 JavaScript로 변환해야 한다. `ts-jest`는 이 변환에 TypeScript 컴파일러(tsc)를 사용한다. tsc는 타입 체크까지 수행하므로 단순 변환 대비 오버헤드가 크다.

테스트 실행 시간의 상당 부분이 코드 변환에 쓰이고 있었다.

`--verbose` 옵션으로 개별 suite 시간을 측정해보니, 대부분의 suite가 빠르게 끝나는데 transform 초기화에 시간이 쏠리고 있었다. 개별 테스트 중에는 content-settings warmup retry 테스트가 실제 `setTimeout` 2초 × 3회 = **4초를 소비**하고 있었고, 암호화 키 생성 테스트도 **1.3초**를 먹고 있었다. 이런 것들은 `jest.useFakeTimers()`로 별도 개선 가능하지만, transform 비용이 압도적이었으므로 거기에 집중했다.

### 2. CI의 --runInBand

CI Dockerfile에서 테스트를 이렇게 실행하고 있었다:

```dockerfile
CMD ["npx", "jest", "--runInBand", "--detectOpenHandles", "--config", "..."]
```

`--runInBand`은 모든 테스트를 **단일 프로세스에서 순차 실행**한다. Jest의 기본 동작인 worker 기반 병렬 실행을 완전히 끈다. 왜 이렇게 했을까?

- 테스트 간 상태 공유 문제를 피하려고
- Docker 컨테이너에서 메모리 이슈를 방지하려고
- "일단 돌아가니까"

하지만 실제로 확인해보니 병렬 실행해도 테스트가 전부 통과했다. 상태 공유 문제는 없었다.

## 해결: ts-jest → @swc/jest

### SWC란

SWC는 Rust로 작성된 JavaScript/TypeScript 컴파일러다. tsc와 달리 **타입 체크 없이 순수 변환만** 수행한다. 테스트 실행에서 타입 체크는 불필요하다 — 그건 `tsc --noEmit`이나 IDE가 할 일이다.

**트레이드오프**: SWC는 타입을 보지 않으므로, 타입 에러가 있어도 테스트가 통과할 수 있다. CI 파이프라인에 `tsc --noEmit` 단계를 별도로 두거나, 빌드 단계(`pnpm turbo run build`)에서 타입 체크가 수행되는지 확인해야 한다. 우리 프로젝트에서는 빌드 단계가 테스트 전에 실행되므로 타입 안전성은 이미 보장되고 있었다.

**롤백이 간단하다**: 문제가 생기면 jest config의 transform을 `"ts-jest"`로 되돌리고 `@swc/core`, `@swc/jest`를 제거하면 끝이다. 설정 파일 하나의 변경이므로 리스크가 낮다.

### 설치

```bash
pnpm add -D @swc/jest @swc/core --filter backend
```

### Jest 설정 변경

```json
{
  "transform": {
    "^.+\\.ts$": ["@swc/jest", {
      "jsc": {
        "parser": {
          "syntax": "typescript",
          "decorators": true
        },
        "transform": {
          "legacyDecorator": true,
          "decoratorMetadata": true
        },
        "target": "es2021"
      },
      "module": {
        "type": "commonjs"
      }
    }]
  }
}
```

NestJS는 데코레이터를 많이 쓰므로 `decorators: true`와 `decoratorMetadata: true`가 필수다. 이걸 빠뜨리면 DI가 깨진다.

### 결과

```
Before (ts-jest):  45s
After  (@swc/jest): 13s  → 3.5배 개선
```

78 suites, 643 tests 전부 통과. 동작 차이 없음.

## Circular Dependency 문제

전환 후 1개 테스트가 실패했다.

```
ReferenceError: WorldAssetResourceType is not defined
```

원인은 두 DTO 파일 간의 circular import였다:

```
sandbox-public.dto.ts  ──import──>  sandbox-user.dto.ts (WorldAssetResourceType)
         ↑                                    |
         └──────────import───────────────────┘  (SandboxWorldAssetDto)
```

ts-jest(tsc)는 circular import를 런타임에 지연 로딩으로 처리해서 대부분 동작한다. 하지만 SWC는 모듈 초기화 순서가 달라서, `@ApiProperty({ enum: WorldAssetResourceType })`처럼 데코레이터의 런타임 값으로 사용되는 경우 아직 초기화되지 않은 값을 참조하게 된다.

### 해결

`WorldAssetResourceType`을 별도 파일로 추출하여 circular을 끊었다:

```typescript
// sandbox.types.ts (새로 생성)
export const WorldAssetResourceType = {
  MODEL: 'MODEL',
  STATIC_MESH: 'STATIC_MESH',
  // ...
} as const
```

```typescript
// sandbox-user.dto.ts
import { WorldAssetResourceType } from '../sandbox.types'
export { WorldAssetResourceType }

// sandbox-public.dto.ts
import { WorldAssetResourceType } from '../sandbox.types'
```

re-export 시 주의할 점: `export { X } from './file'` 형태의 barrel export는 SWC에서 같은 파일 내 런타임 사용 시 문제가 될 수 있다. `import` 후 별도 `export`로 분리하면 된다.

## CI에서는 왜 빨라지지 않았나

로컬에서 3.5배 개선을 확인하고, CI에서도 `--runInBand` → `--maxWorkers=50%`로 병렬화를 시도했다. 로컬에서의 실측:

| 설정 | 시간 |
|------|------|
| `--runInBand` (기존) | 28.7s |
| `--maxWorkers=50%` | 22s |
| 제한 없음 | 13s |

하지만 실제 CI 파이프라인에 적용해보니 **전체 CI 시간은 거의 변하지 않았다.**

이유는 단순했다. CI 전체 시간에서 테스트가 차지하는 비중이 작았다:

```
Docker 빌드 전체:  ~5분
├── pnpm install:  ~1분 30초
├── turbo build:   ~2분
├── 테스트 실행:   ~30초   ← 여기만 개선됨
└── 이미지 빌드:   ~1분
```

30초를 15초로 줄여도 전체 5분에서 체감이 안 된다. 게다가 `@swc/core`는 네이티브 바이너리(~50MB)라 install 시간이 소폭 증가하여 테스트 시간 단축분을 일부 상쇄했다.

결국 **CI Dockerfile의 `--runInBand` 변경은 롤백**했다. CI 전체 시간을 줄이려면 테스트 병렬화가 아니라 Docker 빌드 캐싱이나 파이프라인 구조 자체를 개선해야 한다.

## 최종 정리

| 환경 | Before | After | 개선 |
|------|--------|-------|------|
| 로컬 (병렬) | 45s (ts-jest) | 13s (@swc/jest) | **3.5x** |
| CI | 변경 없음 | 변경 없음 | - |

변경한 파일:
- `jest.config.json` 3개 (backend root, eterno-backend/test, hiker-backend/test)
- `sandbox.types.ts` 1개 (circular dep 해결)
- `package.json` + `pnpm-lock.yaml` (@swc/jest, @swc/core 의존성)

## 배운 것

1. **테스트에서 타입 체크는 낭비다.** tsc의 가치는 타입 검사이지만, 테스트 실행 시에는 순수 변환만 필요하다. SWC가 정확히 그 역할을 한다.

2. **로컬과 CI는 병목이 다르다.** 로컬에서 3.5배 빨라졌다고 CI도 빨라지는 건 아니다. CI 전체 시간에서 테스트가 차지하는 비중이 작으면 테스트만 최적화해도 체감이 없다. 어디를 최적화할지는 전체 파이프라인의 시간 분포를 먼저 봐야 한다.

3. **Circular dependency는 언젠가 터진다.** ts-jest에서는 괜찮았지만 SWC에서 터졌다. 도구를 바꾸면 기존에 숨어있던 코드 스멜이 드러난다. 이건 좋은 일이다.

4. **측정 먼저, 최적화 나중.** 감으로 "느리다"가 아니라 `--verbose`와 `time` 명령어로 실제 시간을 재고 병목을 찾아야 한다. transform이 병목인지, I/O가 병목인지, 개별 테스트가 느린지에 따라 해법이 완전히 다르다. 이번에는 4초짜리 warmup 테스트도 발견했지만, transform 비용이 압도적이라 거기에 집중한 것이 옳은 판단이었다.
