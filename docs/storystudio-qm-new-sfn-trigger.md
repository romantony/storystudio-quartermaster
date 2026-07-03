# StoryStudio → QM-New Step Function — Integration Guide

**Audience:** StoryStudio backend (Convex / MCP batch pipeline)
**Subject:** The new Quartermaster-gated pipeline `E2E-VideoGenerationPipeline-Narration-Basic-QM-New`,
what StoryStudio must send to it, and how the QM slot/admission + capacity-manager
handshake fits around it.
**Status:** SFN + capacity manager are **live in code** (capacity manager runs in
shadow mode). The project-level **admission handshake is a proposed contract, not yet
implemented** — see §2. Where a field or endpoint is a proposal it is called out inline.
**Companion docs:** `docs/storystudio-mcp-sfn-trigger.md` (legacy Basic-QM/Premium-QM),
`storystudio-unified/docs/quartermaster/QM_NEW_PIPELINE_DESIGN.md` (design rationale).

---

## 1. The big picture

```
                      (2) [proposed] admission check
StoryStudio  ─────────────────────────────────────────▶  Quartermaster (QM)
  (Convex /   POST {QM}/v1/admission  → granted/denied            │
   MCP)                                                            │  checks queue depth
     │  (1) build compact sfInput                                  │  + fleet headroom
     │                                                             ▼
     │  (3) StartExecution                                   grants a slot
     ▼
E2E-VideoGenerationPipeline-Narration-Basic-QM-New   (STANDARD SFN, tags batchjob=true qmGateway=true)
     │
     │  per frame (Map, MaxConcurrency=15):
     │     image (t2i / i2i) → TTS → Flux animate → Flux merge      each step is a
     │        every step is a QM-generate task ───────────────────▶ POST {QM}/jobs
     │                                                               + poll GET /jobs/{id}
     ▼                                                                     │
  concat → Whisper SRT → finalize (Fargate: merge + captions + BGM)       │  QM owns:
     │                                                                     │   • provider pick
     │  status callbacks → Convex (jobId + jwtToken + convexEndpoint)      │   • internal→external
     ▼                                                                     │     failover
  Complete                                                                 │   • per-endpoint
                                                                           │     concurrency
                    (4) capacity manager (sweeper every 2 min) ───────────┘
                        scales RunPod workers UP on demand,
                        DOWN (scale-to-zero) after 5-min idle
```

**Key point for StoryStudio:** you do **not** call QM per asset. The SFN calls the
`QM-generate` gateway for every image/TTS/animate/merge automatically. StoryStudio's only
direct responsibilities are **(a)** [proposed] the pre-flight admission check and **(b)**
`StartExecution` with the payload in §3.

---

## 2. The slot / admission handshake

> **This is the piece you described as "check with Quartermaster to get a slot before
> starting the project."** It is the intended pre-flight gate. It is **not yet built** in
> QM — QM today has no `/admission` route. Until it ships, StoryStudio should `StartExecution`
> directly; QM applies back-pressure per asset (see §5) and auto-provisions workers (§6), so
> nothing overruns the fleet — the admission call only adds *earlier* backpressure (deny at
> project start instead of queueing per asset).

### 2.1 Proposed contract — `POST {QM}/v1/admission`

Call this once, **before** `StartExecution`, to reserve fleet headroom for the whole project.

```jsonc
// request  (StoryStudio → QM)
{
  "requestId":       "mcp_abc123",          // idempotency key = mcpRequests.requestId
  "userId":          "user_111",
  "projectType":     "narration-basic",
  "tier":            "basic",
  "durationSeconds": 90,
  "projectedLoad":   { "image": 20, "tts": 20, "video": 20, "srt": 1, "bgm": 1 },
  "plannedDate":     1751500000000
}
```
```jsonc
// response
{ "decision": "granted", "admissionId": "qm_adm_…", "expiresAt": 1751500600000 }
// or
{ "decision": "denied",  "reason": "fleet_saturated", "retryAfterSeconds": 300 }
```

