# StoryStudio ↔ Quartermaster — Project Admission Gate (Build-Planning Doc)

**Audience:** StoryStudio backend (Convex / MCP batch pipeline)
**Purpose:** So StoryStudio can plan its side of the build. This defines the **admission
handshake** StoryStudio calls *before* starting a project, the request/response contract, and
exactly what StoryStudio must implement vs. what Quartermaster (QM) implements. Once
StoryStudio's plan is ready, QM begins its implementation against this contract.
**Status:** Contract **agreed in principle**; QM-side build not started. Two inputs still
open (§10). Endpoints/loads reflect the current RunPod fleet as of 2026-07-03.
**Companion:** `storystudio-qm-new-sfn-trigger.md` (the SFN payload — unchanged except a new
`admissionId` field).

---

## 1. The problem this solves

Today Convex starts a batch project the moment the 2-min cron fires — with **no awareness of
the internal RunPod fleet's capacity**. Under load, every asset call piles into the queue,
waits, times out, and fails; we recover by **manually re-triggering**. That's reactive and
lossy.

**The fix is proactive:** before a project starts, StoryStudio asks QM for a **slot**. QM
knows the project's projected asset load (from `projectType` + `duration`), knows the live
queue and worker capacity, and knows the **learned generation time per asset**. It answers:

- **granted** — capacity is (or will be) there; QM **pre-warms** the workers now, during the
  2–3 min StoryStudio spends generating script/frames/prompts, so they're hot when assets
  arrive.
- **deferred** — the queue is busy; QM returns an **estimated wait**. StoryStudio keeps the
  project queued and retries — no failed generation, no re-trigger.

### 1.1 Scope & priority — read this first

- **MCP/batch only.** StoryStudio calls `/admission` **only** for projects that arrive from
  the **MCP server**. UI-initiated generation **never** calls QM — it stays on the existing
  external-API path, unchanged. The gate governs exclusively pre-planned background work.
- **No strict TAT — optimize for zero-failure quality, not speed.** Nobody is waiting on a
  spinner. So QM **biases toward defer-and-wait**: it admits only when it is confident the
  project will complete *cleanly*, and freely **serializes / queues** big loads rather than
  risk admitting into an overloaded fleet. Deferrals are cheap and expected. This is the whole
  point — *reliability over latency*. Long ETAs are fine; **failed generations are not.**
- **Two levels, don't conflate them.** (a) **Project admission** — the reservation handshake in
  this doc — is **MCP-only**. (b) **Asset-generation routing** — QM's internal-first / external-
  overflow policy (§6.1) — applies to *all* asset work, and lets **UI projects opportunistically
  use spare internal capacity when the queue is lean**, with external as overflow **and DR**.
  UI never *reserves*; it just backfills idle internal capacity.

---

## 2. End-to-end flow

```
StoryStudio (Convex / MCP)                         Quartermaster
──────────────────────────                         ─────────────
mcp-request-queue-processor (2-min cron)
  for each queued+due request:
    │
    │  (1) POST {QM}/admission                 ──▶  project load from projectType+duration
    │      {requestId, projectType,                 vs live queue + worker cap (10) + learned
    │       tier, durationSeconds, userId}          baselines  →  decision
    │                                          ◀──  granted{admissionId,…}  |  deferred{etaSec}
    │
    ├─ deferred ─▶ leave row "queued", set retryAfter = retryAfterSeconds, surface ETA.
    │              next cron tick re-checks admission.   (QM scales workers as queue drains)
    │
    └─ granted ─▶ (2) QM pre-warms reserved endpoints (raises workersMin now)
                  (3) run the "brain": script + frames + prompts  (~2–3 min)   [Convex, unchanged]
                  (4) StartExecution E2E-VideoGenerationPipeline-QM-new
                        input = compact sfInput + admissionId          [see companion doc]
                  (5) SFN runs; every asset goes through QM-generate → RunPod (now warm)
                  (6) onJobTerminated → POST {QM}/admission/{admissionId}/release
                        → QM frees the reservation; workers scale down after idle cooldown
```

