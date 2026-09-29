---
title: 'Backend Tests 3.5x Faster: Migrating from ts-jest to @swc/jest'
description: 'How swapping ts-jest for @swc/jest in a NestJS + Jest backend cut local test time from 45s to 13s — and why the CI parallelization I also tried barely made a difference.'
pubDate: 'Apr 06 2026'
---

## Background

The backend tests in our monorepo were slow. Running 78 test suites with 643 tests took 45 seconds locally, and even longer in CI, where `--runInBand` forced everything to run serially.

Slow tests slow down the development loop. Whether you're doing TDD or just checking a change, 45 seconds is more than enough to break your focus.

## Finding the Bottleneck

### 1. The cost of ts-jest's transform

Jest has to convert `.ts` files to JavaScript before running them. `ts-jest` uses the TypeScript compiler (tsc) for this conversion. Because tsc also performs type checking, it carries significant overhead compared to a plain transform.

A large chunk of test execution time was going to code transformation.

Measuring individual suite times with `--verbose` showed that most suites finished quickly, while time was concentrated in transform initialization. Among individual tests, the content-settings warmup retry test was using a real `setTimeout` of 2 seconds × 3 retries = **4 seconds**, and an encryption key generation test was eating **1.3 seconds**. Those could be improved separately with `jest.useFakeTimers()`, but the transform cost dwarfed everything else, so that's where I focused.

### 2. --runInBand in CI

The CI Dockerfile ran the tests like this:

```dockerfile
CMD ["npx", "jest", "--runInBand", "--detectOpenHandles", "--config", "..."]
```

`--runInBand` runs every test **sequentially in a single process**. It completely disables Jest's default worker-based parallel execution. Why was it set up this way?

- To avoid shared-state problems between tests
- To prevent memory issues inside the Docker container
- "Because it works, so leave it"

But when I actually checked, all the tests passed when run in parallel. There were no shared-state issues.

## The Fix: ts-jest → @swc/jest

### What is SWC?

SWC is a JavaScript/TypeScript compiler written in Rust. Unlike tsc, it **only transforms code, without type checking**. Type checking isn't needed to run tests — that's the job of `tsc --noEmit` or your IDE.

**Trade-off**: Since SWC doesn't look at types, tests can pass even when there are type errors. You need either a separate `tsc --noEmit` step in the CI pipeline or to confirm that type checking happens during the build step (`pnpm turbo run build`). In our project, the build step runs before the tests, so type safety was already guaranteed.

**Rollback is simple**: If something goes wrong, revert the jest config's transform to `"ts-jest"` and remove `@swc/core` and `@swc/jest`. It's a change to a single config file, so the risk is low.

### Installation

```bash
pnpm add -D @swc/jest @swc/core --filter backend
```

### Updating the Jest config

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

NestJS relies heavily on decorators, so `decorators: true` and `decoratorMetadata: true` are mandatory. Leave them out and DI breaks.

### Results

```
Before (ts-jest):  45s
After  (@swc/jest): 13s  → 3.5x faster
```

All 78 suites and 643 tests passed. No behavioral differences.

## The Circular Dependency Problem

After the switch, one test failed.

```
ReferenceError: WorldAssetResourceType is not defined
```

The cause was a circular import between two DTO files:

```
sandbox-public.dto.ts  ──import──>  sandbox-user.dto.ts (WorldAssetResourceType)
         ↑                                    |
         └──────────import───────────────────┘  (SandboxWorldAssetDto)
```

ts-jest (tsc) handles circular imports with lazy loading at runtime, so they mostly work. SWC, however, initializes modules in a different order, so when the value is used at runtime by a decorator — as in `@ApiProperty({ enum: WorldAssetResourceType })` — it ends up referencing a value that hasn't been initialized yet.

### The fix

I broke the cycle by extracting `WorldAssetResourceType` into its own file:

```typescript
// sandbox.types.ts (newly created)
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

A caveat when re-exporting: a barrel export of the form `export { X } from './file'` can cause problems in SWC if the value is also used at runtime in the same file. Splitting it into an `import` followed by a separate `export` solves this.

## Why CI Didn't Get Faster

After confirming the 3.5x improvement locally, I also tried parallelizing CI by changing `--runInBand` → `--maxWorkers=50%`. Local measurements:

| Setting | Time |
|------|------|
| `--runInBand` (original) | 28.7s |
| `--maxWorkers=50%` | 22s |
| No limit | 13s |

But when I applied it to the actual CI pipeline, **total CI time barely changed.**

The reason was simple. Tests made up only a small share of total CI time:

```
Full Docker build:  ~5 min
├── pnpm install:   ~1 min 30 s
├── turbo build:    ~2 min
├── Run tests:      ~30 s   ← the only part that improved
└── Image build:    ~1 min
```

Cutting 30 seconds down to 15 isn't noticeable out of 5 minutes. On top of that, `@swc/core` is a native binary (~50MB), so install time went up slightly, partially offsetting the gains in test time.

In the end, **I rolled back the `--runInBand` change in the CI Dockerfile.** To reduce overall CI time, the answer isn't test parallelization — it's Docker build caching or improving the pipeline structure itself.

## Restructuring the CI Pipeline: Separating Build and Test

If test execution speed has little impact on total CI time, the pipeline structure itself has to change.

### Before: build + test in a single job

Previously, tests ran sequentially inside the Docker build. Tests couldn't start until the build finished, and the image couldn't be pushed until the tests finished. Because everything was serial, all the times added up.

### After: build and test as parallel jobs

I split the GitHub Actions workflow into two independent jobs:

```yaml
jobs:
  test:
    name: Unit Test
    steps:
      - # checkout
      - docker build --target test-runner
      - docker run eterno-backend-test:latest

  build-push:
    name: Build and Push ECR Image
    # needs: test  ← intentionally omitted
    steps:
      - # checkout
      - docker build --target server-runner
      - docker push
```

The key point is that `build-push` **does not depend on** `test`. Both jobs start at the same time.

### Why do it this way?

- **Faster test feedback.** The test job doesn't do heavy work like building the production image, pushing to ECR, or uploading version metadata. It only builds up to the `test-runner` stage and runs immediately, so results come back sooner.
- **Build failures and test failures are identified independently.** When build failures and test failures are mixed in a single job, it's hard to tell what broke. Once they're separated, Slack notifications come in separately too.
- **Tests act as a merge gate.** If passing the `test` job is required for PR merges, a PR won't be merged when tests fail, even if the build succeeds. Because it's independent of the build job, a test failure doesn't block the build, yet the code quality gate stays in place.

### Trade-offs

- It uses twice the CI runner resources. Since both jobs run concurrently, two runners are needed.
- Git checkout and the early Docker build stages (`pruner`, `builder`) run redundantly in both jobs. Due to the Dockerfile's multi-stage structure, both `test-runner` and `server-runner` go through the `builder` stage, so no time is saved there.
- Build/push continues even when tests fail, so unnecessary images may end up in ECR. However, deployment is a separate pipeline, so this isn't a real problem in practice.

## Summary

| Environment | Before | After | Improvement |
|------|--------|-------|------|
| Local (parallel) | 45s (ts-jest) | 13s (@swc/jest) | **3.5x** |
| CI test speed | No change | No change | - |
| CI pipeline | Build + test in serial | Build/test as parallel jobs | Faster test feedback |

Files changed:
- 3 `jest.config.json` files (backend root, eterno-backend/test, hiker-backend/test)
- 1 `sandbox.types.ts` (circular dependency fix)
- `package.json` + `pnpm-lock.yaml` (@swc/jest, @swc/core dependencies)
- `eterno-backend-ci-v2.yaml` (split into parallel build/test jobs)

## Lessons Learned

1. **Type checking during tests is waste.** tsc's value lies in type checking, but running tests only requires a plain transform. That's exactly what SWC does.

2. **Local and CI have different bottlenecks.** Being 3.5x faster locally doesn't mean CI gets faster too. If tests are a small share of total CI time, optimizing only the tests won't be noticeable. To decide what to optimize, look at the time distribution across the whole pipeline first.

3. **Circular dependencies will blow up eventually.** It was fine under ts-jest but broke under SWC. Changing tools exposes code smells that were hiding all along. That's a good thing.

4. **If you can't make it faster, change the structure.** Test execution was such a small part of total CI time that speeding it up was meaningless. In that situation, the real improvement is restructuring the pipeline to run things in parallel. Splitting build and test into independent jobs speeds up test feedback without affecting build time.

5. **Measure first, optimize later.** Don't go by a gut feeling that "it's slow" — measure actual times with `--verbose` and the `time` command and find the bottleneck. The fix is completely different depending on whether the bottleneck is the transform, I/O, or individual slow tests. This time I also found a 4-second warmup test, but because the transform cost was overwhelming, focusing there was the right call.