- **granted** → thread `admissionId` into the SFN input and `StartExecution`.
- **denied** → leave the `mcpRequests` row `queued`, retry after `retryAfterSeconds`
  (batch is pre-planned, so re-queue rather than fall back to external APIs).

`projectedLoad` is a deterministic function of `projectType` + `duration`
(`frameCount ≈ round(duration / 4.5)`, clamped per type). Keep this in **one shared module**
so StoryStudio's request and QM's capacity math never drift.

### 2.2 What exists today instead

QM's live "slot" primitives are lower-level and used **internally** by the pipeline, not by
StoryStudio:

| Endpoint | Auth | Who calls it | Purpose |
|---|---|---|---|
| `POST {QM}/jobs` | `x-gateway-key` | `QM-generate` Lambda (inside the SFN) | submit one asset job; QM queues, meters, and dispatches it |
| `GET  {QM}/jobs/{requestId}` | `x-gateway-key` | `QM-generate` Lambda | poll that job to COMPLETE/FAILED |
| `POST {QM}/acquire` · `/release` · `/heartbeat` | `x-gateway-key` | legacy Basic-QM / Premium-QM broker states | per-asset lane semaphore (QM-new does **not** use these — it uses `/jobs`) |

So today, admission is effectively "per asset, at `/jobs`," not "per project, up front."
The §2.1 endpoint is the agreed next step if you want project-start backpressure.

---

## 3. What to send to the SF (`E2E-VideoGenerationPipeline-Narration-Basic-QM-New`)

**State machine ARN**
```
arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Narration-Basic-QM-New
```
Tags: `batchjob=true`, `qmGateway=true`. Start executions with the existing
`arn:aws:iam::929075264324:role/E2E-StepFunction-Role`.

The payload is **much smaller than Premium-QM**: no `voiceUrls`, `voiceAudioUrl`,
`captionsUrl`, `hookConfig`, `characterBible`, or `synopsis`. QM-new generates images and
per-frame TTS internally and derives the SRT from the concatenated audio with Whisper.

### 3.1 Execution input

```json
{
  "projectId":      "proj_abc123",
  "jobId":          "job_xyz789",
  "userId":         "user_111",
  "projectType":    "narration-basic",
  "aspectRatio":    "9:16",
  "voiceGender":    "female",
  "bgmUrl":         "https://cdn-v2.ai-storystudio.com/bgm/track.mp3",
  "apiKey":         "<storystudio-internal-api-key>",
  "jwtToken":       "<convex-jwt>",
  "convexEndpoint": "https://your-deployment.convex.cloud",
  "admissionId":    "qm_adm_…",
  "frames": [
    {
      "frameId":           "frame_001",
      "frameNumber":       1,
      "imagePrompt":       "A cozy living room at dusk, warm lighting, photorealistic",
      "narrationText":     "Every evening, the house settles into a quiet golden glow.",
      "referenceImageUrl": "",
      "voiceUrl":          "",
      "duration":          4.2
    }
  ]
}
```

### 3.2 Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `projectId` | string | **yes** | Threaded to every QM-generate call + status updates |
| `jobId` | string | **yes** | Used for Convex status callbacks |
| `userId` | string | **yes** | Passed to QM-generate for attribution/metering |
| `projectType` | string | **yes** | e.g. `"narration-basic"`; carried to Fargate finalize |
| `aspectRatio` | string | **yes** | `"16:9"`, `"9:16"`, or `"1:1"` — sets image dims + clip aspect |
| `voiceGender` | string | **yes (key must be present)** | `"male"`→`am_adam`, `"female"`→`af_bella`, anything else→`am_adam`. **Empty string `""` is safe; a missing key errors the TTS state at runtime** — always include it. Project-level (not per-frame). |
| `bgmUrl` | string | **yes** | BGM CDN URL; pass `""` for none |
| `apiKey` | string | **yes** | Internal StoryStudio key used by `E2E-video-concat-premium` |
| `jwtToken` | string | **yes** | Short-lived Convex JWT for status callbacks |
| `convexEndpoint` | string | **yes** | `https://<deployment>.convex.cloud` |
| `admissionId` | string | no (proposed) | From §2.1; carry it through so QM can tie asset jobs to the reservation. Ignored today. |

