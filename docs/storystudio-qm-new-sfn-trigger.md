# StoryStudio → QM-New Step Functions — Integration Guide

**Audience:** StoryStudio backend (Convex / MCP batch pipeline)
**Subject:** The two Quartermaster-gated narration pipelines —
`E2E-VideoGenerationPipeline-Narration-Basic-QM-New` and
`E2E-VideoGenerationPipeline-Narration-Premium-QM-New` — what StoryStudio must send to
each, and how the admission gate + capacity manager fit around them.
**Status (2026-07-03):** Both state machines are **built, deployed, `ACTIVE`**, and pass
AWS's own ASL validator with zero diagnostics. The orchestrator (QM-generate + executor +
catalog) and capacity manager are live. **The admission gate is built and live too** — see
§2, and the full contract in `docs/storystudio-qm-admission-gate.md`. **Neither machine has
run a real end-to-end project yet** — that's the next step, and it's on StoryStudio's side
(wire a request, `StartExecution`, watch it through).
**Confirmed/added this session:** character-reference-image support was already fully live
(per-frame `referenceImageUrl`, no change needed). **BGM is now generated from a prompt**
(`bgmPrompt`, project-level) instead of accepted as a pre-existing URL — `bgmUrl` is
**removed** from both payloads; see §3.2/§9.2 and the updated flow diagrams (§4/§9.4).
**Companion docs:** `docs/storystudio-qm-admission-gate.md` (the admission contract, full
detail), `docs/storystudio-mcp-sfn-trigger.md` (legacy Basic-QM/Premium-QM, being
superseded by these two), `storystudio-unified/docs/quartermaster/QM_NEW_PIPELINE_DESIGN.md`
(design rationale).

---

## 1. The big picture

```
                           (2) admission check (live)
StoryStudio  ─────────────────────────────────────────▶  Quartermaster (QM)
  (Convex /   POST {QM}/admission  → granted/deferred             │
   MCP)                                                            │  checks queue depth,
     │  (1) build compact sfInput                                  │  reservations, cap,
     │                                                             ▼  gen-time baselines
     │  (3) StartExecution                                   grants a slot (or defers
     ▼                                                         with an ETA)
E2E-VideoGenerationPipeline-Narration-{Basic|Premium}-QM-New   (STANDARD SFN, tags batchjob=true qmGateway=true)
     │
     │  per frame (Map, MaxConcurrency=15):
     │     Basic:   image (t2i/i2i) → TTS → Flux animate → Flux merge      each step is a
     │     Premium: image (t2i/i2i) → TTS → Wan2 i2v      → merge          QM-generate task
     │        every step ─────────────────────────────────────────────▶ POST {QM}/jobs
     │                                                                     + poll GET /jobs/{id}
     ▼                                                                           │
  concat → Whisper SRT → finalize (Fargate: merge/upscale + captions + BGM)     │  QM owns:
     │                                                                           │   • provider pick
     │  status callbacks → Convex (jobId + jwtToken + convexEndpoint)            │   • internal→external
     ▼                                                                           │     failover
  Complete                                                                       │   • per-endpoint
                                                                                 │     concurrency
                    (4) capacity manager (sweeper every 2 min) ─────────────────┘
                        scales RunPod workers UP on demand + reservations,
                        DOWN (scale-to-zero) after 5-min idle
```

**Key point for StoryStudio:** you do **not** call QM per asset. Each SFN calls the
`QM-generate` gateway for every image/TTS/video/merge automatically. Your direct
responsibilities are **(a)** the pre-flight admission check (§2) and **(b)** `StartExecution`
with the right payload (§3 for Basic, §9 for Premium).

---

## 2. The admission handshake — live, not a proposal

**This is the piece you described as "check with Quartermaster to get a slot before
starting the project."** It's built and deployed. Full contract, request/response shapes,
load model, and long-video handling are documented in **`docs/storystudio-qm-admission-gate.md`**
— read that before wiring this. Summary:

- `POST {QM}/admission` with `{requestId, projectType, tier, durationSeconds, userId}` →
  `{decision:"granted", admissionId, expiresAt, warmedEndpoints, estimatedReadySeconds}` or
  `{decision:"deferred", reason, estimatedWaitSeconds, retryAfterSeconds}`.
