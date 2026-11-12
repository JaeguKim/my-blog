---
title: 'limit=1 Was the Most Expensive Request: A Friend-List Timeout'
description: 'To decide whether to show a friend-request badge, the app called the friend-list API with limit=1 — and on some accounts it blew past the 3s deadline. The client limit was being used as the DynamoDB page size, so the less you asked for, the more round trips the server made. How p99 went from 1.2s to 62ms, a fix that changed three times under review, and a deploy that shipped the image from just before the fix.'
pubDate: 'Nov 12 2026'
---

## Symptom

In production, the friend-list API `ListFriends` was failing about 15 times a day by exceeding its 3-second deadline. Every failure looked the same:

```
dynamodb Query ... canceled, context deadline exceeded
```

Server latency was hard-capped near 3.00s, which is the request deadline.

I had already worked on this API once. It used to ask Redis for presence one friend at a time, an N+1. Batching that into a single call took it from 225ms to 13ms. The tail was still there.

## First, find which requests are slow

I didn't use the mesh (Istio) p99/p999. WebSocket upgrades (`101`) on the same service pollute the quantiles. I used the app's own Connect access log instead, which records `rpcMethod`, `elapsed`, and the request body per request.

- The >1s tail existed **only in `ListFriends`**. Every other friend method, including `ListMyFriends` on the same service, topped out around 160ms.
- **98.5% of completed `ListFriends` calls had `limit=1`.**
- **100%** of calls over one second were the same request:

```json
{"limit":1,"status":"FRIEND_STATUS_REQUEST_RECEIVED"}
```

It's the home screen asking "is there at least one received friend request?" to decide whether to show a badge. The app is React Native, so Android and iOS share this code:

```ts
checkFriendRequestExists: async () => {
  const response = await deps.listFriends({
    accountId, cursor: '', limit: 1, status: FriendStatus.REQUEST_RECEIVED,
  });
  return response.friends.length > 0;
},
```

The request that asked for a single row was the slowest one.

## limit was a page size, not a row cap

The repo query looked like this:

```go
query := r.db.Query(keyCond).Limit(params.Limit)   // ← limit from the client
// ...status filter
paginator, _ := query.Paginator(params.Cursor)

for paginator.HasNext() {          // drain the partition to the end
    paginator.Next(ctx, &indexes)
    docs = append(docs, ...)
}
```

A DynamoDB Query `Limit` doesn't mean "return N results". It means **"read N rows at a time"**. This function drains the whole partition, so the limit can't reduce what comes back. It only chops the read into smaller pages.

> **Number of Queries = rows in the partition ÷ limit**

With `limit=1`, that's one Query per row, **sequentially**.

There's a second trap. The status condition is a FilterExpression, which is applied **after** the read, while `Limit` counts rows before the filter. Even with zero received requests, it reads every row in the partition (friends, sent requests, received requests), one at a time.

I measured it on a test account with 290 friends:

| requested `limit` | Queries | sum of Query spans |
|---|---|---|
| 1 | **×290** | **1,664ms** |
| 20 | ×15 | 90ms |
| 50 | ×6 | 37ms |
| 1000 | ×1 | (control) |

That account had zero received requests, and it still made 290 round trips. **The less you asked for, the more work the server did.**

Friends, sent requests, and received requests each cap at 300, so one account's partition can reach several hundred rows. Several hundred network round trips get you to 3 seconds quickly.

## How it got this way

The history showed this wasn't a deliberate design.

- Before a large architecture refactor, the repo loop was **bounded** with `for paginator.HasNext() && len(res) < limit`. The refactor dropped that guard, and the request's `limit` was wired straight into the Query.
- Three months later someone noticed duplicates in the list. Instead of fixing the drain, they covered it with a post-hoc `DistinctBy` and left a TODO saying the paginator needed a real fix.
- The proto promises real cursor pagination with `cursor`/`limit`/`next_cursor`. The server returns everything with an empty `next_cursor`, and the client never reads the cursor.

So I checked whether this was a fence worth keeping. It wasn't.

Restoring the bound wasn't the answer either. To show online friends first, the app **fetches the whole list and sorts it on the client**. Cap it at 50 and friend #51 disappears. Returning everything had become a contract the app relies on. The thing to fix wasn't the drain. It was **letting the client choose the page size**.

## The fix changed three times under review

**First: a floor.** `max(limit, 1000)`. `limit=1` becomes 1000, and the whole partition fits in one page. It needs zero client changes, so even old app builds that can't be force-updated are fixed by a server deploy. That alone removes the timeouts.

But the client value still decided the page size: `limit=1001` became 1001. The trap was only half closed.

**Second: a fixed 1000.** Ignore the client `limit` and always use 1000.

Review pushed back right away. 1000 is an artificial cap below DynamoDB's own 1MB page limit. Friend index rows are small, so 1MB holds thousands of them. A fixed 1000 only adds pointless round trips for partitions bigger than that.

**Third: no Limit at all.** And the `limit` field was removed from the repo parameters entirely.

```go
type queryParams struct {
    Cursor   string
    Status   enum.FriendStatus
    Backward bool
    // no Limit — remove the path by which a client value could reach the DB read
}

query := r.db.Query(keyCond)
if r.pageSize > 0 {          // only tests set this; production is 0 = no cap
    query = query.Limit(r.pageSize)
}
```