### 3.3 Frame object (`frames[]`, one per frame)

| Field | Type | Required | Notes |
|---|---|---|---|
| `frameId` | string | **yes** | Stable unique ID; used as the S3 image cache key |
| `frameNumber` | number | **yes** | 1-based; drives concat ordering |
| `imagePrompt` | string | **yes** | Prompt for the image step (t2i, or i2i if `referenceImageUrl` set) |
| `narrationText` | string | **yes** (unless `voiceUrl` set) | TTS text for the per-frame voice |
| `referenceImageUrl` | string | no | **Singular string.** Non-empty ⇒ image goes **i2i** using this UI character reference; empty/absent ⇒ **t2i**. ⚠️ Note this differs from Premium-QM's `referenceImageUrls` (array) — QM-new expects the **singular** field. |
| `voiceUrl` | string | no | If non-empty, TTS is **skipped** and this audio is reused. Empty/absent ⇒ TTS generated from `narrationText`. |
| `duration` | number | **yes** | Seconds; drives the Flux animate clip length |

### 3.4 Fields you must NOT send (vs. Premium-QM)

QM-new ignores or does not need: `voiceUrls`, `voiceAudioUrl`, `captionsUrl`,
`generateShorts`, `shortsRenderStyle`, `mode`, `characterBible`, `synopsis`, `hookConfig`,
and per-frame `voiceName` / `ttsModel` / `referenceImageUrls`. Leaving them in is harmless
but they have no effect — voice is selected by the top-level `voiceGender`.

---

## 4. Pipeline flow (what happens after StartExecution)

```
ValidateInput → CheckValidation
→ UpdateStatusGeneratingImages
→ GenerateImages  (Map over frames, MaxConcurrency=15)   ── all via QM-generate ──
     per frame:
       CheckImageCache → [hit] UseImageCache
                      → [miss] RouteImageGen
                                 → QMGenerateImageT2I   (image.narrationBasic.t2i)
                                 → QMGenerateImageI2I   (image.narrationBasic.i2i, if referenceImageUrl)
                                 → StoreImageMeta
       RouteTTS → [voiceUrl present] UseProvidedVoice
                → QMGenerateTTS      (voice.narrationBasic.tts, voice by voiceGender)
       QMAnimate  (video.narrationBasic.animate → Flux Ken Burns, silent MP4)
       QMMerge    (video.narrationBasic.merge   → voice onto animation, MP4 w/ audio)
       BuildFrameVideo → { frameId, frameNumber, videoUrl, duration }
→ DropFrameData  (carry videoResults, drop frames to stay < 256 KB)
→ UpdateStatusConcatenating
→ ConcatenateVideos           (E2E-video-concat-premium; reads videoUrl + frameNumber)
→ TranscribeAudio             (Whisper SRT from concat audio — no upstream SRT needed)
→ BuildMergedVoiceResult
→ UpdateStatusApplyingBgm → ValidateFinalizeInputsBasic → PrepareFinalizeBasic
→ FinalizeVideoBasic          (Fargate: audio merge + captions + BGM)
→ Complete
```

A frame that exhausts all QM rungs for image/TTS/animate/merge emits a graceful
`{ failed:true, frameId, frameNumber }` item rather than aborting the Map — matching the
legacy pipelines' per-frame resilience. Top-level unrecoverable errors route
`HandleFailure → UpdateStatusFailed → FailState` and set the Convex job to `"failed"`.

---

## 5. How QM meters each asset (per-frame backpressure)

Every `QMGenerate*` state is a `QM-generate` Lambda task that:

