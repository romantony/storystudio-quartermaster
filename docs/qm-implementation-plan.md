# Quartermaster — Master Implementation Plan (four roles)

**Audience:** Quartermaster engineers (this repo) + StoryStudio integration owners.
**Scope:** Bring Quartermaster to production across its four roles:

1. **QM-New SF** — the isolated batch generation pipeline (`E2E-VideoGenerationPipeline-QM-new`).
2. **QM as Orchestrator** — the provider gateway: route every asset internal-first, fail over,
   meter (`QM-generate` → `POST /jobs` → executor → catalog ladders → adapters).
3. **QM as Capacity Manager** — provision/retire RunPod workers to match load under the account cap.
4. **QM as Gatekeeper** — project admission: grant/defer a slot before a project starts.

**Status:** roles 1–3 are **partly built** (see §2); role 4 is **not built**. This plan
sequences the remaining work into four workstreams and three milestones.

**Companion docs:**
- Contracts (StoryStudio-facing): `storystudio-qm-new-sfn-trigger.md`, `storystudio-qm-admission-gate.md`
- Detailed sub-plan for role 4: `qm-admission-gate-implementation-plan.md`
- Design rationale: `storystudio-unified/docs/quartermaster/QM_NEW_PIPELINE_DESIGN.md`

---

## 1. How the four roles interlock

```
        ┌─────────────── control plane ───────────────┐
StoryStudio (MCP) ─▶ (4) GATEKEEPER  ── grant ──▶ (3) CAPACITY MANAGER
   admission           decides IF/WHEN a           pre-warms + holds RunPod
   request             project may start            workers for the reserved load
                          │                              │  (scale up on demand,
                          │ granted (admissionId)        │   down when idle, under cap)
                          ▼                              ▼
        ┌─────────────── generation path ─────────────────────────────┐
   StartExecution ─▶ (1) QM-NEW SF ── per asset ──▶ (2) ORCHESTRATOR ──▶ RunPod (internal)
                        image→TTS→                    POST /jobs → executor    │ overflow / DR
                        animate→merge                 ladder: internal-first   ▼
                        → concat → SRT → finalize      + circuit-broken fallback  Replicate / KIE
```

- **Gatekeeper** gates admission and triggers **Capacity Manager** pre-warm during the 2–3 min
  brain window.
- **Capacity Manager** keeps workers sized to admitted + live load, releases on completion.
- **QM-New SF** is the per-project execution graph; each asset step calls the **Orchestrator**.
- **Orchestrator** routes internal-first (cost), overflow + DR to external providers.

---

## 2. Current state (build on this — don't rebuild)

**Deployment (CDK, `infra/bin/app.ts`):** `QMDatabaseStack` (table) · `QMApiStack` (API Lambda
`api.ts` + `executor`) · `QMWebhookStack` (external callbacks) · `QMSchedulerStack` (`/sweeper`
every 2 min) · `QMDashboardStack` (admin SPA) · `QMPipelineStack` (`QM-broker-call`,
`QM-generate`, and the `Basic-QM` / `Premium-QM` / `QM-new` state machines).

