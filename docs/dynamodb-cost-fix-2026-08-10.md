# DynamoDB cost investigation + fix — 2026-08-10

**Audience:** Quartermaster engineers.
**Status:** Fix shipped and deployed 2026-08-10. Follow-up verification pending (~2026-08-12).
**Related:** `infra/lib/database-stack.ts`, `src/gate/dynamo-gate.ts`, `src/gate/reservation-gate.ts`, `src/handlers/admission.ts`, `src/handlers/api.ts`, `src/types.ts`.

## TL;DR

DynamoDB was the single largest AWS cost line in August ($27.85 of $76.79 MTD, 36%, as of ~9.2 days into the month) — bigger than ECS, Lambda, and Step Functions combined, despite quartermaster having only run ~100 StoryStudio projects that month. Root cause: the 2-minute `/sweeper` cron was doing **three full-table Scans per tick** (720 ticks/day) against a `quartermaster-jobs` table that has never had a single item deleted since it went live (2026-06-09) — nothing in the codebase ever calls `DeleteItemCommand`. The Scan cost scaled with table *size*, not with actual project traffic, so it would have kept climbing every month regardless of load.

Shipped: two new sparse GSIs (replace the three Scans with targeted Queries) + DynamoDB TTL enabled on the table (stops unbounded growth going forward). Both deployed. Estimated DynamoDB run-rate: **~$94–120/mo (unfixed, climbing) → ~$30–45/mo (post-fix)**, total AWS bill **~$260–285/mo → ~$190–210/mo**. Not yet confirmed against real billing data — see "How to check back" below.

## The investigation (how we got here)

1. Table check (`aws dynamodb describe-table`): 86,565 items, 57.4 MB base table + 48.4 MB in the pre-existing `queue-index` GSI. Storage/PITR cost from this is negligible (~$0.10/mo) — **not** the driver.
2. CloudWatch operation counts, Aug 1 → Aug 10 MTD: GetItem 259K, PutItem 134K, UpdateItem 255K, **Query 1.03M, Scan 1.12M**. Scan+Query = 77% of all requests.
3. Consumed capacity: ~235M RCU (reads) vs ~608K WCU (writes) — a ~380x skew. This is a read problem, not a write/ingestion problem.
4. `ReturnedItemCount` for Scan, summed: **4,766 items returned across 1.12M Scan calls.** The overwhelming majority of Scans examined data and returned nothing — DynamoDB bills for items *examined*, not items *matched*.
5. Traced the call sites: `handleSweeper()` (`src/handlers/api.ts`, fired every 2 min by `QMSchedulerStack`) calls, every tick:
   - `reclaimExpiredLeases()` — full Scan for expired `LEASE#` items
   - `reconcileCounter()` — full Scan for live `LEASE#` items (redundant with the one above — same prefix, different filter)
   - `expireStaleReservations()` → `listActiveReservations()` — full Scan for active `RESERVATION#` items
   - `reclaimExpired()` + `runProvisioner()`'s `scanQueuedCanonicalJobsByLane` — paginated Queries against `queue-index`, ×2 lanes each
6. Math check: 3 Scan-type ops × ~54 pages (57MB / ~1MB page) × 720 ticks/day × 9.16 days ≈ 1.07M — matches the observed 1.12M Scan calls closely. Confirmed as the dominant driver.
7. Grepped the whole codebase for `DeleteItemCommand`: **zero hits, anywhere.** Every `JobItem`, `LeaseItem` (even after being marked `deleted`), and `ReservationItem` ever written has been sitting in the table since June. Only `ProviderTaskItem` had a `ttl` field set (`executor.ts`) — but the table's `TimeToLiveSpecification` was never actually enabled in CDK, so even that was inert.
8. User confirmed ~100 projects generated MTD — the CRUD volume (GetItem+PutItem+UpdateItem ≈ 648K, ~6,489/project) roughly matches that. The Scan/Query volume does **not** — it's a fixed-cadence cron cost that scales with table size, independent of project count.

## What shipped (2026-08-10)

### New sparse GSIs (`infra/lib/database-stack.ts`)
- **`lease-index`**: partition key `sk` (always `'LEASE'` for `LeaseItem`), sort key `leaseExpiry` (number). Only lease records have both attributes, so this index only ever contains currently-relevant leases.
- **`reservation-status-index`**: partition key `sk` (`'META'` for both `ReservationItem` and the lightweight `RESERVATIONREQ#` pointer record), sort key `status` (string — only `ReservationItem` sets it, so the pointer records are naturally excluded).

Both are sparse by construction: an item only appears in a GSI if it has *every* attribute in that GSI's key schema.