**Everything agent-facing is unchanged** — the agent still polls
`GET /api/agent/v1/requests/:id` and sees `queued → processing → completed/failed`. Admission
just governs *when* `queued → processing` happens.

---

## 3. Decisions locked (this iteration)

| # | Decision | Choice |
|---|---|---|
| 0 | Scope | **MCP/batch projects only.** UI generation never calls `/admission` (unchanged external path). |
| 0a | Priority | **No strict TAT — reliability over latency.** Bias toward defer-and-wait; admit only when clean completion is confident. Deferrals expected; long ETAs fine, failures not. |
| 1 | Admission granularity | **One reservation per project** (not per asset). `admissionId` threads into the SFN. |
| 2 | Provisioning on grant | **Proactive + live.** On grant QM raises `workersMin` for the reserved endpoints so they cold-start during the brain window. |
| 3 | Grant strictness | **Wait-time-estimated**, not hard fit-or-deny. Allow (provision) if capacity fits within the worker cap; else defer with an ETA; auto-admit when the queue calms. |
| 4 | Worker cap | **10 now** (`RUNPOD_ACCOUNT_CAP=10`), moves to **20 later** once the 10-worker workflow is proven — QM-side constant, no contract change. |
| 5 | Load source of truth | QM computes projected load from `projectType`+`duration` (StoryStudio does **not** send it). Duration is **open-ended** — 90 / 300 / 600 s all supported; `frameCount` scales (§5). |
| 5a | Long-load handling | Admit only if projected drain stays under an **acceptable-wait ceiling**; else defer with ETA. Big loads serialize per endpoint with honest ETAs — *admit only when we can manage* (§5.1). |
| 6 | mcpRequests store | **Stays in Convex.** QM owns only the reservation + fleet state. |
| 7 | Auth | `x-gateway-key` shared secret (same as `POST /jobs`). |

---

## 4. The admission contract  ← **the interface StoryStudio builds against**

Base URL: `QM_BASE_URL` (the QM Lambda Function URL / CloudFront). All calls send header
`x-gateway-key: <shared secret>` and `Content-Type: application/json`.

### 4.1 Request a slot — `POST {QM}/admission`

```jsonc
// request  (Convex → QM)   — call BEFORE creating the project / running the brain
{
  "requestId":       "mcp_abc123",     // idempotency key = mcpRequests.requestId (REQUIRED)
  "projectType":     "narration-basic",// narration-basic | narration-premium  (REQUIRED)
  "tier":            "basic",           // basic | premium                       (REQUIRED)
  "durationSeconds": 90,                // project duration                      (REQUIRED)
  "userId":          "user_111"         // attribution                           (optional)
}
```

QM derives `frameCount` and the per-endpoint job load itself (§5). `requestId` makes the call
**idempotent** — re-POSTing the same `requestId` returns the same decision/`admissionId`, so
the 2-min cron can retry safely.

### 4.2 Responses

**Granted** — proceed to brain + StartExecution:
```jsonc
{
  "decision":             "granted",
  "admissionId":          "qm_adm_7f3…",  // thread into the SFN input
  "expiresAt":            1751500900000,  // reservation TTL = brain window + drain + buffer (dynamic; longer for long videos). StartExecution before this.
  "warmedEndpoints":      ["runpod:flux-tts-s2t"],   // endpoints QM is pre-warming for you
  "estimatedReadySeconds": 180            // ~cold-start; workers warm by ~this time
}
```

**Deferred** — queue busy; keep the row queued and retry:
```jsonc
{
  "decision":             "deferred",
  "reason":               "queue_busy",   // queue_busy | cap_committed | fleet_saturated
  "estimatedWaitSeconds": 240,            // ETA before capacity frees (from live queue × baselines)
  "retryAfterSeconds":    120             // don't re-POST before this
}
```

