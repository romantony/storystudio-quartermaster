# StoryStudio → 4lang Integration Guide

**Audience:** StoryStudio backend (Convex / MCP batch pipeline)
**Subject:** How to opt a narration project into automatic post-concat
localization — translated script, localized TTS, and localized SRT for a
fixed 3-language set — on top of the existing QM-New pipelines.
**Status (2026-07-08):** **Live and deployed.** Both
`E2E-VideoGenerationPipeline-Narration-Basic-QM-New` and
`E2E-VideoGenerationPipeline-Narration-Premium-QM-New` support this today —
no separate opt-in project, no new state machine, no new endpoint to call.
**Prerequisite doc:** this assumes you're already integrated per
`docs/storystudio-qm-new-sfn-trigger.md` (project creation, admission,
`StartExecution`, status polling). This guide only covers the **delta**:
one new request field and one new result field.

---

## 1. What this is (and isn't)

Given an English narration project, 4lang produces — after concat, from the
English transcript — for a **fixed** set of 3 additional languages
(`es`, `pt-BR`, `hi`):

1. A translated script (meaning-preserving, not word-for-word).
2. Localized TTS audio.
3. A localized SRT, synced to that language's own generated audio (not the
   English timings with translated text swapped in).

**Not included** (out of scope for this pass, unlike the full
`StoryStudio Multilingual Video Generation Specification.pdf`):
- No multi-track audio muxed into the final video — you get 3 standalone
  audio URLs back, StoryStudio decides how to package/upload them.
