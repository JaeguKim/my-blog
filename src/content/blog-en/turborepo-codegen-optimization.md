---
title: 'Optimizing Builds in a Turborepo Monorepo: 68% Faster Codegen, 98% Faster Builds, and Package Configurations'
description: 'How we optimized the codegen pipeline (80s → 26s), rolled out build caching across the board (4 min → 6s), and split up configuration with Package Configurations in a NestJS + Turborepo monorepo'
pubDate: 'Feb 13 2026'
---

## Background

In our NestJS + Turborepo monorepo, code generation (`gen:api`, `gen:prisma`, `gen:proto`) was slow enough that it kept breaking our development flow. `pnpm gen:api` in particular was taking 80 seconds, and when I dug in, most of that turned out to be unnecessary work.

The monorepo is structured like this:

```
├── backend/              # NestJS monorepo (two apps: eterno, hiker)
├── frontend/             # React/Next.js frontends
├── packages/
│   ├── smart-contracts/  # Solidity contracts (hardhat)
│   ├── chain-config/     # Blockchain configuration
│   ├── error-codes/      # Error code definitions
│   └── service-settings/ # Service settings
└── scripts/
    └── gen.sh            # Code generation orchestrator
```

## Diagnosis: Why Did gen:api Take 80 Seconds?

Visualizing the task graph with Turbo's `--dry` option makes the problem obvious:

```bash
npx turbo run gen:api --filter=backend --dry=json
```

The original task chain:

```
gen:api
  → depends on backend#build
    → depends on build:eterno-backend (tsc && nest build eterno-backend)
    → depends on build:hiker-backend  (tsc && nest build hiker-backend)
      → both depend on ^build (builds every upstream package)
        → smart-contracts#build (hardhat compile --force && tsc) ← 20s
        → chain-config, error-codes, service-settings builds
```

I found three problems:

1. **`gen:api` depended on `backend#build`** — `nest start api-generator` compiles independently with its own tsconfig, so it never uses the `dist/` produced by `backend#build`. All it needs are the build outputs of the upstream workspace packages (`smart-contracts`, `chain-config`, etc.).
2. **`smart-contracts` was fully recompiled every time** — the cache was invalidated three ways: the `--force` flag, turbo caching being disabled, and `prebuild: rm -rf dist`.
3. **`gen.sh` built things twice and ran everything sequentially** — it called `build_backend()` separately, and then `turbo run gen:api` built the upstream packages all over again.

## Improvement 1: Removing the Unnecessary backend#build Dependency

First, I checked what `nest start api-generator` actually compiles:

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

It **compiles the entire backend source tree on its own**. It doesn't use the `dist/` produced by `backend#build`, and it writes its output to a separate path (`dist/scripts/api-generator/`).

However, the backend source imports upstream workspace packages, e.g. `import ... from 'smart-contracts'`, and those packages export their build output via `main: "./dist/index.js"`. So if their `dist/` doesn't exist, TypeScript compilation fails. In other words, **the backend's own build output is unnecessary; only the upstream packages' build output is required**, which means we can change `backend#build` → `^build`.

So I replaced `backend#build` (building the backend itself) with `^build` (building only the upstream packages):

```diff
// turbo.json
"gen:api": {
  "cache": false,
- "dependsOn": ["clean:api", "backend#build"]
+ "dependsOn": ["clean:api", "^build"]
}
```

In Turbo, `^` means "this task in the upstream packages that the current package depends on."

That single line eliminated the `tsc × 2 + nest build × 2` chain:

| | Before | After |
| --- | --- | --- |
| `pnpm gen:api` | 80s | 56s |
| Number of tasks | 8 | 6 |

## Improvement 2: Enabling the smart-contracts Build Cache

Of the 56 seconds, ~20 were spent in `smart-contracts#build`. The culprit was three layers of cache invalidation:

```json
// packages/smart-contracts/package.json
{
  "prebuild": "rm -rf dist",              // 1. deletes dist every time
  "build": "hardhat compile --force && tsc" // 2. --force ignores the hardhat cache
}

// turbo.json
"build": { "cache": false }                // 3. turbo cache disabled
```

I made two changes:

**Removed `--force` from hardhat compile:**

```diff
- "build": "hardhat compile --force && tsc"
+ "build": "hardhat compile && tsc"
```

Without `--force`, hardhat checks `artifacts/` and `cache/` and skips compilation if the Solidity sources haven't changed.

**Selectively enabled caching for smart-contracts only in turbo.json:**