| Role | Status | What's there | What's missing |
|---|---|---|---|
| **1 QM-New SF** | **Built (test rig), unvalidated** | `E2E-VideoGenerationPipeline-QM-new` (`pipeline-stack.ts` `buildQmNewDefinition`/`qmFrameAssetsMap`): per-frame image(t2i/i2i)→TTS→Flux animate→Flux merge → concat → Whisper SRT → finalize | Not wired to StoryStudio's narration-basic MCP flow; no E2E validation; **premium** QM-new not built |
| **2 Orchestrator** | **Built, working** | `QM-generate` (`POST /jobs`+poll), `executor` (ladder resolve, internal-first, circuit breaker, fallback), `catalog/background.json`, adapters (runpod/kie/replicate); modelslab decommissioned; `video.premium.i2v` now RunPod Wan2 primary → Replicate fallback | **UI-backfill** routing policy not implemented; DR-fallback path not regression-tested post-changes |
| **3 Capacity Manager** | **Built, reservation-aware, pre-warm on grant wired; PATCH default OFF** | `provisioner.ts`: per-endpoint demand (organic + reservation-committed via `getReservedWorkersByEndpoint`) → workers, prewarm, scale-to-zero, cap-weighted rebalance; `prewarmEndpoints()` called synchronously from admission's `grant()`; live-PATCH path fixed (was silently broken — `RUNPOD_API_KEY` was never hydrated in the API Lambda) and gated by a deploy-time flag (`cdk deploy --context RUNPOD_PROVISION_LIVE=true`), defaulting off; 4th endpoint `runpod:wan2-i2v` | `RUNPOD_PROVISION_LIVE` not yet flipped in any deploy (ops decision, not a code gap — validate shadow log in staging first) |
| **4 Gatekeeper** | **Decision logic + pre-warm actuation built** | `src/shared/assetLoad.ts`; gen-time baselines in `executor.ts` (seeded from real `runpod/API.md` figures); `POST /admission` + `/admission/{id}/release`, wired into `api.ts` + the sweeper; reservation state (`RESERVATION#`/`RESERVATIONREQ#`); grant now synchronously pre-warms its endpoints (§WS-C3) — 12 tests in `admission.test.ts` | StoryStudio not yet calling it; no real-traffic validation; `RUNPOD_PROVISION_LIVE` still off so pre-warm is shadow-only in practice until an ops decision flips it |

**Cross-cutting gaps:** consumption/balance runway signal not built (baselines now exist, but
no `MeteringItem` writer or balance-runway alert yet).

---

## 3. Workstreams

### WS-A — QM-New SF (role 1)
**A1. Wire narration-basic (storystudio-unified).** In StoryStudio: build the compact
`sfInput` (per `storystudio-qm-new-sfn-trigger.md`) and `StartExecution` on
`E2E-VideoGenerationPipeline-QM-new`. Confirm the two known gotchas: `voiceGender` present as a
key; frame `referenceImageUrl` singular. *(StoryStudio-side; QM provides the contract.)*
**A2. Single-project E2E + fixes.** Run one narration-basic project end-to-end through QM-new;
fix issues (frame item shape into concat, SRT-from-concat audio, finalize). No gate yet —
orchestrator + shadow capacity, proves the generation path.
**A3. Premium QM-new SF.** Author the premium machine: per-frame image (Qwen t2i/i2i) → premium
TTS → **Wan2 i2v** (not Flux animate/merge) → concat → SRT → finalize; add
`video.narrationPremium.i2v` ladder key. Validate E2E.

### WS-B — Orchestrator (role 2)
**B1. ✅ DONE — Repoint `video.premium.i2v` → RunPod Wan2** (`background.json`): runpod primary
`endpointId nd7wloyvj09xwy`, `counterKey runpod:wan2-i2v`, `lane video`, Replicate `fb:true`.
Adapter gained the `i2v` mode case it needed (`src/adapters/runpod.ts`).
**B2. Internal-first + UI-backfill policy.** Formalize: batch (reserved) runs internal; **UI
asset requests backfill internal only when the queue is lean**, else external; batch always
precedes UI on internal. Encode as an executor/router admission check on `jobType`/priority.
**B3. DR-fallback regression.** Verify `fb:true` rungs still carry generation when an internal
circuit opens (no regression from the internal-first bias). Failure-inject one endpoint.