### Code changes (Scan → Query)
- `src/gate/dynamo-gate.ts`: `reclaimExpiredLeases()` and `reconcileCounter()` rewritten to Query `lease-index` (`sk = 'LEASE' AND leaseExpiry <` / `>= now`) instead of scanning the whole table.
- `src/gate/reservation-gate.ts`: `listActiveReservations()` rewritten to Query `reservation-status-index` (`sk = 'META' AND status = 'active'`) instead of scanning the whole table.

### TTL (stops unbounded growth)
- `timeToLiveAttribute: 'ttl'` enabled on the table.
- `JobItem` (`api.ts`, the highest-volume item type — one per rung/frame/language) now sets `ttl = now + 30 days` at creation.
- `LeaseItem` (`dynamo-gate.ts`, both `acquireSimple` and `acquire`) now sets `ttl = now + 24h`, deliberately decoupled from `leaseExpiry`/heartbeat extension so an actively-heartbeated lease can never be prematurely deleted — this is a backstop for rows already marked `deleted` by the sweeper, not lease-lifetime enforcement.
- `ReservationItem` + its `RESERVATIONREQ#` pointer (`admission.ts`, `reservation-gate.ts`) now set `ttl = expiresAt + 7 days`.
- `ProviderTaskItem`'s pre-existing `ttl` (24h) now actually takes effect for the first time.

### Deploy notes
- DynamoDB rejects more than one GSI create/delete per table update, so `QMDatabaseStack` was deployed in **two passes**: `lease-index` + TTL first, then `reservation-status-index` after confirming the first GSI reached `ACTIVE`.
- `QMApiStack` (ships the Query-based Lambda code) was deployed after both GSIs were `ACTIVE`, with `-c WEBHOOK_BASE_URL=https://d3uk3xx3c9iu7t.cloudfront.net` (see `qm-webhook-base-url-deploy-gotcha` memory — omitting this silently breaks webhook completions fleet-wide).
- Post-deploy: three consecutive sweeper ticks checked in CloudWatch Logs, all clean, no errors.

## What's NOT fixed (known gap)

The `queue-index` GSI Query traffic (~1.03M requests MTD, from `reclaimExpired()` and the provisioner's `scanQueuedCanonicalJobsByLane`) was **not** touched by this change. It still pages through a GSI holding all 40,833+ historical job records, because:
- Existing `JobItem` records (created before 2026-08-10) have no `ttl` — only new ones do. Nothing was backfilled.
- Even for new records, TTL deletion won't kick in for ~30 days post-creation.

So this half of the Scan/Query cost will only start improving gradually over the next month, and only fully resolves once the pre-existing backlog is separately purged or backfilled with a `ttl`. If the post-fix numbers below come in higher than expected, this is the next thing to fix — either backfill `ttl` onto the historical backlog, or give `reclaimExpired()`/the provisioner a status-scoped sparse index the same way `lease-index`/`reservation-status-index` were built.

## Projected impact (unconfirmed — see verification steps)

| | Unfixed trajectory | Post-fix estimate |
|---|---|---|
| DynamoDB | ~$94–120/mo (climbing as table grows) | ~$30–45/mo |
| Everything else | ~$166/mo at current pace | ~$155–166/mo (Lambda should also drop — sweeper ticks were 6.3s+, mostly spent in the eliminated Scans) |
| **Total** | **~$260–285/mo** | **~$190–210/mo** |

This is order-of-magnitude reasoning from request-count and byte-volume splits, not a guarantee — AWS Cost Explorer doesn't break DynamoDB cost down by operation type, so there's no way to verify precisely without watching real post-deploy data.

## How to check back (~2026-08-12 or later)

1. **CloudWatch operation counts** — rerun the same query used during the investigation and compare Scan/Query counts against the pre-fix baseline (Scan 1.12M / Query 1.03M over the Aug 1–10 window):
   ```
   aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB \
     --metric-name SuccessfulRequestLatency \
     --dimensions Name=TableName,Value=quartermaster-jobs Name=Operation,Value=Scan \
     --start-time <deploy-time> --end-time <now> --period 86400 --statistics SampleCount
   ```
   Expect Scan to have collapsed close to zero; Query to be roughly unchanged (see "known gap" above) unless it's also been addressed by then.
2. **Cost Explorer** — pull the same per-service CSV export used at the start of this investigation and compare the DynamoDB line's daily run-rate before/after 2026-08-10.
3. **Table size** — `aws dynamodb describe-table --table-name quartermaster-jobs` — `ItemCount`/`TableSizeBytes` should be flat or slowly declining (TTL deletes), not still climbing.
4. **Sweeper Lambda duration** — CloudWatch Logs `REPORT` lines for `quartermaster-api` should show sub-second-to-low-second billed duration on `/sweeper` invocations, down from the pre-fix 6.3s+.

If the numbers land close to the estimate, close this out. If DynamoDB cost is still meaningfully elevated, the `queue-index` gap above is the most likely remaining cause.