1. `POST {QM}/jobs` with a canonical job — QM **de-dupes by `requestId`**
   (`projectId:frameId:assetType:operation`), so retries and cache hits are free.
2. Polls `GET {QM}/jobs/{requestId}` every ~3 s (deadline ~290 s) until
   `COMPLETE` / `COMPLETE_WITH_FALLBACKS` / `FAILED` / `DEAD`.
3. QM internally: picks the provider by the catalog **ladder** (internal RunPod first for
   batch, external KIE/Replicate as circuit-broken fallback), holds a per-endpoint semaphore
   slot, uploads to S3/CDN, and returns the asset key.

Because QM owns the per-endpoint concurrency, the SFN's `MaxConcurrency=15` is a ceiling, not
a fleet load — QM queues beyond real capacity instead of blasting RunPod. This is the
"back-pressure is transparent" property: the execution keeps running; only individual frame
steps wait.

---

## 6. Capacity manager (workers up on demand, down when idle)

> **This is the piece you described as "enable new active workers when the request flow rises
> and bring them down when it goes down."** It is live in code, currently in **shadow mode**
> (`RUNPOD_PROVISION_LIVE` unset) — it computes and audits the scale decision every tick but
> does not yet PATCH RunPod. Flip the flag to enforce.

- **Driver:** the `/sweeper` route runs every **2 minutes** (EventBridge Scheduler). Besides
  reclaiming expired jobs/leases and reconciling the in-flight counter, it runs the
  **provisioner**.
- **Per RunPod endpoint** (image-gen, image-edit, TTS/S2T today), it reads
  `demand = inflight + queued` from DynamoDB and sets:
  - `workersMax = ceil(demand / JOBS_PER_WORKER)` (default 4 jobs/worker),
  - `workersMin = 1` (**pre-warm**) while any work exists,
  - **scale-to-zero** once demand is 0 **and** a **5-minute cooldown** has elapsed since the
    endpoint was last busy.
- **Shared account cap:** the sum of `workersMax` across endpoints is clamped to
  `RUNPOD_ACCOUNT_CAP` (10, rising to 20 once RunPod balance ≥ $200), allocated
  demand-weighted with leftover headroom handed to the hungriest endpoint.

**Net effect for StoryStudio:** when a batch of projects hits QM, workers spin up within a
sweeper tick or two (≈ first job pays a cold-start; there's a pre-warm min of 1); when the
batch drains, workers scale back to zero after the cooldown. No action required on your side.

---

## 7. Starting an execution (AWS SDK)

```typescript
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const sfn = new SFNClient({ region: 'us-east-1' });

// (proposed) const { admissionId } = await requestAdmission(payload);  // §2.1, else omit

const res = await sfn.send(new StartExecutionCommand({
  stateMachineArn:
    'arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Narration-Basic-QM-New',
  name:  `${projectId}-${jobId}`,          // unique per execution; ≤ 80 chars
  input: JSON.stringify(payload),          // §3.1
}));

console.log('executionArn:', res.executionArn);
```

Set `name` to `${projectId}-${jobId}` for easy CloudWatch correlation; append a suffix on
retry since names must be unique within the state machine.

---

## 8. Rollout status & open items

- **narration-basic** is the first target (this doc). **narration-premium** will follow as a
  separate premium QM-new machine once basic is validated end-to-end.
- `Basic-QM` / `Premium-QM` are untouched — non-QM-new projects keep their current path.
- **Open confirmations** (see `QM_NEW_PIPELINE_DESIGN.md §12` and QM memory):
  1. Does StoryStudio want the §2.1 project-level admission gate now, or is per-asset
     metering (§5) + auto-provisioning (§6) sufficient for phase 1?
  2. `voiceGender` must be present as a key in the execution input (empty string OK).
  3. Confirm TTS is per-frame from `narrationText` (current behavior) rather than a single
     whole-script pass — switch to a pre-Map TTS step if narration is produced whole-script
     upstream.
```