### WS-C — Capacity Manager (role 3)
**C1. ✅ DONE — Add `runpod:wan2-i2v`** to `provisioner.ts` `ENDPOINTS` (4 endpoints share the
cap; `rebalanceUnderCap` already handles N). Also exported `gatherQueuedByEndpoint` and a new
`getEndpointWorkersMax(counterKey)` for WS-D's admission math to reuse.
**C2. ✅ DONE — Reservation-aware demand.** `runProvisioner()` now folds active reservations'
committed worker share into its own sizing: `effectiveWorkers = max(organicWorkers, reserved)`
per endpoint (max, not sum — a reservation's promise and the jobs it eventually submits are
the same demand, so summing would double-count once its SFN starts running). A
reservation-only endpoint (zero live inflight/queued) now pre-warms (`toMin:1`,
reason `reservation-prewarm`/`reservation-hold`) instead of scaling to zero, and
`rebalanceUnderCap`'s proportional-share weighting was extended (`demandWeight()`,
`reserved × JOBS_PER_WORKER` to stay unit-comparable with job counts) so a reservation-only
endpoint isn't starved to 0 when organic demand elsewhere pushes the fleet over the cap —
verified by test with hand-derived numbers (flux-tts-s2t keeps `toMax:2` despite qwen-image-gen's
heavy live traffic taking `toMax:8` of the 10-worker cap). Reservation persistence was
extracted from `admission.ts` into `src/gate/reservation-gate.ts` (mirrors `dynamo-gate.ts`)
so the provisioner can read `getReservedWorkersByEndpoint()` without an
`admission.ts` ↔ `provisioner.ts` import cycle. `ProvisionShadowItem` gained a `reserved`
field for observability. 2 new tests in `__tests__/provisioner.test.ts`; 33/33 suite-wide.
**C3. ✅ DONE — pre-warm-on-grant + go-live mechanism.** `provisioner.prewarmEndpoints()`
raises `workersMin`/`workersMax` for a granted reservation's endpoints synchronously (not
waiting for the next sweeper tick); admission's `grant()` calls it right after saving the
reservation. Fixed a real latent bug found along the way: the live-PATCH path never had a
`RUNPOD_API_KEY` to authenticate with in the API Lambda (only the ARN was present) — added
lazy Secrets-Manager hydration. **Go-live is now a deploy-time flag**
(`cdk deploy --context RUNPOD_PROVISION_LIVE=true`, threaded through `ApiStackProps` +
`infra/bin/app.ts`), defaulting **off** — not flipped by this change; that's an explicit ops
decision once the shadow log is validated in staging. 3 new tests in `provisioner.test.ts`
(shadow raise, skip-when-warm, full LIVE-mode PATCH with mocked Secrets Manager + fetch) + 1
in `admission.test.ts`.
**C4. Cap lever.** Keep `RUNPOD_ACCOUNT_CAP=10`; move to 20 once the 10-worker workflow is proven.

### WS-D — Gatekeeper (role 4)  ✅ **decision logic built** → **detailed in `qm-admission-gate-implementation-plan.md`**
**D1. ✅ DONE.** `src/shared/assetLoad.ts` (projected load per endpoint, duration-parameterized)
+ gen-time **baselines** captured in `executor.ts` (`recordBaseline`, EWMA into
`BASELINE#{counterKey}`), seeded from real `runpod/API.md` warm-inference figures.
**D2. ✅ DONE.** `POST /admission` + `/admission/{id}/release` in `api.ts` → `admission.ts`
decision logic; `RESERVATION#{admissionId}` + `RESERVATIONREQ#{requestId}` pointer
(idempotent); sweeper reservation-expiry. Behind `ADMISSION_STUB=granted` (no separate
`ADMISSION_ENABLED` — real logic runs by default). **Correction made during implementation:**
worker sizing must use peak concurrency (SFN `MaxConcurrency=15`), not lifetime job total, or
a single basic project's 82 jobs would alone exceed the account cap — fixed and verified
against `runpod/API.md`'s documented real worker split. 11 tests passing.
**D3. ✅ Implemented as designed.** No-TAT decision: defer-and-wait bias, big loads serialize
per endpoint via the fleet-protection ceiling (`ADMISSION_MAX_DRAIN_MS`, default 30 min), not
a deadline; dynamic reservation TTL (`brainWindow + drainEstMs + buffer`).

### WS-E — Cross-cutting
**E1. Consumption + balance runway.** Slot-seconds per endpoint → `MeteringItem`; burn vs
`BalanceItem` → low-runway signal (live RunPod balance read if available, else admin-set).
**E2. Testing.** Unit (`assetLoad`, EWMA, admission decision, provisioner rebalance);
integration against a RunPod stub; E2E on staging per milestone.
**E3. Observability.** Dashboard: inflight/workers per endpoint, reservation count, defer rate,
gen-time baselines, runway.

---

## 4. Dependency graph & milestones

