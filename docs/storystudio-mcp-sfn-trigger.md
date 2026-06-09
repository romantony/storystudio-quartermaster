# StoryStudio → Step Function Trigger Guide (MCP Projects)

Projects created via MCP must use the Quartermaster-aware Step Functions instead of the
original pipelines. These pipelines acquire/release ModelsLab slots through Quartermaster
before each provider call, preventing 429s from concurrent executions.

## Which pipeline to start

| Narration type | Step Function ARN |
|---|---|
| Narration Basic | `arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Basic-QM` |
| Narration Premium | `arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Premium-QM` |

Both are tagged `batchjob=true`. The IAM role that starts executions is unchanged:
`arn:aws:iam::929075264324:role/E2E-StepFunction-Role`.

---

## Narration Basic — payload

### Top-level execution input

```json
{
  "projectId":      "proj_abc123",
  "jobId":          "job_xyz789",
  "userId":         "user_111",
  "projectType":    "narration-basic",
  "aspectRatio":    "16:9",
  "bgmUrl":         "https://cdn-v2.ai-storystudio.com/bgm/track.mp3",
  "apiKey":         "<storystudio-internal-api-key>",
  "jwtToken":       "<convex-jwt>",
  "convexEndpoint": "https://your-deployment.convex.cloud",
  "frames": [
    {
      "frameId":     "frame_001",
      "frameNumber": 1,
      "imagePrompt": "A cozy living room at dusk, warm lighting, photorealistic",
      "voiceUrl":    "https://cdn-v2.ai-storystudio.com/voice/frame_001.mp3",
      "duration":    4.2
    }
  ]
}
```

### Field reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `projectId` | string | yes | Propagated to all Lambdas as context |
| `jobId` | string | yes | Used to push status updates to Convex |
| `userId` | string | yes | Passed to `image-basic-generator` for attribution |
| `projectType` | string | yes | Carried through to finalize Fargate task |
| `aspectRatio` | string | yes | `"16:9"`, `"9:16"`, or `"1:1"` |
| `bgmUrl` | string | yes | CDN URL for background music; pass `""` if none |
| `apiKey` | string | yes | Internal StoryStudio API key used by `E2E-video-concat-premium` |
| `jwtToken` | string | yes | Short-lived Convex JWT for status callbacks |
| `convexEndpoint` | string | yes | `https://<deployment>.convex.cloud` |
| `frames` | array | yes | One object per frame (see below) |

### Frame object

| Field | Type | Required | Notes |
|---|---|---|---|
| `frameId` | string | yes | Stable unique ID; used as cache key |
| `frameNumber` | number | yes | 1-based ordering for concatenation |
| `imagePrompt` | string | yes | Text prompt for `image-basic-generator` (Flux Klein) |
| `voiceUrl` | string | yes | Pre-generated narration CDN URL; pass `""` to skip Ken Burns audio |
| `duration` | number | yes | Frame duration in seconds; drives Ken Burns clip length |

### Flow summary

```
ValidateInput
→ UpdateStatusGeneratingImages
→ GenerateImages (Map, MaxConcurrency=15)
    CheckImageCache → [hit] UseImageCache
                   → [miss] AcquireImageSlot (QM rest lane)
                           → GenerateImage (image-basic-generator)
                           → StoreImageMeta
                           → ReleaseImageSlot
                   BuildImagePayload
→ DropFrameData
→ UpdateStatusGeneratingVideos
→ GenerateI2VBasic (Map, MaxConcurrency=3 — Ken Burns local render, no QM slot)
→ UpdateStatusConcatenating
→ ConcatenateVideos
→ TranscribeAudio (Whisper SRT)
→ BuildMergedVoiceResult
→ UpdateStatusApplyingBgm
→ ValidateFinalizeInputsBasic
→ PrepareFinalize
→ FinalizeVideoBasic (Fargate: audio merge + captions + BGM)
→ Complete
```

---

## Narration Premium — payload

### Top-level execution input

