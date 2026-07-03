# QM Admission Gate + Gen-Time Baselines — Implementation Plan (QM side)

**Audience:** Quartermaster engineers (this repo)
**Scope:** The QM-side build behind the StoryStudio contracts in
`storystudio-qm-admission-gate.md` and `storystudio-qm-new-sfn-trigger.md`.
**Status:** Plan — not started. Two inputs still open (baseline seeds, RunPod balance read).
**Principle carried from the contract:** MCP/batch only · no TAT → reliability over latency
(bias to defer) · internal-first for cost, external for overflow + DR · one reservation per
project · cap 10 → 20 later.

---

## 0. What already exists (build on, don't rebuild)

| Capability | Where | Reuse for |
|---|---|---|
| Per-endpoint semaphore + `getInflight(counterKey)` | `src/gate/dynamo-gate.ts` | live in-flight per endpoint (admission input) |
| Queued-per-endpoint tally | `src/handlers/provisioner.ts` → `gatherQueuedByEndpoint()` / `jobCounterKey()` | backlog per endpoint (admission input) |
| Worker scaling (size, prewarm, scale-to-zero, cap rebalance) | `src/handlers/provisioner.ts` → `runProvisioner()` | pre-warm on grant; reservation-aware demand |
| Shadow/live PATCH RunPod | `provisioner.ts` → `patchRunPod()`, `RUNPOD_PROVISION_LIVE` | flip to live for pre-warm |
| Sweeper tick (2-min) | `api.ts` → `handleSweeper()`; `infra/lib/scheduler-stack.ts` | reservation expiry + consumption rollup |
| Job lifecycle chokepoint | `src/handlers/executor.ts` → `setProcessing()` / `complete()` | capture gen-time for baselines |
| Catalog ladders (internal-first + `fb` fallback) | `src/catalog/background.json`, `resolver.ts` | wan2-i2v repoint; asset→endpoint map |
| Single-table model + item types | `src/types.ts`, table `quartermaster-jobs` | add Reservation + Baseline items |

**Gaps to fill:** (1) no projected-load module; (2) executor records **no** gen-time; (3) no
`/admission` route or reservation state; (4) provisioner isn't reservation-aware and doesn't
include `runpod:wan2-i2v`; (5) no consumption/balance rollup.

---

## 1. Data model (new items on `quartermaster-jobs`)

```jsonc
// Reservation — one per admitted project; PK by requestId for idempotency
{ "pk": "RESERVATION#mcp_abc123", "sk": "META",
  "admissionId": "qm_adm_7f3…", "requestId": "mcp_abc123",
  "projectType": "narration-basic", "tier": "basic", "durationSeconds": 90, "userId": "…",
  "perEndpoint": { "runpod:flux-tts-s2t": { "jobs": 82, "workers": 4 } },
  "status": "active",            // active | released | expired
  "decision": "granted",
  "drainEstMs": 720000,
  "createdAt": 0, "expiresAt": 0 // now + brainWindow + drainEst + buffer (dynamic)
}

// Baseline — self-updating gen-time per asset, per endpoint
{ "pk": "BASELINE#runpod:flux-tts-s2t", "sk": "image.narrationBasic.t2i",
  "ewmaMs": 14200, "p95Ms": 21000, "samples": 137, "lastMs": 13800, "updatedAt": 0 }
```

Active reservations are few (≤ tens) → summing committed workers per endpoint is a cheap
Query on `begins_with(pk,"RESERVATION#")` filtered `status=active`, mirroring how the lease
sweeper already scans `LEASE#`.

New types in `src/types.ts`: `ReservationItem`, `BaselineItem`. (`MeteringItem` already exists
— reuse for §5.)

---

## 2. Phase 1 — Projected-load module + gen-time baselines  ✅ **DONE**  *(no behavior change, ship first)*

**Why first:** admission's ETA is only as good as the baselines; and this phase is pure
telemetry — zero risk to the live path.

- **`src/shared/assetLoad.ts`** (new) — `projectAssetLoad(projectType, tier, durationSeconds)`
  → `{ frameCount, perEndpoint: { [counterKey]: jobs }, external: {…} }`.
  `frameCount = clamp(round(duration/5), min, max)` (90→20, 300→60, 600→120). Encodes the
  §5 table (basic: 4·frames+2 on `flux-tts-s2t`; premium split across `flux-tts-s2t` /
  `qwen-image-gen` / `wan2-i2v`). **Single source of truth** — provisioner will import it too.
