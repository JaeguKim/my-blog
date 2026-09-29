---
title: 'From an External Analytics API to Our Own Collection Pipeline: Running World Analytics Ourselves with Kafka + Redis'
description: 'How we replaced the read path that fetched world visits/playtime/DAU/D1 retention from an external analytics API (Squirrel) with a Kafka events → Redis buffer → daily flush → DB pipeline. 100x faster reads, plus the Kafka idempotency, Redis Cluster intersection, and date attribution problems we ran into along the way, and the trade-offs we made.'
pubDate: 'Jun 12 2026'
---

## Background: Our Read Path Was Tied to an External API

We were fetching world analytics (visit count, playtime, DAU, D1 retention) over HTTP from **Squirrel**, our internal analytics API. Squirrel is an analytics server that sits on top of a Snowflake data mart.

The problem was that the entire read path was an external call.

- Typical latency was ~230ms, but **the tail was 4s+**.
- The total-summary view called Squirrel **twice, sequentially**, so observed latency spiked to 5–7 seconds.
- Our product pages were directly exposed to the external system's latency and outages.
- Above all, because the read logic lived outside our system, we couldn't touch it.

So we made a decision: **collect the events ourselves, store them in our own DB, and serve reads from the DB.** Squirrel would stay around for comparison only until consistency was verified, and then be removed.

## Architecture: Events → Redis Buffer → Daily Flush → DB

```
UserWorldEntered / UserWorldDisconnected (Kafka)
        │
        ▼
  Kafka consumer ──► Redis real-time aggregation (3-day TTL)
                       · stat hash   : visit / play  (HINCRBY)
                       · DAU set     : accountId      (SADD)
                       · worlds set  : worldIds active that day (SADD, flush index)
        │
        ▼  daily cron (00:01 UTC, "yesterday")
  world_daily_stats (upsert)  ──►  read API (simple PK lookup)
```

Writing to the DB on every event would blow up write volume. So we followed the same pattern as our existing costume analytics: accumulate in Redis in real time, then flush in bulk once a day.

We store three things in Redis:

- **stat hash** — accumulates visit/play with `HINCRBY`
- **DAU set** — collects the accountIds that connected that day with `SADD`
- **worlds set** — a **flush-target index** that collects the worldIds that had events that day

The flush job runs every day at 00:01 UTC, iterates over "yesterday's" worlds set, and upserts each world into `world_daily_stats`. It takes a `SET NX` lock so that multiple pods don't run it concurrently.

So far, nothing unusual. The tricky part was the decisions that came next.

## Decision 1: Kafka Idempotency and "Counting Only Once"

Kafka is at-least-once. Consumer restarts, rebalances, and producer retries mean **the same event can arrive again.** But `HINCRBY` is not idempotent — a redelivery gets counted twice.

For visits and play, we deduplicated on `entryId`, the unique session key.

```typescript
async incrementVisit(worldId: bigint, date: Date, entryId?: string): Promise<void> {
  if (entryId) {
    const firstSeen = await this.redis.setNx(
      RedisKeyOf.WorldAnalyticsVisitDedup(entryId), '1', ENTRY_DEDUP_TTL, // 1h
    )
    if (!firstSeen) return // already seen this entryId → skip
  }
  await this.redis.hashIncrBy(statKey, STAT_VISIT_FIELD, 1) // count only the first time
  await this.redis.expire(statKey, WORLD_ANALYTICS_TTL)
}
```

`SET NX EX` is a dedup marker that answers "have I seen this entryId before?" in a single atomic round trip. It looks like a distributed lock, but the difference is that it's never released (DEL) — it only expires via TTL. The goal isn't mutual exclusion; it's **preventing duplicates from redelivery**. The dedup key's TTL only needs to outlast the redelivery window (rebalance/restart = seconds to minutes), so we set it to **1 hour**, much shorter than the stat buffer (3 days), to keep the key count in check.

DAU is different. `SADD` operates on a set, so adding the same accountId any number of times is idempotent. The accountId itself acts as the dedup key, so no separate marker is needed.

So **what if a Redis write fails?** Here we made a conscious trade-off. If we rethrow the failure to trigger Kafka reprocessing, (a) consumer lag spikes during an outage, and (b) if the dedup TTL has already expired by the time the message is reprocessed, we actually end up double-counting. Analytics data is a non-financial UX metric, and a small ± error won't change any decisions. So:

> **We adopted at-most-once.** Failures are swallowed but exposed via the `world_analytics_write_failures_total` metric, and if an anomaly is detected, we overwrite with a Squirrel backfill.

## Decision 2: D1 Retention on Redis Cluster = Set Intersection