- **granted** → thread `admissionId` into the SFN input (§3.2/§9.2) and `StartExecution`.
- **deferred** → leave the row queued, retry after `retryAfterSeconds`. No strict TAT here
  (see the admission doc §1.1) — deferrals are the expected, safe path under load, not an
  error case.
- On the project's terminal state (completed or failed), call
  `POST {QM}/admission/{admissionId}/release` from your own `onJobTerminated` hook — **the
  SFN does not release the reservation itself.**

**Reality check on decision quality today:** the gen-time baselines admission uses to
estimate wait are freshly seeded from documented RunPod figures, not yet learned from real
traffic (QM has never processed a real project). Early ETAs will be reasonable but
approximate; they self-correct as real jobs complete. This doesn't change the contract or
what you implement — just don't be surprised if an early `estimatedWaitSeconds` is off by a
factor of 2.

---

## 3. What to send to the SF — Narration-Basic (`...-Narration-Basic-QM-New`)

**State machine ARN**
```
arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Narration-Basic-QM-New
```
Tags: `batchjob=true`, `qmGateway=true`. Start executions with the existing
`arn:aws:iam::929075264324:role/E2E-StepFunction-Role`.

The payload is **much smaller than the legacy Premium-QM**: no `voiceUrls`, `voiceAudioUrl`,
`captionsUrl`, `hookConfig`, `characterBible`, or `synopsis`. This pipeline generates images
and per-frame TTS internally and derives the SRT from the concatenated audio with Whisper.

### 3.1 Execution input

```json
{
  "projectId":      "proj_abc123",
  "jobId":          "job_xyz789",
  "userId":         "user_111",
  "projectType":    "narration-basic",
  "aspectRatio":    "9:16",
  "voiceGender":    "female",
  "bgmPrompt":      "cinematic orchestral, warm and reflective, no vocals",
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
| `projectType` | string | **yes** | `"narration-basic"`; carried to Fargate finalize |
| `aspectRatio` | string | **yes** | `"16:9"`, `"9:16"`, or `"1:1"` — sets image dims + clip aspect |
| `voiceGender` | string | **yes (key must be present)** | `"male"`→`am_adam`, `"female"`→`af_bella`, anything else→`am_adam`. **Empty string `""` is safe; a missing key errors the TTS state at runtime** — always include it. Project-level (not per-frame). |
| `bgmPrompt` | string | no | Text description for BGM generation (e.g. `"cinematic orchestral, warm and reflective, no vocals"`), generated via QM (ACE-Step → Suno/KIE fallback). **Key can be omitted or empty** — unlike `voiceGender`, this is a `Choice`-gated field, not a direct reference, so a missing key does **not** error; it just skips BGM (silent final video). Project-level (not per-frame). Length = sum of all frame `duration`s, computed automatically. **`bgmUrl` no longer exists in this contract** — BGM is always generated, never passed as a pre-existing URL. |
| `apiKey` | string | **yes** | Internal StoryStudio key used by `E2E-video-concat-premium` |
| `jwtToken` | string | **yes** | Short-lived Convex JWT for status callbacks |
| `convexEndpoint` | string | **yes** | `https://<deployment>.convex.cloud` |
| `admissionId` | string | no | From §2, if you're calling admission. Threaded through for correlation/audit; not currently read back by any state in this SFN. **You** release it (§2), not the SFN. |

### 3.3 Frame object (`frames[]`, one per frame)

| Field | Type | Required | Notes |
|---|---|---|---|
| `frameId` | string | **yes** | Stable unique ID; used as the S3 image cache key |
| `frameNumber` | number | **yes** | 1-based; drives concat ordering |
| `imagePrompt` | string | **yes** | Prompt for the image step (t2i, or i2i if `referenceImageUrl` set) |
| `narrationText` | string | **yes** (unless `voiceUrl` set) | TTS text for the per-frame voice |
| `referenceImageUrl` | string | no | **Singular string.** Non-empty ⇒ image goes **i2i** using this UI character reference; empty/absent ⇒ **t2i**. ⚠️ Differs from the legacy Premium-QM's `referenceImageUrls` (array) — this field is **singular**. |
| `voiceUrl` | string | no | If non-empty, TTS is **skipped** and this audio is reused. Empty/absent ⇒ TTS generated from `narrationText`. |
| `duration` | number | **yes** | Seconds; drives the Flux animate clip length |

