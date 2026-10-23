---
title: 'A Field the Mapper Threw Away Cost Us a Second RPC on Every World Entry'
description: 'The download-info lookup on world entry called an external backend twice — not because the data was missing, but because the conversion code received it and discarded it. Cutting it to one call dropped server p50 by 58%. Plus the two real defects review caught, and why merge-to-deploy being 17 days apart meant redoing the measurement window.'
pubDate: 'Oct 22 2026'
---

## The Problem

When a client enters a world, it calls `GetDownloadInfo` — the API that answers "which build should I download?" That handler called the external creator backend (Eterno) **twice**.

```go
// before
world, err := e.world.Get(ctx, worldID, locale)        // Eterno GetWorld
// ...
place, err := e.world.GetPlace(ctx, world.Desc.MainPlaceID, false)  // Eterno GetPlace
```

Read the world, then read that world's main place. The two calls are serial, and this is the entry hot path.

To see whether the second call could go away, I dumped an actual `GetWorld` response from Eterno. It was already in there.

```
World.main_place_meta = {
  placeId: 2827, version: 17, isPublished: true,
  buildFilePath: "assets/place/cook/live/2827/17",
  mapName: "/User/99_2827_17/99_2827_17", maxPlayerCount: 10
}
```

`version` and `buildFilePath`. Everything download info needs was right there.

## Why It Was Two Calls

The second call wasn't needed because the response lacked the values. **The domain conversion received them and threw them away.**

```go
// BackendWorldDescMapper.FromProto(world, meta)
MaxPlayerCount: int64(meta.GetMaxPlayerCount()),
MainPlaceID:    desc.GetMainPlaceId(),
UpdatedAt:      meta.GetUpdatedAt().AsTime(),
// version and buildFilePath are dropped here ← the only reason GetPlace was called again
```

The mapper pulls three fields and lets the rest fall on the floor. The discarded `version` and `buildFilePath` are exactly the `ClientPlaceVer`/`ServerPlaceVer` and `Client/ServerMapResourcePath` that download info carries.

The history says this was a byproduct, not a design. There was a migration from a one-tier world model to a two-tier world-place model, and `main_place_meta` was added to the IDL the same day. But that field was added so the **list and detail APIs wouldn't have to read the place separately**, and the download path kept following the original rule: places come from the place endpoint.

The essence of the bug is that the fact "the value is already in this response" was **only visible if you opened the mapper**. Read the call site alone and the second lookup looks obviously necessary.

## First, Though: Check the Traffic

A confession. My first target wasn't this API — it was `GetManyDownloadInfos`, the bulk variant that returns download info for several worlds. Its handler ran the single-world logic serially per world: 20 worlds meant 40 Eterno calls. The code even carried a `// NOTE: should be changed to batch processing if needed` comment.

I wrote a plan and started implementing. Then I measured the call volume.

**Zero calls in 24 hours across prod, staging, and dev.**

The clue was already in front of me and I didn't cross-check it. An app-side survey I'd read said "unused from RN, appears only in the debug catalog." I read that and still didn't drop my assumption that it mattered for home and list responsiveness.

**Verify production call volume before proposing an optimization.** It's one query, and skipping it means optimizing code nobody calls.

## The Change

I redirected to the path that actually gets traffic. Three pieces.

**1. A mapper moves the meta into a place.** It has to share conversion rules with the existing UGC place mapper, but the two proto messages carry the same build fields on different types. I bound them with an interface.

```go
// placeBuild is the set of build fields that eterno's Place and World.MainPlaceMeta
// both carry under the same names.
type placeBuild interface {
	GetVersion() int32
	GetBuildFilePath() string
	GetMapName() string
	GetMaxPlayerCount() int32
}

func placeFromBuild(worldID, placeID int64, build placeBuild) model.Place { ... }
```

Better than six positional arguments. Two adjacent `int`-ish parameters will compile just fine if you swap them.

**2. The adapter returns world and place from one `GetWorld`.** The existing `GetWorld` shares the common body but doesn't pay the mapping cost. I got this part wrong first and introduced a regression where list and catalog paths built a places map they never used. Self-review caught it.

**3. The interactor owns the routing.**