This beats keeping the field with an "ignored" comment. A comment won't stop the next person from plugging `params.Limit` back in. Without the field, doing that takes a deliberate code change.

This changes one contract. `limit <= 0` used to fail validation in the Query layer and come back as `INTERNAL`. Now it returns the full list. Live clients never send it, and since the API returns everything regardless of `limit`, succeeding is more consistent. I recorded the new contract in the ADR.

### Making sure the test actually guards the drain

I added a test that the repo reads every page. With the default page size, though, a few seeded rows fit in a single page. A bound put back into the drain loop would still pass. The first PR review called out exactly that.

So the repo got a test-only `pageSize`, set to 2 in the test to force multiple pages. Then I checked it: deliberately adding a `break` to the drain loop fails that case. A test that can't fail protects nothing.

## Things I got wrong

**It wasn't "accounts with many received requests."** My first write-up said the slow accounts were popular ones with many pending requests, not ones with many friends. The mechanism says otherwise. The filter runs after the read, so the round-trip count is set by the **total rows in the partition**. The 290-friend account made 290 round trips with zero received requests. The slow production accounts were probably popular because such accounts usually also have many friends.

**It wasn't "an Android problem" either.** Most slow calls had an `okhttp` User-Agent, so I first wrote it up as the Android home screen. The app code turned out to be shared, with no platform branch. `okhttp` dominates because RN on Android uses okhttp and there are more Android users. I corrected the announcement too.

**I opened the follow-up ticket too early.** Even after the fix, the badge check reads every received request, attaches profile/presence/last-login to each, and returns them all. I filed a ticket for "a count-only RPC", reassessed the evidence, and dropped it:

- Once the DB round trips are gone, the remaining cost is an estimated ~50ms for the worst accounts.
- There's no post-fix production data yet.
- It needs IDL, server, and app releases, while the old app builds that can't be force-updated keep using the old path anyway.

I left it as an option, to decide after looking at post-deploy data.

## The deploy shipped the image from just before the fix

The fix was merged to master, cherry-picked to the release branch, and production was redeployed. I opened the logs to measure, and the pod image tag looked wrong:

```
container_image: 42.0.0-release-42.3af7137
```

`3af7137` is the **parent** of the cherry-pick commit. It doesn't contain the fix.

| time (KST) | event |
|---|---|
| 14:33:42 | cherry-pick pushed to the release branch |
| 14:33:46 | CI (image build) for that commit starts |
| **14:37:36** | **production redeploy — latest image at that moment: `3af7137`** |
| 14:39:24 | CI finishes |

The deploy ran before the build finished, so the previous image went out again. Had I trusted the "deploy complete" message and measured, I'd have concluded the fix did nothing. After a redeploy with the fixed image (`dd7a0c1`), pods started switching at 14:43 and the rollout finished by 14:45.

**The first step of post-deploy measurement is checking the image tag, not the numbers.** The same log line carries `container_image`, so splitting by image also gives an exact before/after boundary without guessing from timestamps.

## Results

I compared production `ListFriends` response logs, **split by image**:

| window | n | p50 | p90 | p99 | max | ≥1s |
|---|---|---|---|---|---|---|
| before (24h) | 55,551 | 62.5ms | 863.7ms | 1,922.5ms | 3,001.2ms | 4,494 |
| before (2h right before deploy) | 3,008 | 17.9ms | 320.9ms | 1,199.3ms | 2,738.3ms | 67 |
| **after** | **523** | **14.8ms** | **23.6ms** | **61.6ms** | **314.0ms** | **0** |

- p99 went from 1.2–1.9s to **62ms**. There were zero calls over one second, and none over 500ms.
- Of 165 failures in the 24 hours before, 29 ended near 3 seconds, hitting the deadline. After the fix there was one failure, which ended in 15.8ms and had nothing to do with timeouts.
- The after window is only 19 minutes and 523 calls, too short to say heavy accounts are well represented. Confirming zero deadline errors over a full day is a next-day check.

## Why nobody noticed

Finally, I checked whether any alert would have caught this. None did.

- Per-method latency/error metrics and a dashboard exist, but **no alert** was attached to them.
- The closest alert is load-balancer-wide p99 > 1s. Fifteen timeouts a day are invisible in total traffic, so it fired zero times in seven days. That's correct behavior; it just answers a different question.

Here's what would have caught this earlier, cheapest first:

1. **A per-method fault-count alert.** The metrics already exist, so this can go in now. It should alert on counts, not ratios, because 15 a day rounds to zero as a ratio.
2. **A DB-calls-per-request metric.** Count DynamoDB/Redis calls in the request context and record a per-method histogram. This incident would have shown up as "290 Queries for one request", and the earlier presence one as "290 Redis calls". It catches N+1s and paging storms in one place.
3. **A structured slow-request log.** What cracked this was `limit=1` in the access log. Logging the method, small request parameters, and User-Agent only for requests over one second makes the next one a single query.

---

Two things stay with me.

**The request for one row can be the most expensive one.** When "page size" and "result cap" share a name (`Limit`) and the client sets it, you get a paradox where asking for less makes the server work more. The real fix is to split `Limit` into `PageSize` and `MaxItems` in the DB wrapper so this trap can't be expressed. The same pattern still exists in a few other services.

**Merged isn't deployed, and deployed isn't fixed.** This time a "deploy complete" sat on top of the image from just before the fix. Checking the image tag before the numbers is what kept me from concluding "no effect".