By definition, D1 retention is an intersection.

```
D1 = (previous day's DAU ∩ current day's DAU) / previous day's DAU
```

Since we keep DAU as sets, the natural implementation is a one-liner: `SINTERCARD(yesterday, today)`. **Except it doesn't work.**

Our deployed Redis runs in Cluster mode. The two DAU sets have different keys, so they land in **different hash slots** (we didn't use hash tags). In Cluster mode, cross-key operations spanning multiple slots fail with a `CROSSSLOT` error. On top of that, Redis 6.2.7 in dev doesn't even have the `SINTERCARD` command (it's 7.0+ only).

The fix is simple. **Single-key `SMEMBERS` is cluster-safe, so we fetch the two sets separately and compute the intersection in the application.** We build a lookup Set from the smaller one and scan the larger one.

```typescript
async getDauIntersectCount(worldId, dateStr1, dateStr2): Promise<number> {
  // No SINTERCARD/SINTER: cross-slot ops break with CROSSSLOT on Cluster, and 6.2.7 doesn't have it.
  const [a, b] = await Promise.all([
    this.getDauMembers(worldId, dateStr1), // SMEMBERS (single key, safe)
    this.getDauMembers(worldId, dateStr2),
  ])
  const [small, large] = a.length <= b.length ? [a, b] : [b, a]
  const seen = new Set(small)
  let count = 0
  for (const member of large) if (seen.has(member)) count++
  return count
}
```

Lesson: with infrastructure, you have to design around **"commands that work in the deployed environment,"** not just "commands that work." `SINTERCARD` ran fine on a local single-node Redis, but on Cluster it's blocked outright.

## Decision 3: Which Date Should Playtime Be Attributed To?

Playtime arrives as a cumulative value in the disconnect event. But what if a session **crosses UTC midnight?** The user entered yesterday (23:55) and left today (00:10).

The flush job closes out each date exactly once and never reads it again. So **any increment to a past date that's already been flushed is lost forever.**

So we attributed play_sec **to the disconnect date, not the session start date**. The flush for the disconnect date always runs after this event, so capture is guaranteed.

```typescript
// Attribute to the date of "now" (= disconnect time), regardless of session length
const date = toUtcDateOnly(new Date())
await this.cacheRepo.addPlaySec(BigInt(worldId), date, accessTimeSeconds, entryId)
```

The trade-off is clear. For sessions that cross midnight, **play goes to the exit date while visit/DAU go to the entry date**. It's a small, bounded daily skew, and we accepted it as the price of avoiding data loss.

## Read Path: External HTTP → DB

D1 and DAU are already stored as snapshots in `world_daily_stats` at flush time. So a read comes down to a simple lookup on the PK `(world_id, date)`. No JOINs, no external calls.

What this PR changed is the **read source** (external Squirrel HTTP → local DB). Looking only at the component that was swapped out:

| Call | Before (Squirrel HTTP) | After (DB) | Improvement |
|---|---|---|---|
| Single lookup | typical ~230ms, **tail 4s+** | **~2ms** (PK index) | ~100x |
| total-summary | 2 sequential calls → 5–7s observed | ~2ms | tail ~1,000x+ |

## Safety Net: Swapping It Out with Convergence Checks

Ripping out an external API in one go is scary. So we added a **convergence job that compares our self-collected values against Squirrel in batch**. Every day it compares every world for the previous day and reports `converged / mismatched`. Visits and DAU must match exactly; playtime is allowed ±5% (due to differences in aggregation cadence).

Thanks to this check, we caught something interesting in production: **Squirrel's D1 comes back as `null` for recent dates.** That's because the D1 computation in the upstream Snowflake mart is delayed/stalled in dev. Comparing that as `0` against our own value (e.g. 1.0) produces a false mismatch every time. So we adjusted it to **exclude the comparison when Squirrel's d1 is null (`d1NotComparable`)** — "not computed yet" is not a "mismatch."

## Wrapping Up

Three takeaways:

- **Removing an external dependency doesn't just improve latency.** The read logic finally becomes "code we can actually change." That mattered more than the 100x speedup.
- **Full idempotency (at-least-once) isn't free.** For non-financial metrics, the combination of at-most-once + a failure metric + backfill recovery is a reasonable cost/benefit trade-off. Deciding up front how accurate things need to be simplifies the design.
- **Infrastructure constraints are design inputs.** Redis Cluster's CROSSSLOT, commands missing in certain versions (SINTERCARD), Kafka's at-least-once, the flush's single close-out — you have to design with these as premises rather than working around them, or they'll blow up later.