- **Baseline capture in `executor.ts`:**
  - `setProcessing()` → also write `processingStartedAt = now`.
  - `complete()` → `genMs = now − processingStartedAt`; upsert `BASELINE#{counterKey}` /
    `{assetType}.{tier}.{operation}` with EWMA (`ewma = α·genMs + (1−α)·ewma`, α≈0.2), bump
    `samples`, track `p95` (approx). Skip on cache hits.
- **Seed** priors — sourced from real measured warm-inference figures in
  `/home/roman-antony/runpod/API.md` (flux-tts-s2t ≈12.5s blended, qwen-image-gen 8s,
  qwen-image-edit 15s, wan2-i2v 92s), not guesses. Closes the earlier "baseline seed" open item.
- **Tests:** `__tests__/assetLoad.test.ts` (load math, both tiers, unsupported types).
  EWMA convergence covered indirectly via `__tests__/admission.test.ts`'s baseline-driven
  defer case; no standalone `baseline.test.ts` yet (executor's `recordBaseline` is
  integration-shaped — would need a fuller executor harness than exists today).

**Exit:** `projectAssetLoad()` unit-tested; `recordBaseline()` wired into `executor.ts`'s two
completion paths (sync + polled). Baselines are unpopulated until real jobs run — admission
falls back to the seeds above until then.

---

## 3. Phase 2 — `POST /admission` + `/release` + reservation-aware capacity  ✅ **DONE** *(flagged)*

- **Routes in `src/handlers/api.ts`** (gateway-key section, next to `/jobs`):
  - `POST /admission` → `handleAdmission(evt)`
  - `POST /admission/{admissionId}/release` → `handleAdmissionRelease(evt)`
- **`src/handlers/admission.ts`** — decision logic actually implemented:
  1. Validate `{requestId, projectType, tier, durationSeconds, userId?}` → 400 if missing;
     400 if `projectType` unsupported (`projectAssetLoad().supported === false`).
  2. **Idempotency:** a pointer item `RESERVATIONREQ#{requestId}` → `admissionId` resolves to
     the primary `RESERVATION#{admissionId}` record; if `status:active` and unexpired, its
     decision is returned unchanged (no re-decision, verified by test).
  3. `load = projectAssetLoad(...)`.
  4. Per touched endpoint: `inflight` (`getInflight`), `queued` (`gatherQueuedByEndpoint`,
     exported from `provisioner.ts`), `workersMax` (`getEndpointWorkersMax`, new export),
     `ewmaMs` (average of `BASELINE#{counterKey}` rows, seed fallback), plus **other active
     reservations'** `perEndpointJobs`/`neededWorkers` for that same endpoint (so a second
     granted-but-not-yet-started project on a hot endpoint is accounted for, not just live
     `inflight`/`queued`).
  5. **Worker sizing correction (caught during implementation):** sizing must use the
     project's **peak concurrency**, not its lifetime job total — a narration-basic project's
     82 total jobs ÷ `JOBS_PER_WORKER=4` ≈ 21 workers would alone exceed the entire account cap,
     which is wrong. Concurrency is bounded by the SFN Map's `MaxConcurrency=15`
     (`pipeline-stack.ts`), so `neededWorkers = ceil(min(frameCount,15) / JOBS_PER_WORKER)` —
     e.g. a 20-frame basic project needs ~4 workers, matching the account cap's real documented
     split in `runpod/API.md` (`flux-tts-s2t:5, qwen-image-edit:2, wan2:2, qwen-image-gen:1`).
     Drain/ETA still correctly uses the full job total amortized over those workers.
  6. **Decision:** two independent checks — (a) fleet-wide worker cap (`Σ workersMax` vs
     `Σ other-reservations’ workers`, whichever is larger, plus this project's need, vs
     `ACCOUNT_CAP`) and (b) per-endpoint drain vs `ADMISSION_MAX_DRAIN_MS` (fleet-protection
     ceiling, not a deadline). `reason` is `cap_committed` / `queue_busy` / `fleet_saturated`
     depending on which check(s) fail. **Verified:** a solo narration-premium project (3
     endpoints × ~4 workers = 12 > cap 10) correctly defers with `cap_committed` even against
     an otherwise-empty fleet — this is expected/documented behavior (premium defers sooner),
     not a bug.
  7. **Grant:** writes `RESERVATION#{admissionId}` (`status:active`, dynamic
     `expiresAt = now + brainWindow + drainEstMs + buffer`) + the requestId pointer; returns
     `{decision:"granted", admissionId, expiresAt, warmedEndpoints, estimatedReadySeconds}`.
     `warmedEndpoints` names the endpoints a future pre-warm call (WS-C3) should target — no
     actual RunPod PATCH happens yet, by design (kept separate from WS-C3).
  8. **Defer:** `{decision:"deferred", reason, estimatedWaitSeconds, retryAfterSeconds}`
     (`retryAfterSeconds` is a fraction of the ETA, clamped, so the cron re-checks sooner than
     the full worst-case wait).
  9. **Release:** `POST /admission/{admissionId}/release` flips `status→released`; idempotent
     (already-released or unknown-but-existing returns `released:true`); 404 only if the
     admissionId was never granted.