```json
"smart-contracts#build": {
  "cache": true,
  "inputs": ["contracts/**", "src/**", "hardhat.config.ts", "tsconfig.json", "package.json"],
  "outputs": ["dist/**", "typechain-types/**", "artifacts/**"]
}
```

Since the default `build` task has `cache: false`, I used a package-specific override (`smart-contracts#build`) to turn caching on for just this package. If none of the files listed in `inputs` have changed, turbo skips running the build script entirely and restores `outputs` from the cache.

The two caches operate at different layers:

```
Run gen:api
  → turbo: have smart-contracts input files changed?
    → NO → restore outputs from cache (0s)
    → YES → run prebuild + hardhat compile
             → hardhat: have the Solidity sources changed?
               → NO → skip compilation (2s)
               → YES → full compile (20s)
```

| | Before | After (1st run) | After (2nd run) |
| --- | --- | --- | --- |
| `pnpm gen:api` | 59s | 29s | 26s |

## Improvement 3: Removing Duplicate Builds from gen.sh + Parallelizing

Looking at `gen.sh`, the `generate_api()` function was calling `build_backend()` separately:

```bash
function generate_api() {
  build_backend    # turbo run build --filter backend (tsc×2 + nest build×2)
  turbo run clean:api
  turbo run gen:api  # builds upstream again via ^build → duplicate!
}

generate_prisma    # runs sequentially
generate_proto     # runs sequentially
generate_api
```

Two problems:
- `build_backend()` duplicated the `gen:api → ^build` dependency already declared in turbo.json
- `prisma` and `proto` are independent, yet they ran sequentially

The fix:

```bash
function generate_api() {
  # removed build_backend — turbo handles it automatically via ^build
  turbo run gen:api
}

generate_prisma &   # run in background
generate_proto &    # run in background
wait                # wait for both to finish
generate_api        # runs afterwards because it needs the prisma types
```

| | Before | After |
| --- | --- | --- |
| `pnpm gen` (full) | 139s | 94s |

## Improvement 4: Rolling Out Build Caching Across the Board

After improving the codegen pipeline, I extended the same caching strategy to the full `pnpm build`. Previously every build task (except smart-contracts) had `cache: false`, so a full rebuild ran every time, even when no source had changed.

### Discovering Bugs in the outputs Configuration

Before enabling caching, I reviewed the existing `outputs` settings and found two bugs:

```json
// turbo.json — original configuration
"build:eterno-backend": {
  "outputs": ["dist/**"]  // ❌ points to backend/dist/
}
// Actual nest build output: backend/apps/eterno-backend/dist/

"hiker#build": {
  // outputs not set → falls back to the default dist/**
}
// Actual vite output: frontend/hiker/build/  (outDir in vite.config.ts)
```

Because caching was set to `cache: false`, the wrong outputs never surfaced as a problem. But once you switch to `cache: true`, turbo restores files from these paths on a cache HIT, so incorrect outputs lead to missing build artifacts. This was very likely the cause of the problems we had run into when we tried `cache: true` in the past.

### The Changes

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

**The `inputs` strategy**: For most packages I didn't specify `inputs`. When `inputs` is absent, turbo hashes every file in the package, which is safer than an explicit `inputs` list — there's no risk of forgetting to add a new file to `inputs`. The one exception is the backend build tasks (`build:eterno-backend`, `build:hiker-backend`), where I did specify `inputs`, because they need to distinguish per-app sources within the same package.

### Verifying the Cache

I wrote a script that automatically verifies 12 scenarios to make sure caching behaves correctly:

```bash
./scripts/verify-turbo-cache.sh
```

Each scenario: modify a file → check cache status with `turbo run build --dry=json` → restore with `git checkout`. For example:

| Scenario | Change | Expected MISS | Expected HIT |
| --- | --- | --- | --- |
| chain-config changed | `packages/chain-config/index.ts` | chain-config, backend×2, eterno, ovdr-official | hiker, odds, smart-contracts |
| Only eterno-backend changed | `backend/apps/eterno-backend/src/main.ts` | build:eterno-backend | build:hiker-backend, all frontends |
| Prisma generated code changed | `backend/prisma/_generated/` | build:eterno-backend, build:hiker-backend | all packages, all frontends |

All 12 scenarios PASS.

### Results

| Scenario | Before (no cache) | After (cached) | Improvement |
| --- | --- | --- | --- |
| `pnpm build` 1st run (cold) | 4m 42s | 4m 38s | Same |
| `pnpm build` 2nd run (no changes) | 4m 5s | **6s** | **-98%** |

The cold build is unchanged, but a second build with no source changes dropped from 4 minutes to 6 seconds. In day-to-day development, only the packages that changed get rebuilt and everything else is restored from the cache, so most builds see a big time savings.