```go
worldType := enum.GetWorldType(worldID)

switch {
case needsVersionedPlace(worldType, placeVersion):
	// A pinned version can't come from the meta — the meta only carries the published one
	place, err := c.GetPlaceByVersion(ctx, world.Desc.MainPlaceID, placeVersion)
	...
case mainPlace == nil:
	// A world with no published main place has no meta (READY_FOR_PUBLISHING, etc.)
	...
case worldType == enum.WorldTypeNative:
	return world, c.applyNativeVersionSettings(mainPlace), nil
default:
	return world, mainPlace, nil   // one call, done
}
```

I sampled 500 live requests for the distribution.

| Case | Share | Eterno calls |
|---|---|---|
| Native, no version requested | 51% | 1 |
| Native, version requested | 17% | 1 (native ignores the version) |
| UGC, no version requested | 7% | 1 |
| UGC, version requested | 21% | still 2 |
| Explicit place id | 3% | already 1 |

**75% moves to the one-call path.** The remaining 21% went to follow-up work.

## Two Real Defects Review Caught

I believed this was a behavior-preserving refactor. I ran review from several angles and two things came back. Both were places where the one-call path produced a **different answer** than the two-call path.

### We were serving unpublished builds as successful responses

I decided "is there a published main place?" with `place.ID == 0` — testing whether the meta was *present*. But `MainPlaceMeta` carries an explicit `is_published`.

Follow the case where the meta arrives but is unpublished:

- the mapper maps it to `version: 0` and `buildFilePath: ""`
- `Place.GetMeta()` falls back to the empty version key and returns **success**
- the client gets version `"0"` and an empty download URL, with a **200**

The old code read the real place record in that case and returned a working build. I changed the guard to read `is_published`, restoring the old behavior.

One honest note here. I tried to confirm from logs whether Eterno ever sends an unpublished meta, and **the server doesn't log that field** (zero hits over 12 hours). My search proved nothing. So rather than lean on "it doesn't happen," I added a guard that falls back to the old behavior if it does.

### Pre-download bailed out with an error before the exposure check

`GetWorldPreloadInfo` is an unauthenticated endpoint hit once per app launch. It was written to absorb "the banner points at a world that isn't exposed" as "nothing to preload."

```go
// A banner wired to a non-exposed world is an ops-data problem. Don't hand a download
// URL to an unauthenticated caller, but from the app's side this is the same as having
// nothing to fetch — so it is not an error.
if err := ensureWorldExposed(world.Desc); err != nil {
	return nil, nil
}
```

I wrote that comment. And I broke it. Reading world and place together moved the place lookup **ahead of the exposure check**, so a world with no main place assigned (`MainPlaceID == 0`) failed the place-id validator and the error propagated out. One misconfigured banner would break pre-download for an entire country.

Fixed by resolving no place when there's no main place id, letting the exposure check absorb it.

### A fake test, proven fake by mutation testing

One more, as a bonus. The test review ran mutation testing and proved that one of my assertions **could not fail for any change**.

```go
func (f *fakeWorldCatalog) GetWithPlace(
	_ context.Context, _ int64, placeVersion string, _ string,  // ← discards worldID
) (*model.World, *model.Place, error) {
	return f.world, f.place, nil   // fixed value
}
```

`require.Equal(t, openTestWorldID, got.WorldID)` passed not because the production code was right but because **the fake returned the fixture**. Hardcode a nonsense world id at the call site and it still passes. I made the fake record its arguments, then confirmed that mutation actually fails now.

## Measuring: Merge Is Not Deploy

Both PRs merged, and I waited for the live deploy before measuring. I got stuck twice.

**First, the inflection point wasn't the merge date.** The merges were Oct 2 and Oct 8, but the metrics stayed flat until Oct 19. A release branch gets cut (Oct 15) and rolls out later still (Oct 19, 13:32). **Slice your before/after window at the merge date and the improvement is invisible.** I pinned the deploy by having the k8s ReplicaSet creation timestamp and the metric step agree independently.

**Second, logs couldn't do it.** Elasticsearch retention is 7–10 days, so it doesn't reach 20 days back. The data warehouse has no server RPC latency table. I ended up in Prometheus (VictoriaMetrics, 30-day retention). Writing it down because it's a trap I'll hit again — **compare pre/post server metrics in the metrics store.**