- **Flag:** implemented as **`ADMISSION_STUB=granted`** only (no separate `ADMISSION_ENABLED` —
  unset env means real decision logic runs immediately; the stub is purely for StoryStudio to
  integrate against the wire shape without depending on capacity state).
- **Sweeper (`handleSweeper` in `api.ts`)**: calls `expireStaleReservations()` — scans
  `status:active` reservations past `expiresAt` → `status:expired`, freeing their committed
  worker share from subsequent decisions. Result surfaced as `reservationsExpired` in the
  sweeper's response, alongside the existing `provisioning` shadow-audit.
- **Tests:** `__tests__/admission.test.ts` (11 cases) — validation 400s, grant on an empty
  fleet, defer on cap contention (the premium 12-vs-10 case), defer on a drain-ceiling
  breach with cap headroom, idempotent re-POST (asserts only lookup calls fire, no
  re-decision), `ADMISSION_STUB` bypass, release (fresh/idempotent/404), reservation expiry.
  31/31 across the full suite; `tsc --noEmit` clean.

**Exit:** ✅ grant/deferred/release verified against a mocked DynamoDB fleet, including the
worker-sizing correction. **Not yet done:** live pre-warm on grant (WS-C3, deliberately out of
scope here), reservation-aware demand folded into the provisioner's own scaling (WS-C2), and
real end-to-end validation against StoryStudio's integration (needs their WS-A wiring).

---

## 4. Phase 3 — Proactive live pre-warm + `wan2-i2v` wiring

- ✅ **Catalog (`background.json`)** — `video.premium.i2v` repointed to **runpod primary**
  (`endpointId nd7wloyvj09xwy`, `counterKey runpod:wan2-i2v`, `lane video`, 480p) → Replicate
  `fb:true` (KIE rung dropped per the confirmed fallback). Adapter gained the missing `i2v`
  mode case (`runpod.ts`) — the repoint alone would've hit the `default` fallthrough. (When the
  premium QM-new machine lands, add the `video.narrationPremium.i2v` key too.)
- ✅ **Provisioner `ENDPOINTS`** — `runpod:wan2-i2v` added (4 endpoints now share the cap;
  `rebalanceUnderCap` already handles N).
- ✅ **Reservation-aware demand — DONE (WS-C2).** Reservation persistence extracted from
  `admission.ts` into `src/gate/reservation-gate.ts` (mirrors `dynamo-gate.ts`), avoiding an
  `admission.ts` ↔ `provisioner.ts` import cycle. `runProvisioner()` now calls the new
  `getReservedWorkersByEndpoint()` and combines it with organic demand as
  `effectiveWorkers = max(organicWorkers, reserved)` per endpoint (max, not sum — a
  reservation's promise and the jobs it later submits are the same demand; summing would
  double-count once its SFN starts running). A reservation-only endpoint (zero live
  inflight/queued) now pre-warms (`toMin:1`, reason `reservation-prewarm`/`reservation-hold`)
  instead of scaling to zero. `rebalanceUnderCap`'s proportional-share weighting
  (`demandWeight()`) was extended to convert `reserved` (worker-units) through
  `JOBS_PER_WORKER` so it stays comparable with `inflight+queued` (job-count-units) —
  otherwise a reservation-only endpoint would weigh ~1-10 against tens of queued jobs
  elsewhere and get starved to 0 by rebalancing, defeating the pre-warm it's owed. Verified
  by test: with heavy organic load on one endpoint pushing the fleet over the 10-worker cap,
  a reservation-only endpoint still keeps a non-zero share (`toMax:2`) rather than 0.
  `ProvisionShadowItem` gained a `reserved` field for audit visibility.
  2 tests in `__tests__/provisioner.test.ts`.
- ☐ **Pre-warm actuation (WS-C3, still open):** on a granted admission, raise `workersMin` for
  the reserved endpoints *right now* (not just on the next 2-min sweeper tick) — write intended
  state + `patchRunPod` when live. Flip **`RUNPOD_PROVISION_LIVE=true`** (validate the shadow
  log first). Idle cooldown (existing 5-min) scales back after release. This is the step that
  makes admission's `warmedEndpoints` response field actually true — today it's aspirational
  (the *next* sweeper tick will pre-warm via C2, but nothing pre-warms synchronously on grant).

