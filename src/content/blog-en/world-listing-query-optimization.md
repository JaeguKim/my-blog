---
title: 'Making a NestJS World Listing Query 7x Faster: From N+1 to a Single JOIN'
description: 'Figuring out why the listWorlds API was slow and improving it in three steps: N+1 → batching → a single JOIN. Plus how I validated it by building a measurement environment with the same data scale as live.'
pubDate: 'May 20 2026'
---

## The Problem

The `listWorlds` API was consistently slow. The logs showed 2–3 seconds per request — even though there were only 45 published worlds at the time.

Open up the code and the reason is obvious right away.

```typescript
// world.service.ts — before optimization
async getPublishedWorldsForListing(filter) {
  const worlds = await this.worldRepo.findManyWorlds(filter)  // fetches every world + place + version
  
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

With N=45, that's `1 + 3×45 = 136` external calls. Even worse, banned/private worlds are all fetched from the DB and only then dropped in the application.

## Three-Step Optimization

### Step 1: Batch queries

I started by collapsing N calls into one.

```
Before: gRPC getGroupById() ×N  →  After: gRPC getGroupsByIds() ×1
Before: DB getMainPlace() ×N    →  After: DB getPublishedVersionsByPlaceIds() ×1
```

The number of DB calls dropped from `1 + 3N → 3`. But two problems remained.

First, the initial `findManyWorlds()` still fetched every world × every place × every version. Banned/private filtering still happened in the application.

Second, `enrichVersionMeta` (which reads mapName and maxPlayerCount from the CDN) was being called N times concurrently via `Promise.all`, with no concurrency cap.

### Step 2: A single JOIN (current)

Push the filters down into the DB's WHERE clause, and fetch only the data you need in one JOIN.

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
            take: 1,           // only the latest published version
          },
        },
      },
      inspectionReport: true,
    },
    orderBy: orderBy ?? { updatedAt: 'desc' },
  })
}
```

One DB call. Banned/private worlds are never fetched at all. Zero gRPC calls (ownerGroup is included via the JOIN).

I kept `enrichVersionMeta`. The mapName/maxPlayerCount read from the CDN are only known once cooking is complete, and they're currently cached in Redis with a 1-day TTL. Limiting it to a concurrency cap of 20 also fixed the uncapped problem.

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

Before vs. after:

| Item | Original N+1 | Batched | **Single JOIN** |
|---|---|---|---|
| DB queries | `1 + 3N` | `3` | **`1`** |
| gRPC calls | `N` | `1` | **`0`** |
| Version rows fetched | All | All | **Latest 1** |
| Fetches banned/private | Yes | Yes | **No** |
| Concurrent CDN request cap | None | None | **20** |

## Setting Up the Measurement Environment

To see how much faster the code actually got, you have to measure at a data scale similar to live. I used an isolated environment (the `query-opt` namespace) in dev, loaded with live-scale data.

### Understanding live data volume

First, I checked how much data live actually had.

| Item | Count |
|---|---|
| Total worlds | 3,031 |
| Draft | 1,954 |
| Non-draft PUBLIC | 578 |
| Non-draft PRIVATE | 490 |
| Non-draft PAUSE | 9 |
| Published (listing targets) | 45 |
| Total places | 3,031 (1 per world) |
| Total place_versions | 9,244 |

The version distribution mattered too. It wasn't enough to match the total count — the query planner only behaves like it does in live if you reproduce the real distribution (most places have 1–2 versions, a few have dozens to over a hundred).

I pulled the cumulative distribution of version counts per place from live and hard-coded it into the seed SQL as a CASE expression with 62 buckets.

```sql
-- place_versions seed (reproducing the live distribution)
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
      -- ...62 buckets...
      ELSE 198                   -- top outliers
    END AS max_ver
  FROM (
    SELECT p.id, ROW_NUMBER() OVER (ORDER BY p.id) AS rn
    FROM places p WHERE ...
  ) p
  JOIN worlds w ON w.id = p.world_id
) vc
CROSS JOIN generate_series(1, vc.max_ver) AS v;
```

The result was 3,031 worlds and 8,630 place_versions (live's 9,244 minus 2 outliers).

### Pinning the CDN

`enrichVersionMeta` reads `metadata.json` from the CDN. It was unclear whether the dev environment could reach the live CDN, and the CDN wasn't the bottleneck in the first place. So I pinned it to a single CDN URL that actually exists in the dev environment.

```sql
-- set cooked_build_file only on the last version of published worlds
cooked_build_file = 'assets/place/cook/place/32/1'  -- a path that actually exists in dev
```

Once the Redis cache is warm, no CDN calls happen. If you need to measure in a cold state, just flush Redis before measuring.

### Measurement script

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

## Results

Live-equivalent data volume, warm Redis, 30 runs.

| Metric | main (before) | fix (after) | Improvement |
|------|:---:|:---:|:---:|
| p50 | 2,804 ms | **400 ms** | **-85.7%** |
| p95 | 3,022 ms | **436 ms** | **-85.6%** |
| p99 | 3,436 ms | **441 ms** | **-87.2%** |
| avg | 2,906 ms | **406 ms** | **-86.0%** |

More than a 7x improvement. At p50, 2.8s → 400ms.

## What If the Data Grows?

With only 45 published worlds today, the 45 `enrichVersionMeta` calls finish quickly. If published worlds grow to 500 or 5,000, where will the bottlenecks appear?

### Problem 1: `enrichVersionMeta` is O(N)

It's capped at a concurrency of 20. In a cold state with 500 published worlds:

```
500 ÷ 20 concurrent × ~500ms average CDN response time = 12.5 seconds
```

In a warm state it's fine because it hits Redis, but cold hits happen right after a deploy or when Redis restarts.

**Solution**: Store `mapName` and `maxPlayerCount` in the `place_versions` table. These values are known once cooking completes, so the cooking-completion event handler can write them to the DB. The listing query can then fetch all the data in a single JOIN with no CDN/Redis calls.

### Problem 2: No pagination in `findPublishedForListing`

Right now `findMany` has no `take`/`skip`. With 5,000 published worlds, it would fetch all 5,000 at once.

**Solution**: Introduce cursor-based pagination.

```typescript
async findPublishedForListing(filter: {
  categories?: string[]
  cursor?: bigint    // the last world.id received
  take?: number      // page size
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

If you sort by `updatedAt`, duplicate values are possible, so using `id` as the cursor key is the safer choice.

### Problem 3: Indexes on the worlds table

The `worlds` table currently has only `@@index(ownerGroupId)`. The `isDraft` and `accessStatus` columns used in the WHERE clause have no index.

As the number of published worlds grows, the planner may choose a sequential scan.

```prisma
// recommended additional index
@@index([isDraft, accessStatus])         // worlds filter
```

The `places` table has `@@index([worldId])`, but since the EXISTS subquery uses `WHERE world_id=? AND is_main_place=true`, a composite index would be more efficient.

```prisma
@@index([worldId, isMainPlace])          // places EXISTS subquery
```

The same goes for `place_versions`.

```prisma
@@index([placeId, status])               // place_versions EXISTS subquery
```

---

At the current scale (45 published worlds), the single JOIN alone delivered a 7x improvement. Once published worlds grow into the hundreds or more, pagination plus storing the values in DB columns (removing enrichVersionMeta) will be the next improvements to make.