### 3.4 Fields you must NOT send (vs. legacy Premium-QM)

This pipeline ignores or does not need: `voiceUrls`, `voiceAudioUrl`, `captionsUrl`,
`generateShorts`, `shortsRenderStyle`, `mode`, `characterBible`, `synopsis`, `hookConfig`,
and per-frame `voiceName` / `ttsModel` / `referenceImageUrls`. Leaving them in is harmless
but they have no effect — voice is selected by the top-level `voiceGender`.

> ⚠️ **Breaking change (2026-07-03): `bgmUrl` is gone, not just unused.** Earlier versions of
> this doc had you pass a pre-existing `bgmUrl`. That field **no longer exists** in this
> contract — send `bgmPrompt` instead (§3.2). If you send `bgmUrl`, it's silently ignored,
> and you'll get a silent final video unless `bgmPrompt` is also present.

---

## 4. Basic pipeline flow (what happens after StartExecution)

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
→ RouteBGM → [bgmPrompt present] QMGenerateBGM  (bgm.narrationBasic → ACE-Step → Suno/KIE fallback;
                                                  duration = sum of all frame durations)
           → [absent/empty]      SkipBgm         (bgmResult.cdnUrl = "", silent final video)
   (BGM runs here — before frames is dropped below — because QM-generate needs the full
    frames array to sum durations; ASL has no native array-sum function)
→ DropFrameData  (carry videoResults + bgmResult, drop frames to stay < 256 KB)
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

Every `QMGenerate*` state (in either pipeline) is a `QM-generate` Lambda task that:

1. `POST {QM}/jobs` with a canonical job — QM **de-dupes by `requestId`**
   (`projectId:frameId:assetType:operation`), so retries and cache hits are free.
2. Polls `GET {QM}/jobs/{requestId}` every ~3 s until
   `COMPLETE` / `COMPLETE_WITH_FALLBACKS` / `FAILED` / `DEAD`.
3. QM internally: picks the provider by the catalog **ladder** (internal RunPod first for
   batch, external KIE/Replicate as circuit-broken fallback), holds a per-endpoint semaphore
   slot, uploads to S3/CDN, and returns the asset key.

Because QM owns the per-endpoint concurrency, each SFN's `MaxConcurrency=15` is a ceiling,
not a fleet load — QM queues beyond real capacity instead of blasting RunPod. This is the
"back-pressure is transparent" property: the execution keeps running; only individual frame
steps wait.

---

## 6. Capacity manager (workers up on demand + reservations, down when idle)

> **This is the piece you described as "enable new active workers when the request flow
> rises and bring them down when it goes down."** It's live in code and running in
> production (verified — see below), currently in **shadow mode**
> (`RUNPOD_PROVISION_LIVE=false`) — it computes and audits the scale decision every tick,
> including reservation pre-warm, but doesn't yet PATCH RunPod. Going live is a deploy-time
> flag (`cdk deploy --context RUNPOD_PROVISION_LIVE=true`), a decision QM's side makes once
> the shadow log is trusted — no action on your side either way.

- **Driver:** the `/sweeper` route runs every **2 minutes** (EventBridge Scheduler). Besides
  reclaiming expired jobs/leases and reconciling the in-flight counter, it runs the
  **provisioner** and expires stale admission reservations.
- **Per RunPod endpoint** (4 today: `flux-tts-s2t`, `qwen-image-gen`, `qwen-image-edit`,
  `wan2-i2v`), it combines **organic demand** (`inflight + queued`) with **active admission
  reservations' committed workers** (whichever is larger — not summed, since a reservation's
  promise and the jobs it later submits are the same demand) and sets:
  - `workersMax` sized to that combined demand,
  - `workersMin ≥ 1` (**pre-warm**) while any demand exists — including reservations that
    haven't submitted a single real job yet,
  - **scale-to-zero** to each endpoint's own confirmed idle floor (not a uniform default —
    `flux-tts-s2t` and `wan2-i2v` idle to 3, the other two to 2) once demand is 0 **and** a
    **5-minute cooldown** has elapsed.