> There are only **two outcomes to handle**: `granted` → go; `deferred` → re-queue and retry
> after `retryAfterSeconds`. `reason`/ETA are for logging + UX, not branching.

### 4.3 Release the slot — `POST {QM}/admission/{admissionId}/release`

Call on **terminal** project state (complete **or** failed), from your existing
`onJobTerminated` hook. Best-effort — if you miss it, the reservation TTLs out at `expiresAt`
and workers scale down on the idle cooldown anyway. Frees the reservation immediately so the
next project can be admitted sooner.

```jsonc
// request
{ "outcome": "completed" }   // completed | failed
// response
{ "released": true }
```

---

## 5. Projected load model (how QM sizes a project)

Deterministic from `projectType` + `duration`. `frameCount = f(duration)`, clamped per type
(≈ `duration / 5`, so 90 s → 20, 300 s → 60, 600 s → 120 frames). Load is projected **per
internal RunPod endpoint**, because that's what QM provisions. Per-frame work: basic =
4 jobs/frame (image + TTS + animate + merge); premium = image + TTS + video per frame; both
add 1 SRT + 1 BGM per project.

| Duration → frames | narration-basic → `flux-tts-s2t` | narration-premium → `flux-tts-s2t` / `qwen-image-gen` / `wan2-i2v` |
|---|---|---|
| **90 s → 20** | **82** (20 img + 20 tts + 20 animate + 20 merge + 1 srt + 1 bgm) | 22 / 20 / 20 |
| **300 s → 60** | **242** | 62 / 60 / 60 |
| **600 s → 120** | **482** | 122 / 120 / 120 |

Notes StoryStudio should know:
- **narration-basic puts its entire load on one endpoint** (`flux-tts-s2t`) — one 90 s basic
  already saturates that pool; a **600 s basic is ~482 jobs on that single endpoint**.
- `flux-tts-s2t` **also serves every project's TTS/SRT/BGM** — so a long basic can starve
  other projects' audio. This is the fleet's main contention point.
- **narration-premium lights up three endpoints at once**, all sharing the worker cap — so
  premium (especially 300 s+) is harder to admit and defers sooner. This is what the
  **10 → 20 cap** move is for.
- Fallbacks (Replicate/KIE) are external and not provisioned; they only engage if an internal
  endpoint's circuit opens.

### 5.1 Long videos & large loads (300 s / 600 s)

The admission math scales without change — a big project just has a large `projected`, so it
gets a large **honest ETA**. What QM does to stay robust at 120+ frames (all QM-side; **no
change to the StoryStudio contract**):

- **Fleet-protection ceiling** — the admit/defer knob. Because there's **no TAT** (§1.1), this
  ceiling isn't a latency deadline — it's a bound on how deep the endpoint's queue may grow
  before further jobs risk timing out. QM admits only while projected drain stays under it;
  otherwise it **defers with the ETA**. Big loads **serialize per endpoint** behind an honest
  wait instead of piling in and failing. This is the literal meaning of *"admit only when we
  can manage."* With no TAT the bias is deliberately toward **defer** — a clean run later beats
  a failed run now.
- **Dynamic reservation TTL** — a 600 s project holds workers ~15–20 min, so `expiresAt` is
  `now + estimatedDrain + buffer` (not a flat 15 min); QM heartbeats it while the SFN runs.
- **ETA reflects the full drain** — `(backlog + projected) × baseline ÷ workers`. A 600 s
  basic at, say, 6–10 dedicated workers is a ~12–20 min generation; StoryStudio receives that
  as `estimatedWaitSeconds`/`estimatedReadySeconds` and can surface it.
- **Net effect for StoryStudio:** long videos = **larger ETAs and more `deferred` responses**,
  same two outcomes to handle. Robustness lives entirely in QM.