```
B1 (wan2 repoint) ─┬─▶ WS-A3 (premium SF)
                   └─▶ C1 (provisioner wan2)
D1 (assetLoad+baselines) ─▶ D2 (admission) ─▶ C2 (reservation-aware) ─▶ C3 (go-live + prewarm)
WS-A1/A2 (narration-basic E2E) runs on the built orchestrator + shadow capacity (no D/C needed)
E1/E2/E3 span all.
```

**Milestone M1 — narration-basic generation proven (no gate).**
WS-A1 + A2 (+ B3). One narration-basic project runs E2E through QM-new on the existing
orchestrator, capacity in shadow. *Proves the generation path.*
Exit: a finished narration-basic video from an MCP request via QM-new.

**Milestone M2 — control plane live for narration-basic.**
WS-D (D1→D3) + WS-C (C1→C3) + StoryStudio §7 wiring. Admission grants/defers; grant pre-warms
workers (live); release frees them. *Proves gatekeeper + capacity manager.*
Exit: 2 concurrent narration-basic → 2nd defers with ETA; granted one runs on pre-warmed
workers; reservation releases and workers scale down.

**Milestone M3 — premium + ramp.**
WS-A3 (premium SF) + B1/C1 (wan2) + E1 (consumption/balance). Premium narration E2E through the
gate; ramp MCP % (remove `ADMISSION_STUB` from staging, roll to production traffic gradually);
move cap 10→20 when proven. Later: split
`flux-tts-s2t` (Flux→qwen-image-gen endpoint; keep TTS+BGM+SRT together).
Exit: premium narration E2E; ramped batch traffic; runway alerting.

---

## 5. Immediate next actions (unblocked today)

1. ✅ **WS-B1 + C1** — wan2-i2v repointed in the catalog + provisioner (done).
2. ✅ **WS-D1 + D2** — `assetLoad`, baselines, and the full `POST /admission`/`/release`
   decision logic are built and tested (done — see §2 above and
   `qm-admission-gate-implementation-plan.md` for the detail, including the worker-sizing
   correction found during implementation).
3. **WS-A1/A2** — StoryStudio wires narration-basic to QM-new; run the first E2E (M1).
   *(Still open — StoryStudio-side. This is the only thing blocking M1/M2 validation now.)*
4. ✅ **WS-C2** — active reservations now fold into `runProvisioner()`'s own demand (done —
   see §3 WS-C above). The two capacity views (admission's decision math and the
   provisioner's organic scaling) now share one signal via `getReservedWorkersByEndpoint()`.
5. ✅ **WS-C3** — `prewarmEndpoints()` built and wired into admission's `grant()`; live-PATCH
   bug fixed (RunPod key hydration); go-live is now `cdk deploy --context
   RUNPOD_PROVISION_LIVE=true` (defaulting off — see §3 WS-C above). **The remaining step is
   an explicit ops decision**, not code: deploy to staging, watch the `PROVISION_SHADOW` audit
   trail for a few real admission grants, then flip the context flag when trusted.

**M1/M2 status:** all of QM's own control-plane code (roles 2–4) is now built and unit-tested.
What remains for M1 (narration-basic E2E) is entirely on StoryStudio's side (WS-A); what
remains for M2 (control plane live) is StoryStudio's wiring plus the ops decision to flip
`RUNPOD_PROVISION_LIVE`.

---

## 6. Open inputs & risks

**Open inputs (don't block M1 or D1):**
- Baseline **seed values** for the RunPod fleet (Flux Klein 4B, Kokoro, Flux animate/merge,
  Qwen image, Wan2 i2v, ACE-step, Whisper) — sharpen day-one ETAs; else conservative priors.
- Whether **RunPod balance** is readable live via API (WS-E1 only).

**Risks / mitigations:**
- *Going live with provisioning (C3)* → validate shadow log first; cap bounds spend; idle
  cooldown retires workers.
- *`flux-tts-s2t` overload under long videos* → serialize via admission ceiling now; endpoint
  split later (M3).
- *Contract drift (load math)* → single `assetLoad` module imported by admission **and** provisioner.
- *Premium three-endpoint load vs 10-worker cap* → admission defers premium sooner; 10→20 lever.
- *DR* → external `fb` rungs never removed; regression-tested in B3.