- **On an admission grant** (§2), QM also **pre-warms synchronously** — it doesn't wait for
  the next sweeper tick — so RunPod's cold start (2.5–4 min) overlaps the ~2–3 min you spend
  building frames/prompts, not starts after it.
- **Shared account cap:** the sum of `workersMax` across the 4 endpoints is clamped to
  `RUNPOD_ACCOUNT_CAP` (10 today, rising to 20 once RunPod balance ≥ $200).

**Net effect for StoryStudio:** call admission (§2) and it pre-warms immediately; even
without admission, workers still spin up within a sweeper tick or two once real jobs land.
No action required on your side beyond calling `/admission` if you want the earlier,
synchronous pre-warm.

---

## 7. Starting an execution (AWS SDK)

```typescript
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const sfn = new SFNClient({ region: 'us-east-1' });

// Admission — see §2 / storystudio-qm-admission-gate.md for the full contract.
const admission = await requestAdmission({
  requestId: mcpRequestId, projectType, tier, durationSeconds, userId,
});
if (admission.decision === 'deferred') {
  // leave the row queued, retry after admission.retryAfterSeconds
} else {
  const res = await sfn.send(new StartExecutionCommand({
    stateMachineArn: isPremium
      ? 'arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Narration-Premium-QM-New'
      : 'arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Narration-Basic-QM-New',
    name:  `${projectId}-${jobId}`,          // unique per execution; ≤ 80 chars
    input: JSON.stringify({ ...payload, admissionId: admission.admissionId }), // §3.1 / §9.1
  }));
  console.log('executionArn:', res.executionArn);
}
```

Set `name` to `${projectId}-${jobId}` for easy CloudWatch correlation; append a suffix on
retry since names must be unique within the state machine.

---

## 8. Rollout status & open items

- **Both narration-basic and narration-premium QM-New machines are built and deployed**
  (`ACTIVE`). Neither has run a real project yet — that's the next step, and it's yours:
  wire narration-basic first (simpler payload), validate end-to-end, then repeat for premium.
- `Basic-QM` / `Premium-QM` (legacy, non-QM-New) are untouched — projects not routed through
  these two new machines keep their current path unaffected.
- **Confirmed / resolved:**
  1. Admission (§2) is built — your call whether to start using it now or validate the raw
     generation path first (§4/§10) and add admission after.
  2. `voiceGender` must be present as a key in the execution input (empty string OK) — confirmed.
  3. TTS is per-frame from `narrationText` (current behavior), not a single whole-script pass
     — confirmed as final for this pipeline.
- **Still open on QM's side** (doesn't block you starting): a DR-fallback regression test for
  the internal→external circuit-breaker path, a UI-traffic-backfill routing policy (affects
  the UI path only, not this batch pipeline), and a consumption/balance-runway signal. None
  of these change the contract in this doc.

---

## 9. What to send to the SF — Narration-Premium (`...-Narration-Premium-QM-New`)

**State machine ARN**
```
arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Narration-Premium-QM-New
```
Tags: `batchjob=true`, `qmGateway=true`. Same execution role as Basic.