```json
{
  "projectId":      "proj_abc123",
  "jobId":          "job_xyz789",
  "userId":         "user_111",
  "projectType":    "narration-premium",
  "aspectRatio":    "16:9",
  "bgmUrl":         "https://cdn-v2.ai-storystudio.com/bgm/track.mp3",
  "apiKey":         "<storystudio-internal-api-key>",
  "jwtToken":       "<convex-jwt>",
  "convexEndpoint": "https://your-deployment.convex.cloud",
  "voiceUrls":      ["https://cdn-v2.ai-storystudio.com/voice/frame_001.mp3"],
  "voiceAudioUrl":  "https://cdn-v2.ai-storystudio.com/voice/merged.mp3",
  "captionsUrl":    "",
  "generateShorts": false,
  "shortsRenderStyle": "highlights",
  "mode":           "standard",
  "characterBible": "Alice is a 30-year-old scientist with short brown hair...",
  "synopsis":       "A documentary about deep-sea exploration.",
  "hookConfig": {
    "enabled":      true,
    "imageUrl":     "https://cdn-v2.ai-storystudio.com/hook/still.jpg",
    "audioUrl":     "https://cdn-v2.ai-storystudio.com/hook/audio.mp3",
    "prompt":       "Dramatic underwater shot, bioluminescent creatures",
    "aspectRatio":  "16:9",
    "projectId":    "proj_abc123"
  },
  "frames": [
    {
      "frameId":           "frame_001",
      "frameNumber":       1,
      "imagePrompt":       "Alice in a submarine control room, dramatic lighting",
      "narrationText":     "Deep beneath the surface lies a world few have ever seen.",
      "voiceName":         "en-US-Journey-F",
      "ttsModel":          "gemini-2.5-flash-preview-tts",
      "voiceUrl":          "https://cdn-v2.ai-storystudio.com/voice/frame_001.mp3",
      "duration":          5.1,
      "referenceImageUrls": []
    }
  ]
}
```

### Field reference — top level

| Field | Type | Required | Notes |
|---|---|---|---|
| `projectId` | string | yes | |
| `jobId` | string | yes | |
| `userId` | string | yes | Passed to `image-basic-generator` |
| `projectType` | string | yes | Carried to finalize Fargate task |
| `aspectRatio` | string | yes | `"16:9"`, `"9:16"`, or `"1:1"` |
| `bgmUrl` | string | yes | Pass `""` if no BGM |
| `apiKey` | string | yes | Internal StoryStudio API key |
| `jwtToken` | string | yes | Convex JWT |
| `convexEndpoint` | string | yes | |
| `voiceUrls` | string[] | yes | Array of per-frame CDN audio URLs (same order as `frames`); used for status updates |
| `voiceAudioUrl` | string | yes | Pre-merged full narration audio URL (used by global SRT generation fallback) |
| `captionsUrl` | string | yes | Pass existing CDN SRT URL to skip re-transcription, or `""` to regenerate; must match `https://cdn-v2.ai-storystudio.com/*` to be used as cache |
| `generateShorts` | boolean | no | Defaults to `false`; set `true` to fire-and-forget shorts pipeline after concat |
| `shortsRenderStyle` | string | no | Passed to shorts pipeline (e.g. `"highlights"`) |
| `mode` | string | yes | Pipeline mode string carried to finalize (e.g. `"standard"`) |
| `characterBible` | string | yes | Character description text passed to QA agent for consistency checks |
| `synopsis` | string | yes | Project synopsis passed to QA agent |
| `hookConfig` | object | yes | Hook generation config (see below); set `enabled: false` to skip |
| `frames` | array | yes | One object per frame (see below) |

### hookConfig object

| Field | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | yes | `false` skips hook generation entirely |
| `imageUrl` | string | if enabled | Still image for the hook clip |
| `audioUrl` | string | if enabled | Audio track for the hook clip |
| `prompt` | string | if enabled | Motion prompt for hook I2V (Replicate S2V) |
| `aspectRatio` | string | if enabled | Must match top-level `aspectRatio` |
| `projectId` | string | if enabled | Must match top-level `projectId` |

### Frame object

