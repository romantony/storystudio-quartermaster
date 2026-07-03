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
| **3 Capacity Manager** | **Built, SHADOW mode** | `provisioner.ts` in `/sweeper`: per-endpoint demand → workers, prewarm, scale-to-zero, cap rebalance; audits decisions; 4th endpoint `runpod:wan2-i2v` added | `RUNPOD_PROVISION_LIVE` off (never PATCHes); **not reservation-aware** (admission's reservations aren't folded into `runProvisioner()`'s demand yet); no pre-warm-on-grant hook |
| **4 Gatekeeper** | **Decision logic built, not live-integrated** | `src/shared/assetLoad.ts`; gen-time baselines captured in `executor.ts` (seeded from real `runpod/API.md` figures); `POST /admission` + `/admission/{id}/release` in `admission.ts`, wired into `api.ts` + the sweeper; reservation state (`RESERVATION#`/`RESERVATIONREQ#`); grant/defer/idempotency/expiry — 11 tests passing | No live pre-warm on grant (by design, deferred to align with WS-C3); StoryStudio not yet calling it; no real-traffic validation |

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
**C2. Reservation-aware demand.** *(Still open.)* Fold active-reservation worker commitments
into `runProvisioner()` demand so pre-warmed pools aren't scaled down before the SFN arrives.
Note: admission's own grant/defer decision (WS-D) already accounts for other active
reservations independently — this task is specifically about the provisioner's organic
scaling loop seeing the same commitment, so the two don't drift apart.
**C3. Go LIVE + pre-warm-on-grant.** Validate the shadow log, flip `RUNPOD_PROVISION_LIVE=true`;
on a granted admission raise `workersMin` for reserved endpoints immediately. Idle cooldown
scales back after release. *(Admission already reports `warmedEndpoints` in its response —
this task is the actuation that makes it real.)*
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
gate; ramp MCP % behind `ADMISSION_ENABLED`; move cap 10→20 when proven. Later: split
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
   *(Still open — StoryStudio-side.)*
4. **WS-C2** — fold active reservations into `runProvisioner()`'s own demand, so the two
   capacity views (admission's decision math and the provisioner's organic scaling) don't
   silently diverge. Natural next QM-side step now that both D2 and C1 exist.
5. **WS-C3** — go live: flip `RUNPOD_PROVISION_LIVE=true` and wire admission's grant response
   (`warmedEndpoints`) into an actual `workersMin` raise. Depends on C2 landing first so the
   pre-warm doesn't get clawed back by the sweeper before the SFN's jobs arrive.

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