Same philosophy as Basic-QM-New — a compact payload, images/TTS generated internally, SRT
derived from concat audio via Whisper — but premium-tier models throughout: **Qwen**
image generation (vs. Flux Klein), **Qwen3-TTS voice-design** (vs. Kokoro), and **Wan 2.2
i2v** for actual camera motion (vs. Flux's Ken Burns pan/zoom on a still). Finalize
additionally **upscales 480p → 1080p** (Wan2's native output is 480p).

### 9.1 Execution input

```json
{
  "projectId":      "proj_abc123",
  "jobId":          "job_xyz789",
  "userId":         "user_111",
  "projectType":    "narration-premium",
  "aspectRatio":    "9:16",
  "voiceSpeaker":   "Ryan",
  "voiceInstruct":  "calm, warm documentary narrator",
  "voiceLanguage":  "English",
  "bgmPrompt":      "cinematic orchestral, warm and reflective, no vocals",
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

Notice the frame object is **identical** to Basic's (§3.3) — only three new **top-level**
voice fields replace `voiceGender`, and the underlying models differ.

### 9.2 Top-level fields (deltas from Basic — §3.2 fields not listed here are identical)

| Field | Type | Required | Notes |
|---|---|---|---|
| `projectType` | string | **yes** | `"narration-premium"` |
| `voiceSpeaker` | string | **yes (key must be present)** | Qwen3-TTS speaker name. Defaults to `"Ryan"` server-side if empty, but the key must exist — same gotcha as `voiceGender`. |
| `voiceInstruct` | string | **yes (key must be present)** | Tone/style instruction for the voice-design model (e.g. `"calm authoritative documentary tone"`). Empty string is safe. |
| `voiceLanguage` | string | **yes (key must be present)** | e.g. `"English"`. Empty string is safe (defaults server-side). |
| `admissionId` | string | no | Same as Basic (§3.2) — pass `tier:"premium"` to admission when requesting this. |

All other top-level fields (`projectId`, `jobId`, `userId`, `aspectRatio`, `bgmPrompt`,
`apiKey`, `jwtToken`, `convexEndpoint`) are identical to §3.2 — including BGM: same
`bgmPrompt`-generates-via-ACE-Step behavior (catalog key `bgm.narrationPremium`, same
underlying rung as Basic's `bgm.narrationBasic`).

### 9.3 Frame object

**Identical to Basic's (§3.3)** — same fields, same singular `referenceImageUrl` convention,
same "TTS skipped if `voiceUrl` non-empty" behavior. One added nuance:

> ⚠️ **`narrationText` doubles as the Wan2 motion prompt.** It's used both for the TTS voice
> track *and* as the description of camera/scene motion for the Wan2 i2v step (matching the
> convention the legacy Premium-QM pipeline already uses). If you want narration text that
> reads naturally but describes poor visual motion, that's a known tension — not something
> to fix in this contract, just something to be aware of when authoring narration for
> premium projects.

### 9.4 Premium pipeline flow

```
ValidateInput → CheckValidation
→ UpdateStatusGeneratingImages
→ GenerateImages  (Map over frames, MaxConcurrency=15)   ── all via QM-generate ──
     per frame:
       CheckImageCache → [hit] UseImageCache
                      → [miss] RouteImageGen
                                 → QMGenerateImageT2I   (image.narrationPremium.t2i — Qwen-Image-Gen)
                                 → QMGenerateImageI2I   (image.narrationPremium.i2i — Qwen-Image-Edit, if referenceImageUrl)
                                 → StoreImageMeta
       RouteTTS → [voiceUrl present] UseProvidedVoice
                → QMGenerateTTS      (voice.narrationPremium.tts — Qwen3-TTS voice-design; speaker/instruct/language from top-level input)
       QMGenerateVideo (video.narrationPremium.i2v → Wan 2.2 I2V-A14B; narrationText = motion prompt; silent MP4)
       QMMerge         (video.narrationPremium.merge → voice onto the Wan2 video, MP4 w/ audio; same generic mux Basic uses)
       BuildFrameVideo → { frameId, frameNumber, videoUrl, duration }
→ RouteBGM → [bgmPrompt present] QMGenerateBGM  (bgm.narrationPremium → ACE-Step → Suno/KIE fallback)
           → [absent/empty]      SkipBgm         (bgmResult.cdnUrl = "", silent final video)
→ DropFrameData  (carry videoResults + bgmResult)
→ UpdateStatusConcatenating
→ ConcatenateVideos           (E2E-video-concat-premium)
→ TranscribeAudio             (Whisper SRT from concat audio)
→ BuildMergedVoiceResult
→ UpdateStatusApplyingBgm → ValidateFinalizeInputsPremium → PrepareFinalizePremium
→ FinalizeVideoPremium         (Fargate: 480p→1080p upscale + audio merge + captions + BGM)
→ Complete
```

Same per-frame resilience and top-level failure routing as Basic (§4) — a frame that
exhausts all rungs fails gracefully without aborting the whole Map.

### 9.5 Fields you must NOT send

Same exclusion list as Basic (§3.4), **plus** don't send `voiceGender` — premium ignores it;
use `voiceSpeaker`/`voiceInstruct`/`voiceLanguage` instead.

---