---

## 6. Capacity model (QM side — context for planning)

The scarce resource is **RunPod workers under a shared account cap of 10** (→ 20 later), cold
start **2.5–4 min**, throughput sized at `ceil(demand / jobs-per-worker)`. Four endpoints
share the cap:

| counterKey | endpointId | serves |
|---|---|---|
| `runpod:flux-tts-s2t` | `rnqxi6c0mlq517` | basic image/TTS/animate/merge, all TTS, SRT, BGM |
| `runpod:qwen-image-gen` | `e165se4r3eo5hp` | premium image (t2i) |
| `runpod:qwen-image-edit` | `oxwx8o879qwtla` | premium image (i2i) |
| `runpod:wan2-i2v` | `nd7wloyvj09xwy` | premium video (Wan2 i2v) — Replicate fallback |

QM will:
1. **Learn generation time per asset** — record each job's pure generation time (PROCESSING →
   COMPLETE) into a self-updating baseline (EWMA), seeded with priors and converging to the
   real fleet within a few dozen jobs. *(New — QM records no per-asset timing today.)*
2. **Estimate drain/wait** — `(backlog + projected) × baseline ÷ workers` per endpoint; the
   max across an admission's endpoints is the ETA in §4.2.
3. **Provision within the cap** — on grant, raise `workersMin` for the reserved endpoints
   (pre-warm); scale down after the idle cooldown once the queue drains.
4. **Track capacity vs consumption** — slot-seconds consumed vs RunPod balance → a low-runway
   signal so the account is topped up before failures (see §10 open item).

StoryStudio does not implement any of §6 — it's listed so your team understands what "granted"
and the ETA actually mean.

### 6.1 Internal-first routing, UI backfill, and DR fallback (cost policy)

QM's asset routing is **internal-first to control cost** — every generation prefers our own
RunPod models; external providers (Replicate / KIE / Google) are **overflow, not the default**:

- **Maximize internal utilization.** Batch (MCP) work is admitted via the gate and runs on
  internal RunPod. **When the internal queue is lean**, QM also **admits UI projects' asset-
  generation requests onto internal capacity** — backfilling otherwise-idle workers. This is
  purely an asset-generation optimization; UI projects still **never reserve** and never gate a
  batch project.
