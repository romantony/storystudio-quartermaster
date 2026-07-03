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
| **2 Orchestrator** | **Built, working** | `QM-generate` (`POST /jobs`+poll), `executor` (ladder resolve, internal-first, circuit breaker, fallback), `catalog/background.json`, adapters (runpod/kie/replicate); modelslab decommissioned | `wan2-i2v` not repointed to RunPod; **UI-backfill** routing policy not implemented; DR-fallback path not regression-tested post-changes |
| **3 Capacity Manager** | **Built, SHADOW mode** | `provisioner.ts` in `/sweeper`: per-endpoint demand → workers, prewarm, scale-to-zero, cap rebalance; audits decisions | `RUNPOD_PROVISION_LIVE` off (never PATCHes); only 3 endpoints (no `wan2-i2v`); not reservation-aware; no pre-warm-on-grant hook |
| **4 Gatekeeper** | **Not built** | — | Everything: `assetLoad` module, gen-time baselines, `POST /admission`+`/release`, reservation state, wait-time estimation (see role-4 sub-plan) |

**Cross-cutting gaps:** no per-asset gen-time baselines (executor records none); no
consumption/balance runway signal.

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
**B1. Repoint `video.premium.i2v` → RunPod Wan2** (`background.json`): runpod primary
`endpointId nd7wloyvj09xwy`, `counterKey runpod:wan2-i2v`, `lane video`, Replicate `fb:true`.
*(Can start immediately; also needed by WS-A3 and WS-C1.)*
**B2. Internal-first + UI-backfill policy.** Formalize: batch (reserved) runs internal; **UI
asset requests backfill internal only when the queue is lean**, else external; batch always
precedes UI on internal. Encode as an executor/router admission check on `jobType`/priority.
**B3. DR-fallback regression.** Verify `fb:true` rungs still carry generation when an internal
circuit opens (no regression from the internal-first bias). Failure-inject one endpoint.

### WS-C — Capacity Manager (role 3)
**C1. Add `runpod:wan2-i2v`** to `provisioner.ts` `ENDPOINTS` (4 endpoints share the cap;
`rebalanceUnderCap` already handles N).
**C2. Reservation-aware demand.** Fold active-reservation worker commitments into
`runProvisioner()` demand so pre-warmed pools aren't scaled down before the SFN arrives, and
reservations count toward the cap.
**C3. Go LIVE + pre-warm-on-grant.** Validate the shadow log, flip `RUNPOD_PROVISION_LIVE=true`;
on a granted admission raise `workersMin` for reserved endpoints immediately. Idle cooldown
scales back after release.
**C4. Cap lever.** Keep `RUNPOD_ACCOUNT_CAP=10`; move to 20 once the 10-worker workflow is proven.

### WS-D — Gatekeeper (role 4)  → **detailed in `qm-admission-gate-implementation-plan.md`**
**D1.** `src/shared/assetLoad.ts` (projected load per endpoint, 90/300/600 s) + gen-time
**baselines** captured in `executor` (`setProcessing`→`processingStartedAt`, `complete`→EWMA
`BASELINE#{counterKey}`). *(No behavior change — ship first.)*
**D2.** `POST /admission` + `/admission/{id}/release` in `api.ts`, `admission.ts` decision logic,
`RESERVATION#{requestId}` (idempotent), sweeper reservation-expiry. Behind
`ADMISSION_ENABLED` / `ADMISSION_STUB=granted`.
**D3.** No-TAT decision: internal-first, defer-and-wait, serialize big loads under the
fleet-protection ceiling; dynamic reservation TTL.

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

1. **WS-B1** — repoint `video.premium.i2v` to RunPod Wan2 in `background.json` (+ WS-C1 endpoint entry).
2. **WS-D1** — `src/shared/assetLoad.ts` + baseline capture in `executor` (pure telemetry, zero risk).
3. **WS-A1/A2** — StoryStudio wires narration-basic to QM-new; run the first E2E (M1).

These three run in parallel: A (generation path, StoryStudio-led) · D1+B1 (QM-led, no live
impact) · nothing blocks on the still-open inputs.

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