- No localized YouTube metadata, titles, descriptions, tags, or thumbnails.
- No YouTube upload of any kind (the spec's §9–10 remain manual/future work).
- No dynamic/arbitrary target-language lists — it's always exactly these 3,
  or none. If you need a different language set later, that's a catalog +
  ASL change on QM's side, not a request-time parameter today.

If you need the fuller pipeline (localized metadata, thumbnails, YouTube
publish), treat this as phase 1 of that spec, not the whole thing.

---

## 2. How to enable it

Add one field to the `StartExecution` input you already send (§3.1/§9.1 of
`storystudio-qm-new-sfn-trigger.md`) — nothing else about the request
changes:

```json
{
  "projectId": "proj_abc123",
  "jobId": "job_xyz789",
  ...
  "fourLang": true
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `fourLang` | boolean | no | `true` ⇒ run localization after concat. Omitted or `false` ⇒ unchanged behavior, no localized assets produced. Works identically on both Basic and Premium — same field name, same semantics, same fixed 3-language set. |

That's the entire integration surface on the request side. Frame objects,
`voiceGender`/`voiceSpeaker`/`voiceInstruct`/`voiceLanguage`, `bgmPrompt`,
etc. are all unaffected and unrelated to `fourLang`.

---

## 3. What you get back

Localization runs once per project (not per frame), fully in parallel across
the 3 languages, right after `TranscribeAudio` produces the English
transcript and before the video is finalized. It does **not** block or delay
the English master video's Finalize step in any special way you need to
handle — it's just additional work happening alongside on the same
execution.

### 3.1 Convex status callback

`localizedAssets` is added to the `assets` payload of the
`applying-bgm` status update (the same callback that already carries
`concatenatedVideoUrl`/`captionsUrl`):

```json
{
  "jobId": "job_xyz789",
  "status": "applying-bgm",
  "assets": {
    "mergedVideoUrl": "https://cdn.../concatenated.mp4",
    "localizedAssets": [
      { "language": "es",    "scriptText": "El sistema solar no es solo...", "voiceoverUrl": "https://cdn.../es_voiceover.wav", "srtUrl": "https://cdn.../es_subtitles.srt" },
      { "language": "pt-BR", "scriptText": "O sistema solar não é apenas...", "voiceoverUrl": "https://cdn.../pt_voiceover.wav", "srtUrl": "https://cdn.../pt_subtitles.srt" },
      { "language": "hi",    "scriptText": "सूर्य केवल आग का गोला नहीं है...", "voiceoverUrl": "https://cdn.../hi_voiceover.wav", "srtUrl": "https://cdn.../hi_subtitles.srt" }
    ]
  }
}
```

If `fourLang` was omitted/false, `localizedAssets` is simply an empty array —
no schema change needed on your side to handle the "not requested" case.

### 3.2 Execution output

The same `localizedAssets` array is also present in the Step Functions
execution's final output (the `Complete` state), for cases where you read
the terminal execution result directly (e.g. `DescribeExecution`) rather
than relying solely on the Convex callback.

### 3.3 Per-language failure shape

Each of the 3 languages succeeds or fails independently — one language
failing does **not** fail the project or block the other two languages or
the English master video:

```json
{ "language": "hi", "failed": true, "error": "LocalizationError" }
```

Treat any `localizedAssets[i]` entry with `failed: true` as "this language's
localized assets are unavailable for this run" — script/audio/SRT URLs will
be absent. There's currently no automatic retry-just-this-language endpoint
(unlike the full spec's proposed `/regenerate` API in §11.3) — a failed
language means re-running the whole project with `fourLang: true` again, or
waiting for that as a future addition if it's needed.

A partial-per-language failure can also happen within one language: if
translation and TTS both succeed but the localized SRT re-transcription
fails, you'll get `scriptText`/`voiceoverUrl` populated with `srtUrl: ""` —
script and audio are still usable even without captions for that language.

---

## 4. The fixed language set, and why

| Language | Code | TTS engine | Notes |
|---|---|---|---|
| Spanish | `es` | Qwen Voice Design | |
| Portuguese (Brazil) | `pt-BR` | Qwen Voice Design | Generic Portuguese in the TTS model, not a BR-specific voice — quality verified live, near-perfect. |
| Hindi | `hi` | Kokoro (Hindi voice pack, `hf_alpha`) | **Not Qwen** — Qwen Voice Design has no Hindi support at all in its language set, on either Basic or Premium tier. Kokoro's Hindi pack was verified live and already works on the deployed pod. |

This engine split (Qwen for `es`/`pt-BR`, Kokoro for `hi`) is internal to QM
and identical regardless of whether the project is `narration-basic` or
`narration-premium` — you don't need to do anything differently per tier.

**Quality, verified live against the production pod (2026-07-08):** all 3
languages round-tripped cleanly through Whisper transcription with the
generated audio matching the source meaning; Hindi had minor, non-blocking
phonetic drift on 2 words out of a ~15-word test sentence. Translation
quality (Claude) was near-perfect for Spanish/Portuguese in spot checks.

---

## 5. Timing and cost impact

- Adds roughly **1–2 minutes** to total project wall time (translation +
  TTS + SRT generation, run in parallel across the 3 languages, alongside —
  not blocking — the English Finalize step).
- Adds, per project with `fourLang: true`: 3 translation calls (Claude), 3
  TTS calls, and 3 additional Whisper transcriptions. These count against
  the same QM capacity/backpressure model as everything else (§5/§6 of the
  main SFN trigger doc) — no special quota or separate admission request
  needed.
- No additional `admissionId`/admission-handshake changes — `fourLang` rides
  the same admission grant as the rest of the project.

---

## 6. Example: minimal diff to an existing integration

If you're already calling `Narration-Basic-QM-New` per §3 of
`storystudio-qm-new-sfn-trigger.md`, the only change is:

```diff
 {
   "projectId": "proj_abc123",
   "jobId": "job_xyz789",
   "userId": "user_111",
   "projectType": "narration-basic",
   "aspectRatio": "9:16",
   "voiceGender": "female",
   "bgmPrompt": "cinematic orchestral, warm and reflective, no vocals",
+  "fourLang": true,
   "apiKey": "<storystudio-internal-api-key>",
   "jwtToken": "<convex-jwt>",
   "convexEndpoint": "https://your-deployment.convex.cloud",
   "admissionId": "qm_adm_…",
   "frames": [ ... ]
 }
```

Same diff applies verbatim to `Narration-Premium-QM-New` (§9).

---

## 7. Companion docs

- `docs/storystudio-qm-new-sfn-trigger.md` §3.2/§9.2 (field tables) and §4a
  (full technical detail: state names, ASL flow, retry/failure semantics) —
  read this if you need to debug a specific execution rather than just
  integrate the happy path.
- `StoryStudio Multilingual Video Generation Specification.pdf` — the
  original, broader spec (adds metadata/thumbnails/YouTube publishing on
  top of this). This guide covers a scoped first slice of it: translate +
  TTS + SRT only, triggered from the existing QM-New pipelines rather than
  a new standalone multilingual-project API.