```promql
# external calls per request (daily)
sum(increase(ovdr_server_rpc_caller_requests_total{
  namespace="live", app_service="world_service",
  rpc_service="backend.apis.eterno.v1.EternoAPI", rpc_method="GetPlace"}[24h]))

# handler latency
histogram_quantile(0.5, sum by (le) (rate(
  ovdr_server_rpc_handler_request_duration_seconds_bucket{
  namespace="live", app_service="world_service", rpc_method="GetDownloadInfo"}[24h])))
```

Absolute call counts move with traffic, so I normalized to **calls per request**.

## Results

### External calls: −67.6%

| | GetPlace/request | GetPlace/day |
|---|---|---|
| Before (23 days) | **2.69** (range 2.64–2.76) | ~78,000 |
| After | **0.89** | ~20,000 |

Normalized to equal traffic, **44,000–55,000 fewer calls per day**.

### Server latency: p50 −58%

| | p50 | p90 | p99 |
|---|---|---|---|
| Before | 23.4ms | 77.8ms | 188.5ms |
| After | **9.8ms** | **44.8ms** | **97.2ms** |
| | −58% | −42% | −48% |

Day-to-day reproducibility is high (before 23.6 / 23.4 / 23.0 → after 9.8 / 9.8).

p50 dropped 13.6ms, but the removed call is about 5ms. This isn't "p50 minus one call" — **the distribution shifted**. The two-call cases clustered above the median, and when most of them became one call, the median itself moved down into what used to be a lower percentile.

## Where My Predictions Were Wrong

The most useful thing measurement taught me wasn't the result — it was **why my predictions were off**.

**I underestimated the reduction by 4–5×.** I'd written down 10,000 calls per day; the real number was 44,000–55,000. I counted only the volume of the two public RPCs and assumed each dropped one call. But the measured ratio was 2.69 per request. Entry, join, and teleport reuse the same code internally, and that inbound traffic never entered my denominator. **The change's reach was wider than the surface I was looking at.**

**Pre-download didn't improve at all.** `GetWorldPreloadInfo` p50 went 18.3 → 18.0ms, effectively flat. Its p90 is 25ms, a very tight distribution, which suggests this path usually returns early because the banner has no world, or that something else dominates its cost.

**Total external call volume barely moved.** Per request it went 23.86 → 23.29, just −0.57. GetPlace dropped 1.85, so something else made up the difference — another change in the same release.

| Method | Before/req | After/req | Daily change |
|---|---|---|---|
| ListWorldEvents | 0 | 0.963 | +22,771 |
| GetManyWorlds | 0.053 | 0.176 | +2,595 |
| **GetPlace** | **2.732** | **0.885** | **−60,051** |

A world-events feature that shipped in the same release added 0.96 external calls per request. Unrelated to my work — but if I want to claim "reduced load on the external backend," I have to say this too. Before taking credit for a metric, count the other changes that landed in the same window.

## No Regression, But It Gave Me a Scare

For 25 hours after the deploy, `WORLD_VERSION_MISMATCH` fired 46 times. Baseline is 0–4 per day. It was **the same error code** review had warned me about.

Instead of guessing, I aggregated every log line.

| Count | Client version |
|---|---|
| 40 | `40.2.0-release-40.*` — the previous release client |
| 3 | `42.0.0-feature-*-test` |
| 2 | `41.0.0-release-41.*` — within baseline noise |
| 1 | `41.0.0-*-renewal` |

87% were stale clients straddling the release boundary. A native world's version set is keyed by client version from dynamic config, and that logic is identical before and after, so an unregistered client version legitimately finding no match is correct behavior. If it were a code defect it would have kept firing; it's been zero since.

An incidental finding: the `GetPlace` calls that remain are themselves slower (p50 4.8 → 7.5ms). Not a regression — a selection effect. The cheap calls are the ones that disappeared, leaving versioned reads and fallbacks.

---

Two things stay with me.

The code change that removed one external call from the entry hot path is under 400 lines. What it took to *find* it was one thing: **opening the mapper**. Read the call site and the second lookup looks necessary; dump the response proto and the value is sitting there. When you suspect a duplicate call, "are we calling again because the data is missing?" and "are we receiving it and throwing it away?" are different questions, and the second one gets asked less often.

And measuring cost more effort than improving. Get the deploy time wrong and the improvement reads as zero; skip counting the other changes in the release and you over-credit yourself. I got both wrong on the first try.
