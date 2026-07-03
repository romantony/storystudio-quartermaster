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

## 2. Phase 1 — Projected-load module + gen-time baselines  *(no behavior change, ship first)*

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
- **Seed** priors (from §10 open item, else conservative defaults) so ETAs work on day one.
- **Tests:** `__tests__/assetLoad.test.ts` (load math at 90/300/600, both tiers);
  `__tests__/baseline.test.ts` (EWMA convergence, first-sample seed).

**Exit:** `BASELINE#*` rows populate from real jobs; `projectAssetLoad()` unit-tested.

---

## 3. Phase 2 — `POST /admission` + `/release` + reservation-aware capacity  *(flagged)*

- **Routes in `src/handlers/api.ts`** (gateway-key section, next to `/jobs`):
  - `POST /admission` → `handleAdmission(evt)`
  - `POST /admission/{admissionId}/release` → `handleAdmissionRelease(evt)`
- **`src/handlers/admission.ts`** (new) — decision logic:
  1. Validate `{requestId, projectType, tier, durationSeconds, userId?}`.
  2. **Idempotency:** if `RESERVATION#{requestId}` exists and not expired → return its decision.
  3. `load = projectAssetLoad(...)`.
  4. Per endpoint the project needs: read `inflight` (`getInflight`), `queued`
     (`gatherQueuedByEndpoint`), `committedWorkers` (sum active reservations), `ewmaMs`
     (baseline, weighted over the endpoint's asset mix).
  5. `headroom = ACCOUNT_CAP − Σ committedWorkers`. **No-TAT decision:** grant if the endpoint
     can be given a worker share within `headroom` **and** projected drain stays under the
     **fleet-protection ceiling** (`ADMISSION_MAX_DRAIN_MS`); else **defer**. Big loads
     serialize per endpoint (an endpoint already committed to another project defers the next).
  6. **Grant:** write `RESERVATION#{requestId}` (`status:active`, dynamic `expiresAt`),
     return `{decision:"granted", admissionId, expiresAt, warmedEndpoints, estimatedReadySeconds}`.
     **Defer:** return `{decision:"deferred", reason, estimatedWaitSeconds, retryAfterSeconds}`
     (`estimatedWaitSeconds = (backlog+committed)·ewma ÷ workers`).
  7. **Release:** mark reservation `released` → frees committed workers immediately.
- **Flag:** `ADMISSION_ENABLED`. When off (or `ADMISSION_STUB=granted`), always return
  `granted` so StoryStudio can integrate against the wire shape before the math lands.
- **Sweeper (`handleSweeper`)**: expire `status:active` reservations past `expiresAt` →
  `status:expired`, free their workers (so a granted-but-never-started project can't pin the cap).
- **Tests:** `__tests__/admission.test.ts` — grant when headroom, defer when endpoint
  committed, idempotent re-POST, deferred ETA math, release frees workers.

**Exit:** grant/deferred/release correct against a stubbed fleet; StoryStudio integrating.

---

## 4. Phase 3 — Proactive live pre-warm + `wan2-i2v` wiring

- **Catalog (`background.json`)** — repoint `video.premium.i2v` from KIE → **runpod primary**:
  `{ provider:"runpod", model:"wan-2.2-i2v", mode:"i2v", endpointId:"nd7wloyvj09xwy",
     endpoint:"v2/nd7wloyvj09xwy", counterKey:"runpod:wan2-i2v", routingMode:"direct",
     lane:"video", fixed:{resolution:"480p"} }` then Replicate `fb:true`. (When the premium
  QM-new machine lands, add the `video.narrationPremium.i2v` key too.)
- **Provisioner `ENDPOINTS`** — add `{ counterKey:"runpod:wan2-i2v", endpointId:"nd7wloyvj09xwy" }`
  (4 endpoints now share the cap; `rebalanceUnderCap` already handles N).
- **Reservation-aware demand:** in `runProvisioner()`, add each active reservation's
  `perEndpoint.workers` to that endpoint's demand so a pre-warmed pool isn't scaled down before
  the SFN arrives, and reservations count toward the cap.
- **Pre-warm on grant:** on a granted admission, raise `workersMin` for the reserved endpoints
  now (write intended state + `patchRunPod` when live). Flip **`RUNPOD_PROVISION_LIVE=true`**
  (validate the shadow log first). Idle cooldown (existing 5-min) scales back after release.
- **Tests:** provisioner rebalance with 4 endpoints; reservation demand prevents premature
  scale-down; pre-warm raises `workersMin` within cap.

**Exit:** granting a project warms its endpoints during the brain window; workers scale down
after release/idle. `wan2-i2v` provisioned like the others.

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

| Var | Purpose | Default |
|---|---|---|
| `ADMISSION_ENABLED` | master flag for the gate | off |
| `ADMISSION_STUB` | `granted` → always grant (StoryStudio integration) | unset |
| `ADMISSION_MAX_DRAIN_MS` | fleet-protection ceiling (defer above this) | tune (~30 min) |
| `RUNPOD_ACCOUNT_CAP` | shared worker cap | 10 (→20) |
| `RUNPOD_PROVISION_LIVE` | shadow → live PATCH for pre-warm | unset (shadow) |
| `BASELINE_EWMA_ALPHA` | gen-time smoothing | 0.2 |
| existing: `JOBS_PER_WORKER`, `RUNPOD_SCALEDOWN_COOLDOWN_MS`, `SAFE_LIMIT`, lease TTLs | — | — |

No new infra stack — routes ride the existing API Lambda; the sweeper schedule already exists.
SDK (`sdk/typescript/src/client.ts`) optionally gains `admit()` / `releaseAdmission()` helpers.

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
