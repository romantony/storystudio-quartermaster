# Quartermaster — Multi-Provider Asset-Generation Gateway (Implementation Guide)

**Name:** **Quartermaster** (codename `qm`) — it *allocates scarce supplies*
(provider slots, GPU workers, credits) and routes every generation request to the
right provider, which is exactly this system's job. (Check npm/PyPI/domain/trademark
before locking externally.)
**Status:** Design / implementation proposal
**Audience:** Backend engineers on StoryStudio and the Remotion documentary pipeline
**Reference:** https://docs.modelslab.com/rate-limits — plan: **Unlimited Premium**

> **Scope.** This is **not** a ModelsLab-only or Remotion-only system. It is a
> **central, multi-product, multi-provider asset-generation gateway** serving
> StoryStudio (Narration / Documentary / Movie, each Basic + Premium) *and* the
> Remotion documentary pipeline. ModelsLab is the **primary** provider for
> Narration/Documentary; Movie tiers and some premium assets call other providers
> (Replicate, Kie, Google, Anthropic, OpenAI) directly. The queue, per-provider
> rate-limiter, FIFO, and failover machinery (§21–§27) are **provider-agnostic**;
> all the product-specific model choices live in one place — the **Capability
> Catalog (§28)**.

---

## Table of contents

**Concept & rationale**
1. [The problem in one paragraph](#1-the-problem-in-one-paragraph)
2. [What the ModelsLab limit actually is](#2-what-the-modelslab-limit-actually-is-and-why-it-shapes-the-design)
3. [Where ModelsLab is called today](#3-where-modelslab-is-called-today-the-surfaces-to-migrate)
4. [Architecture](#4-architecture) · 5. [Core data model (Redis/Valkey)](#5-core-data-model-redis) · 6. [Permit lifecycle](#6-the-permit-lifecycle)
7. [Fairness & prioritization](#7-fairness--prioritization) · 8. [Atomic acquire/release (Lua)](#8-the-atomic-acquirerelease-lua-sketch) · 9. [Handling 429](#9-handling-modelslabs-own-429-defense-in-depth)
10. [Caching & dedupe](#10-caching--dedupe-keep-and-elevate-to-shared) · 11. [Client SDK surface](#11-client-sdk-surface-typescript--python) · 12. [Observability](#12-observability-you-cannot-tune-what-you-cannot-see)
13. [Failure modes](#13-failure-modes--how-the-design-handles-them) · 14. [Configuration](#14-configuration) · 15. [Rollout plan](#15-rollout-plan) · 16. [Summary of key decisions](#16-summary-of-the-key-decisions)

**Empirical & capacity**
17. [Benchmark & the 8/7 video reservation](#17-empirical-benchmark--the-8-for-video--7-for-rest-reservation)
18. [Multi-provider routing](#18-multi-provider-routing-modelslab--backgroundvideo-replicate--kie--foreground)
19. [Resources & cost to operate](#19-resources-required--cost-to-operate)
20. [Consumption metering & attribution](#20-consumption-metering--attribution-per-model--platform--project--request)

**Phase 1 implementation path (DynamoDB-first) — START HERE to build**
21. [Phased delivery: DynamoDB → Valkey](#21-phased-delivery-phase-1-dynamodb-orchestration--phase-2-valkey)
22. [Avoiding Lambda timeout (SFN + SQS/EventBridge roles)](#22-avoiding-lambda-timeout-step-functions-callbacks--the-real-roles-of-sqs--eventbridge)
23. [Slim job payloads](#23-slim-job-payloads-dont-pass-the-whole-project-json)
24. [**Lean DynamoDB-only FIFO**](#24-lean-variant-dynamodb-only-fifo-no-sqs-no-event-bus)
25. [Scaling: table + endpoint + limiter per service class](#25-scaling-out-a-separate-table--endpoint--limiter-per-service-class)
26. [Generation failure handling](#26-generation-failure-handling)
27. [Provider failover & circuit breaking](#27-provider-failover--circuit-breaking--keep-generating-through-an-endpoint-outage)
28. [Capability Catalog + provider adapters](#28-capability-catalog--provider-adapters-the-single-place-to-change-providers)
29. [**Implementation appendix** — catalog seed, adapter stubs, Step Functions ASL, webhook ingress](#29-implementation-appendix-for-a-separate-repo)
30. [Admin dashboard (catalog, keys, cost & balance)](#30-admin-dashboard-catalog-keys-cost--balance)
31. [Coexistence & launch model (strangler-fig, MCP routing, free/premium credits)](#31-coexistence--launch-model)

> ### How to read this doc (important)
> The doc evolved from a ModelsLab-only limiter into a **multi-provider gateway**,
> so it has two layers:
> * **§1–§20 — concept & rationale.** These frame the problem in Redis/Valkey
>   terms (the eventual **Phase 2** state). Read for the *why*. Where they show
>   Redis Lua (§5–§8), the **Phase-1 DynamoDB equivalents** are §24.1 / §29.1.
> * **§21–§30 — the build.** This is the implementation path. **To start coding,
>   read §24 (lean DynamoDB-only FIFO) → §29 (catalog seed, adapters, Step
>   Functions, webhook) → §30 (admin dashboard), with §26–§28 for failure,
>   failover, and the catalog.**
>
> **Authoritative artifacts** (when sections overlap, these win):
> * Request contract → **§29.2 `CanonicalJob`** (supersedes the §7.3 acquire sketch
>   and the §11 SDK example, which are illustrative of the *why*, not the wire shape).
>   Priority interacts with the catalog ladder per **§28.4.1**.
> * Catalog → **§29.1 `catalog.json`**.
> * Concurrency model → **per-provider semaphore with video/rest floors** (§17.4,
>   §24.1); `lane` (video/rest) is the *within-provider* floor, while priority
>   `P0/P1/P2` (§7,§18,§25) selects the *provider/table*. They are complementary.

---

## 1. The problem in one paragraph

We share **one ModelsLab account** (one API key) across multiple independent
producers: StoryStudio (several project types) and the Remotion documentary
pipeline (many users, both foreground/interactive and background/batch jobs).
Every one of these calls ModelsLab for **LLM text, image, image-to-image, TTS,
SFX, and video** generation. ModelsLab's Premium plan enforces a **global
account-wide concurrency cap of 15 queued requests**. Today each caller hits
ModelsLab directly with no shared awareness of how many requests are already in
flight, so under load we collide on the cap, get HTTP `429`s, fail renders, and
have no fairness — one big background batch can starve an interactive user. We
need a **single central authority** that all producers go through, which keeps
the global in-flight count under the cap, shares the budget fairly, and degrades
gracefully.

---

## 2. What the ModelsLab limit actually is (and why it shapes the design)

From the rate-limits page, for our **Premium** plan:

| Property | Value / behaviour |
|---|---|
| Limit type | **Concurrency / queue depth**, *not* requests-per-minute |
| Premium cap | **15 queued API requests** |
| Scope | **Per account, across ALL endpoints and models** (LLM + image + voice + video share one pool) |
| Ordering | FIFO — requests processed in queue order |
| Over-limit response | HTTP **`429`** with a **`retry_after`** field |
| Above 15 | Requires enterprise contract |

Three consequences drive the whole design:

1. **It's a semaphore, not a token-bucket.** The right primitive is a
   **distributed semaphore of size N** (a fixed number of permits), *not* a
   rate limiter measured in requests/second. We borrow a permit before calling
   ModelsLab and return it when the job is done.

2. **The pool is shared across every endpoint.** A video job, an SFX job, and
   an LLM call all consume from the same 15. The system must be **endpoint-agnostic**
   — one global pool, not one pool per API.

3. **ModelsLab generation is asynchronous.** We submit a job, get an `id`, then
   poll `.../fetch`. The job occupies a slot in ModelsLab's queue for its
   **entire lifetime** (submit → processing → output ready), which for video can
   be minutes. Therefore **a permit must be held for the whole job lifetime, not
   just the HTTP submit call.** This is the single most important correctness
   rule.

> **Headroom.** We never target exactly 15. ModelsLab counts our polling/fetch
> traffic and there is measurement skew between our view and theirs. Configure a
> **`SAFE_LIMIT` of 12** (≈80% of 15) and tune from telemetry. The remaining
> slack absorbs in-flight races and lets `retry_after`-driven retries land.

---

## 3. Where ModelsLab is called today (the surfaces to migrate)

Quartermaster must front every existing call site. Current direct callers:

| Code | Endpoint(s) | Type |
|---|---|---|
| `aws_lambda/doc_lambda/handlers/script_generator.py` (`_modelslab_chat`) | `api/v7/llm/chat/completions` | LLM text |
| `aws_lambda/doc_lambda/asset_pipeline.py` | `v7 text-to-image`, `v6 text2img` (qwen), `v7 image-to-image`, `v6 images/fetch`, `v7 voice/text-to-speech`, `v6 video/img2video_ultra`, `v6 video/fetch`, `v7 llm/chat` | image / i2i / TTS / video |
| `aws_lambda/doc_lambda/handlers/sfx_gen.py` | `v6 voice/sfx`, `v6 voice/fetch` | SFX |
| `scripts/render-request.ts` (`generateModelsLabSfx`, `fetchModelsLabSfxResult`) | `v6 voice/sfx`, `v6 voice/fetch` | SFX |

Note the existing local-only mitigations we will replace/augment:
`sfxRunCache` (in-process dedupe map) and the per-handler poll loops
(`MODELSLAB_MAX_POLL_ATTEMPTS`). These are correct in spirit but **per-process**
— they have no idea what other processes/Lambdas/users are doing. The central
system makes that awareness global.

---

## 4. Architecture

### 4.1 Two viable shapes

**Pattern A — Proxy gateway.** A service sits *in the request path*: callers POST
the generation request to Quartermaster, Quartermaster forwards to ModelsLab, owns
the polling, and returns the result (or a webhook). Maximum control (it's the
only thing holding the key), but it must understand every endpoint's payload and
hold long connections for minutes-long video jobs.

**Pattern B — Permit broker (recommended).** A small central service exposes only
`acquire` / `release` / `heartbeat`. Callers ask Quartermaster for a **lease**, then
call ModelsLab **directly** (as they do today), then release the lease. The
broker only owns the **distributed semaphore + fair queue**, not the payloads.

We recommend **Pattern B**: it's minimally invasive (existing code keeps its
ModelsLab payload logic), it's trivially language-portable (we have both
**TypeScript** and **Python** callers), and it keeps Quartermaster tiny and
endpoint-agnostic. Pattern A can be layered on later for the highest-value
endpoints if we want a single key vault.

```
                 ┌──────────────────────────────────────────────┐
                 │            ModelsLab Rate-Limit Broker         │
   StoryStudio ─▶│   (stateless service; Redis-backed semaphore)  │
   (proj types)  │                                                │
                 │   acquire(tenant,priority,endpoint,estDur) ──▶ │
   Remotion   ─▶ │   release(leaseId)                             │
   foreground    │   heartbeat(leaseId)                           │
                 │                                                │
   Remotion   ─▶ │        ┌───────────────┐                      │
   background    │        │     Redis      │  permits + queues    │
                 │        └───────────────┘                      │
                 └───────────────────┬──────────────────────────┘
                                     │ (after lease granted)
   each caller ──────────────────────┴────────────▶  ModelsLab API
                            (direct, holds lease for full job life)
```

### 4.2 Why Redis/Valkey

The state is tiny (a counter-set plus per-tenant wait queues) but must be
**atomic across many processes/Lambdas**. A Redis-protocol store with **Lua
scripts** gives us atomic compare-and-grant in one round trip. **Recommended
engine: ElastiCache for Valkey** — the Redis 7.2 open-source fork, wire- and
command-compatible (same Lua, ZSET, `INCR`/`DECR`, Pub/Sub), AWS's supported
default, and ~20% cheaper than Redis OSS (see §19.2). Everywhere this doc says
"Redis," read "Redis-protocol store (Valkey)"; existing clients work unchanged.
Quartermaster processes are **stateless** and horizontally scalable — all truth
lives in the store.

---

## 5. Core data model (Redis)

```
modelslab:cfg:safe_limit         -> int (effective permit count, mutable; AIMD adjusts it)
modelslab:permits:active         -> ZSET  member=leaseId           score=lease_expiry_epoch_ms
modelslab:lease:<leaseId>        -> HASH  {tenant, priority, endpoint, acquired_at, job_id?}
modelslab:wait:<priority>        -> ZSET  member=waiterId          score=enqueue_epoch_ms (FIFO within tier)
modelslab:tenant_inflight:<tid>  -> int   (for per-tenant fairness cap)
modelslab:stats:429              -> sliding counter (for adaptive throttle)
```

* **`permits:active` is the semaphore.** `ZCARD` = current global in-flight count.
  Members are scored by **expiry**, so a crashed caller's permit is auto-reclaimed
  by sweeping `ZREMRANGEBYSCORE active -inf now` — this is the **leak guard**.
* **`wait:<priority>`** are the queues callers sit in when no permit is free.
* **`tenant_inflight`** enforces "no single tenant may hold more than X% of the
  pool" so fairness holds even before anyone has to wait.

---

## 6. The permit lifecycle

```
acquire ─▶ [granted lease]  ─▶ submit job to ModelsLab ─▶ poll fetch (heartbeat) ─▶ output ready
   │                                                                                     │
   └─(no permit)─▶ enqueue + wait/retry-after ─▶ (woken when slot frees) ─▶ granted      ▼
                                                                                     release
```

**Rules:**

1. **Acquire before submit.** Never call a ModelsLab *generation* endpoint
   without a granted lease.
2. **Hold for the full job.** Keep the lease through submission **and** the entire
   poll-until-ready loop. Release only on terminal success **or** terminal failure.
3. **Heartbeat long jobs.** Lease TTL is finite (leak protection). For long jobs
   (video, big batches) send `heartbeat(leaseId)` on each poll iteration to extend
   the lease. If a caller dies, heartbeats stop, the lease expires, the slot
   returns to the pool automatically.
4. **Always release in `finally`.** Release on success, on error, and on
   timeout. The TTL is a safety net, not the primary mechanism.
5. **Polling/fetch calls do not take a *new* permit** — they ride under the
   already-held lease (they belong to the same job). Set `SAFE_LIMIT` with enough
   headroom to absorb the fetch traffic ModelsLab does count.

### TTL guidance per endpoint (starting points, tune from data)

| Endpoint class | Typical duration | Lease TTL | Heartbeat |
|---|---|---|---|
| LLM chat | seconds | 60s | not needed |
| Image / i2i | 5–30s | 90s | optional |
| TTS | 5–30s | 90s | optional |
| SFX | 5–30s | 90s | optional |
| Video (img2video) | 1–5 min+ | 120s, extended by heartbeat | **required**, every poll |

---

## 7. Fairness & prioritization

A single global FIFO is *not* enough — a 200-scene background batch would fill the
queue ahead of a user waiting on one interactive image. We use **priority tiers
with round-robin fairness within a tier**, plus a **per-tenant in-flight cap**.

### 7.1 Priority tiers

| Tier | Who | Example |
|---|---|---|
| **P0 — interactive** | a human is actively waiting | StoryStudio editor preview, Remotion Studio foreground regen |
| **P1 — foreground job** | user-initiated full generation, user expects it "soon" | a user clicks "Generate documentary" |
| **P2 — background batch** | scheduled / bulk / non-urgent | nightly batch, large multi-video series prep |

Dispatch order: drain **P0** before **P1** before **P2**. To prevent starvation
of P2 under sustained P0/P1 load, **reserve a floor** (e.g. at least 2 of 12
permits are always eligible for P2). Configurable.

### 7.2 Fairness within a tier (and per-tenant cap)

* **Round-robin / deficit scheduling across `tenant` keys** within a tier so two
  users at the same priority alternate rather than one draining first.
* **Per-tenant in-flight cap**: no single `tenant` may hold more than, say,
  `ceil(SAFE_LIMIT * 0.5)` permits at once. A `tenant` is the natural fairness
  unit — recommend `tenant = "{product}:{project_or_user_id}"`, e.g.
  `storystudio:proj_123` or `remotion:user_abc`. Background jobs can use a
  coarser tenant so they collectively share one slice.

### 7.3 Acquire call contract

```
acquire(
  tenant:     str,   # fairness unit, e.g. "remotion:user_abc"
  priority:   P0|P1|P2,
  endpoint:   str,   # "llm" | "image" | "i2i" | "tts" | "sfx" | "video" (telemetry + TTL)
  est_dur_ms: int,   # hint for TTL selection
) -> { granted: bool, leaseId?: str, retryAfterMs?: int, position?: int }
```

Two client modes, both supported:

* **Long-poll / blocking** (best for interactive): Quartermaster holds the request
  open until a permit frees or a timeout, then returns `granted`.
* **Poll + `retryAfterMs`** (best for Lambda/batch): broker returns immediately
  with `retryAfterMs`; caller sleeps and retries. This mirrors how the code
  already handles ModelsLab's own `retry_after`.

---

## 8. The atomic acquire/release (Lua sketch)

Atomicity is the whole game. Do the reclaim-check-grant in **one** Lua script so
two callers can't both see "14 in flight" and both grant.

```lua
-- ACQUIRE  KEYS[1]=active  ARGV: now, ttl, safe_limit, leaseId, tenant, tenant_cap, tenant_inflight_key
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])          -- reclaim expired leases
local inflight = redis.call('ZCARD', KEYS[1])
local tenant_inflight = tonumber(redis.call('GET', ARGV[7]) or '0')
if inflight < tonumber(ARGV[3]) and tenant_inflight < tonumber(ARGV[6]) then
  redis.call('ZADD', KEYS[1], ARGV[1] + ARGV[2], ARGV[4])         -- grant: add lease scored by expiry
  redis.call('INCR', ARGV[7])                                     -- bump tenant in-flight
  return {1, ARGV[4]}                                             -- granted, leaseId
end
return {0}                                                        -- not granted -> caller enqueues/retries
```

```lua
-- RELEASE  KEYS[1]=active  ARGV: leaseId, tenant_inflight_key
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
if removed == 1 then redis.call('DECR', ARGV[2]) end             -- only if we actually held it
return removed
```

```lua
-- HEARTBEAT  KEYS[1]=active  ARGV: now, ttl, leaseId
-- extend expiry only if the lease still exists (GT avoids resurrecting a reclaimed lease)
return redis.call('ZADD', KEYS[1], 'GT', 'XX', ARGV[1] + ARGV[2], ARGV[3])
```

The **dispatcher** (waking waiters when a slot frees) can be: (a) callers
self-poll their `wait` queue position, or (b) a broker loop that pops the
highest-priority eligible waiter on each release and notifies via pub/sub. Start
with **self-poll + `retryAfterMs`** (simplest, stateless, Lambda-friendly);
add pub/sub long-poll for P0 interactivity if latency demands it.

---

## 9. Handling ModelsLab's own 429 (defense in depth)

Even with `SAFE_LIMIT < 15`, we can still occasionally see ModelsLab `429`s
(clock skew, the fetch traffic they count, other tools sharing the key). So
**callers must still handle 429**, and Quartermaster should **adapt**:

1. **Respect `retry_after`.** On a 429 from ModelsLab, the caller sleeps for the
   returned `retry_after` (with jitter) and retries the *same* lease — it does
   **not** release and re-acquire (it still legitimately owns a slot).
2. **Report 429s to Quartermaster** (`stats:429`). Quartermaster runs **AIMD** on
   `cfg:safe_limit`:
   * On a burst of 429s → **multiplicatively decrease** `safe_limit` (e.g. ×0.75,
     floor 4) to back off the whole fleet.
   * After a quiet period → **additively increase** back toward 12 (e.g. +1 per
     interval).
   This makes the global budget self-tuning against whatever ModelsLab actually
   enforces, including capacity shared with other tools on the same key.
3. **Exponential backoff with jitter** on retries; cap total attempts; surface a
   clean terminal error to the caller (don't hang a render forever).

---

## 10. Caching & dedupe (keep and elevate to shared)

The cheapest ModelsLab request is the one you don't make — directly extends our
effective concurrency. The codebase already does this locally; make it global:

* **Result cache.** `sfx_gen.py` already caches SFX in S3 by
  `stable_hash("modelslab","sfx",cue,prompt,duration)` and checks before
  generating. Generalize this content-hash cache to **all** endpoints (image,
  i2i, TTS, LLM where deterministic) so a cache hit **never acquires a permit**.
* **In-flight dedupe across processes.** `sfxRunCache` in `render-request.ts`
  dedupes concurrent identical requests *within one process*. Promote this to a
  **Redis single-flight lock** keyed by the same content hash: the first caller
  generates, concurrent callers wait on the result. This prevents N users
  requesting the same asset from burning N permits.

**Order of operations per request:** cache-check → single-flight lock →
`acquire` permit → submit + poll (+heartbeat) → store in cache → `release`.

---

## 11. Client SDK surface (TypeScript + Python)

Provide thin wrappers so call sites change minimally. Sketch:

```ts
// modelslabBroker.ts
const lease = await broker.acquire({
  tenant: `remotion:${userId}`,
  priority: isForeground ? "P1" : "P2",
  endpoint: "sfx",
  estDurationMs: 30_000,
});
try {
  const job = await submitToModelsLab(payload);            // existing logic
  const result = await pollUntilReady(job, () => broker.heartbeat(lease.id)); // existing poll loop, now heartbeats
  return result;
} finally {
  await broker.release(lease.id);                           // always
}
```

```python
# modelslab_broker.py
lease = broker.acquire(tenant=f"remotion:{user_id}", priority="P2",
                       endpoint="image", est_duration_ms=30_000)
try:
    job = submit_to_modelslab(payload)                      # existing logic
    result = poll_until_ready(job, heartbeat=lambda: broker.heartbeat(lease.id))
    return result
finally:
    broker.release(lease.id)
```

The wrapper hides acquire-retry/backoff, heartbeat scheduling, and 429 reporting,
so individual call sites (`_modelslab_chat`, `generateModelsLabSfx`,
`asset_pipeline` image/TTS/video helpers) just wrap their existing body.

---

## 12. Observability (you cannot tune what you cannot see)

Emit metrics from Quartermaster and SDKs:

* **`modelslab.inflight`** (gauge) — `ZCARD active`; alert when sustained near `SAFE_LIMIT`.
* **`modelslab.safe_limit`** (gauge) — current AIMD value; if it sits low, ModelsLab is pushing back.
* **`modelslab.queue_depth`** per priority/tenant; **`modelslab.wait_ms`** histogram.
* **`modelslab.429_total`**, **`modelslab.permit_timeouts`**, **`modelslab.leases_reclaimed`** (a leak/crash signal).
* **`modelslab.permit_hold_ms`** per endpoint — to calibrate TTLs.
* **`modelslab.cache_hit_ratio`** — directly measures pressure relief.

A small dashboard: in-flight vs safe_limit over time, queue depth by tier, 429
rate, p50/p95 wait time. These tell you whether to push for an enterprise cap.

---

## 13. Failure modes & how the design handles them

| Failure | Handling |
|---|---|
| Caller crashes mid-job | Lease TTL expires → `ZREMRANGEBYSCORE` reclaims the slot; heartbeat stops naturally |
| Caller forgets to release | Same TTL reclaim; `permit_hold_ms`/`leases_reclaimed` flags the offender |
| Redis unavailable | **Fail-safe choice:** prefer *closed* (block/queue) for batch to protect the cap; allow a **degraded local fallback** (small per-process semaphore) for P0 so interactive work isn't fully down. Make this an explicit config switch. |
| Broker restarts | Stateless — state is in Redis; resumes cleanly |
| ModelsLab returns 429 anyway | Caller backs off on `retry_after`; broker AIMD-lowers `safe_limit` |
| Other tools share the key | AIMD naturally cedes budget; consider a separate broker namespace per key if keys are split later |
| Long video job exceeds TTL | Heartbeat extends; if heartbeats stop, slot reclaimed (correct — job is presumed dead) |
| Double-release / release of foreign lease | `ZREM` returns 0 → no-op; `DECR` guarded on actual removal |

---

## 14. Configuration

All values below are grounded in the §17 benchmark (lease TTLs ≈ 3–4× measured
avg + buffer). Tune from production telemetry.

```ini
# ---- shared state ----
RLB_REDIS_URL=rediss://...                # the only required shared resource (§19)

# ---- ModelsLab pool: background + ALL video (§17, §18) ----
MODELSLAB_PLAN_LIMIT=15                    # hard ceiling from the Premium plan
MODELSLAB_SAFE_LIMIT=15                    # effective budget; lower to 12 if 429s appear
MODELSLAB_SAFE_LIMIT_MIN=6                 # AIMD floor under sustained 429s
MODELSLAB_VIDEO_FLOOR=8                    # guaranteed video slots (work-conserving)
MODELSLAB_REST_FLOOR=7                     # guaranteed image/tts/sfx/llm slots
MODELSLAB_REST_INTRA_PRIORITY=image,i2i,tts,sfx,llm   # image first: it feeds video (§17.2)
MODELSLAB_VIDEO_WINS_CONTENTION=true      # freed slot -> video first when video waiting

# lease TTLs (ms) — from measured submit->ready: video 40s, sfx 16s, i2i 14.5s,
# image 12.4s, llm 3.5s, tts 2.6s
MODELSLAB_LEASE_TTL_MS_VIDEO=120000
MODELSLAB_LEASE_TTL_MS_SFX=60000
MODELSLAB_LEASE_TTL_MS_IMAGE=60000
MODELSLAB_LEASE_TTL_MS_I2I=60000
MODELSLAB_LEASE_TTL_MS_LLM=60000
MODELSLAB_LEASE_TTL_MS_TTS=30000
MODELSLAB_HEARTBEAT_INTERVAL_MS=20000     # safety net; only video can outlive its TTL under load
MODELSLAB_ACQUIRE_TIMEOUT_MS=180000       # max a caller waits for a slot before erroring

# defense-in-depth (§9): honour ModelsLab's own retry_after + AIMD
MODELSLAB_RETRY_MAX_ATTEMPTS=5
MODELSLAB_AIMD_DECREASE=0.75              # ×0.75 on 429 burst
MODELSLAB_AIMD_INCREASE_PER_MIN=1        # +1/min recovery toward SAFE_LIMIT

# ---- foreground / priority pools: Replicate + Kie (§18) ----
REPLICATE_SAFE_LIMIT=20                   # start conservative; AIMD-tune from Replicate 429s
KIE_SAFE_LIMIT=10                         # per Kie account limits
FOREGROUND_PROVIDER_ORDER=replicate,kie   # pick lowest live queue depth, fail over

# ---- routing (§18.2) ----
ROUTE_FOREGROUND_PROVIDERS=replicate,kie  # P0/P1
ROUTE_BACKGROUND_PROVIDER=modelslab       # P2 + all video

# ---- resilience ----
RLB_FAIL_MODE_BACKGROUND=closed           # if Redis down, block batch (protect the cap)
RLB_FAIL_MODE_FOREGROUND=local_fallback   # degraded per-process semaphore for interactive
```

**Note on the floors:** `VIDEO_FLOOR + REST_FLOOR == SAFE_LIMIT`. If you drop
`SAFE_LIMIT` to 12 for headroom, rescale the floors (e.g. 7 video / 5 rest, or
keep 8/4) — the §17.4 acquire rule only requires the two floors to sum to the
effective limit.

---

## 15. Rollout plan

1. **Phase 0 — Broker + SDKs, shadow mode.** Stand up Quartermaster and Redis. Add
   TS/Python SDKs. Wire `acquire/release` into call sites but with
   `SAFE_LIMIT=15` and metrics only (no blocking) to gather real `permit_hold_ms`
   and concurrency distributions.
2. **Phase 1 — Enforce on SFX first.** SFX already has the cache + dedupe pattern
   (`sfx_gen.py`, `render-request.ts`), so it's the lowest-risk first enforcement
   point. Drop `SAFE_LIMIT` to 12, turn on blocking, validate fairness.
3. **Phase 2 — Roll to LLM, image/i2i, TTS** (`script_generator._modelslab_chat`,
   `asset_pipeline` helpers).
4. **Phase 3 — Video last** (longest leases, needs heartbeat correctness proven).
5. **Phase 4 — Global single-flight cache** across all endpoints; enable AIMD;
   tune tiers, tenant cap, and reserved P2 floor from dashboards.
6. **Phase 5 — (optional) Proxy mode / key vault** for the highest-value
   endpoints, and a data-backed case for an enterprise cap if `inflight` is
   pinned at `SAFE_LIMIT` with deep queues.

---

## 16. Summary of the key decisions

* Model the limit as a **distributed semaphore of size `SAFE_LIMIT≈12`**, shared
  across **all** endpoints — because the plan limit is account-wide concurrency,
  not per-endpoint RPM.
* **Hold one permit for the entire async job lifetime** (submit → poll → ready),
  protected by **lease TTL + heartbeat** so crashes can't leak slots.
* Use a **Quartermaster as a permit broker (Pattern B)** so existing TS/Python call sites
  keep their payload logic and just wrap acquire/heartbeat/release.
* Make it fair with **priority tiers (P0 interactive > P1 foreground > P2 batch)**,
  **round-robin per-tenant**, a **per-tenant in-flight cap**, and a **reserved
  P2 floor**.
* **Defense in depth:** still honour ModelsLab's `retry_after`, and let Quartermaster
  **AIMD-tune `safe_limit`** from the live 429 rate.
* **Relieve pressure** by promoting the existing local cache/dedupe
  (`sfxRunCache`, S3 SFX cache) to a **global content-hash cache + single-flight**
  so cache hits never consume a permit.

---

## 17. Empirical benchmark & the 8-for-video / 7-for-rest reservation

> Measured by `scripts/modelslab_bench.py` and `scripts/modelslab_bench_video.py`
> against the live Premium account, using the **exact production payloads**. Each
> number is **submit → output-ready** wall time = the **permit-hold duration**
> (download excluded; it holds no slot). Runs were **single-flight / unloaded**,
> so these are best-case per-job times; real concurrency adds ModelsLab-side
> queue wait, which is exactly what `SAFE_LIMIT` headroom absorbs.

### 17.1 Measured latency (n=2–3 each)

| Endpoint | Model | Avg | Range | Jobs/min per slot |
|---|---|---|---|---|
| TTS | `inworld-tts-1` | **2.6s** | 2.6–2.7 | ~23 |
| LLM | `google-gemini-2.5-flash` | **3.5s** | 2.6–4.0 | ~17 |
| Image (t2i) | `gemini-3.1-t2i` | **12.4s** | 12.0–12.7 | ~4.8 |
| Image (i2i) | `gemini-3.1-i2i` | **14.5s** | 14.0–15.1 | ~4.1 |
| SFX | `sfx` | **16.0s** | 15.9–16.1 | ~3.8 |
| **Video (i2v)** | `wan-2.2-i2v` 480p/82f | **40.3s** | 33.8–43.9 | **~1.5** |

**Headline finding:** video is the slowest stage but only by ~2.5× over SFX/image
— **~40s, not minutes**. That makes a video-favoring reservation cheap to satisfy.

> Polling caveat discovered while benchmarking: the video `fetch` can return a
> bare `{"status":"processing","message":"Try Again","output":""}` with **no
> `id`/`request_id`**. You must **persist the `request_id` from the *initial*
> submit response** and reuse it on every `video/fetch` poll (production
> `_modelslab_i2v_poll` already does this; the generic poller must too).

### 17.2 Does 8/7 keep the video pipeline saturated? — Yes, comfortably

Pipeline fact: **image → then video** (i2v needs the image first). So video's only
hard upstream dependency is image generation; TTS/SFX/LLM are for the final audio
mux and **do not block** video gen.

* **Video throughput at 8 slots** = 8 ÷ 40.3s = **~11.9 videos/min** (one finished
  video every ~5.0s in steady state; first video latency ≈ image 12.4s + video
  40.3s ≈ **53s** warm-up).
* **Images needed to feed that** = 11.9/min. One image slot does ~4.8/min, so
  feeding 8 video slots costs only **~2.5 image slots** out of the 7-rest pool.
* That leaves **~4.5 rest slots** for TTS/SFX/LLM. ⇒ **The 7-rest pool can never
  starve the 8-video pool of input images.** Video is the bottleneck by design,
  which is what we want.

**Caveat to watch — SFX is the heaviest rest consumer.** At full video throughput,
if *every* scene also needs an SFX (16s each), SFX demand alone is
11.9/min ÷ 3.8 ≈ **3.1 slots**, plus ~2.5 for images ≈ 5.6 of the 7 rest slots.
Still fits, but tight. Two mitigations, both already implied by the design:
1. **Prioritize image generation *within* the rest pool** (it's on the video
   critical path; TTS/SFX are not). A simple intra-pool priority: `image > i2i >
   tts > sfx > llm`.
2. Lean on the **global SFX cache** (§10) — SFX is the most repetitive cue type,
   so cache hits cut its real slot demand sharply.

### 17.3 Make the reservation work-conserving (don't waste slots)

A *hard* 8/7 partition would idle video's 8 slots whenever there's no video work,
and cap video at 11.9/min even when the rest pool is empty. Instead implement the
split as **two guaranteed floors over one shared pool of 15, with video winning
contention**:

* **Video is guaranteed ≥ 8** and **rest is guaranteed ≥ 7** (floors, not caps).
* **Either side may borrow the other's idle slots.** When the system is
  video-heavy, video bursts up to **all 15** (≈ 22 videos/min) if rest is idle;
  when video-light, rest reclaims those slots for images/TTS/SFX.
* **Video has reclaim priority:** when any slot frees and video work is waiting,
  the freed slot goes to video first. Since ModelsLab jobs can't be preempted
  mid-flight, video's worst-case wait to reclaim a borrowed slot is bounded by the
  **longest rest job ≈ SFX 16s** — acceptable, and far better than starving.

This is the literal implementation of your "reserve 8 for video; if the video
queue is free others can use it, but prioritize video."

### 17.4 Redis encoding of the floors

Reuse the §5 model with two class counters instead of one flat semaphore:

```
SAFE_LIMIT          = 15            # (or 12 with headroom; see §2)
VIDEO_FLOOR         = 8
REST_FLOOR          = 7             # VIDEO_FLOOR + REST_FLOOR == SAFE_LIMIT
modelslab:inflight:video  -> int
modelslab:inflight:rest   -> int
```

Acquire rule (atomic Lua), where `total = video + rest`:
* **video** request granted if `total < SAFE_LIMIT` **and**
  (`video < VIDEO_FLOOR` **or** `rest <= REST_FLOOR`)  ← i.e. video may exceed its
  floor only by borrowing slots rest isn't using.
* **rest** request granted if `total < SAFE_LIMIT` **and**
  (`rest < REST_FLOOR` **or** `video <= VIDEO_FLOOR`)  ← rest may borrow only
  slots video isn't using.
* On any release, run the dispatcher **video-first**, then rest.

This keeps both floors honoured, lets either side use idle capacity, and gives
video the tie-break — all without ever exceeding `SAFE_LIMIT`.

---

## 18. Multi-provider routing (ModelsLab = background/video; Replicate + Kie = foreground)

Per the updated plan, **ModelsLab is dedicated to background & planned video
generation**, while **foreground / priority work routes to Replicate and Kie**.
This *simplifies* the ModelsLab side and *generalizes* Quartermaster into a
**provider-aware router** sitting above per-provider limiters.

### 18.1 What changes

* **ModelsLab no longer serves interactive users**, so the P0/P1/P2 priority
  tiers from §7 **collapse on ModelsLab** to a single concern: *video vs. its
  supporting image/TTS/SFX, all background*. That is exactly the **8/7 floor
  model of §17** — no human-latency fairness needed inside ModelsLab.
* The central component becomes a **router + N independent limiters**:
  * `modelslab` limiter → semaphore of 15 with the 8/7 video/rest floors.
  * `replicate` limiter → its own concurrency budget (per Replicate account limits).
  * `kie` limiter → its own budget (per Kie limits).
* The codebase already speaks all three: `asset_pipeline.py` has
  `VALID_IMAGE_PROVIDERS = {gemini, replicate, modelslab, kie}` and Kie task
  polling (`KIE_AI_API_KEY`), so routing is a dispatch decision, not new I/O.

### 18.2 Routing rule

```
route(request):
  if request.priority in {P0, P1}  ->  provider = pick(replicate, kie)   # foreground/interactive
  else (background / planned)       ->  provider = modelslab              # incl. all video
  return providerLimiter[provider].acquire(...)
```

* **Foreground** (StoryStudio editor, Remotion Studio preview, user-waiting
  generation): Replicate / Kie, chosen by capability + each provider's live
  queue depth (load-balance, fail over between them).
* **Background / planned** (batch series, scheduled jobs, **all video**):
  ModelsLab, governed by the 8/7 reservation.

### 18.3 Why this is the right shape

* **Isolation:** a foreground spike can't touch ModelsLab's 15-slot budget, so a
  bulk overnight video run never delays an interactive user, and vice-versa.
* **Each provider keeps one limiter of its own** — same primitive (distributed
  semaphore + fair queue), three instances, one router. Replicate/Kie limits are
  configured the same way `SAFE_LIMIT` is for ModelsLab (start conservative,
  AIMD-tune from their 429s).
* **Cost/latency fit:** ModelsLab's strength here is *throughput on long batch
  video* (cheap, 8 parallel ≈ 12 videos/min); Replicate/Kie absorb *latency-
  sensitive* one-offs. The router encodes that division explicitly.

### 18.4 Revised tier→provider→budget map

| Tier | Who | Provider | Budget primitive |
|---|---|---|---|
| P0 interactive | editor/preview, user watching | Replicate / Kie | per-provider semaphore, lowest queue first |
| P1 foreground | user-initiated, expects "soon" | Replicate / Kie | shared with P0, P0 wins contention |
| P2 background/planned | batch, scheduled, **all video** | **ModelsLab** | 15-slot pool, **8 video / 7 rest floors (§17)** |

> Net: the §7 priority tiers still exist, but they now select a **provider**
> first; *within ModelsLab* the only scheduling left is the video-favoring 8/7
> floor, which the benchmark in §17 confirms keeps the video pipeline saturated.

---

## 19. Resources required & cost to operate

> Scope: the cost of **running the rate-limit control plane** — *not* the
> ModelsLab/Replicate/Kie generation spend, which is a separate line item and is
> *reduced* by this system (caching + dedupe in §10). All prices are
> approximate `us-east-1` on-demand, **monthly**, as a planning estimate — verify
> against current pricing.

### 19.1 The key insight: the control plane is tiny

Quartermaster only stores a counter-set plus a few wait-queue entries — the active
set never exceeds `SAFE_LIMIT` (≤15) members, total state is **kilobytes**. The
operation rate is also tiny: even at full tilt the busiest endpoint (TTS, ~23
jobs/min/slot) drives only a few hundred `acquire/release/heartbeat` ops per
minute fleet-wide. Any Redis handles 10⁴–10⁵ ops/s, so **you size Redis for
availability, not capacity.** This keeps the bill near the floor.

### 19.2 Recommended shape: library + Redis (no broker service)

Because ModelsLab now serves only **background** work (§18), there is **no P0
interactive long-poll requirement on ModelsLab**, so Quartermaster does **not** need
to be a standalone service. Ship it as a **thin client library** (TS + Python)
that runs the atomic acquire/release/heartbeat **Lua scripts directly against
Redis**. This removes broker compute, load balancers, and a single point of
failure. **The only shared resource you must provision is Redis.**

| Resource | Purpose | Spec | Est. monthly |
|---|---|---|---|
| **Managed Valkey (HA)** | the distributed semaphore + wait queues + single-flight locks | **ElastiCache for Valkey** `cache.t4g.micro`, primary + 1 replica, Multi-AZ | **~$19–24** |
| **Control-plane Lambda** (cron, 1/min) | AIMD tuning of `SAFE_LIMIT`, reclaim sweep, metrics flush | 128 MB, ~43k invocations/mo | **~$0–1** (free tier) |
| **CloudWatch** | metrics (§12) + dashboard + a few alarms | ~10 custom metrics, 1 dashboard | **~$3–8** |
| **S3 result cache** | already exists (`cache/documentary/...`) — marginal growth | existing bucket | **~$1–3** |
| Client libraries | run inside existing Lambdas/ECS/workers | no new compute | **$0** |
| **Total (recommended)** | | | **≈ $30–45 / month** |

**Engine choice — use Valkey.** [ElastiCache for **Valkey**](https://aws.amazon.com/elasticache/what-is-valkey/)
is the open-source Redis 7.2 fork AWS now defaults to. It is **wire- and
command-compatible** (RESP), so everything this design uses works unchanged:
`EVAL`/`EVALSHA` Lua, `ZADD GT XX`, `ZREMRANGEBYSCORE`, `ZCARD`, `INCR`/`DECR`,
and Pub/Sub. Existing clients connect as-is — `ioredis` (TS) and `redis-py`
(Python) both speak Valkey; `RLB_REDIS_URL` is unchanged (or use the
`valkey-glide` client if you prefer the native one). AWS prices node-based
Valkey **~20% below** Redis OSS, so it's the cheaper *and* the supported default
— no reason to pick Redis OSS for this.

Serverless alternatives (no instance to manage, built-in HA + TLS):
* **ElastiCache Serverless for Valkey** — lowest entry point; at our kilobyte
  state + low op rate it sits at the storage floor, **~$6–7/mo all-in** (worked
  below).
* **Upstash (Valkey/Redis-compatible)** — per-request pricing, ~**$5–15/mo** at
  this volume; public-TLS rather than in-VPC.

#### 19.2.1 Projected cost — Serverless Valkey, in-VPC (worked example)

Confirmed `us-east-1` pricing: **storage $0.084 / GB-hour** (minimum **100 MB**
billed per cache), **compute $0.0023 / million ECPUs** (1 ECPU ≈ one ~1 KB
read/write; Lua `EVAL` bills by the vCPU it uses).

* **Storage** — our entire state (active lease ZSET ≤15 members, a few wait/queue
  entries, single-flight locks, live usage counters from §20) is **well under the
  100 MB floor**, so we pay the floor:
  `0.1 GB × 730 hr × $0.084 = `**`$6.13 / month`**.
* **Compute (ECPUs)** — even at a generous **100 completed jobs/min fleet-wide**,
  each job is ~6 ops (acquire + release + ~2 heartbeats + cache/single-flight
  lookups). At ~2 ECPUs/op that's `100 × 6 × 2 × 60 × 730 ≈ 52.6M ECPUs/month`
  → `52.6 × $0.0023 = `**`≈ $0.12 / month`**. Ten-fold traffic is still <$1.50.
* **VPC** — **$0.** ElastiCache Serverless runs *inside your VPC* via managed
  endpoints/ENIs at no charge; callers (Lambda/ECS in the same VPC) reach it over
  private IPs, so **no NAT gateway and no inter-AZ transfer charge** apply
  (serverless replication across AZs is handled by the service and included).

> **Projected Serverless Valkey total ≈ $6–7 / month, in-VPC, no extra VPC cost.**
> The 100 MB storage floor dominates; compute is cents. This is the cheapest
> production-grade option and has built-in Multi-AZ HA — so for this workload
> **Serverless Valkey is the recommended engine**, beating the node-based HA pair
> (~$19–24) on both cost and ops. Add CloudWatch (~$3–8) and the existing S3 cache
> (~$1–3) for a **control-plane total of ≈ $10–18 / month.**

### 19.3 Minimum (dev / single-region, no HA)

| Resource | Spec | Est. monthly |
|---|---|---|
| Valkey, single node | ElastiCache for Valkey `cache.t4g.micro` (no replica) | ~$9–10 |
| CloudWatch (basic) | — | ~$1–3 |
| **Total (minimum)** | | **≈ $11–13 / month** |

Acceptable for staging or low-stakes use; **not** recommended for the production
video pipeline because a Redis failure with no replica forces the
`RLB_FAIL_MODE_BACKGROUND=closed` path (batch stalls until Redis returns).

### 19.4 Optional add-on: standalone broker / proxy service (only if needed later)

You'd add this **only** to (a) hold all provider API keys in one vault (proxy
mode, §4.1 Pattern A), or (b) offer pub/sub long-poll for sub-second foreground
dispatch on Replicate/Kie. Not required for a stable video pipeline.

| Resource | Spec | Est. monthly |
|---|---|---|
| ECS Fargate broker | 2 × (0.25 vCPU / 0.5 GB) for HA | ~$18 |
| Internal NLB | service-to-service | ~$16–22 |
| **Add-on subtotal** | | **≈ $35–40 / month** |

### 19.5 Non-infra resources required

* **Provider accounts & quotas (the real capacity limits):**
  * **ModelsLab Premium** — already held; 15-slot pool (the constraint this whole
    system manages). An **enterprise upgrade** is the lever if §12 shows
    `inflight` pinned at `SAFE_LIMIT` with deep queues for sustained periods.
  * **Replicate** + **Kie** accounts for foreground (§18) — confirm each one's
    concurrency limit and set `REPLICATE_SAFE_LIMIT` / `KIE_SAFE_LIMIT`
    accordingly; these are the foreground capacity ceilings.
* **Secrets:** `MODELSLAB_API_KEY`, `REPLICATE_API_TOKEN`, `KIE_AI_API_KEY`,
  `RLB_REDIS_URL` — store in your existing secret manager; the library reads them
  from env as the code does today.
* **Engineering effort (one-time):** ~Redis + Lua scripts + TS/Python client
  libs + wiring the existing call sites (§3) + dashboards. Rollout is staged in
  §15 (SFX → LLM/image/TTS → video), so it lands incrementally, not big-bang.
* **Network:** clients (Lambdas/ECS) need VPC route to Redis (ElastiCache is
  in-VPC; Upstash is public-TLS). Negligible data-transfer cost (kilobyte ops).

### 19.6 Cost vs. benefit

For **≈ $10–18/month** (Serverless Valkey + CloudWatch + existing S3 cache) the
system (a) prevents the 429-driven render failures and retries we get today,
(b) **keeps 8 video slots saturated → ~12 videos/min, burst to ~22/min** (§17),
(c) isolates background video from foreground users (§18), and (d) **cuts
generation spend** by making cache hits (§10) consume zero slots *and* zero API
cost. The control-plane cost is immaterial next to the generation bill it protects
and reduces — the dominant spend remains the ModelsLab/Replicate/Kie generation
itself, which is unchanged in unit price and lowered in volume.

---

## 20. Consumption metering & attribution (per model / platform / project / request)

**Yes — and it's a natural extension, not a bolt-on.** Every unit of work already
passes through `acquire`, so Quartermaster is the *one chokepoint* where we can stamp
attribution and measure exactly what each job consumed. We just widen the lease
descriptor and emit a usage record on `release`.

### 20.1 Attribution dimensions (carried on every `acquire`)

```ts
broker.acquire({
  // scheduling (existing)
  tenant, priority, endpoint,            // endpoint: video|image|i2i|tts|sfx|llm
  estDurationMs,
  // attribution (new)
  platform,        // "storystudio" | "remotion"
  projectId,       // or projectType for StoryStudio
  requestId,       // the render request / job id
  userId,          // who triggered it
  provider,        // "modelslab" | "replicate" | "kie"
  model,           // "wan-2.2-i2v" | "gemini-3.1-t2i" | "inworld-tts-1" | "sfx" | "google-gemini-2.5-flash" | ...
});
```

On `release` Quartermaster knows the **hold duration** (`slot_ms`, our measured
proxy for ModelsLab queue occupancy — see §17) and the **outcome**
(success / failure / retried). That is enough to attribute both *capacity*
(slot-seconds) and *cost* (jobs × per-model unit price) to any dimension.

The codebase already has most of these on hand: `render-request.ts` /
`asset_pipeline.py` know `request_id`, `imageModel`/`imageProvider`, `endpoint`,
and the platform; wiring them into `acquire` is a parameter pass-through.

### 20.2 Two-tier storage (don't put billing data in the cache)

**Tier 1 — live counters in Valkey (real-time, cheap, TTL'd).** For dashboards
and in-path quota checks, increment hash counters as part of the same release:

```
HINCRBY usage:project:{projectId}:{yyyymmdd}   {model}:count   1
HINCRBYFLOAT usage:project:{projectId}:{yyyymmdd} {model}:slot_ms  <held_ms>
HINCRBY usage:platform:{platform}:{yyyymmdd}    {provider}:count 1
HINCRBY usage:request:{requestId}               {model}:count   1     # EXPIRE after retention
```

These are kilobytes (well inside the 100 MB Serverless floor → **$0 marginal**),
and let the §7 fairness cap evolve into **real per-project / per-request budgets**
enforced *in the acquire path* (reject or down-prioritize once a project exceeds
its slot-seconds budget for the day).

**Tier 2 — durable metering store (history, billing, analytics).** Emit one
structured event per completed job to a durable sink:

```json
{ "ts":"…","platform":"remotion","projectId":"…","requestId":"v3-f2…",
  "userId":"…","provider":"modelslab","model":"wan-2.2-i2v","endpoint":"video",
  "slotMs":40300,"outcome":"success","estCostUsd":0.0123 }
```

Sink options (pick one): **DynamoDB** on-demand (cheap point-writes + GSIs by
`projectId`/`requestId`), **CloudWatch EMF logs**, or **S3 (date-partitioned) +
Athena** for ad-hoc roll-ups. At our volume any of these is **~$1–5/mo**.

### 20.3 Cardinality rule (important)

`requestId` and `userId` are **high-cardinality** — keep them in the **durable
store and the TTL'd Valkey request key only**. Do **not** make them CloudWatch
*metric dimensions* (cost blows up). Publish CloudWatch metrics only on
**low-cardinality** dims — `platform`, `provider`, `model`, `endpoint` (and
`projectId` if the project count is bounded). Drill to request/user level via the
DynamoDB/S3 store, not metrics.

### 20.4 What you can then answer

* "How many `wan-2.2-i2v` slot-seconds did **project X** burn today?" → Valkey
  live counter or Tier-2 aggregate.
* "Per-**platform** (StoryStudio vs Remotion) consumption by model this month." →
  Tier-2 group-by.
* "Cost of **request_id `v3-f2…`** broken down by model." → query `requestId` in
  Tier-2 (or the TTL'd Valkey request key while it's still warm).
* "Which project is starving the video pool?" → top-N `projectId` by `slotMs` on
  `provider=modelslab, endpoint=video`.

### 20.5 Cost of metering

Tier-1 counters ride inside the already-negligible ECPU/storage budget (**$0
marginal**). Tier-2 durable sink adds **~$1–5/mo**. So full per-model /
per-platform / per-project / per-request attribution raises the control-plane
total only marginally — to **≈ $12–22 / month** — while giving precise chargeback
and the data to justify (or defer) a ModelsLab enterprise upgrade.

---

## 21. Phased delivery: Phase 1 DynamoDB orchestration → Phase 2 Valkey

**Verdict: yes, this works** — and Phase 1 needs **no always-on store at all**.
The semaphore can live in **DynamoDB** (atomic conditional writes), so the same
8/7 floor logic (§17) runs serverless and pay-per-use. Phase 2 swaps *only the
backend* of `acquire`/`release` to Valkey when scale demands it — the SDK
interface (§11) is identical across both, so nothing else changes.

> This aligns with what already exists: `infra/aws/doc/doc-stepfunctions.asl.json`,
> the `render_dispatch` handlers, and the request-record + status-polling pattern
> in `service/`. Phase 1 is mostly *formalizing the gate*, not new architecture.

### 21.1 The orchestration flow (exactly as proposed)

```
requestor → [1] POST request
                 │
            [2] store job in DynamoDB  status=QUEUED, s3Target=<project folder>
                 │
            [3] dispatcher/SFN: try acquire slot (atomic) ──fail──▶ wait, retry
                 │ granted
            [4] status=PROCESSING; submit to provider; poll until ready
                 │
            [5] upload asset → s3://.../<project folder>/...   release slot
                 │
            [6] status=COMPLETE (+ assetKey)   [emit completion event]
                 ▼
requestor ← [7] GET status → COMPLETE → read S3 asset → next process
```

Steps 1–2 and 7 are your current request-record/polling pattern; 3–6 are the
gate + worker. **Status lifecycle:** `QUEUED → PROCESSING → COMPLETE | FAILED`
(`FAILED → QUEUED` on retry). `QUEUED` ≠ `PROCESSING` matters — it lets you see
*queue depth* (waiting for a slot) separately from *in-flight* work.

### 21.2 DynamoDB design (Phase 1)

```
# Job/status item — one per asset job
PK = REQ#{requestId}   SK = JOB#{jobId}
  status, class(video|rest), priority, provider, model, endpoint,
  platform, projectId, s3Target, assetKey?, attempts, leaseExpiry, createdAt, updatedAt
GSI "status-index": PK=status, SK=priority#createdAt   # dispatcher pulls QUEUED in order

# Semaphore item — ONE item is the whole gate
PK = COUNTER#modelslab
  video_inflight (N), rest_inflight (N)
```

**Acquire (atomic, video example):**
```
UpdateItem COUNTER#modelslab
  UpdateExpression:    ADD video_inflight :one
  ConditionExpression: (video_inflight + rest_inflight) < :limit
                       AND (video_inflight < :vfloor OR rest_inflight <= :rfloor)
```
`ConditionalCheckFailedException` ⇒ pool full ⇒ leave job `QUEUED`, retry later.
**Release:** `ADD video_inflight :neg_one` (guard `video_inflight > 0`). This is
the §17.4 floor rule expressed in DynamoDB instead of Lua.

### 21.3 Who admits jobs (don't block a Lambda)

Two serverless options — **a Lambda must never sleep waiting for a slot** (15-min
cap + idle cost):

* **A — Step Functions native (recommended; you already have SFN).** Each
  provider call is a sub-flow: `AcquireSlot` (Lambda conditional-update) → on deny
  `Wait 30s` → retry; on grant `Submit` → `Poll`(loop with `Wait`) → `Upload` →
  `ReleaseSlot`. SFN's `Wait` states are free of compute cost.
* **B — Dispatcher Lambda on EventBridge (~every 30–60s).** Query the
  `status-index` GSI for `QUEUED` jobs by priority, try `acquire` for each, start
  a worker (async invoke / `StartExecution`) and set `PROCESSING`; stop when
  `acquire` fails (pool full).

Either way the worker holds **no blocking wait** — it only runs once it owns a
slot, does submit→poll→upload→release, then exits.

### 21.4 Leak protection without TTL reclaim

DynamoDB item-TTL deletes items but **never decrements your counter**, so you
cannot rely on it. Instead: every `PROCESSING` item carries `leaseExpiry`; an
**EventBridge cron (1–5 min)** scans `PROCESSING` where `leaseExpiry < now`, marks
them `FAILED`/requeues, and releases the slot (decrement). This is the Phase-1
analog of Valkey's lazy ZSET-expiry reclaim (§6) — coarser (cron cadence) but
correct.

### 21.5 What triggers the move to Phase 2 (Valkey)

The single `COUNTER#` item caps at ~1000 writes/s and the dispatcher tick adds
latency. At 15 slots with 2.6–40s jobs (§17) the acquire/release rate is a few
per second — **Phase 1 is comfortably within limits.** Move to Valkey when any of
these appear:

| Signal | Why Valkey helps |
|---|---|
| Counter write-contention / `ConditionalCheckFailed` storms as customers grow | In-memory atomic ops absorb far higher churn |
| Cron/`Wait`-tick dispatch latency too slow (want near-instant slot hand-off) | Pub/Sub wakes the next waiter immediately |
| High op volume makes per-write DynamoDB cost/latency unattractive | ECPU ops are cheaper at volume (§19.2.1) |
| Need live per-project usage counters + sub-second quota checks (§20) | `HINCRBY` live counters, lazy TTL reclaim |

**Migration is low-risk:** keep `acquire/release/heartbeat` behind the SDK
interface (§11) from day one; Phase 2 reimplements only its body (DynamoDB
conditional-update → Valkey Lua). Callers, status flow, S3 layout, and the
DynamoDB *status* table all stay — Valkey takes over only the *gate* (and
optionally the live usage counters).

### 21.6 Phase 1 cost

Pure pay-per-use, **no storage floor**: DynamoDB on-demand (a few writes + status
reads per job) ≈ **$1–3/mo** at low volume; EventBridge crons negligible; Step
Functions Standard transitions a few dollars at most (use Express if poll loops
get chatty). So **Phase 1 ≈ $3–8/mo, and cheaper than Valkey at low volume**
precisely because there's no always-on ~$6–7 floor — which is exactly why
starting on DynamoDB and graduating to Valkey at scale is the right call.

---

## 22. Avoiding Lambda timeout: Step Functions callbacks + the real roles of SQS / EventBridge

A single Lambda that submits to a provider and then polls until the asset is
ready will, for batched requests or queue-deep periods, blow the **15-minute
Lambda hard limit** and bill for idle wait. The fix is to **never hold a Lambda
open across the wait** — let **Step Functions** own the waiting, with **zero
compute running** during it.

### 22.1 Clear up the component roles first

Your sketch had EventBridge doing the queuing and the resuming. EventBridge can't
do the first and only indirectly does the second — here is the correct split:

| Need | Right service | Notes |
|---|---|---|
| **Hold the backlog of pending jobs** | **SQS** (or DynamoDB GSI) | EventBridge is a router/scheduler, **not** a durable pull-queue; it keeps no backlog |
| **Drive the periodic dispatcher + lease sweeper** | **EventBridge Scheduler** | cron/one-time → target Lambda |
| **Carry "job complete" events to interested consumers** | **EventBridge bus** | fan-out to: resume-Lambda, the requestor's "next process", metering |
| **Resume a paused Step Function** | **`SendTaskSuccess`/`SendTaskFailure`** (SFN API) | called by a tiny Lambda the completion event triggers — EventBridge *triggers* it, the SFN API *does* it |
| **Wait minutes for a provider with no timeout** | **Step Functions** (`.waitForTaskToken` or `Wait`+`Choice` loop) | SFN pauses for up to **1 year**; no Lambda is held |

> Net: EventBridge sits **between the completion signal and the Step Function as a
> router/trigger**, not as a queue. The queue is SQS/DynamoDB; the resume is the
> SFN callback API.

### 22.2 Two ways to make the SFN wait without timeout

**Option A — Callback (`.waitForTaskToken`) — best for long/external completion.**

```
SubmitJob (Task, resource: lambda:invoke.waitForTaskToken)
  - Lambda: acquire already held → POST to provider → persist {taskToken, providerRequestId,
            jobId} in DynamoDB → return (Lambda exits in ~1s)
  - SFN now PAUSES on this state — no compute, no timeout
        … provider works (40s … minutes) …
  - Poller Lambda (EventBridge Scheduler, every N s) OR provider webhook → checks fetch;
    when ready: upload asset to S3 project folder → release slot →
    emit "job.complete" event
  - "job.complete" → EventBridge rule → Resume Lambda → SendTaskSuccess(taskToken, {assetKey})
  - SFN RESUMES to the next state
```

The submit Lambda runs ~1s; the poller runs ~1s per tick; **nothing is held open
for the job's duration.** This is the canonical pattern for work that can exceed
15 minutes.

**Option B — In-SFN poll loop — simplest for bounded jobs (our 40s video).**

```
Submit (Lambda ~1s) → Wait 12s → CheckStatus (Lambda ~1s)
   → Choice: ready?  yes → Upload → Release → Done
                     no  → (attempts<max?) → back to Wait
```

`Wait` states cost nothing and don't run Lambdas, so no invocation ever
approaches the timeout. Given §17 shows video ≈ 40s, a `Wait 12s` loop finishes
in ~3–4 short iterations. **Recommended for ModelsLab** (no task-token plumbing);
switch to Option A only for genuinely long or webhook-driven providers.

### 22.3 The acquire-slot wait is the same idea

Admission (§17/§21) also uses an SFN wait, so a job that can't get a slot never
pins a Lambda:

```
AcquireSlot (Lambda: DynamoDB conditional update)
   → Choice: granted? yes → SubmitJob…
                       no  → Wait 30s → back to AcquireSlot   (with max-attempts guard)
```

(Or gate at the **dispatcher** instead: it only `StartExecution`s a job once it has
acquired a slot — then the SFN has no acquire loop at all. Either is fine; gating
at the dispatcher keeps SFN executions to admitted jobs only.)

### 22.4 End-to-end Phase-1 flow (corrected)

```
[ingest Lambda] POST → write slim job to DynamoDB (status=QUEUED) → send to SQS
        │
[dispatcher] EventBridge Scheduler (~30–60s) → read SQS/GSI by priority
        │   → AcquireSlot (DynamoDB conditional) → if granted: StartExecution(SFN), status=PROCESSING
        ▼
[Step Function]  Submit → Wait/Poll (Option B)  — or  Submit.waitForTaskToken (Option A)
        │                                              ▲
        │                                  EventBridge "job.complete" → Resume Lambda → SendTaskSuccess
        ▼
   Upload asset → s3://…/<project folder>/  → ReleaseSlot (DynamoDB) → status=COMPLETE
        │
        └─ emit "job.complete" event → (requestor's next process / metering §20)
        ▼
[requestor] GET status → COMPLETE → read S3 asset → next step
```

Nothing in this path holds a Lambda longer than ~1–2s; all waiting is in SFN
`Wait`/paused states or SQS — **timeout-proof by construction.**

---

## 23. Slim job payloads (don't pass the whole project JSON)

This is a hard requirement, not just hygiene: **Step Functions state, EventBridge
events, and SQS messages are each capped at 256 KB.** A full render manifest
(`package.videos[].frames[]`, prepared assets, citations…) will exceed that and is
expensive to shuttle around. Use the **claim-check pattern**: keep the big JSON in
S3/DynamoDB, pass only a **reference + the few fields this job needs**.

**Store once (already your pattern — manifests live in S3):**
```
s3://…/requests/{requestId}/manifest.json     # the whole project/render manifest
```

**Pass around only a slim job descriptor:**
```json
{
  "requestId": "…",
  "jobId": "v3-f2-video",
  "class": "video",                 // video | rest  (drives the 8/7 floor, §17)
  "provider": "modelslab",
  "model": "wan-2.2-i2v",
  "endpoint": "video",
  "params": { "prompt": "…", "initImageKey": "…/v3-f2.png", "numFrames": 82, "fps": 16, "resolution": "480" },
  "s3Target": "…/<project folder>/v3-f2.mp4",
  "priority": "P2",
  "manifestRef": "s3://…/requests/{requestId}/manifest.json"   // claim check
}
```

Rules of thumb:
* Include **only what the worker needs to execute and place the asset**: ids,
  class/provider/model/endpoint, the specific prompt/params, the S3 target, and a
  `manifestRef` for anything else.
* The worker fetches the full manifest from `manifestRef` **only if** it needs
  more — most jobs won't.
* Never embed image bytes or long prompt blobs beyond what the call requires;
  reference S3 keys (e.g. `initImageKey`) instead of inlining data.
* This keeps every SFN transition, event, and message comfortably under 256 KB,
  lowers cost, and makes the §20 attribution fields (platform/projectId/model)
  the *only* metadata that travels — exactly what you want to stamp anyway.

---

## 24. Lean variant: DynamoDB-only FIFO (no SQS, no event bus)

**Yes — one DynamoDB table can be the FIFO queue, the semaphore, *and* the status
store at once.** This is the leanest correct topology: drop SQS and the
EventBridge bus, and the only stateful resource is a single table. Fewer
components = fewer failure points, which is the goal.

### 24.1 One table, three jobs

```
# Job item (queue entry + status + attribution, all in one)
PK = REQ#{requestId}   SK = JOB#{jobId}
  status(QUEUED|PROCESSING|COMPLETE|FAILED|DEAD), lane(video|rest), priority,
  enqueueSeq, provider, model, endpoint, params, s3Target, manifestRef,
  attempts, leaseExpiry, platform, projectId, createdAt, updatedAt

# FIFO index — query QUEUED in arrival order, per lane
GSI "queue-index": PK = lane, SK = enqueueSeq      # enqueueSeq = epoch-ms + "#" + jobId

# Semaphore item (§21.2)
PK = COUNTER#modelslab   { video_inflight, rest_inflight }
```

* **FIFO:** `Query` the `queue-index` for a lane, `ScanIndexForward=true`,
  ascending `enqueueSeq` → strict arrival order. `epoch-ms + jobId` is sufficient
  ordering at our rate; for guaranteed-monotonic ordering use an atomic sequence
  item (`ADD seq 1`) instead — at the cost of one more hot write (defer to Phase 2).
* **Exactly-once dequeue:** claim via conditional update
  (`SET status=PROCESSING ... ConditionExpression: status = :queued`). Concurrent
  dispatchers cannot double-admit the same job.

### 24.2 FIFO vs the 8/7 video priority — pick per-lane FIFO

Strict **global** FIFO and the §17 video-favoring reservation are in tension (you
can't simultaneously honour pure arrival order *and* always prefer video).
Resolution: **FIFO within each lane (`video`, `rest`), dispatched video-first.**
You keep the video-pipeline guarantee and remain FIFO where it matters. Only
choose a single global FIFO line if you are willing to drop the video floor.

### 24.3 Admission with no queue service and no bus

Wake the next job **inline** instead of via SQS/EventBridge:

* **On enqueue** — ingest writes `QUEUED`, then immediately attempts
  `acquire`; if granted → `StartExecution` + flip to `PROCESSING`; if the pool is
  full → leave it `QUEUED` (nothing else to do).
* **On release** — the finishing job, right after `ADD *_inflight -1`, queries the
  `queue-index` (video lane first) for the oldest `QUEUED` job and admits it.
  Completion thus *pulls* the next item — a self-sustaining chain.
* **Safety net** — a single **EventBridge Scheduler** rule (every 1–5 min) runs
  the **sweeper**, which (a) reclaims expired leases (`PROCESSING` past
  `leaseExpiry` → requeue/`FAILED`, decrement counter) **and** (b) re-attempts
  admission for any `QUEUED` backlog, covering any missed inline wake-up.

That one schedule rule is the *only* extra trigger, and it is a managed
cron — not a running service.

> **Dependencies (`dependsOn`).** A job with parents — **i2v** (needs its image),
> **lipsync** (needs image **and** TTS audio) — carries `dependsOn:[jobId…]`. The
> admitter **skips** it until every parent is `COMPLETE`, then admits normally;
> the parents' completion (the "pull next" step) re-checks dependents. This is how
> the image→video and image+audio→lipsync ordering is enforced without a separate
> DAG engine — just a status check at admission time.

> Optional even-leaner wiring: use **DynamoDB Streams** on the table to fire the
> admit Lambda on insert (new `QUEUED`) and on counter decrement (release),
> instead of inline admit. It decouples nicely but adds the stream + handler;
> inline-admit + sweeper is the minimal-component choice.

### 24.4 What SQS gave you, rebuilt for free on the table

You already need the lease sweeper for slot-leak protection (§21.4), so the
SQS-replacement machinery is essentially *already there*:

| SQS feature | DynamoDB-only equivalent |
|---|---|
| Visibility timeout | `leaseExpiry` + sweeper (already required) |
| Retry / redelivery | `attempts` counter + `PROCESSING → QUEUED` requeue |
| Dead-letter queue | `status = DEAD` once `attempts > max` |
| Consumer wake-up | inline admit on enqueue/release (+ sweeper backstop) |
| Ordering | `queue-index` ascending `enqueueSeq` (per-lane FIFO) |

### 24.5 Resulting failure surface & cost

* **Stateful resources: one DynamoDB table.** Plus Step Functions (managed,
  durable, multi-AZ) for no-timeout execution (§22) and **one** EventBridge
  Scheduler rule for the sweeper. No SQS, no event bus, no Valkey, no broker
  service.
* **Minimize Lambdas further (optional):** Step Functions can call DynamoDB
  through native **AWS SDK service integrations** (so `AcquireSlot`,
  `ReleaseSlot`, claim, and admit are DynamoDB calls *from the state machine*, no
  Lambda), and can call ModelsLab via the **HTTP Task** integration — leaving
  Lambdas only where you want custom logic.
* **Cost:** strictly less than §21 — still just DynamoDB on-demand + SFN
  transitions + one cron ≈ **$3–8/mo** at low volume, with **no always-on store**.
* **Phase-2 boundary unchanged:** when the single `COUNTER#`/`queue-index`
  partition starts to feel write-contention, or you need sub-second wake-ups and
  live usage counters, swap the *gate + queue* to Valkey behind the same
  `acquire`/`release`/`enqueue` interface (§21.5). The DynamoDB *status* table can
  stay as the durable record either way.

**Bottom line:** for a FIFO, lean, few-moving-parts system, **DynamoDB-only is the
right Phase-1 answer** — queue + semaphore + status in one table, inline admission,
one sweeper cron, Step Functions for timeout-proof execution. It is correct,
cheap, and has the smallest possible blast radius.

### 24.6 Architecture diagram (Phase 1, DynamoDB-only FIFO)

```
   Producers                          AWS — Phase 1 control plane
 ┌─────────────┐
 │ StoryStudio │ ──POST job──┐
 │ Remotion bg │             │   ┌──────────────────────────────────────────────┐
 │ Remotion fg │ ──POST job──┼──▶│ Ingest (CloudFront→Lambda URL, or direct invoke)│
 └─────────────┘             │   │  1. validate + build SLIM job (claim-check)   │
        ▲                    │   │  2. PutItem status=QUEUED                      │
        │ GET status         │   │  3. try INLINE ADMIT (acquire → start)        │
        │                    │   └───────┬──────────────────────────────────────┘
        │                    │           │ acquire (conditional UpdateItem, 8/7)
        │                    │           ▼
        │                    │   ┌──────────────────────────────────────────────┐
        │                    │   │     DynamoDB  «jobs» table  (single source)   │
        │                    │   │   • job items: status + attribution (§20)     │
        │                    │   │   • GSI queue-index: per-lane FIFO            │
        │                    │   │   • COUNTER#modelslab: video/rest semaphore  │
        │                    │   └───┬───────────────────────────▲──────────────┘
        │                    │ admit │ StartExecution    release  │ (UpdateItem -1)
        │                    │       ▼                            │
        │                    │   ┌──────────────────────────────────────────────┐
        │                    │   │  Step Functions  (one execution per job)      │
        │                    │   │  Submit → Wait→Poll(loop) → Upload → Release   │
        │                    │   │     │ HTTPS submit/poll                        │
        │                    │   │     ▼                                          │
        │                    │   │  ModelsLab API ──asset bytes──┐                │
        │                    │   └───────────────────────────────┼──────────────┘
        │                    │                                   ▼
        │                    │                         ┌───────────────────┐
        └────────────────────┼─────────────────────── │  S3 project folder │ ◀─ manifest.json
            read asset on     │                        └───────────────────┘    (claim check)
            COMPLETE          │
                              │   ┌──────────────────────────────────────────────┐
                              │   │ EventBridge Scheduler (1–5 min) → Sweeper λ   │
                              │   │  • reclaim expired leases (release + requeue) │
                              │   │  • re-admit any QUEUED backlog (safety net)   │
                              │   └──────────────────────────────────────────────┘
```

Stateful surface = **one table**. Everything else is managed/serverless and
stateless. No SQS, no event bus, no broker, no Valkey.

### 24.7 How to implement (step by step)

1. **Table + index.** Create the `jobs` table (PK `REQ#{requestId}`, SK
   `JOB#{jobId}`) and the `queue-index` GSI (PK `lane`, SK `enqueueSeq`). Seed the
   `COUNTER#modelslab` item `{video_inflight:0, rest_inflight:0}`. Enable
   point-in-time recovery. Add a `leaseExpiry` attribute (no DynamoDB TTL on it —
   the sweeper, not TTL, does reclaim; §21.4).
2. **Ingest endpoint.** A **Lambda Function URL behind CloudFront** (no API
   Gateway, §30.7) — or, since producers are your own Lambdas, a **direct
   `lambda:invoke` (IAM auth)** with no public endpoint at all (preferred for
   server-to-server). The handler (a) validates, (b) computes a deterministic
   `jobId` (reuse `stable_hash` for cache/idempotency), (c) checks the result cache
   (§10) and short-circuits to `COMPLETE` on a hit, (d) writes a **slim** job item
   (§23) `status=QUEUED`, (e) calls the admit routine once.
3. **Admit routine** (shared Lambda, or SFN SDK integration): conditional
   `acquire` on `COUNTER#` with the §17.4 floor rule; on grant flip the job to
   `PROCESSING`, set `leaseExpiry`, `StartExecution` on the state machine; on deny,
   no-op (job stays `QUEUED`).
4. **State machine (ASL).** `Submit` (Lambda or HTTP Task) → `Wait 12s` →
   `CheckStatus` → `Choice` ready? (`Upload` → `Release` → mark `COMPLETE` → emit
   `job.complete`) : (attempts<max → loop). Wrap provider states in `Retry`
   (honour ModelsLab `retry_after`, §9) and a `Catch` → `Release` + `FAILED`. Use
   `Wait`/poll so no Lambda nears the 15-min cap (§22).
5. **Release = pull next.** The `Release` step decrements the counter **and**
   queries `queue-index` (video lane first) for the oldest `QUEUED` job and admits
   it — the self-sustaining chain (§24.3).
6. **Sweeper.** One EventBridge Scheduler rule (1–5 min) → Lambda: reclaim
   `PROCESSING` past `leaseExpiry` (release + requeue or `DEAD` once
   `attempts>max`) and re-admit any `QUEUED` backlog.
7. **Status API.** `GET /jobs/{requestId}` via the same **CloudFront → Lambda
   Function URL** (or direct invoke) → DynamoDB read returning `{status,
   assetKey?}`. (Optional: publish `job.complete` to subscribers so producers can
   skip polling.)
8. **Metering (optional).** On `Release`, write the §20 usage record
   (Tier-1 counters now skippable in Phase 1; Tier-2 durable event is a single
   `PutItem`).
9. **Wire callers** (next section), then roll out per §15 (SFX first → … → video).

### 24.8 What changes for the consumers (producers)

Consumers stop calling ModelsLab directly and instead submit a job and await a
result. Concretely, at the current call sites — `render-request.ts`
(`generateModelsLabSfx`), `asset_pipeline.py` (image/i2i/TTS/video helpers),
`sfx_gen.py`, `script_generator._modelslab_chat`:

* **Replace** the direct `POST` + in-process poll loop (and `sfxRunCache`) with:
  ```
  jobId = submit(ingestApi, {                # slim descriptor (§23)
    requestId, jobId, lane,                  # lane = "video" | "rest"
    provider:"modelslab", model, endpoint,
    params:{ prompt, initImageKey?, … },     # S3 keys, not bytes
    s3Target, priority,                      # priority -> P2 for background
    platform, projectId, userId,             # attribution (§20)
    manifestRef })                           # claim check, not the full JSON
  result = awaitComplete(statusApi, jobId)   # poll GET, or subscribe to job.complete
  asset  = readS3(result.assetKey)
  ```
* **Provide attribution + lane** on every submit (platform, projectId, requestId,
  model, endpoint; `lane=video` only for i2v, else `rest`).
* **Move big state to S3** and pass `manifestRef` — never the full manifest (§23).
* **Idempotency:** use a deterministic `jobId` (content hash) so retries and
  duplicate scenes dedupe and hit the cache rather than burning a slot.
* **Keep payloads** (the exact ModelsLab request bodies) — those move *into* the
  `Submit` step unchanged; only *who calls ModelsLab* and *when* changes.
* **Drop** per-process concurrency hacks (`MODELSLAB_MAX_POLL_ATTEMPTS` loops,
  `sfxRunCache`); the central table now owns concurrency, ordering, and dedupe.

Net consumer change is small and mechanical: submit-and-await replaces call-and-poll,
plus a few attribution fields. The behavioural payoff (no 429s, FIFO fairness,
8/7 video priority, metering) is entirely on the platform side.

---

## 25. Scaling out: a separate table + endpoint + limiter per service class

> "For the priority/foreground path, can we have a separate DynamoDB table with
> its own API endpoint and rate-limiter?" **Yes — and that is precisely the right
> way to scale.** It realizes the §18 multi-provider split as **physically
> isolated lanes**, so foreground and background cannot affect each other.

### 25.1 Table-per-service-class

Run **one `jobs`-style table per service class**, each self-contained (its own
FIFO `queue-index`, its own `COUNTER#` semaphore, its own dispatcher/SFN, its own
ingest endpoint):

| Table | Serves | Provider(s) | Semaphore |
|---|---|---|---|
| `jobs-bg` | background + **all video** (P2) | ModelsLab | 15, **8 video / 7 rest** (§17) |
| `jobs-fg` | foreground / interactive (P0/P1) | Replicate + Kie | `REPLICATE_SAFE_LIMIT`, `KIE_SAFE_LIMIT` (§18) |

Why separate tables rather than lanes in one:

* **Failure isolation / blast radius.** A hot partition, throttle, or bad deploy
  on the background table cannot stall foreground users, and vice-versa.
* **Independent scaling.** Each table scales its own throughput (and migrates to
  Valkey on its own schedule — see §25.4); foreground's latency profile and
  background's throughput profile no longer compete for one partition.
* **Independent limits & IAM.** Per-provider counters live in their own item; each
  endpoint gets its own role, quotas, and dashboards.

### 25.2 Its own API endpoint + two-layer rate limiting

The foreground service gets a **dedicated ingest endpoint** (e.g.
`POST /fg/jobs`) with rate limiting at **two layers**:

1. **Edge limiter — CloudFront + AWS WAF rate-based rules.** Per-key / per-IP
   **rate + burst** limits at the CloudFront edge (the dashboard/webhook surface is
   already CloudFront → Lambda Function URL, §30.7, so this reuses the same edge —
   no API Gateway). WAF sheds abusive load *before* it reaches the queue. (If you
   later want per-consumer *quota* plans specifically, that's the one feature WAF
   doesn't do as neatly as API Gateway usage plans — track quota in the table via
   §20 metering instead.)
2. **Concurrency limiter — the table's `COUNTER#`.** The §17.4 conditional-update
   semaphore, but sized to **Replicate/Kie** concurrency rather than ModelsLab's
   15. Foreground typically has slots free (it's interactive and provisioned for
   it), so **inline admit starts work near-instantly**; the cron is only a
   backstop.

Background keeps its own endpoint (`POST /bg/jobs`) and the ModelsLab 8/7 limiter.

### 25.3 Routing stays a thin decision

The §18 router becomes "pick the endpoint/table by priority":

```
route(job):
  P0|P1  ->  POST /fg/jobs   (jobs-fg, Replicate/Kie, edge-throttled)
  P2|video -> POST /bg/jobs  (jobs-bg, ModelsLab, 8/7 floors)
```

Same slim payload, same `acquire`/`release`/status contract — only the base URL
and target table differ. Consumers select the endpoint by whether the work is
interactive; nothing else in §24.8 changes.

### 25.4 Per-table Valkey migration (the clean Phase-2 boundary)

Because each class is isolated, **you migrate to Valkey one table at a time,
starting where it pays most**: foreground benefits first from Valkey's sub-second
wake-ups and live quota counters, so swap `jobs-fg`'s gate to Valkey when its
latency/throughput demands it, while `jobs-bg` (throughput-bound, latency-tolerant)
stays on DynamoDB longer. The `acquire`/`release`/`enqueue` interface (§11) is
identical, so each migration is a backend swap behind the same endpoint — no
consumer change, no big-bang.

**Summary:** start lean with **one DynamoDB table** (§24); scale by **cloning the
pattern into a second table** for the foreground/priority class, fronted by its
own API-Gateway-throttled endpoint and its own provider-sized semaphore (§25);
then graduate hot tables to Valkey individually (§25.4) — each step additive,
isolated, and behind a stable interface.

---

## 26. Generation failure handling

Two invariants govern everything below:

> **I1 — A slot is released on *every* terminal path** (success, failure,
> timeout). A failure must never leak a permit.
> **I2 — `leaseExpiry` + the sweeper is the universal backstop.** If anything
> dies before it can release (crashed execution, failed `Release` write, lost
> `StartExecution`), the sweeper reclaims the slot. So no failure mode can
> permanently shrink the pool.

### 26.1 Classify first: transient vs terminal

| Class | Examples | Handling |
|---|---|---|
| **Transient** | `429` (ModelsLab queue full despite our gate), 5xx, network timeout, the video `fetch` "processing / Try Again" (§17.1) | **Retry in place**, slot held, honour `retry_after` |
| **Terminal-retryable** | poll exceeded max attempts, download/S3-upload error, malformed-but-recoverable output | **Release slot → retry from `QUEUED`** up to the attempts budget |
| **Terminal-permanent** | content-moderation rejection, invalid/blocked prompt, `4xx` bad input | **No blind retry** — optional one-shot remediation, else fail fast |
| **Terminal-provider** | `402` insufficient credits, key disabled, account suspended | **Fail the whole provider over** (§27): OPEN its circuit, alarm ops, route to next ladder rung — it's an account problem, not a job problem |
| **Infra crash** | Lambda/SFN/host dies mid-job, `Release` write fails | **Sweeper** reclaims via `leaseExpiry` (I2) |

The Submit/Poll step maps provider responses to typed errors
(`ProviderThrottled`, `ProviderServerError`, `ProviderBadInput`,
`States.Timeout`) so the state machine can branch correctly.

### 26.2 In-flight: Step Functions `Retry` (transient) + `Catch` (terminal)

```jsonc
"SubmitJob": {
  "Type": "Task",                       // Lambda or HTTP Task -> ModelsLab
  "Retry": [
    { "ErrorEquals": ["ProviderThrottled","ProviderServerError","States.Timeout"],
      "IntervalSeconds": 5, "BackoffRate": 2.0, "MaxAttempts": 5,
      "JitterStrategy": "FULL" }       // exponential backoff + jitter (§9)
  ],
  "Catch": [
    { "ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": "HandleFailure" }
  ],
  "Next": "PollStatus"
}
```

* **Transient → in-place retry**, the slot stays held (the job legitimately still
  owns it). For a server-specified `retry_after`, route the `429` to a
  `Wait`(seconds=`$.retry_after`) → loop, rather than a fixed interval. Report the
  `429` to the AIMD controller so the **global limit backs off** fleet-wide (§9).
* **Anything terminal → `Catch` → `HandleFailure`**, which **always runs
  `ReleaseSlot`** first (I1).

### 26.3 Terminal path: release → retry budget → dead-letter

```
HandleFailure  (ReleaseSlot + attempts++ + record reason)
      │
   DecideRetry (Choice)
      ├── attempts < MAX  &  error is retryable ──▶ Requeue (status=QUEUED)  → re-enters FIFO
      └── else ───────────────────────────────────▶ MarkDead (status=DEAD)  → DLQ-equivalent
```

* **Requeue** sets `status=QUEUED` and re-enters the lane. Keep the original
  `enqueueSeq` so a retry doesn't lose its place *but* cap `attempts` so a poison
  job can't head-of-line-block the lane forever.
* **`status=DEAD`** is the dead-letter state: emit a `job.failed` event, raise a
  CloudWatch alarm on DEAD-rate, and surface it to the requestor (§26.6). No
  separate DLQ infra — it's a status value on the same table.
* **`ProviderBadInput`** skips the retry loop (or takes a single remediation pass —
  e.g. `remediate_image_prompt` already exists) then goes straight to `DEAD`.

### 26.4 The sweeper: catch everything the happy path missed

A crash between `acquire` and `Release` — failed `StartExecution`, dead SFN
execution, failed `Release` write — would otherwise hold a slot forever. The
EventBridge-Scheduler sweeper (§24.3) closes this:

* Find `PROCESSING` items with `leaseExpiry < now` → **release the slot**
  (decrement counter) and **requeue or `DEAD`** by the same attempts rule.
* This makes the system **self-healing**: every failure mode is eventually
  consistent back to a correct slot count. Alarm on `leases_reclaimed` — a
  nonzero rate is your crash/leak signal (§12).
* Long jobs (video) extend `leaseExpiry` via heartbeat (§6) so a *healthy* long
  job is never mistaken for a crash.

### 26.5 Idempotency & cache safety on retry

* **Deterministic `jobId`** (content hash, reuse `stable_hash`) + a fixed
  `s3Target` make submit, upload, and requeue **idempotent** — a retry can't
  create duplicate assets, and a job that actually succeeded before a crash is
  caught by the **cache check** at re-admit (so it never re-burns a slot).
* **Never cache a failure.** Write to the result cache (§10) **only** on verified
  success; partial/failed outputs are discarded so the next attempt regenerates.

### 26.6 Graceful degradation — the request survives a job failure

Per-job isolation means one dead asset shouldn't kill the documentary. On a
terminal `DEAD`, the consumer falls back along the **existing asset chain** rather
than aborting:

* **Video (i2v) fails →** use the **already-generated still image** (the i2v input
  already exists) as a static scene; or drop to the renderer's existing
  **background-mode** chain (`footage → pexels-image → generated-image → text-only`).
* **Image fails →** next provider/model in the chain, then `text-only`.
* **TTS/SFX fails →** render without that audio layer (SFX is optional; a missing
  scene-SFX degrades gracefully).

The request completes as **`COMPLETE_WITH_FALLBACKS`** (a distinct status) and
proceeds — consistent with the repo's existing "accept partial results" stance.
A request only hard-fails if a *required* asset (e.g. all scenes) is unrecoverable.

### 26.7 What the requestor sees

The status API returns the terminal state and reason, so the poller (or
`job.complete`/`job.failed` subscriber) can act:

```
GET /jobs/{id} -> { status: "COMPLETE" , assetKey }                 # use it
              -> { status: "COMPLETE_WITH_FALLBACKS", assetKey,     # use fallback asset
                   degraded: [{ jobId, reason }] }
              -> { status: "DEAD", reason, attempts }               # required asset lost -> handle/alert
```

Failures are thus **observable** (typed reason + metrics by model/provider via the
§20 `outcome` field), **bounded** (attempts budget), **non-leaking** (I1 + I2), and
**non-fatal where possible** (fallbacks). Net: a generation failure costs at most a
bounded set of retries and, at worst, a gracefully degraded scene — never a stuck
slot or a wedged pipeline.

---

## 27. Provider failover & circuit breaking — keep generating through an endpoint outage

§26 keeps a *job* from leaking a slot. This section keeps the *pipeline* from
stopping when an **endpoint** (not the input) is the problem — a ModelsLab outage,
a model 5xx storm, sustained `429`s. The principle: **fail over to an equivalent
provider first; degrade quality only when the whole ladder is exhausted.**

### 27.1 Two fallbacks, tried in order

1. **Provider failover (same asset, different endpoint)** — re-route the *same*
   job to the next capable provider/model. Quality preserved. Tried **first**.
2. **Quality degradation (§26.6)** — static image / stock / text-only. Tried
   **only after** every provider in the ladder is unavailable.

### 27.2 Per-asset provider ladders

Define, per asset type, an ordered ladder of equivalent generators (your codebase
already has the pieces — `VALID_IMAGE_PROVIDERS = {gemini, replicate, modelslab,
kie}`, a Gemini TTS path, the Pexels/Pixabay chains):

| Asset | Ladder (try top→down) | Last resort |
|---|---|---|
| **Video (i2v)** | `modelslab:wan-2.2-i2v` → `replicate:<i2v>` → `kie:<i2v>` → **`synthetic:ken-burns`** → `stock:pexels-video` | static image (§26.6) |
| **Image** | `modelslab:gemini-3.1-t2i` → `replicate:nano-banana-2` → `gemini:nano-banana` → `kie:*` → `stock:pexels-image` | text-only |
| **TTS** | `modelslab:inworld-tts-1` → `gemini:tts` | render without VO (rare; usually required) |
| **SFX** | `modelslab:sfx` | skip the SFX layer |
| **LLM** | `modelslab:chat` → `gemini`/`claude` | n/a (script is upstream) |

> The **`synthetic:ken-burns`** rung is the key guarantee for *video specifically*:
> a programmatic pan/zoom on the already-generated still (pure Remotion, **no API**)
> means an animated scene can always be produced even if **every** i2v provider is
> down. Video generation literally cannot stop.

### 27.3 Job-level failover flow

Extend the `DecideRetry` branch (§26.3) with a "try next provider" step before any
degrade/DEAD:

```
on terminal-retryable / endpoint error on provider A:
   if attempts < MAX  and  circuit(A) CLOSED        -> requeue on A          (same rung)
   else if ladder has a next healthy rung B          -> providerIndex++,      (failover)
                                                        requeue on B's table/lane
   else if a degrade option exists (§26.6)           -> degrade
   else                                              -> DEAD
```

Re-enqueueing to provider B means writing the job to **B's table/lane** (§25) with
its `provider/model` swapped and `attempts` reset for the new rung (but a global
`ladderIndex` so it can't loop forever). Same slim payload, same `s3Target`, so the
asset still lands in the right project folder.

### 27.4 Circuit breaker — why the pipeline doesn't *stall* during an outage

Per-job failover alone is too slow in a real outage: every job would first exhaust
its retries against the dead endpoint. A **circuit breaker per `(provider,
endpoint)`** flips routing for *all* jobs the moment an endpoint is unhealthy:

* **State** lives in the same store (a `HEALTH#{provider}:{endpoint}` item; Valkey
  counters in Phase 2). Track a rolling error rate over a short window.
* **CLOSED → OPEN** when `errorRate > threshold` over `≥ minSamples` in the window.
  While **OPEN**, the router **skips that rung at admit time** — new jobs start at
  the next healthy provider immediately, *without* wasting retries or slots on the
  dead endpoint.
* **OPEN → HALF-OPEN** after a cooldown: let a few probe jobs through; on success
  **CLOSE** (resume normal routing), on failure re-**OPEN**.
* Works hand-in-hand with the **AIMD limiter** (§9): `429` bursts both lower the
  global budget *and* feed the breaker.

This is what makes "the video generation does not stop" true in practice: the
first few failures trip the breaker, then the whole fleet routes around the outage
to Replicate/Kie/synthetic until ModelsLab recovers.

### 27.5 Don't let failover starve foreground

Failing **background** ModelsLab video over to **Replicate/Kie** consumes the
foreground providers' budget (§25). Guard it:

* Re-enqueue failed-over background jobs at **low priority** into the target
  provider's table, so interactive foreground work still wins contention.
* Optionally reserve a small **failover budget** in `jobs-fg` so an outage can
  drain elsewhere without ever exhausting interactive capacity.
* Prefer the **`synthetic:ken-burns`** rung for background video under a ModelsLab
  outage — it consumes **no provider budget at all**, so a long outage degrades to
  motion-on-stills rather than competing for foreground slots.

### 27.6 Config & observability

```ini
ASSET_LADDER_VIDEO=modelslab:wan-2.2-i2v,replicate:i2v,kie:i2v,synthetic:ken-burns,stock:pexels-video
ASSET_LADDER_IMAGE=modelslab:gemini-3.1-t2i,replicate:nano-banana-2,gemini:nano-banana,kie:t2i,stock:pexels-image
ASSET_LADDER_TTS=modelslab:inworld-tts-1,gemini:tts
ASSET_LADDER_SFX=modelslab:sfx
CIRCUIT_ERROR_THRESHOLD=0.5         # open above 50% errors
CIRCUIT_WINDOW_SECONDS=60
CIRCUIT_MIN_SAMPLES=5
CIRCUIT_OPEN_COOLDOWN_SECONDS=30
CIRCUIT_HALFOPEN_PROBES=2
FAILOVER_BACKGROUND_PRIORITY=lowest # don't starve foreground (§27.5)
```

Emit: `circuit_state{provider,endpoint}` (0/1), `failover_total{from,to,assetType}`,
and a `running_on_fallback` gauge — so a dashboard shows at a glance *that* you're
on fallback, *which* provider is down, and *how much* quality degradation
(synthetic/stock rungs) is in play. Alarm on circuit-OPEN and on
`synthetic`/`stock` rung usage exceeding a baseline.

**Bottom line:** an endpoint failure first **fails over** to an equivalent provider
(quality intact); a *sustained* endpoint outage **trips the breaker** so the whole
fleet routes around it instantly; and the **`ken-burns` synthetic rung** guarantees
a video scene is always producible with zero external dependency. Combined with
§26, the pipeline keeps running through transient errors, bad inputs, infra
crashes, **and** full provider outages.

### 27.7 Where to maintain the fallback — centrally (with one exception)

**Maintain the fallback logic centrally.** The reasons are structural, not
stylistic:

* **Endpoint health is a global fact.** A per-consumer circuit breaker is useless —
  each process would independently rediscover the outage and burn its own retries,
  with no coordinated routing. The breaker only works if its state is **shared**,
  which means it lives where the semaphore lives (DynamoDB `HEALTH#` item / Valkey).
* **Routing policy must be consistent and changeable without redeploys.** If
  ladders live in each consumer, they drift across StoryStudio/Remotion/users, and
  reordering providers mid-incident ("ModelsLab is down, prefer Replicate") would
  require redeploying every producer. Centrally, it's a **runtime config change**.
* **Quartermaster already owns the per-provider tables, budgets, and metering
  (§25, §20).** It's the only component that knows every provider's live health and
  free capacity, so it's the only one positioned to pick the next rung correctly
  and budget-aware (§27.5).

**What lives where:**

| Concern | Owner | Why |
|---|---|---|
| Provider ladders (order per asset type) | **Central, as data-driven config** (DynamoDB/SSM Parameter Store) | reorder at runtime during an incident, no deploy |
| Circuit-breaker state | **Central store** | global fact; shared by all consumers |
| Failover decision + re-enqueue to next provider | **Central** (the `DecideRetry`/router, §27.3) | needs health + budgets it already owns |
| API-provider rungs (ModelsLab→Replicate→Kie→stock) | **Central** | they are asset-generation API calls it brokers |
| Failover metering / `running_on_fallback` | **Central** (§20) | one dashboard, one source of truth |
| **Pure-render terminal degrade** (`ken-burns`, `text-only`) | **Consumer (Remotion renderer)** | not an API call — it's a *rendering* operation the compositions already own (the background-mode chain) |

So the consumer stays dumb: it **submits one job** ("video for scene X") and the
central system **transparently walks the API ladder** (ModelsLab → Replicate → Kie
→ stock), returning either the asset (tagged with which rung served it +
`degraded?`) **or** a terminal `EXHAUSTED_API_OPTIONS` signal. Only on that signal
does the consumer invoke its **local, no-API** degrade — Ken Burns on the existing
still, or text-only — because that is a render decision, not a generation call.

> **Migration note — remove the per-consumer loops.** Today `asset_pipeline.py`
> (`ensure_generated_image`, the model/provider loop) and the per-handler poll
> loops do their *own* provider fallback in-process. Once failover is central,
> **delete those local loops**, or you get two uncoordinated failover layers
> (double retries, conflicting order, no shared breaker). Keep only the
> render-only terminal degrade in the consumer; the central ladder owns everything
> up to that point.

---

## 28. Capability Catalog + provider adapters (the single place to change providers)

This realizes the §27.7 decision concretely. Two pieces:

1. **Capability Catalog** — a *central, data-driven* map from
   `(assetType, tier, operation)` → an **ordered provider ladder**. Change a
   provider here, and every product/consumer picks it up with **no redeploy**.
2. **Provider adapters** — per provider, the code that **translates one canonical
   request into that provider's request shape** (and its response back). This is
   what "modify the request as per the provider" means: on failover the executor
   hands the *same canonical job* to the next rung's adapter, which re-shapes it
   for that provider — so a ModelsLab→Replicate→Kie hop never fails for payload
   mismatch.

### 28.1 Where the catalog lives

There are **two catalogs** (§28.4.1) — `background` (free/ModelsLab) and
`foreground` (premium/Kie+Replicate) — each stored as **versioned central config**,
hot-reloadable, separate from code, selected by the request's queue tag:

* **DynamoDB config items** — `PK=CATALOG#{queue}` (`#background` / `#foreground`),
  `SK={assetType}#{tier}#{operation}`, value = the ordered ladder. Same store you
  already run; cache in-process with a short TTL. **Recommended** (queryable,
  low-latency).
* or **SSM Parameter Store / S3 JSON** — native versioning + change history if you
  prefer config-as-parameter.

Either way it carries a `version` so a bad edit is auditable and revertible, and a
change to "prefer Replicate over ModelsLab for image-basic today" is a one-line
config write — exactly the "central place to change the provider" you asked for.

### 28.2 The catalog (updated global catalog)

Each rung = `{provider, model, routingMode}`. `routingMode`: `aggregated`
(ModelsLab/Kie fronts the model) or `direct` (native provider API). `(fb)` = the
cross-provider fallback rung.

| Asset | Tier | Op | Order | Provider | Model (ref) |
|---|---|---|---|---|---|
| **Image** | Basic | t2i | 1 | modelslab | `qwen-text-to-image` |
| | | | 2 | modelslab | `flux-klien-9B` |
| | | | 3 (fb) | replicate | `black-forest-labs/flux-2-klein-9b` |
| **Image** | Basic | i2i | 1 | modelslab | `qwen-Image-to-Image` |
| | | | 2 | modelslab | `flux-klien-9B-image-to-image` |
| | | | 3 | modelslab | `google/nano-banana-2-text2image` |
| | | | 4 (fb) | replicate | `black-forest-labs/flux-2-klein-9b` |
| **Image** | Premium | t2i | 1 | modelslab | `qwen-text-to-image` |
| | | | 2 | modelslab | `alibaba_cloud/qwen-image-2.0-pro-text-to-image` |
| | | | 3 | modelslab | `google/nano-banana-2-image-edit` |
| | | | 4 (fb) | kie | `google/nanobanana2` |
| **Image** | Premium | i2i | 1 | modelslab | `qwen-Image-to-Image` |
| | | | 2 | modelslab | `alibaba_cloud/qwen-image-2.0-pro-text-to-image` |
| | | | 3 (fb) | kie | `google/nanobanana2` |
| **Video** | Basic | — | 1 | *consumer* | `ken-burns` / `basic-animation` (render-side, **no API / no slot**) |
| **Video** | Premium | i2v | 1 | modelslab | `wan-2.2-i2v` |
| | | | 2 (fb) | replicate | `wan-video/wan-2.2-i2v-fast` |
| **Lipsync** (spokesperson) | Documentary **Premium 1 & 2** (foreground) | img+audio→video | 1 | **runpod** | `infinitetalk` |
| | | | 2 (fb) | *consumer* | static spokesperson image (no lip motion) |
| **Movie** | Basic | image | — | → reuses **Image Premium** ladder | (qwen → qwen-2.0-pro → nano-banana-2 → kie) |
| **Movie** | Basic | video (i2v) | 1 | kie | `bytedance/seedance-1-5-pro` |
| | | | 2 (fb) | replicate | `bytedance/seedance-1.5-pro` |
| **Movie** | Premium | image | — | → reuses **Image Premium** ladder, **Nano-Banana-2** rung | `google/nano-banana-2-image-edit` → kie `google/nanobanana2` |
| **Movie** | Premium | video (i2v) | 1 | kie | `bytedance/seedance-2-fast` |
| | | | 2 (fb) | replicate | `bytedance/seedance-2.0-fast` |
| **Voice** | Basic | tts | 1 | modelslab | `text-to-speech` |
| | | | 2 (fb) | replicate | `jaaari/kokoro-82m` |
| **Voice** | Premium | tts | 1 | google (direct) | `gemini-3.1-flash-tts-preview` |
| **SFX** | — | — | 1 | modelslab | `sfx` |
| **BGM** | Basic | — | 1 | modelslab | `ai-music-generator` |
| **BGM** | Premium | — | 1 | kie | `suno generate-music` |
| **LLM** | — | — | 1 | anthropic / openai / google (direct) | direct provider API |

**Source endpoints (for the adapters to resolve API URL + `model_id`):**

| Rung | Endpoint |
|---|---|
| Image Basic t2i — qwen | `modelslab.com/models/modelslab/qwen-text-to-image` |
| Image Basic t2i — flux | `modelslab.com/models/modelslab/flux-klien-9B` |
| Image Basic t2i — fb | `replicate.com/black-forest-labs/flux-2-klein-9b/api` |
| Image Basic i2i — qwen | `modelslab.com/models/modelslab/qwen-Image-to-Image` |
| Image Basic i2i — flux | `modelslab.com/models/modelslab/flux-klien-9B-image-to-image` |
| Image Basic i2i — nano-banana-2 | `modelslab.com/models/google/nano-banana-2-text2image` |
| Image Basic i2i — fb | `replicate.com/black-forest-labs/flux-2-klein-9b/api` |
| Image Prem t2i — qwen-2.0-pro | `modelslab.com/models/alibaba_cloud/qwen-image-2.0-pro-text-to-image` |
| Image Prem t2i — nano-banana-2 | `modelslab.com/models/google/nano-banana-2-image-edit` |
| Image Prem — fb (Kie) | `docs.kie.ai/market/google/nanobanana2` |
| Video Prem i2v — wan | `modelslab.com/models/modelslab/wan-2.2-i2v` |
| Video Prem i2v — fb | `replicate.com/wan-video/wan-2.2-i2v-fast/api` |
| Movie Basic video — Kie | `docs.kie.ai/market/bytedance/seedance-1-5-pro` |
| Movie Basic video — fb | `replicate.com/bytedance/seedance-1.5-pro/api` |
| Movie Prem video — Kie | `docs.kie.ai/market/bytedance/seedance-2-fast` |
| Movie Prem video — fb | `replicate.com/bytedance/seedance-2.0-fast/api` |
| Voice Basic — fb | `replicate.com/jaaari/kokoro-82m/api` |
| Lipsync — RunPod run | `POST https://api.runpod.ai/v2/infinitetalk/run` — header `Authorization: Bearer $RUNPOD_API_KEY` |
| Lipsync — RunPod status | `GET https://api.runpod.ai/v2/infinitetalk/status/{job_id}` — header `Authorization: Bearer $RUNPOD_API_KEY` |
| BGM Basic | `modelslab.com/models/modelslab/ai-music-generator` |
| BGM Premium | `docs.kie.ai/suno-api/generate-music` |
| **FG** Image Prem — Kie nano-banana | `docs.kie.ai/market/google/nano-banana` |
| **FG** Image Prem — fb (Replicate) | `replicate.com/google/nano-banana/api` |
| **FG** SFX — Replicate audiogen | `replicate.com/sepal/audiogen/api` |
| **FG** BGM Basic — Google Lyria | Google API, model `lyria-3-pro-preview` |

> Rows above the **FG** markers are the **background** (free) catalog; rows marked
> **FG** are **foreground** (premium) — full ladders in §29.1. Foreground reuses
> the same Kie/Replicate Seedance + Suno + kokoro endpoints already listed.

Notes:
* **Video-basic costs no generation slot** — it's the consumer-side Ken Burns /
  basic-animation render (§27.2), so the queue/limiter only governs *premium*
  and *movie* video. Good for budget.
* **Lipsync (RunPod InfiniteTalk) depends on TWO upstream assets** — the
  spokesperson **image** *and* the **TTS audio** must be `COMPLETE` first; the
  orchestrator schedules the lipsync job only after both finish (a 2-parent
  dependency, like image→video but with audio added). It's a **long, GPU-bound,
  `lane:video`** job → use the callback/long-lease path (§22/§29.4). Fallback is the
  consumer-side **static spokesperson image** (no lip motion), so a RunPod outage
  degrades the talking-head to a still rather than stopping the documentary.
* **Movie images reuse the Image-Premium ladder** (catalog *aliasing*, not
  duplication): Movie-Basic → the full Image-Premium ladder; Movie-Premium → the
  **Nano-Banana-2** rung specifically. One change to Image-Premium propagates to
  Movie automatically.
* **Movie video routes via Kie (primary) → Replicate (fallback)** — both are
  existing providers in the registry, so Movie needs **no new limiter**, only the
  Seedance catalog rungs. (Earlier "call providers directly" is superseded by this
  Kie/Replicate routing.)
* `(fb)` rungs are cross-provider; the breaker (§27.4) skips an unhealthy rung so a
  new job starts directly on the next one.

### 28.3 Canonical request → per-provider adapter

The Lambda sends **one provider-agnostic request**; Quartermaster never makes the
caller know provider shapes.

```jsonc
// canonical request (what the Lambda/consumer sends — slim, §23)
{
  "assetType": "image", "tier": "premium", "operation": "t2i",
  "product": "documentary", "requestId": "...", "jobId": "...",
  "prompt": "…",
  "initImageKey": "…/v3-f2.png",        // for i2i / i2v
  "params": { "aspectRatio": "16:9", "resolution": "1K", "durationS": 5 },
  "s3Target": "…/<project folder>/v3-f2.png",
  "platform": "storystudio", "projectId": "…", "priority": "P2"
}
```

Each provider implements a small **adapter** interface:

```
adapter(provider) = {
  buildRequest(canonical, model) -> { url, headers, body }   // map canonical -> provider shape
  parseResult(raw)              -> { outputUrls } | needsPoll(id|fetchUrl)
  classifyError(raw, httpCode)  -> Transient | TerminalRetryable | TerminalPermanent
}
```

* **ModelsLab adapter** — sets `key`, `model_id`, `prompt`, `init_image`,
  `aspect_ratio/resolution/num_frames/fps` per the existing payloads
  (`asset_pipeline.py`, `sfx_gen.py`); handles the `id`→`fetch` poll incl. the
  "Try Again/processing, no id" quirk (§17.1).
* **Replicate adapter** — `Authorization: Token …`, `{version|model, input:{…}}`,
  prediction-poll; e.g. `flux-2-klein-9b`, `wan-2.2-i2v-fast`, `kokoro-82m`.
* **Kie adapter** — its market API shape + task poll (`nanobanana2`, Suno music).
* **Google/Anthropic/OpenAI adapters** — native SDK/HTTP for TTS / LLM.

`buildRequest` is exactly "**modify the request as per the provider**": same
canonical job, different wire format per rung. On failover the executor just calls
the **next rung's adapter**, so the request is always correctly shaped for whoever
actually serves it.

> **Secrets never live in the catalog or payloads.** Every adapter injects its
> credential from env/secret manager (`MODELSLAB_API_KEY`, `REPLICATE_API_TOKEN`,
> `KIE_AI_API_KEY`, …) at send time — the `"key"`/`Authorization` field is **never**
> stored in the catalog, the job item, or any logged payload. (If a live key is
> ever pasted into a ticket/curl, rotate it.)

#### 28.3.1 ModelsLab model resolution — **per-model** request shape (exact)

The shape differs by model *and* API version, so the ModelsLab adapter keys its
template on `model`. Resolved from the confirmed payloads:

| Catalog model | API URL | `model_id` | Size param | i2i / extra params |
|---|---|---|---|---|
| `flux-klien-9B` (Basic t2i) | `/api/v6/images/text2img` | `flux-klein` | `width`,`height` (strings), `samples` | — |
| `flux-klien-9B-image-to-image` (Basic i2i) | `/api/v6/images/img2img` | `flux-klein` | `samples` | `init_image:[…]`, `strength`, `enhance_prompt` |
| `alibaba_cloud/qwen-image-2.0-pro-text-to-image` (Prem t2i) | `/api/v7/images/text-to-image` | `qwen-image-2.0-pro-t2i` | `size:"W*H"` (note `*`) | — |
| `alibaba_cloud/qwen-image-2.0-pro` (Prem i2i) | `/api/v7/images/image-to-image` | `qwen-image-2.0-pro-i2i` | `size:"W*H"` | `init_image:[…]` |
| `qwen-*` / `gemini-3.1-t2i` / `nano-banana-2*` (existing) | `/api/v6 text2img` or `/api/v7 text-to-image` | per `asset_pipeline.py` | `width/height` (v6) or `aspect_ratio`+`resolution` (v7) | `init_image:[…]` (v7 i2i) |

**Canonical → ModelsLab param mapping** the adapter performs:

```
canonical.prompt                      -> "prompt"
canonical.params.aspectRatio/res      -> v6: "width"+"height"     (e.g. "1024"/"1024")
                                         v7 qwen: "size":"1024*1024"
                                         v7 gemini/nano: "aspect_ratio"+"resolution"
canonical.initImageKey(s) -> CDN URL  -> "init_image": [ "<public url>" ]   # S3 key resolved to public URL
                                         (+ "strength","enhance_prompt" for flux i2i)
env MODELSLAB_API_KEY                  -> "key"          # injected at send, never stored
+ "samples":"1", "model_id": <table>
```

Two things the adapter must own:
* **`size` formatting differs** — v6 uses separate `width`/`height`; v7-qwen uses a
  single `size:"W*H"` with a literal `*`; v7-gemini/nano uses `aspect_ratio` +
  `resolution`. The canonical request stays `{aspectRatio, resolution}`; the adapter
  formats per model.
* **`init_image` is always an array of *public URLs*** — the adapter resolves the
  canonical `initImageKey` (S3) to a public/CDN URL before sending (ModelsLab
  fetches it), exactly as `_modelslab_i2i_generate_image` does today.

This is why the adapter is keyed on **model**, not just provider: one ModelsLab
"provider" spans v6 and v7 endpoints with three different size encodings — the
catalog ref selects the right template.

#### 28.3.2 Kie adapter (Seedance, Nano-Banana-2, Suno) — unified create + callback

Kie has **one create pattern** for market models and a separate Suno endpoint;
both are **async with `taskId` + optional `callBackUrl` webhook**, base
`https://api.kie.ai`, auth `Authorization: Bearer ${KIE_AI_API_KEY}`.

| Concern | Value |
|---|---|
| Market create (Seedance, Nano-Banana-2) | `POST /api/v1/jobs/createTask`, body `{model, callBackUrl?, input:{…}}` |
| Market poll | unified *Get Task Details* (`/api/v1/jobs` task-detail) by `taskId` |
| Suno create (BGM Premium) | `POST /api/v1/generate`, body `{prompt, customMode, instrumental, model:"V4_5", style?, title?, callBackUrl?}` |
| Suno poll | `GET /api/v1/generate/record-info?taskId=…` → `data.response.sunoData[].audioUrl` |
| Submit response | `{code:200, msg, data:{taskId}}` (any non-200 `code` = submit failure) |

**Per-model `input` templates** (canonical → Kie):

```
nano-banana-2 (image):     { prompt, image_input:[urls…(≤14)], aspect_ratio, resolution:"1K|2K|4K", output_format:"png" }
bytedance/seedance-1.5-pro: { prompt, input_urls:[url…(0-2)], aspect_ratio(REQ), resolution:"480p|720p|1080p", duration:"4|8|12"(STRING,REQ), fixed_lens, generate_audio }
bytedance/seedance-2-fast:  { prompt, first_frame_url:url, last_frame_url?, reference_image_urls?:[…], aspect_ratio(REQ), resolution:"480p|720p", duration:int(4-15), generate_audio }
```

**Error map** (`code`): `429`→Transient(throttle, AIMD); `455/500/408/501`→Transient/retryable;
`402`→**TerminalProvider** (insufficient credits — *alarm ops, fail the whole Kie
provider over, do not retry*); `422`→TerminalPermanent (bad input); `433`→Transient
(sub-key limit); `505`→TerminalPermanent (feature disabled).

> **Use the webhook, not polling.** Set `callBackUrl` to a gateway endpoint that
> maps the `taskId`→SFN task token and calls `SendTaskSuccess` (§22 Option A).
> Seedance/Suno can run minutes; callback-driven completion avoids poll cost and
> the 15-min Lambda cap entirely. Keep the *Get Task Details* poll as a fallback
> for missed callbacks (the sweeper, §26.4).

#### 28.3.3 Replicate adapter (flux-2-klein-9b, wan-2.2-i2v-fast, seedance-2.0-fast, kokoro)

One pattern: `POST https://api.replicate.com/v1/models/{owner}/{name}/predictions`
(or `/v1/predictions` with `version`), auth `Authorization: Bearer
${REPLICATE_API_TOKEN}`, body `{input:{…}, webhook?}`; poll
`GET /v1/predictions/{id}` until `status ∈ {succeeded,failed,canceled}`; `output`
is a **URL or array of URLs** (varies per model — adapter normalizes).

**Per-model `input` templates** (canonical → Replicate) + output shape:

```
black-forest-labs/flux-2-klein-9b (image): { prompt, images:[urls…(≤5)], aspect_ratio|"match_input_image",
                                             output_megapixels, output_format, output_quality, go_fast:true }  -> output: [url]
wan-video/wan-2.2-i2v-fast (i2v):          { prompt, image:url(REQ), last_image?, num_frames:81, resolution:"480p",
                                             frames_per_second:16, go_fast:true, sample_shift, seed }            -> output: url
bytedance/seedance-2.0-fast (i2v):         { prompt, image:url(first frame), last_frame_image?, reference_images?:[…],
                                             duration:int|-1, resolution, aspect_ratio|"adaptive", generate_audio } -> output: url
jaaari/kokoro-82m (tts):                   { text, voice, speed }                                                  -> output: url(wav)
```

**Error map:** HTTP `429`→Transient(throttle); `5xx`/prediction `status=failed`
with transient detail→Transient/retryable; `422`/validation→TerminalPermanent;
`402`/billing→TerminalProvider (alarm + fail provider over). Replicate also
supports a `webhook` → same task-token completion as Kie (§22 Option A).

#### 28.3.4 Canonical fields the adapters consume (so all of the above resolve)

Because each model names things differently, the canonical request carries
*intent*, and adapters translate. Key normalizations the executor does once:

| Canonical | ModelsLab | Kie Seedance-1.5 | Kie Seedance-2 | Repl. WAN | Repl. Seedance-2 |
|---|---|---|---|---|---|
| `initImageKey` (i2v first frame) | `init_image:url` | `input_urls:[url]` | `first_frame_url:url` | `image:url` | `image:url` |
| `params.durationS` | **fixed** `num_frames:"82"`, `fps:"16"` (≈5s) | `"4\|8\|12"` (snap) | `int 4–15` | `num_frames`+`fps` | `int` (or `-1`) |
| `params.resolution` | `"480"` | `"480p\|720p\|1080p"` | `"480p\|720p"` | `"480p"` | string |
| `params.aspectRatio` | n/a | `aspect_ratio`(req) | `aspect_ratio`(req) | via resolution | `aspect_ratio\|"adaptive"` |
| image i2i refs | `init_image:[…]` | `image_input:[…]`(nano) | — | `images:[…]`(flux) | `reference_images:[…]` |

* **All input images are public URLs** — the adapter resolves the canonical S3
  `initImageKey`/`imageKeys` to a public/CDN URL first (as ModelsLab/Kie/Replicate
  all fetch by URL).
* **Duration normalization** is a shared helper: canonical `durationS` → snap to
  each model's allowed encoding (string-enum vs int vs `num_frames=round(s*fps)`).
  **ModelsLab WAN 2.2 i2v is the exception — it uses fixed defaults
  `num_frames:"82"`, `fps:"16"` (≈5s), not derived from `durationS`.** The adapter
  sends `init_image`, `prompt`, `negative_prompt`, `resolution`, `num_frames:"82"`,
  `fps:"16"`, `output_type` for this rung (matching the current
  `asset_pipeline.py` payload).
* **Output normalization:** `parseResult` returns a list of URLs whether the
  provider gives a bare string (WAN, Seedance, kokoro) or an array (flux, ModelsLab).

### 28.4 The execute-with-failover loop

```
catalog = catalogs[job.queue]      # §28.4.1 — "background"(free/ModelsLab) | "foreground"(premium/Kie+Replicate)
ladder  = catalog.get(assetType, tier, operation)       # no runtime filtering — the file already excludes the wrong providers
for rung in ladder:
    if circuit(rung.provider, rung.model) == OPEN: continue        # skip dead endpoint (§27.4)
    if not limiter[rung.provider].acquire(job): enqueue/wait; continue   # per-provider budget (§25)
    req = adapter[rung.provider].buildRequest(canonical, rung.model)     # <-- per-provider request
    try:
        raw = send(req); result = adapter[rung.provider].poll/parse(raw)
        upload(result -> s3Target); release; record(served_by=rung); return COMPLETE(degraded = rung.isFallback)
    except err:
        cls = adapter[rung.provider].classifyError(err)
        feedCircuit(rung, cls); release
        if cls == Transient and attempts<max: retry same rung (§26.2)
        else: continue          # advance to next rung (failover)
# ladder exhausted:
return EXHAUSTED_API_OPTIONS    # consumer does render-only degrade (ken-burns/text-only, §27.7)
```

This is precisely your flow: *receive request from Lambda → match to provider →
send → on failure go to the fallback and re-shape the request for that provider*,
with the slot gate, circuit breaker, and attribution wired in.

#### 28.4.1 Two catalogs, selected by tag (the free/paid boundary is a file, not a filter)

There are **two catalog files**, and the router picks one by the request's tag —
no runtime ladder filtering:

| Catalog | Serves | Providers | Selected when |
|---|---|---|---|
| **`catalog.background.json`** | **free tier** — Narration basic/premium, Documentary basic, via batch jobs | **ModelsLab** primary (→ Replicate/Kie only as *generation* fallback) | request tagged `free`/`background` (MCP `batchjob`) → **new background app** |
| **`catalog.foreground.json`** | **premium / paid** — Movie, Documentary/Narration premium, all priority/interactive | **Kie + Replicate** (+ Google TTS/LLM, RunPod lipsync); **no ModelsLab** | request tagged `premium`/`paid`/`foreground` → **existing SFNs** |

* **ModelsLab = free-tier funnel only.** It is the **freemium quality-preview**:
  users generate on it (batch) to *test quality*, which converts them to paid.
  ModelsLab never appears in `catalog.foreground.json`.
* **Premium = Kie/Replicate (paid, extra tokens)** — elastic (no 15-slot queue)
  *and* premium-model: the double upgrade incentive, faster **and** better.
* **Why this resolves coexistence:** the two catalogs **share no provider on the
  contended account** — the paid path never touches ModelsLab — so the existing
  foreground SFNs and Quartermaster **cannot fight over the 15 slots**.

The execute-with-failover loop (§28.4) is unchanged except `catalog =
catalogs[job.queue]`. Each catalog still has its own `providers`/`circuit` block
and its own per-provider limiters (§28.5).

> **Asset placement decisions** the two-file split makes explicit:
> * **Lipsync (RunPod)** lives in **`foreground`** (premium); free Documentary-basic
>   uses the **static-spokesperson** render fallback (keeps free ≈ zero marginal cost,
>   and "your spokesperson talks when you upgrade" is a clean funnel hook).
> * **SFX / BGM-basic** are ModelsLab-only → they live in **`background`** only.
>   Paid audio extras use premium equivalents where they exist (BGM-premium = Kie
>   Suno); decide per-asset whether a paid request omits SFX or you add a non-
>   ModelsLab SFX rung.

### 28.5 Per-provider limiter registry

Because providers are now first-class, each gets its **own table + semaphore**
(§25), sized to that provider's real limit; the catalog only chooses *which*
provider, the registry enforces *how much*:

| Provider | Used for | Budget source |
|---|---|---|
| `modelslab` | primary: image/i2i/video-prem/tts-basic/sfx/bgm-basic (Narration, Documentary) | 15, **8 video / 7 rest** (§17) |
| `replicate` | fallback image/video/tts; **Movie video fallback (Seedance)** | Replicate account concurrency |
| `kie` | image-prem fallback (nanobanana2); BGM premium (Suno); **Movie video primary (Seedance 1.5-pro / 2-fast)** | Kie account limits |
| `google` | Voice Premium TTS; LLM | Google API quota |
| `anthropic` / `openai` | LLM (direct) | their per-key rate limits |
| `runpod` | **Lipsync / spokesperson (InfiniteTalk)** for Documentary **Premium 1 & 2** (foreground) | **10 parallel workers** (`RUNPOD_SAFE_LIMIT=10`); `lane:video`, long GPU jobs |

> Movie adds **no new provider** — Seedance is reached through `kie` (primary) and
> `replicate` (fallback), which already have limiters. Movie video does, however,
> become a meaningful consumer of the **Kie** budget, so size `KIE_SAFE_LIMIT`
> with Movie load (and Seedance's longer render times) in mind, and give Movie
> video its own video/rest-style floor within the Kie table if it competes with
> nanobanana2/Suno traffic there.

### 28.6 What the consumer/Lambda sends (and stops doing)

* Send the **canonical request** (§28.3) with `assetType/tier/operation/product` —
  **never a provider or model id**. The catalog resolves the ladder; swapping a
  provider is a central config change, invisible to the consumer.
* **Stop hardcoding model/provider** in `asset_pipeline.py` / handlers and **stop
  the local provider loops** (§27.7 migration note) — Quartermaster owns selection,
  failover, request-shaping, and limits.
* The only provider-shaped code that remains anywhere is **inside the adapters**,
  in one central place — so onboarding a new provider or re-ordering a ladder
  touches the catalog + one adapter, nothing else.

---

## 29. Implementation appendix (for a separate repo)

Everything below is self-contained so it can be lifted into the Quartermaster repo. It
covers: **(29.1)** the catalog seed JSON, **(29.2)** adapter interface + stubs
(TS & Python), **(29.3)** the Step Functions changes, **(29.4)** the webhook
ingress endpoint. Secrets are read from env at runtime — **never** committed.

### 29.1 Catalog seed — **two files** (`catalog.background.json`, `catalog.foreground.json`)

Per §28.4.1 the catalog is **split in two**, selected by request tag:

* **`catalog.background.json`** (free tier) — **ModelsLab-primary** rungs for
  Narration basic/premium + Documentary basic, with Replicate/Kie only as
  generation fallbacks. SFX + BGM-basic live here.
* **`catalog.foreground.json`** (premium/paid) — **Kie/Replicate (+Google, RunPod)**
  rungs for Movie, Doc/Narration premium, premium video, lipsync, premium voice/BGM.
  **No `provider:"modelslab"` anywhere in this file.**

Both share the **same schema** (shown below) and each carries its own
`providers`/`circuit` block. `lane` drives the ModelsLab 8/7 floor (§17);
`routingMode` ∈ `aggregated|direct|render`; `modelId`/`endpoint` are adapter hints
when the wire id differs from the catalog ref; `fb:true` marks a fallback rung.
Load each into its own config namespace (DynamoDB `PK=CATALOG#background` /
`PK=CATALOG#foreground`, or two SSM/S3 docs, §28.1).

Both files are given in full below.

> **Documentary product tiers** (which drive where RunPod/stock land):
> | Tier | Catalog | Recipe |
> |---|---|---|
> | **Documentary Basic** | background (free) | **basic image + free stock video** (Pexels/Pixabay); no RunPod, no AI video gen |
> | **Documentary Premium 1** | foreground (paid) | **RunPod lip-sync spokesperson + Remotion** (talking-head segments composed with premium image/video) |
> | **Documentary Premium 2** | foreground (paid) | **RunPod for the full documentary** (lip-sync drives the whole video) |
>
> So **lipsync/RunPod lives in `catalog.foreground.json`** (used by Documentary
> Premium 1 & 2 — they differ only in *how much* lipsync the recipe requests, not
> in the provider ladder). **Documentary Basic video = stock footage** in
> `catalog.background.json` (consumer-side Pexels/Pixabay, free, no generation
> slot). Premium1 vs Premium2 is a **product recipe** (how many lipsync jobs the
> orchestrator emits), not a catalog difference.

#### `catalog.background.json` (free tier / batch — ModelsLab-primary)

```json
{
  "version": "2026-06-09.1",
  "providers": {
    "modelslab": { "limit": 15, "floors": { "video": 8, "rest": 7 }, "secretEnv": "MODELSLAB_API_KEY" },
    "replicate": { "limit": 20, "secretEnv": "REPLICATE_API_TOKEN" },
    "kie":       { "limit": 10, "floors": { "video": 6, "rest": 4 }, "secretEnv": "KIE_AI_API_KEY" },
    "google":    { "limit": 8,  "secretEnv": "GOOGLE_API_KEY" },
    "anthropic": { "limit": 8,  "secretEnv": "ANTHROPIC_API_KEY" },
    "openai":    { "limit": 8,  "secretEnv": "OPENAI_API_KEY" }
  },
  "circuit": { "errorThreshold": 0.5, "windowSeconds": 60, "minSamples": 5, "openCooldownSeconds": 30, "halfOpenProbes": 2 },
  "ladders": {
    "image.basic.t2i": [
      { "provider": "modelslab", "model": "qwen-text-to-image", "modelId": "qwen", "endpoint": "v6/text2img", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "modelslab", "model": "flux-klien-9B", "modelId": "flux-klein", "endpoint": "v6/text2img", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "replicate", "model": "black-forest-labs/flux-2-klein-9b", "routingMode": "aggregated", "lane": "rest", "fb": true }
    ],
    "image.basic.i2i": [
      { "provider": "modelslab", "model": "qwen-Image-to-Image", "modelId": "qwen", "endpoint": "v6/img2img", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "modelslab", "model": "flux-klien-9B-image-to-image", "modelId": "flux-klein", "endpoint": "v6/img2img", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "modelslab", "model": "google/nano-banana-2-text2image", "modelId": "gemini-3.1-i2i", "endpoint": "v7/image-to-image", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "replicate", "model": "black-forest-labs/flux-2-klein-9b", "routingMode": "aggregated", "lane": "rest", "fb": true }
    ],
    "image.premium.t2i": [
      { "provider": "modelslab", "model": "qwen-text-to-image", "modelId": "qwen", "endpoint": "v6/text2img", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "modelslab", "model": "alibaba_cloud/qwen-image-2.0-pro-text-to-image", "modelId": "qwen-image-2.0-pro-t2i", "endpoint": "v7/text-to-image", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "modelslab", "model": "google/nano-banana-2-image-edit", "modelId": "gemini-3.1-t2i", "endpoint": "v7/text-to-image", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "kie", "model": "nano-banana-2", "endpoint": "v1/jobs/createTask", "routingMode": "aggregated", "lane": "rest", "fb": true }
    ],
    "image.premium.i2i": [
      { "provider": "modelslab", "model": "qwen-Image-to-Image", "modelId": "qwen", "endpoint": "v6/img2img", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "modelslab", "model": "alibaba_cloud/qwen-image-2.0-pro", "modelId": "qwen-image-2.0-pro-i2i", "endpoint": "v7/image-to-image", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "kie", "model": "nano-banana-2", "endpoint": "v1/jobs/createTask", "routingMode": "aggregated", "lane": "rest", "fb": true }
    ],
    "video.basic": [
      { "provider": "consumer", "model": "stock-footage", "routingMode": "stock", "lane": "none", "note": "Documentary Basic: free Pexels/Pixabay footage" },
      { "provider": "consumer", "model": "ken-burns", "routingMode": "render", "lane": "none", "fb": true },
      { "provider": "consumer", "model": "basic-animation", "routingMode": "render", "lane": "none", "fb": true }
    ],
    "video.premium.i2v": [
      { "provider": "modelslab", "model": "wan-2.2-i2v", "endpoint": "v6/video/img2video_ultra", "routingMode": "aggregated", "lane": "video",
        "fixed": { "num_frames": "82", "fps": "16" } },
      { "provider": "replicate", "model": "wan-video/wan-2.2-i2v-fast", "routingMode": "aggregated", "lane": "video", "fb": true }
    ],
    "movie.basic.image.t2i":  { "aliasOf": "image.premium.t2i" },
    "movie.basic.image.i2i":  { "aliasOf": "image.premium.i2i" },
    "movie.basic.video.i2v": [
      { "provider": "kie", "model": "bytedance/seedance-1.5-pro", "endpoint": "v1/jobs/createTask", "routingMode": "aggregated", "lane": "video" },
      { "provider": "replicate", "model": "bytedance/seedance-1.5-pro", "routingMode": "aggregated", "lane": "video", "fb": true }
    ],
    "movie.premium.image.t2i": [
      { "provider": "modelslab", "model": "google/nano-banana-2-image-edit", "modelId": "gemini-3.1-t2i", "endpoint": "v7/text-to-image", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "kie", "model": "nano-banana-2", "endpoint": "v1/jobs/createTask", "routingMode": "aggregated", "lane": "rest", "fb": true }
    ],
    "movie.premium.image.i2i": { "aliasOf": "movie.premium.image.t2i" },
    "movie.premium.video.i2v": [
      { "provider": "kie", "model": "bytedance/seedance-2-fast", "endpoint": "v1/jobs/createTask", "routingMode": "aggregated", "lane": "video" },
      { "provider": "replicate", "model": "bytedance/seedance-2.0-fast", "routingMode": "aggregated", "lane": "video", "fb": true }
    ],
    "voice.basic.tts": [
      { "provider": "modelslab", "model": "text-to-speech", "modelId": "inworld-tts-1", "endpoint": "v7/voice/text-to-speech", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "replicate", "model": "jaaari/kokoro-82m", "routingMode": "aggregated", "lane": "rest", "fb": true }
    ],
    "voice.premium.tts": [
      { "provider": "google", "model": "gemini-3.1-flash-tts-preview", "routingMode": "direct", "lane": "rest" }
    ],
    "sfx": [
      { "provider": "modelslab", "model": "sfx", "endpoint": "v6/voice/sfx", "routingMode": "aggregated", "lane": "rest" }
    ],
    "bgm.basic": [
      { "provider": "modelslab", "model": "ai-music-generator", "endpoint": "v6/voice/music", "routingMode": "aggregated", "lane": "rest" }
    ],
    "bgm.premium": [
      { "provider": "kie", "model": "suno", "modelId": "V4_5", "endpoint": "v1/generate", "routingMode": "aggregated", "lane": "rest" }
    ],
    "llm": [
      { "provider": "anthropic", "model": "claude", "routingMode": "direct", "lane": "rest" },
      { "provider": "google", "model": "gemini", "routingMode": "direct", "lane": "rest", "fb": true },
      { "provider": "openai", "model": "gpt", "routingMode": "direct", "lane": "rest", "fb": true }
    ]
  }
}
```

#### `catalog.foreground.json` (premium / paid — Kie + Replicate + Google, **no ModelsLab**)

Premium tier only (no `image.basic`/`video.basic`). Foreground image uses
**nano-banana** (via Kie → Replicate); foreground video premium is **Replicate
wan-fast only**; SFX = Replicate `audiogen`; BGM-basic = Google `lyria`.

```json
{
  "version": "2026-06-09.1",
  "providers": {
    "kie":       { "limit": 10, "floors": { "video": 6, "rest": 4 }, "secretEnv": "KIE_AI_API_KEY" },
    "replicate": { "limit": 20, "secretEnv": "REPLICATE_API_TOKEN" },
    "google":    { "limit": 8,  "secretEnv": "GOOGLE_API_KEY" },
    "anthropic": { "limit": 8,  "secretEnv": "ANTHROPIC_API_KEY" },
    "openai":    { "limit": 8,  "secretEnv": "OPENAI_API_KEY" },
    "runpod":    { "limit": 10, "secretEnv": "RUNPOD_API_KEY", "note": "10 parallel InfiniteTalk workers; Documentary Premium lip-sync, lane:video" }
  },
  "circuit": { "errorThreshold": 0.5, "windowSeconds": 60, "minSamples": 5, "openCooldownSeconds": 30, "halfOpenProbes": 2 },
  "ladders": {
    "image.premium.t2i": [
      { "provider": "kie", "model": "nano-banana", "endpoint": "v1/jobs/createTask", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "replicate", "model": "google/nano-banana", "routingMode": "aggregated", "lane": "rest", "fb": true }
    ],
    "image.premium.i2i": [
      { "provider": "kie", "model": "nano-banana", "endpoint": "v1/jobs/createTask", "routingMode": "aggregated", "lane": "rest" },
      { "provider": "replicate", "model": "google/nano-banana", "routingMode": "aggregated", "lane": "rest", "fb": true }
    ],
    "video.premium.i2v": [
      { "provider": "replicate", "model": "wan-video/wan-2.2-i2v-fast", "routingMode": "aggregated", "lane": "video" }
    ],
    "lipsync.premium.video": [
      { "provider": "runpod", "model": "infinitetalk", "endpoint": "v2/infinitetalk/run", "routingMode": "direct", "lane": "video",
        "needs": ["image", "audio"], "resolution": "720p", "note": "Documentary Premium 1 (spokesperson) & Premium 2 (full)" },
      { "provider": "consumer", "model": "static-spokesperson", "routingMode": "render", "lane": "none", "fb": true }
    ],
    "movie.basic.image.t2i":  { "aliasOf": "image.premium.t2i" },
    "movie.basic.image.i2i":  { "aliasOf": "image.premium.i2i" },
    "movie.basic.video.i2v": [
      { "provider": "kie", "model": "bytedance/seedance-1.5-pro", "endpoint": "v1/jobs/createTask", "routingMode": "aggregated", "lane": "video" },
      { "provider": "replicate", "model": "bytedance/seedance-1.5-pro", "routingMode": "aggregated", "lane": "video", "fb": true }
    ],
    "movie.premium.image.t2i": { "aliasOf": "image.premium.t2i" },
    "movie.premium.image.i2i": { "aliasOf": "image.premium.i2i" },
    "movie.premium.video.i2v": [
      { "provider": "kie", "model": "bytedance/seedance-2-fast", "endpoint": "v1/jobs/createTask", "routingMode": "aggregated", "lane": "video" },
      { "provider": "replicate", "model": "bytedance/seedance-2.0-fast", "routingMode": "aggregated", "lane": "video", "fb": true }
    ],
    "voice.basic.tts": [
      { "provider": "replicate", "model": "jaaari/kokoro-82m", "routingMode": "aggregated", "lane": "rest" }
    ],
    "voice.premium.tts": [
      { "provider": "google", "model": "gemini-3.1-flash-tts-preview", "routingMode": "direct", "lane": "rest" }
    ],
    "sfx": [
      { "provider": "replicate", "model": "sepal/audiogen", "routingMode": "aggregated", "lane": "rest" }
    ],
    "bgm.basic": [
      { "provider": "google", "model": "lyria-3-pro-preview", "routingMode": "direct", "lane": "rest" }
    ],
    "bgm.premium": [
      { "provider": "kie", "model": "suno", "modelId": "V4_5", "endpoint": "v1/generate", "routingMode": "aggregated", "lane": "rest" }
    ],
    "llm": [
      { "provider": "anthropic", "model": "claude", "routingMode": "direct", "lane": "rest" },
      { "provider": "google", "model": "gemini", "routingMode": "direct", "lane": "rest", "fb": true },
      { "provider": "openai", "model": "gpt", "routingMode": "direct", "lane": "rest", "fb": true }
    ]
  }
}
```

**New foreground models needing adapter handlers** (not in §29.2 yet): Kie
`nano-banana` (same shape as `nano-banana-2`); Replicate `google/nano-banana`
(image, `{prompt, image_input?:[…]}`); Replicate `sepal/audiogen` (SFX,
`{prompt, duration?}` → URL); Google `lyria-3-pro-preview` (BGM, Google API).
Add these to the Kie/Replicate/Google adapters.

Resolver: `getLadder(catalog, assetType, tier, operation)` → look up `"{assetType}.{tier}.{operation}"` in the selected catalog
(or `"{assetType}"` for sfx/llm); follow `aliasOf` once. Confirm the two TODO ids
in production (`flux-klein` and the inworld/music `model_id`s) against live calls.

### 29.2 Adapter interface + stubs

**TypeScript** (reference implementation):

```ts
// adapter.ts
export type ErrClass = "Transient" | "TerminalRetryable" | "TerminalPermanent" | "TerminalProvider";
export interface Rung { provider: string; model: string; modelId?: string; endpoint?: string; lane: "video"|"rest"|"none"; fixed?: Record<string,string>; }
export interface CanonicalJob {
  assetType: string; tier: string; operation: string; product: string;
  requestId: string; jobId: string;
  prompt: string; initImageUrls?: string[];           // already resolved S3 -> public URL
  audioUrl?: string;                                  // for lipsync (RunPod InfiniteTalk): the TTS output URL
  dependsOn?: string[];                               // parent jobIds that must be COMPLETE first (i2v: image; lipsync: image + audio)
  params: { aspectRatio?: string; resolution?: string; durationS?: number; generateAudio?: boolean; voice?: string };
  s3Target: string;
}
export interface BuiltRequest { url: string; method: "POST"|"GET"; headers: Record<string,string>; body?: unknown; }
export interface SubmitResult { outputUrls?: string[]; taskRef?: string; raw: any; }   // taskRef = provider taskId/predictionId for poll/webhook
export interface PollResult { done: boolean; outputUrls?: string[]; failed?: boolean; retryAfterMs?: number; }

export interface Adapter {
  supportsWebhook: boolean;
  buildRequest(job: CanonicalJob, rung: Rung, callbackUrl?: string): BuiltRequest;
  parseSubmit(raw: any): SubmitResult;
  poll(taskRef: string): Promise<PollResult>;
  parseWebhook?(payload: any): { taskRef: string; outputUrls?: string[]; failed?: boolean };
  classifyError(httpCode: number, raw: any): ErrClass;
}

const ML = "https://modelslab.com/api";
const env = (k: string) => process.env[k]!;
// canonical durationS -> seedance-1.5 string enum
const snap = (s = 5, allowed: string[]) =>
  allowed.reduce((a, c) => Math.abs(+c - s) < Math.abs(+a - s) ? c : a);

// ---- ModelsLab (per-model param shapes, §28.3.1) ----
export const modelslab: Adapter = {
  supportsWebhook: false,
  buildRequest(job, rung) {
    const key = env("MODELSLAB_API_KEY");
    const base: any = { key, model_id: rung.modelId, prompt: job.prompt };
    if (job.initImageUrls?.length) base.init_image = job.initImageUrls;
    const ep = rung.endpoint!;
    let url = "", body = base;
    if (ep.startsWith("v6/text2img") || ep.startsWith("v6/img2img")) {
      url = `${ML}/${ep.includes("img2img") ? "v6/images/img2img" : "v6/images/text2img"}`;
      body = { ...base, width: "1024", height: "1024", samples: "1",
               ...(ep.includes("img2img") ? { strength: "0.1", enhance_prompt: false } : {}) };
    } else if (ep.startsWith("v7/text-to-image")) {
      url = `${ML}/v7/images/text-to-image`;
      body = rung.modelId?.startsWith("qwen") ? { ...base, size: "1024*1024" }
                                              : { ...base, aspect_ratio: job.params.aspectRatio ?? "16:9", resolution: job.params.resolution ?? "1K" };
    } else if (ep.startsWith("v7/image-to-image")) {
      url = `${ML}/v7/images/image-to-image`;
      body = rung.modelId?.startsWith("qwen") ? { ...base, size: "1024*1024" }
                                              : { ...base, aspect_ratio: "16:9", resolution: "1K" };
    } else if (ep.startsWith("v6/video")) {
      url = `${ML}/v6/video/img2video_ultra`;
      body = { ...base, init_image: job.initImageUrls?.[0], negative_prompt: "static, freeze, no motion, blur, glitch, distortion",
               resolution: "480", output_type: "mp4", ...(rung.fixed ?? {}) };   // fixed: num_frames 82, fps 16
    } else if (ep.startsWith("v7/voice/text-to-speech")) {
      url = `${ML}/v7/voice/text-to-speech`; body = { key, model_id: rung.modelId, prompt: job.prompt, voice_id: job.params.voice };
    } else if (ep.startsWith("v6/voice/sfx")) {
      url = `${ML}/v6/voice/sfx`; body = { key, model_id: "sfx", prompt: job.prompt, duration: job.params.durationS ?? 3, temp: false };
    } else if (ep.startsWith("v6/voice/music")) {
      url = `${ML}/v6/voice/music`; body = { key, model_id: "music", prompt: job.prompt };
    }
    return { url, method: "POST", headers: { "Content-Type": "application/json" }, body };
  },
  parseSubmit(raw) {
    const out = Array.isArray(raw.output) ? raw.output : (raw.output ? [raw.output] : []);
    if (out.length) return { outputUrls: out, raw };
    return { taskRef: String(raw.id ?? raw.request_id ?? ""), raw };   // poll by id (incl. "Try Again" quirk, §17.1)
  },
  async poll(taskRef) { /* POST /v6/images|video|voice/fetch {key, request_id: taskRef}; map output[]/processing */ return { done: false }; },
  classifyError(code, raw) {
    if (code === 429) return "Transient";
    if (String(raw?.status) === "error" && /nsfw|moderation|invalid/i.test(raw?.message ?? "")) return "TerminalPermanent";
    if (code >= 500) return "Transient";
    return "TerminalRetryable";
  },
};

// ---- Kie (unified createTask + webhook, §28.3.2) ----
const KIE = "https://api.kie.ai/api";
export const kie: Adapter = {
  supportsWebhook: true,
  buildRequest(job, rung, cb) {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${env("KIE_AI_API_KEY")}` };
    if (rung.model === "suno") {
      return { url: `${KIE}/v1/generate`, method: "POST", headers,
        body: { prompt: job.prompt, customMode: false, instrumental: true, model: rung.modelId ?? "V4_5", callBackUrl: cb } };
    }
    let input: any = { prompt: job.prompt };
    if (rung.model === "nano-banana-2")
      input = { ...input, image_input: job.initImageUrls ?? [], aspect_ratio: job.params.aspectRatio ?? "auto", resolution: job.params.resolution ?? "1K", output_format: "png" };
    else if (rung.model === "bytedance/seedance-1.5-pro")
      input = { ...input, input_urls: job.initImageUrls ?? [], aspect_ratio: job.params.aspectRatio ?? "16:9", resolution: job.params.resolution ?? "720p", duration: snap(job.params.durationS, ["4","8","12"]), generate_audio: !!job.params.generateAudio };
    else if (rung.model === "bytedance/seedance-2-fast")
      input = { ...input, first_frame_url: job.initImageUrls?.[0], aspect_ratio: job.params.aspectRatio ?? "16:9", resolution: job.params.resolution ?? "720p", duration: Math.min(15, Math.max(4, job.params.durationS ?? 5)), generate_audio: !!job.params.generateAudio };
    return { url: `${KIE}/v1/jobs/createTask`, method: "POST", headers, body: { model: rung.model, callBackUrl: cb, input } };
  },
  parseSubmit(raw) { if (raw.code !== 200) throw { httpCode: raw.code, raw }; return { taskRef: raw.data.taskId, raw }; },
  async poll(taskRef) { /* GET /v1/jobs task-detail or /v1/generate/record-info?taskId; map status/urls */ return { done: false }; },
  parseWebhook(p) { const d = p.data ?? p; return { taskRef: d.taskId, outputUrls: d.resultUrls ?? d.response?.sunoData?.map((s:any)=>s.audioUrl), failed: p.code !== 200 }; },
  classifyError(code) {
    if (code === 429 || code === 433) return "Transient";
    if (code === 402) return "TerminalProvider";        // insufficient credits -> fail provider over (§26.1)
    if (code === 422 || code === 505) return "TerminalPermanent";
    if (code >= 500 || code === 408 || code === 455 || code === 501) return "Transient";
    return "TerminalRetryable";
  },
};

// ---- Replicate (predictions + webhook, §28.3.3) ----
const REP = "https://api.replicate.com/v1";
export const replicate: Adapter = {
  supportsWebhook: true,
  buildRequest(job, rung, cb) {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${env("REPLICATE_API_TOKEN")}` };
    let input: any = { prompt: job.prompt };
    if (rung.model.includes("flux-2-klein"))      input = { ...input, images: job.initImageUrls ?? [], aspect_ratio: "16:9", output_format: "jpg", go_fast: true };
    else if (rung.model.includes("wan-2.2-i2v"))  input = { ...input, image: job.initImageUrls?.[0], num_frames: 81, resolution: "480p", frames_per_second: 16, go_fast: true };
    else if (rung.model.includes("seedance"))     input = { ...input, image: job.initImageUrls?.[0], resolution: job.params.resolution ?? "720p", aspect_ratio: job.params.aspectRatio ?? "16:9", duration: job.params.durationS ?? 5, generate_audio: !!job.params.generateAudio };
    else if (rung.model.includes("kokoro"))       input = { text: job.prompt, voice: job.params.voice ?? "af_nicole", speed: 1 };
    const [owner, name] = rung.model.split("/");
    return { url: `${REP}/models/${owner}/${name}/predictions`, method: "POST", headers, body: { input, webhook: cb, webhook_events_filter: ["completed"] } };
  },
  parseSubmit(raw) { if (raw.error) throw { httpCode: 422, raw }; const o = raw.output; return { taskRef: raw.id, outputUrls: o ? (Array.isArray(o) ? o : [o]) : undefined, raw }; },
  async poll(taskRef) { /* GET /v1/predictions/{taskRef}; succeeded->output, failed->failed */ return { done: false }; },
  parseWebhook(p) { const o = p.output; return { taskRef: p.id, outputUrls: o ? (Array.isArray(o) ? o : [o]) : undefined, failed: p.status === "failed" || p.status === "canceled" }; },
  classifyError(code) { if (code === 429) return "Transient"; if (code === 402) return "TerminalProvider"; if (code === 422) return "TerminalPermanent"; if (code >= 500) return "Transient"; return "TerminalRetryable"; },
};

// ---- RunPod (InfiniteTalk lip-sync / spokesperson, §28.2) — run + status/{id}, image+audio in ----
const RUNPOD = "https://api.runpod.ai/v2";
const runpodOutUrl = (p: any): string | undefined => {           // RunPod output shape varies; dig for a URL
  const dig = (x: any): string | undefined =>
    typeof x === "string" && x.startsWith("http") ? x
    : Array.isArray(x) ? x.map(dig).find(Boolean)
    : x && typeof x === "object" ? ["video_url","videoUrl","output_url","url","output","result","video","artifacts"].map(k => dig(x[k])).find(Boolean)
    : undefined;
  return dig(p);
};
export const runpod: Adapter = {
  supportsWebhook: true,                                          // RunPod accepts a "webhook" in the run body
  buildRequest(job, rung, cb) {
    return {
      url: `${RUNPOD}/infinitetalk/run`, method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("RUNPOD_API_KEY")}` },
      body: { input: {
        prompt: job.prompt,
        image: job.initImageUrls?.[0],                            // spokesperson image (must be COMPLETE)
        audio: job.audioUrl,                                      // TTS output (must be COMPLETE)
        resolution: (rung as any).resolution ?? job.params.resolution ?? "720p",
        enable_safety_checker: true,
      }, ...(cb ? { webhook: cb } : {}) },
    };
  },
  parseSubmit(raw) { const o = runpodOutUrl(raw); return o ? { outputUrls: [o], raw } : { taskRef: String(raw.id ?? ""), raw }; },
  async poll(taskRef) { /* GET /v2/infinitetalk/status/{taskRef}; status COMPLETED->url, FAILED/CANCELLED/TIMED_OUT->failed */ return { done: false }; },
  parseWebhook(p) { const s = String(p.status ?? "").toUpperCase(); const o = runpodOutUrl(p); return { taskRef: String(p.id ?? ""), outputUrls: o ? [o] : undefined, failed: ["FAILED","ERROR","CANCELLED","TIMED_OUT"].includes(s) }; },
  classifyError(code) { if (code === 429) return "Transient"; if (code === 401) return "TerminalProvider"; if (code >= 500) return "Transient"; return "TerminalRetryable"; },
};

export const ADAPTERS: Record<string, Adapter> = { modelslab, kie, replicate, runpod /*, google, anthropic, openai */ };
```

**Python** (mirror for the worker side — interface + one adapter shown; replicate
the same `buildRequest/classifyError` bodies as above):

```python
# adapter.py
from dataclasses import dataclass, field
from typing import Optional, Any
import os

ErrClass = str  # "Transient" | "TerminalRetryable" | "TerminalPermanent" | "TerminalProvider"

@dataclass
class CanonicalJob:
    assetType: str; tier: str; operation: str; product: str
    requestId: str; jobId: str; prompt: str
    s3Target: str
    initImageUrls: list[str] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)

class Adapter:
    supports_webhook = False
    def build_request(self, job: CanonicalJob, rung: dict, callback_url: Optional[str] = None) -> dict: ...
    def parse_submit(self, raw: dict) -> dict: ...          # {outputUrls?, taskRef?, raw}
    def poll(self, task_ref: str) -> dict: ...              # {done, outputUrls?, failed?}
    def parse_webhook(self, payload: dict) -> dict: ...     # {taskRef, outputUrls?, failed?}
    def classify_error(self, http_code: int, raw: dict) -> ErrClass: ...

class KieAdapter(Adapter):
    supports_webhook = True
    BASE = "https://api.kie.ai/api"
    def build_request(self, job, rung, callback_url=None):
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {os.environ['KIE_AI_API_KEY']}"}
        if rung["model"] == "bytedance/seedance-1.5-pro":
            allowed = ["4", "8", "12"]; s = job.params.get("durationS", 5)
            dur = min(allowed, key=lambda c: abs(int(c) - s))
            inp = {"prompt": job.prompt, "input_urls": job.initImageUrls, "aspect_ratio": job.params.get("aspectRatio", "16:9"),
                   "resolution": job.params.get("resolution", "720p"), "duration": dur, "generate_audio": bool(job.params.get("generateAudio"))}
        elif rung["model"] == "bytedance/seedance-2-fast":
            inp = {"prompt": job.prompt, "first_frame_url": (job.initImageUrls or [None])[0], "aspect_ratio": job.params.get("aspectRatio", "16:9"),
                   "resolution": job.params.get("resolution", "720p"), "duration": max(4, min(15, job.params.get("durationS", 5))), "generate_audio": bool(job.params.get("generateAudio"))}
        elif rung["model"] == "nano-banana-2":
            inp = {"prompt": job.prompt, "image_input": job.initImageUrls, "aspect_ratio": job.params.get("aspectRatio", "auto"),
                   "resolution": job.params.get("resolution", "1K"), "output_format": "png"}
        else:
            inp = {"prompt": job.prompt}
        return {"url": f"{self.BASE}/v1/jobs/createTask", "method": "POST", "headers": headers,
                "body": {"model": rung["model"], "callBackUrl": callback_url, "input": inp}}
    def parse_submit(self, raw):
        if raw.get("code") != 200: raise RuntimeError({"httpCode": raw.get("code"), "raw": raw})
        return {"taskRef": raw["data"]["taskId"], "raw": raw}
    def classify_error(self, code, raw=None):
        if code in (429, 433): return "Transient"
        if code == 402: return "TerminalProvider"
        if code in (422, 505): return "TerminalPermanent"
        if code >= 500 or code in (408, 455, 501): return "Transient"
        return "TerminalRetryable"
```

### 29.3 Step Functions changes (per-job state machine)

Replace any "one Lambda submits and polls to completion" logic with this ASL.
Key changes: **(a)** an `AcquireSlot` gate with `Wait`+retry; **(b)** a
**callback branch** (`.waitForTaskToken`) for webhook-capable providers (Kie,
Replicate) and a **poll-loop branch** for ModelsLab; **(c)** `Catch`→`Release`
on every terminal path; **(d)** failover by re-driving with the next rung.

```jsonc
{
  "Comment": "Per-job asset generation with slot gate, callback/poll, failover",
  "StartAt": "AcquireSlot",
  "States": {
    "AcquireSlot": {                         // DynamoDB conditional update (8/7 floor, §24.1)
      "Type": "Task", "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "acquireSlot", "Payload.$": "$" },
      "ResultPath": "$.slot", "Next": "SlotGranted?",
      "Retry": [{ "ErrorEquals": ["SlotUnavailable"], "IntervalSeconds": 30, "MaxAttempts": 240, "BackoffRate": 1.0 }],
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "MarkFailed" }]
    },
    "SlotGranted?": { "Type": "Choice",
      "Choices": [{ "Variable": "$.rung.supportsWebhook", "BooleanEquals": true, "Next": "SubmitCallback" }],
      "Default": "SubmitPoll" },

    "SubmitCallback": {                       // Kie/Replicate: pause until webhook resolves the token (§29.4)
      "Type": "Task", "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
      "Parameters": { "FunctionName": "submitJob", "Payload": { "job.$": "$", "taskToken.$": "$$.Task.Token" } },
      "TimeoutSeconds": 1800,
      "ResultPath": "$.result", "Next": "Upload",
      "Retry": [{ "ErrorEquals": ["ProviderThrottled","ProviderServerError"], "IntervalSeconds": 10, "BackoffRate": 2.0, "MaxAttempts": 5, "JitterStrategy": "FULL" }],
      "Catch": [{ "ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": "ReleaseThenDecide" }]
    },

    "SubmitPoll": {                           // ModelsLab: submit then poll loop
      "Type": "Task", "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "submitJob", "Payload.$": "$" },
      "ResultPath": "$.submit", "Next": "Wait",
      "Retry": [{ "ErrorEquals": ["ProviderThrottled","ProviderServerError"], "IntervalSeconds": 10, "BackoffRate": 2.0, "MaxAttempts": 5, "JitterStrategy": "FULL" }],
      "Catch": [{ "ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": "ReleaseThenDecide" }]
    },
    "Wait": { "Type": "Wait", "Seconds": 12, "Next": "CheckStatus" },
    "CheckStatus": {
      "Type": "Task", "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "pollJob", "Payload.$": "$" },
      "ResultPath": "$.result", "Next": "Ready?",
      "Catch": [{ "ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": "ReleaseThenDecide" }]
    },
    "Ready?": { "Type": "Choice",
      "Choices": [
        { "Variable": "$.result.done", "BooleanEquals": true, "Next": "Upload" },
        { "Variable": "$.result.attempts", "NumericGreaterThan": 8, "Next": "ReleaseThenDecide" }
      ],
      "Default": "Wait" },

    "Upload": {                               // download result -> S3 project folder, then release
      "Type": "Task", "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "uploadAndRelease", "Payload.$": "$" },
      "End": true,
      "Catch": [{ "ErrorEquals": ["States.ALL"], "ResultPath": "$.error", "Next": "ReleaseThenDecide" }]
    },

    "ReleaseThenDecide": {                     // ALWAYS release the slot (I1, §26)
      "Type": "Task", "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "releaseSlot", "Payload.$": "$" },
      "ResultPath": "$.released", "Next": "DecideFailover" },
    "DecideFailover": {                         // attempts/circuit -> next rung, degrade, or dead (§27, §28.4)
      "Type": "Task", "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "decideFailover", "Payload.$": "$" },
      "ResultPath": "$.next", "Next": "HasNextRung?" },
    "HasNextRung?": { "Type": "Choice",
      "Choices": [{ "Variable": "$.next.action", "StringEquals": "retry", "Next": "AcquireSlot" }],
      "Default": "MarkFailed" },
    "MarkFailed": { "Type": "Task", "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "markFailed", "Payload.$": "$" }, "End": true }
  }
}
```

Notes:
* `AcquireSlot` throws `SlotUnavailable` when the pool is full; the `Retry`
  (`Wait 30s`, no backoff, up to ~2h) is the no-Lambda queue wait (§22.3).
* `decideFailover` re-points `$.rung` to the next ladder entry (so re-entering
  `AcquireSlot` runs on the next provider) or returns `dead`.
* Slot is gated/held by the **central DynamoDB/Valkey** counter; the SFN merely
  orchestrates — it does not itself hold concurrency.

#### 29.3.1 Rollout: prove one Step Function, then replicate

Don't build all flows at once. **Stand up a single Step Function end-to-end first**
— pick the simplest, lowest-risk asset (recommend **SFX** or **image**, both
short, single-provider, already cached) — wire it through the whole path
(ingest → DynamoDB gate → SFN → adapter → S3 → status), and validate the gate,
FIFO, failure handling, and metering on real traffic.

Once that one works, **replicate the same state machine to the other asset types**
(image → i2i → tts → **video last**, the longest leases). The ASL is identical per
flow; only the adapter/lane/TTL differ, so each replica is a parameterization, not
a redesign. This is the §15 order, expressed as one-SFN-then-fan-out.

**Phase 2 (Valkey) is implemented last.** Build and run everything on the
**DynamoDB-only** gate (§24); migrate the gate to Valkey (§21.5/§25.4) only after
all flows are proven and the metrics (§12) justify it — the `acquire/release`
interface is identical, so it's a backend swap with no SFN/adapter changes.

### 29.4 Webhook ingress endpoint (yes — you need one)

**Confirmed:** Kie and Replicate deliver completion via `callBackUrl`/`webhook`,
so Quartermaster **must expose a public HTTPS ingress** for them to POST to. Without
it you'd fall back to polling (still supported via the §29.3 poll branch + the
sweeper), but the callback path is cheaper and avoids the Lambda timeout for
long Seedance/Suno jobs.

**Shape (no API Gateway):** `CloudFront → Lambda Function URL (webhookHandler)`.
The webhook Lambda exposes a **Function URL** (`AuthType: AWS_IAM`) and CloudFront
fronts it with **Origin Access Control (OAC)** so the URL accepts requests **only
from CloudFront** (CloudFront signs them). Auth at the app layer = a **static API
key header** the provider includes **plus** the provider's HMAC **signature**.
**AWS WAF on the CloudFront distribution** provides rate-limiting + (optionally) an
IP allowlist — replacing what API Gateway throttling would have done.

```
POST https://<cloudfront-host>/webhooks/{provider}    # provider ∈ kie | replicate
   header: X-Gateway-Key: <static key from Secrets Manager>
   (CloudFront → OAC-signed → Lambda Function URL → webhookHandler)
```

**On submit, persist the mapping** (so the webhook can find the waiting SFN):
when `submitJob` (callback branch) gets a `taskRef`, write to the jobs table:

```
PK = PROVIDERTASK#{provider}#{taskRef}   ->  { jobId, requestId, taskToken, s3Target, createdAt, ttl }
```

**Webhook handler logic:**

```ts
// webhookHandler.ts  (Lambda Function URL event = LambdaFunctionURLEvent, v2.0 shape)
export const handler = async (evt: LambdaFunctionURLEvent) => {
  const provider = evt.rawPath.split("/").pop()!;                 // "kie" | "replicate" (no path templating on Function URLs)
  const raw = JSON.parse(evt.body ?? "{}");

  // 0. STATIC KEY gate (coarse) — header set by the provider; reject if absent/mismatched
  if (evt.headers["x-gateway-key"] !== env("GATEWAY_STATIC_KEY")) return { statusCode: 401 };

  // 1. VERIFY authenticity (do NOT trust an open endpoint)
  if (!verifySignature(provider, evt.headers, evt.body)) return { statusCode: 401 };

  // 2. Map provider taskRef -> { jobId, taskToken } via DynamoDB
  const { taskRef, outputUrls, failed } = ADAPTERS[provider].parseWebhook!(raw);
  const map = await getItem(`PROVIDERTASK#${provider}#${taskRef}`);
  if (!map) return { statusCode: 200 };                           // unknown/duplicate -> ack & drop

  // 3. IDEMPOTENCY: conditional-claim so a duplicate webhook is a no-op
  const claimed = await claimWebhookOnce(map.jobId);              // conditional update; false if already resolved
  if (!claimed) return { statusCode: 200 };

  // 4. Resume the paused Step Function
  if (failed) {
    await sfn.sendTaskFailure({ taskToken: map.taskToken, error: "ProviderFailed", cause: JSON.stringify(raw).slice(0,256) });
  } else {
    // optionally hand the output URL straight to the SFN; Upload state pulls bytes -> S3
    await sfn.sendTaskSuccess({ taskToken: map.taskToken, output: JSON.stringify({ outputUrls }) });
  }
  return { statusCode: 200 };                                     // always 200 quickly so providers don't retry-storm
};
```

Requirements baked in:
* **Reachable + verified, no API Gateway.** CloudFront (public) → OAC-signed →
  Lambda **Function URL** (`AWS_IAM`, so it rejects anything not from CloudFront).
  Three layers of trust: **WAF** (rate-limit/IP) on CloudFront, the **static
  `X-Gateway-Key`** header, and the **provider HMAC signature** — Kie's
  [Webhook Verification](https://docs.kie.ai/common-api/webhook-verification) and
  Replicate's webhook **signing secret** (HMAC over body+timestamp). Reject on any
  failure (`401`).
* **Idempotent.** Providers may deliver a callback more than once; the
  `claimWebhookOnce` conditional update ensures only the first resolves the token
  (a second `sendTaskSuccess` on a consumed token would otherwise error).
* **Fast 200.** Return `200` immediately so the provider doesn't retry-storm; do
  any heavy work (download/normalize) inside the SFN `Upload` state, not the
  webhook.
* **Fallback = poll + sweeper.** If a callback is missed (provider drop, ingress
  blip), the §26.4 sweeper detects the `PROCESSING` job past `leaseExpiry` and the
  poll branch (or a reconciliation `pollJob`) finishes it — the callback is an
  optimization, never a single point of failure.
* **TTL** on the `PROVIDERTASK#` item (e.g. 24h) so the mapping self-cleans.

This closes the loop: catalog (§29.1) selects the rung → adapter (§29.2) shapes
the request → Step Functions (§29.3) gates + orchestrates → webhook ingress
(§29.4) resolves long async jobs back into the state machine, with polling +
sweeper as the safety net.

---

## 30. Admin dashboard (catalog, keys, cost & balance)

A single internal UI to **manage the catalog (models/providers per Image/Video/
Voice/BGM/LLM), rotate API keys, and watch cost + provider balance** so you
top-up *before* a `402` ever fails a job (§26.1 Terminal-provider). Everything it
edits is the **central config + secrets** Quartermaster already reads — the
dashboard is a controlled writer, not a new runtime dependency.

### 30.1 Layout

```
┌── ModelsGateway Admin ─────────────────────────────── [admin ▾] [logout] ──┐
│ Catalog | Providers & Keys | Cost & Consumption | Balances | Audit         │
├────────────────────────────────────────────────────────────────────────────┤
│ CATALOG  (filter: assetType ▾  tier ▾  op ▾)                                │
│  image.premium.t2i        lane:rest                       [+ add rung]      │
│   1 ▸ modelslab  qwen-text-to-image            ●healthy   [edit][↑↓][off]   │
│   2 ▸ modelslab  qwen-image-2.0-pro            ●healthy   [edit][↑↓][off]   │
│   3 ▸ modelslab  nano-banana-2 (edit)          ●healthy   [edit][↑↓][off]   │
│   4 ▸ kie        nano-banana-2        (fb)     ○circuit-open  [edit][↑↓]    │
│  video.premium.i2v        lane:video                                        │
│   1 ▸ modelslab  wan-2.2-i2v                    ●healthy                     │
│   2 ▸ replicate  wan-2.2-i2v-fast      (fb)     ●healthy                     │
│  …                                              version 2026-06-09.3        │
└────────────────────────────────────────────────────────────────────────────┘
```

### 30.2 Capabilities (mapped to the request)

| Need | Dashboard action | Writes to |
|---|---|---|
| **Maintain models per Image/Video/Voice/BGM** | view/edit ladders by `assetType.tier.operation`; reorder (primary→secondary→fallback), enable/disable a rung, add/remove model | catalog config (§29.1), version-bumped |
| **Providers & their API keys** | per-provider: base URL, limit/floors, circuit state, **masked key (•••last4)** | provider config + Secrets Manager |
| **Add a new provider** | create provider record (name, baseURL, authType, limit), attach secret, add its models to ladders | provider config + Secrets Manager (+ one adapter code deploy, §30.6) |
| **Update / rotate an API key** | "Rotate key" → paste new key → new Secrets Manager version → optional grace window → revoke old | Secrets Manager (never the catalog/DB) |
| **Cost per API request** | maintain price table (provider+model → unit cost); see spend by provider/model/product/day | price table + §20 metering |
| **Replenish before failure** | per-provider balance, burn rate, **runway days**, low-balance alerts; record a top-up | balance store + alerting |

### 30.3 Data model (extends the existing table)

```
# Price table — "cost per API request" (editable as providers change pricing)
PK = PRICE  SK = {provider}#{model}
  { unitCostUsd, unit: "request"|"second"|"clip"|"1Kpx", currency:"USD", updatedAt, updatedBy }

# Provider config (key is a *reference*, never the value)
PK = PROVIDER  SK = {provider}
  { baseUrl, authType:"bearer"|"key-field", secretArn, keyLast4, limit, floors?, enabled, updatedAt }

# Balance / replenishment
PK = BALANCE  SK = {provider}
  { balanceUsd, source:"api"|"estimated", lastTopupUsd, lastTopupAt,
    thresholdUsd, burnUsdPerDay, runwayDays, updatedAt }

# Audit (every change is recorded)
PK = AUDIT  SK = {ts}#{actor}
  { action, target, before, after }
```

### 30.4 Cost & consumption

* **Cost = §20 metering × price table.** Each completed job already records
  `{provider, model, endpoint, slotMs, count, project, …}`; multiply by the
  PRICE row's `unitCostUsd` (per request / per second / per clip) to get spend.
* Views: spend by **provider / model / assetType / product / day**, success vs
  fail %, top consumers (project/request), and circuit-open events. High-cardinality
  drill-down (request/user) comes from the Tier-2 store, not metrics (§20.3).
* Editing a PRICE row updates all forward estimates; keep history (`updatedAt`)
  so past spend reflects the price in effect then.

### 30.5 Balances & replenishment (prevent the 402)

The whole point: never let a provider run dry mid-pipeline.

* **Balance source** — pull from the provider's balance API where it exists
  (Kie *get-account-credits*, Replicate billing) on a schedule; otherwise
  **estimate**: `balance = lastTopup − cumulativeCostSince(lastTopup)` from §20 ×
  prices, and reconcile when the API is reachable.
* **Runway** = `balanceUsd ÷ burnUsdPerDay` (trailing 7-day burn). Shown per
  provider as "Kie ≈ 3.2 days left".
* **Alerts** — when `balanceUsd < thresholdUsd` *or* `runwayDays < N` (e.g. 5),
  fire email/Slack/PagerDuty so ops top up **before** the provider returns `402`.
  This is the proactive complement to the reactive §26.1 Terminal-provider /
  §27.4 circuit-open handling — together they mean a depleted provider degrades
  to "fail over + alert", never to a hard pipeline stop.
* **Record top-ups** in the UI (`lastTopupUsd/At`) to re-baseline the estimate.

### 30.6 Add provider / rotate key — the flows

**Rotate / update a key (zero-downtime):**
1. Admin pastes the new key → dashboard writes a **new Secrets Manager version**
   for that provider's `secretArn` (old version retained).
2. Adapters read the secret by ARN at send time (cached briefly), so they pick up
   the new version automatically — **no redeploy**.
3. Optional **grace window**: keep the old version `AWSPREVIOUS` for N minutes in
   case in-flight calls used it, then disable it.
4. UI shows only `•••last4`; the raw key is never returned by the admin API after
   write, never stored in the catalog/DB, never logged (§28.3 secrets rule).

**Add a new provider:**
1. Create the `PROVIDER` record (baseURL, authType, limit/floors) + store its key
   in Secrets Manager.
2. **Deploy its adapter module** (the *only* code change — `buildRequest/
   parseSubmit/poll/classifyError`, §29.2); register it in `ADAPTERS`.
3. Add its models as rungs in the relevant ladders; set PRICE rows + BALANCE
   threshold. From then on it's catalog-managed like any other.

### 30.7 Architecture & auth (CloudFront + Lambda Function URL, no API Gateway)

**No API Gateway.** One CloudFront distribution fronts both origins: the **S3 SPA**
(default behavior) and the **admin-api Lambda Function URL** (behavior `/api/*`).
The SPA calls the API on the *same* CloudFront host, so there's no CORS and one
TLS domain.

```
[Admin browser]
   │  HTTPS (one domain)
   ▼
[CloudFront + WAF]
   ├── default behavior  ───────────────▶ [S3 (SPA)]                 (OAC)
   └── /api/*  ─────────────────────────▶ [admin-api Lambda Function URL]  (OAC, AuthType=AWS_IAM)
                                                │  X-Gateway-Key + JWT verified in Lambda
                                                ├──▶ DynamoDB (CATALOG/PROVIDER/PRICE/BALANCE/AUDIT)
                                                ├──▶ Secrets Manager (key read/rotate)
                                                └──▶ metering store (§20)
[EventBridge Scheduler] ──▶ balance-poller Lambda ──▶ provider balance APIs + alerts
```

* **Function URL, not API Gateway.** The admin-api Lambda exposes a **Function
  URL** with `AuthType: AWS_IAM`; CloudFront reaches it via **OAC** (CloudFront
  signs the request), so the URL is **not callable directly** — only through
  CloudFront. S3 is likewise locked to CloudFront via OAC. This removes the API
  Gateway hop, its per-request cost, and a moving part.
* **Edge controls replace API Gateway features.** Throttling/abuse protection and
  IP allowlisting come from **AWS WAF on CloudFront** (rate-based rules) instead of
  API Gateway usage plans. Request size/validation is done in the Lambda.

**Auth — static API key + static login:**
* **Static API key** (`X-Gateway-Key`, from Secrets Manager) is a **coarse gate**
  the SPA sends on every `/api/*` call. ⚠️ A key shipped in browser JS is **not a
  real secret** — treat it as a filter, not authentication.
* **Real auth is the static login.** One (or a few) admin accounts; **bcrypt/argon2
  hash in Secrets Manager** (never plaintext/code); login issues a **short-lived
  signed JWT** (~1h) in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie; every
  `/api/*` route verifies **both** the key and the JWT.
* **Harden the edges**: HTTPS only; **login rate-limit + lockout** (in-Lambda +
  WAF); put the dashboard behind a **WAF IP allowlist / VPN** since the credential
  is single-factor.
* **Least-privilege**: the admin-api Lambda role may write only the catalog/price/
  balance items and the specific provider secrets — nothing else.
* **Audit everything** (§30.3 AUDIT): who changed which ladder/key/price, before/
  after, timestamp.
* Upgrade path: swap the static login for **Cognito/SSO + MFA** (CloudFront can use
  a Lambda@Edge/CloudFront Function auth check) when more than a couple of admins
  need access — the rest is unchanged.

> Webhook ingress (§29.4) uses the **same pattern** — CloudFront → Lambda Function
> URL (OAC) — so the whole HTTP surface is API-Gateway-free and consistent.

> Net: the dashboard turns the catalog (§29.1), secrets, price table, and §20
> metering into an operable control panel — change a model or provider, rotate a
> key with no redeploy, and keep every provider funded ahead of demand so a `402`
> never reaches a job.

---

## 31. Coexistence & launch model

How **Quartermaster** ships *alongside* the current pipeline (no rewire) and how the
free→paid launch funnel works on top of it.

### 31.1 Strangler-fig coexistence (don't rewire — wrap)

Introduce Quartermaster in **parallel**, not by replacing the existing flow:

* **Existing Step Functions stay as-is = foreground / premium / priority.** They
  already use **Kie + Replicate** (the `catalog.foreground.json` providers, §29.1),
  so they need **no change**.
* **A replicated Step Function (the §29.3 per-job ASL) = background / batch / free.**
  It is wired to **Quartermaster** (catalog → adapters → DynamoDB limiter → webhook)
  and uses **`catalog.background.json`** (ModelsLab-primary).
* **The router is the MCP tag** (§31.2): a request tagged `batchjob`/`background`
  starts the **new** SFN → Quartermaster; everything else stays on the **existing**
  SFNs.

```
                         ┌─ tag: foreground/premium ─▶ EXISTING Step Functions ─▶ Kie/Replicate
   request ─▶ [MCP] ─────┤                                                         (catalog.foreground)
                         └─ tag: batchjob/background ▶ NEW Step Function ─▶ QUARTERMASTER ─▶ ModelsLab
                                                        (§29.3 ASL)         (gate+catalog+adapters)  (catalog.background)
```

**Why this is low-risk:**
* **No shared blast radius** — the two paths share **no provider on a contended
  account** (foreground never touches ModelsLab, §28.4.1), so Quartermaster can't
  destabilize the existing one, and there's no 15-slot tug-of-war.
* **Trivial rollback** — stop routing the `batchjob` tag to the new SFN; the old
  flow is untouched.
* **Incremental** — start with **one** background SFN for one asset (SFX/image,
  §29.3.1), prove it, then replicate to the rest. Phase 2 (Valkey) comes last.
* **Migration path** — once Quartermaster is proven on background, you *may* move
  more traffic behind it later (strangler-fig completes), but you're never forced to.

### 31.2 MCP-tagged routing

The MCP layer is the single entry that tags and routes:

* MCP tool receives a generation/agent request, attaches a **`queue` tag**
  (`background` for batch/free, `foreground` for interactive/premium) plus the
  attribution fields (§20: `platform`, `projectId`, `userId`, `tier`).
* **`background`** → `StartExecution` on the **new** SFN (Quartermaster, background
  catalog). **`foreground`** → the **existing** SFNs (foreground catalog).
* Producers send a **slim job** (§23) — `manifestRef` + the few fields the job needs
  — not the whole project JSON.

### 31.3 Launch funnel (freemium → paid)

* **Free on signup** — **Narration basic/premium + Documentary basic**, generated
  **as batch jobs** through Quartermaster on the **ModelsLab background catalog**
  (≈ zero marginal cost; Doc-basic is basic image + free stock video, §29.1).
* **Agent flow** — analyze the user's YouTube channel → suggest a **content
  calendar** → generate videos → publish. All via **background batch jobs**.
* **Conversion lever** — ModelsLab output is the **quality preview**; upgrading to
  **premium** (Movie, Documentary Premium 1 & 2, premium video/voice) routes to the
  **foreground catalog** (Kie/Replicate/RunPod/Google) — **faster *and* better**.
* **Premium = tokens / subscription** — paid generations deduct from the user's
  token balance or subscription entitlement.

> **Launch guardrail — auto-posting.** Publishing AI content to a user's YouTube on
> their behalf carries OAuth-scope, API-quota, and brand/policy risk. **Launch
> human-in-the-loop**: the agent produces the calendar + the videos, the user
> **approves** before publish. Add auto-publish later behind explicit opt-in.

### 31.4 Credit enforcement ("free" must be *limited*)

Free is **unlimited volume but capped concurrency** on ModelsLab (§2) — so without
per-user limits, free signups would flood the 15-slot queue and starve everyone.
The controls already exist in the design:

* **Per-user credit budget** (the "limited" in free) — a weekly/daily slot-seconds
  or job-count cap enforced **at admit time** via the §20.2 live counters
  (`usage:project:{id}` / per-user). Over budget → reject or defer.
* **Per-tenant fairness** — the §7 / §24.2 per-tenant cap + per-lane FIFO so one
  user's batch can't monopolize the queue.
* **Token deduction for premium** — at admit, check the user's token/subscription
  balance (from the §30 ledger = §20 metering × price table); deduct on completion;
  block when exhausted (distinct from a provider `402`, §26.1).
* **Provider funding** — the §30 balance monitor keeps Kie/Replicate/RunPod topped
  up so *paid* demand never hits a provider `402`.

### 31.5 Risks & mitigations (launch checklist)

| Risk | Mitigation |
|---|---|
| Free signups saturate the ModelsLab 15-slot queue | Per-user credit caps (§31.4) + per-tenant FIFO fairness |
| Auto-posting to YouTube (policy/quota/brand) | Human-in-the-loop approval at launch (§31.3) |
| Paid provider runs out of credits mid-job | §30 balance alerts + top-up ahead of burn; circuit-breaker failover (§27) |
| New app destabilizes existing pipeline | Strangler-fig: separate SFNs, no shared contended provider, instant rollback (§31.1) |
| Cost runaway on premium | §20 per-user metering + token gating; price table drives charge-back (§30) |

> **Net:** Quartermaster ships as a *parallel* background/free engine behind an MCP
> tag — existing foreground untouched, rollback trivial, no provider contention —
> while the free ModelsLab tier doubles as the freemium quality-preview that
> converts users to the paid Kie/Replicate foreground path.