**Exit:** ✅ reservation-aware provisioning verified (a granted project's endpoints hold warm
without waiting for real job traffic, and survive cap contention from other demand). **Not yet
done:** synchronous pre-warm actuation on grant (C3) and the `RUNPOD_PROVISION_LIVE` flip.

---

## 5. Phase 4 — Capacity vs consumption + balance signal

- **Consumption rollup (sweeper):** aggregate slot-seconds per endpoint from baseline samples /
  job durations into `MeteringItem` (`USAGE:{platform}:{date}` → `{model}:slot_ms|count`).
- **Balance/runway:** compute burn-rate vs `BalanceItem.balanceUsd`; emit a **low-runway**
  signal (log/metric/alarm) when `runwayDays < threshold` so the account is topped up before
  failures. Live RunPod-balance read **if the API exposes it** (§open item), else the
  admin-set number already in `handlePutBalance`.
- **Admin surface:** existing `GET /api/cost` / `GET /api/balances` already read these — extend
  the dashboard to show per-endpoint slot-seconds + runway.

**Exit:** cost/consumption visible per endpoint; low-runway alerts fire.

---

## 6. Phase 5 — Hardening & ramp

- Tune `ADMISSION_MAX_DRAIN_MS`, worker-share-per-project, EWMA α, reservation buffer from live
  data. Failure injection: reservation expiry mid-brain, RunPod PATCH failure, baseline cold
  start (no samples yet). Confirm external **DR fallback** still carries generation when an
  internal circuit opens (no regression to `fb` rungs).
- Ramp: enable `ADMISSION_ENABLED` for a % of MCP projects; watch defer rate + failure rate.
- **Move cap 10 → 20** (`RUNPOD_ACCOUNT_CAP`) once the 10-worker workflow is proven.
- **Later (separate effort):** split `runpod:flux-tts-s2t` — Flux (image/animate/merge) →
  `qwen-image-gen` endpoint; keep TTS+BGM+SRT together (see admission-gate doc §10.3). Pure
  `counterKey` remap + `ENDPOINTS` change; admission/load model absorb it.

---

## 7. Env / config summary

**Implemented** (`src/handlers/admission.ts`):

| Var | Purpose | Default |
|---|---|---|
| `ADMISSION_STUB` | `granted` → always grant, skip capacity math (StoryStudio integration) | unset (real logic runs) |
| `ADMISSION_MAX_DRAIN_MS` | fleet-protection ceiling (defer above this) | 1,800,000 (30 min) |
| `ADMISSION_MAP_CONCURRENCY` | worker-sizing concurrency cap, mirrors the SFN Map's `MaxConcurrency` | 15 |
| `ADMISSION_BRAIN_WINDOW_MS` | added to reservation TTL for Convex's script/frame/prompt phase | 180,000 (3 min) |
| `ADMISSION_RESERVATION_BUFFER_MS` | extra slack added to reservation TTL | 300,000 (5 min) |
| `ADMISSION_ESTIMATED_READY_MS` | reported `estimatedReadySeconds` on grant (no live pre-warm yet — see Phase 3) | 210,000 |
| `ADMISSION_RETRY_MIN_SECONDS` / `ADMISSION_RETRY_MAX_SECONDS` | clamp on deferred `retryAfterSeconds` | 60 / 600 |
| `RUNPOD_ACCOUNT_CAP` | shared worker cap (same var provisioner already reads) | 10 (→20) |
| `RUNPOD_JOBS_PER_WORKER` | jobs-per-worker sizing constant (same var provisioner already reads) | 4 |
| `BASELINE_EWMA_ALPHA` | gen-time smoothing (`executor.ts` `recordBaseline`) | 0.2 |

**Not yet added:** `RUNPOD_PROVISION_LIVE` flip (Phase 3 — pre-warm on grant isn't wired to
this module yet, deliberately). No new infra stack — routes ride the existing API Lambda; the
sweeper schedule already exists. SDK (`sdk/typescript/src/client.ts`) optionally gains
`admit()` / `releaseAdmission()` helpers (not done — StoryStudio calls the HTTP contract directly).

---

## 8. Dependency order & open inputs

```
Phase 1 (load module + baselines)  ──▶  Phase 2 (admission + reservations)  ──▶  Phase 3 (pre-warm + wan2)
                                                     │
Phase 4 (consumption/balance) ───────────────────────┘   Phase 5 (harden + ramp + cap 10→20)
```

- Phase 1 & the wan2-i2v catalog repoint (Phase 3, first bullet) can start immediately.
- **Open inputs (don't block Phase 1):** baseline seed values for the RunPod fleet; whether
  RunPod balance is readable live via API (Phase 4 only).
- StoryStudio builds their §7 surface against the Phase-2 stub in parallel.