## Improvement 5: Splitting Up Configuration with Package Configurations

While rolling out build caching across the board, the root `turbo.json` accumulated as many as 9 package-specific overrides:

```json
// turbo.json — bloated root configuration
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

To figure out which package uses which settings, you have to dig through the root file. Turborepo offers a feature that solves exactly this: [Package Configurations](https://turborepo.dev/docs/reference/package-configurations) — you put a `turbo.json` in each package and inherit the root configuration with `"extends": ["//"]`.

### How I Found It: The Turborepo Claude Skill

The idea for this refactor came from the [Turborepo Claude Skill](https://skills.sh/vercel/turborepo/turborepo) officially provided by Vercel. You can install it with the `npx skills` CLI:

```bash
$ npx skills search turborepo

vercel/turborepo@turborepo  7.7K installs
antfu/skills@turborepo      2.9K installs
wshobson/agents@turborepo-caching  2.2K installs

$ npx skills add vercel/turborepo@turborepo --yes
```

Installing it creates a symlink at `.claude/skills/turborepo/`, and from then on Claude automatically references it whenever you work on anything turbo-related. The skill's Anti-Patterns section includes the following:

> **Package-Specific Task Overrides in Root turbo.json**
> When multiple packages need different task configurations, use **Package Configurations** (`turbo.json` in each package) instead of cluttering root `turbo.json` with `package#task` overrides.

### Applying It

I created a `turbo.json` in each package that overrides only that package's `build` settings:

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

The root `turbo.json` now holds only the shared task definitions:

```json
// turbo.json — cleaned-up root configuration
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

Only `prisma-generator-nestjs-dto#build` stays in the root — it's a git submodule, so adding a `turbo.json` inside the package would mean modifying the submodule's repository.

### Verification

I ran the existing verification script (13 scenarios) as-is to confirm that caching behaves identically:

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

(In the script output above, "변경" means "changed" and "전체" means "all".)

The behavior is exactly the same, but each piece of configuration now lives right next to the package it belongs to.

## Final Results

### Individual Commits

| Commit | Change | Target | Before | After | Improvement |
| --- | --- | --- | --- | --- | --- |
| 1 | `gen:api` dependency `backend#build` → `^build` | `pnpm gen:api` | 80s | 56s | -24s (30%) |
| 2 | Enable smart-contracts cache + remove `--force` | `pnpm gen:api` | 59s | 26s | -33s (56%) |
| 3 | Remove `build_backend` from gen.sh + parallelize prisma/proto | `pnpm gen` | 139s | 94s | -45s (32%) |
| 4 | Roll out build caching across the board | `pnpm build` (2nd run) | 4m 5s | 6s | -98% |

### Cumulative Impact

| Target | Original Before | Final After | Total Improvement |
| --- | --- | --- | --- |
| `pnpm gen:api` | 80s | 26s | **-54s (68%)** |
| `pnpm gen` (full) | 139s | 94s | **-45s (32%)** |
| `pnpm build` (2nd run) | 4m 5s | 6s | **-98%** |

## Lessons Learned

**Check the task graph with `turbo --dry` first.** If you look at which tasks run, and why, before you execute anything, unnecessary dependencies jump right out.

**Respect your build tools' own caches.** Habitually throwing in a `--force` flag or `rm -rf dist` defeats the caching mechanisms the tools give you. Cache invalidation should be deliberate, and only when needed.

**Trace "who actually consumes this build output?"** The key to confirming that `gen:api` didn't use `backend#build`'s `dist/` was comparing the tsconfig `include` scope against the output paths.

**If `outputs` isn't accurate, caching becomes poison.** On a cache HIT, turbo skips the build and restores only the files listed in `outputs`. If `outputs` doesn't match the actual build artifacts, files go missing and dependent tasks fail. With `cache: false`, the build runs every time, so `outputs` errors never surface.

**It's safer not to specify `inputs`.** Without `inputs`, turbo hashes every file in the package. An explicit `inputs` list risks missing newly added files. Use `inputs` only when you need to distinguish sources for different tasks within the same package.

**Keep configuration close to the code.** When per-package build settings are all piled into the root `turbo.json`, it's hard to tell which package uses which outputs. Splitting them out with Package Configurations (`<package>/turbo.json` + `"extends": ["//"]`) means you can see the settings as soon as you open the package.

**Make use of your tools' official skills and docs.** Turborepo's Claude Skill (`npx skills add vercel/turborepo@turborepo`) provides a list of anti-patterns and a decision tree. Because it was referenced automatically while I worked, I was able to spot improvements like Package Configurations.