| Field | Type | Required | Notes |
|---|---|---|---|
| `frameId` | string | yes | Stable unique ID; used as S3 cache key for both image and video |
| `frameNumber` | number | yes | 1-based |
| `imagePrompt` | string | yes | Text prompt for `image-basic-generator` |
| `narrationText` | string | yes | Narration text; also used as motion prompt for Wan 2.2 I2V |
| `voiceName` | string | yes | Google TTS voice ID (e.g. `"en-US-Journey-F"`) |
| `ttsModel` | string | yes | TTS model (e.g. `"gemini-2.5-flash-preview-tts"`) |
| `voiceUrl` | string | yes | Pre-generated narration URL; if non-empty, TTS generation is skipped |
| `duration` | number | yes | Frame duration in seconds; drives I2V clip length |
| `referenceImageUrls` | string[] | yes | Character reference images for `image-basic-generator` consistency; pass `[]` for no reference |

### Flow summary

```
ValidateInput
→ StoreFramesInS3 (reduces state payload size)
→ ParallelHookAndImages (Parallel)
    Branch 1 — Hook (Replicate S2V, no QM slot):
        GenerateHook → [fallback] GenerateHookFallback (KIE)
    Branch 2 — Per-frame (Map, MaxConcurrency=15):
        Per frame:
          CheckPreGeneratedAudio → [skip] UsePreGeneratedTTS
                                 → [generate] GenerateFrameTTS (Google TTS)
          CheckImageCache → [hit] UseImageCache
                         → [miss] AcquireImageSlot (QM rest lane)
                                 → GenerateImage (image-basic-generator)
                                 → StoreImageMeta
                                 → ReleaseImageSlot
          CheckVideoCache → [hit] UseVideoCache
                         → [miss] AcquireVideoSlot (QM video lane)
                                 → GenerateI2V (video-i2v-generator / Wan 2.2)
                                 → NormalizeI2VResult → StoreVideoMeta
                                 → ReleaseVideoSlot
          MergeFrameAudio (embed TTS onto I2V clip)
→ MergeParallelResults
→ QaAgentNarrationPremium [→ rework loop if issues found]
→ RestorePipelineContextAfterQA
→ ConcatenateVideos
→ GenerateGlobalCaptions (Whisper SRT)
→ UpdateStatusApplyingBgm
→ PrepareFinalizePremium
→ [optional] TriggerShortsFromLongForm
→ FinalizeVideoPremium (Fargate: 480p→1080p upscale + captions + BGM)
→ Complete
```

---

## How to start an execution (AWS SDK)

```typescript
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const sfn = new SFNClient({ region: 'us-east-1' });

const res = await sfn.send(new StartExecutionCommand({
  stateMachineArn: isMcpProject
    ? (isNarrationPremium
        ? 'arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Premium-QM'
        : 'arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Basic-QM')
    : existingArn,
  name: `${projectId}-${jobId}`,   // must be unique per execution; 80 char max
  input: JSON.stringify(payload),
}));

console.log('executionArn:', res.executionArn);
```

The execution `name` field is optional but setting it to `${projectId}-${jobId}` makes
CloudWatch log correlation trivial. It must be unique within the state machine — reusing
the same name on a retry requires appending a suffix (e.g. `-retry1`).

---

## Error handling

Both pipelines are resilient — failures in individual frames do not abort the Map.
The `Complete` state always fires unless the Fargate finalize task itself fails.

The `HandleFailure → UpdateStatusFailed → FailState` path is only reached when a
top-level unrecoverable error occurs (e.g. `ValidateInput` rejects the payload, or
`ConcatenateVideos` returns no URL). In that case the execution ends with status
`FAILED` and the Convex job status is set to `"failed"` via `E2E-update-status`.

---

## Notes on Quartermaster integration

- **Slot acquisition is internal** — StoryStudio does not call `/acquire` or `/release`
  directly. The pipelines call `QM-broker-call` Lambda automatically.
- **Back-pressure is transparent** — if all 15 ModelsLab slots are taken, the
  `AcquireImageSlot` / `AcquireVideoSlot` states busy-wait (up to 110 s) before the
  Lambda times out and retries. The SFN execution keeps running; only the individual
  frame state is delayed.
- **Non-MCP projects** continue to use the original pipelines
  (`E2E-VideoGenerationPipeline-Basic` / `E2E-VideoGenerationPipeline-Premium`) and
  call ModelsLab directly, unchanged.