- **Overflow to external.** When internal capacity is saturated (or a UI request needs a warm,
  low-latency path the internal queue can't give right now), the request spills to the external
  provider ladder. Batch reservations always take precedence over UI backfill on internal.
- **Fallback is always in place for DR.** The external ladder is **never removed** — it is the
  disaster-recovery path. If an internal endpoint's circuit opens (errors/outage) or the fleet
  is down, the catalog's `fb: true` rungs (Replicate / KIE) carry generation through. The no-
  TAT, internal-first bias reduces *cost*, it does **not** reduce *resilience*.

Net: **internal for cost, external for overflow and DR.** Admission (§4) governs batch; §6.1
governs how spare internal capacity is shared and how failures are absorbed.

---

## 7. What StoryStudio builds  ← **your planning checklist**

| # | Change | Where (per the design doc's code map) |
|---|---|---|
| 1 | **Call `POST {QM}/admission`** before project creation, inside the queue processor. On `deferred`, leave the `mcpRequests` row `queued`, store `retryAfter = retryAfterSeconds`, do **not** create the project. On `granted`, proceed. | `agentApi.ts` → `processQueuedJobsScheduler` |
| 2 | **Persist `admissionId`** (and `expiresAt`) on the `mcpRequests` row. | `mcpRequests` schema: add `admissionId?`, `admissionExpiresAt?`, `retryAfter?` |
| 3 | **Thread `admissionId`** into the QM-new SFN input at StartExecution. | `e2e/pipeline.ts` (or `qmPipeline.ts`) `startQmNewPipeline` |
| 4 | **Release on terminal** — `POST {QM}/admission/{admissionId}/release` with `completed`/`failed`. | `videoQueue.ts` → `onJobTerminated` |
| 5 | **Respect `retryAfterSeconds`** in the cron so a deferred request isn't re-checked too soon. | `crons.ts` / `processQueuedJobsScheduler` |
| 6 | **(Optional) Surface the ETA** to the agent/UI so a deferred project shows an estimated start time instead of silently waiting. | agent status mapping |

That's the whole StoryStudio surface: **one pre-flight call, one field to thread, one release
call, and deferred-aware re-queue logic.** No per-asset calls — the SFN handles those.

---

## 8. SFN payload delta

The QM-new execution input is exactly as documented in `storystudio-qm-new-sfn-trigger.md`,
with **one addition**: include the granted `admissionId` at top level so QM can tie the
per-asset jobs to the reservation.

```jsonc
{
  "projectId": "…", "jobId": "…", "userId": "…",
  "projectType": "narration-basic", "aspectRatio": "9:16",
  "voiceGender": "female", "bgmUrl": "…", "apiKey": "…",
  "jwtToken": "…", "convexEndpoint": "…",
  "admissionId": "qm_adm_7f3…",          // ← NEW, from §4.2 granted response
  "frames": [ /* … */ ]
}
```

---

## 9. Build sequencing

1. **QM** implements: `shared/assetLoad`, baseline capture in the executor, `POST /admission`
   + `/release`, reservation table, live pre-warm, and wires the `runpod:wan2-i2v` endpoint
   into the catalog + provisioner. Ships behind a flag with a **stub-friendly contract** so
   StoryStudio can integrate against a granted/deferred stub before the capacity logic lands.
2. **StoryStudio** implements §7 against this contract in parallel.
3. **Joint validation:** narration-basic end-to-end — deferred path (2nd concurrent basic
   defers with an ETA), granted path (workers pre-warm, SFN runs on warm workers), release
   path (reservation frees, workers scale down). Then narration-premium.
4. **Ramp:** flag-gate on `createdViaMcp`; ramp %; move cap 10 → 20 when proven.

---

## 10. Open items (do not block StoryStudio's planning)

1. **Baseline seed values** — QM has no real generation-time numbers for the current RunPod
   fleet yet; it seeds conservative priors and learns. If StoryStudio/infra has any measured
   warm times (Flux Klein 4B, Kokoro, Flux animate/merge, Qwen image, Wan2 i2v, ACE-step,
   Whisper), they sharpen day-one ETAs.
2. **RunPod balance read** — whether the low-runway signal reads balance live via the RunPod
   API or a manually-set number. Affects only §6.4, not the StoryStudio contract.
3. **Planned endpoint re-architecture (later).** `runpod:flux-tts-s2t` currently bundles too
   many models (image + animate + merge + TTS + BGM + SRT), which is the fleet's contention
   hotspot (§5). Plan: **move Flux (image/animate/merge) onto the Qwen image-gen endpoint** and
   **keep TTS + BGM + SRT together** on their own endpoint — separating video/image generation
   from audio so long video loads can't starve audio. This is a QM-side change (catalog
   `counterKey` remap + provisioner `ENDPOINTS`); the admission contract and the per-endpoint
   load model absorb it transparently. **Not in scope now** — flagged so the load tables above
   are understood as the current, pre-split topology.

---

## 11. Quick reference

- **Admission:** `POST {QM}/admission` → `granted{admissionId,expiresAt}` | `deferred{retryAfterSeconds,estimatedWaitSeconds}`
- **Release:** `POST {QM}/admission/{admissionId}/release` `{outcome}`
- **Auth:** `x-gateway-key` header.
- **StoryStudio handles two outcomes:** granted → brain + StartExecution(+admissionId); deferred → re-queue, retry after `retryAfterSeconds`.
- **SFN:** `arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-QM-new` (payload per companion doc + `admissionId`).
