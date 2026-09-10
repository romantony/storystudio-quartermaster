# `media` endpoint — contract

**Superseded 2026-09-10.** The plan below (reuse `flux4B-Wan2-storystudio`'s
root image via `ENDPOINT_ROLE=all`) turned out to have a real blocker: the
account's only live endpoint pointed at this codebase (`rnqxi6c0mlq517`,
`Flux-TTS-ANIM`) was found to be running the **`story-studio-tts`** image (a
separate, minimal `./tts`-subfolder build with only `tts`/`voice_clone_prompt`
— confirmed via the RunPod REST API directly), not the full pod2 image this
doc assumed. Repointing that live production TTS endpoint to a different image
was rejected as too risky to a currently-serving endpoint.

**New decision:** a fourth, purpose-built image —
**`romantony/flux4B-Wan2-storystudio`'s `postprod-lite/`** subfolder (new,
this session) — built specifically for the orchestrator's assembly steps, on
its own new RunPod endpoint, leaving `rnqxi6c0mlq517` untouched. It reuses the
pod2 handler's `merge`/`concat`/`upscale`/`caption`/`mix_bgm`/`animate`
functions **verbatim** (not reimplemented — see the file's own docstring for
the "ported from" list), so this is *not* the reverted `059a4ad` "build a
parallel implementation" mistake; it's an extraction, not a rewrite. Two real
differences from the pod2 handler:
- **No network volume** — Real-ESRGAN (~5MB) and Whisper large-v3-turbo
  (~3.6GB) are baked into the image at build time instead of loaded from
  `/runpod-volume/models`, since this endpoint never needs FLUX/Kokoro/
  Qwen-TTS/ACE-Step/SFX (image/TTS/video generation stays on the existing
  separate endpoints — qwen-image-gen, Wan2, flux-tts-anim).
- Added `remove_silence` (ported from quartermaster's own
  `infra/docker/concat-and-trim/index.ts`, same validated tuning constants)
  and a standalone `transcribe` mode; `mix_bgm` gained optional `sfx_urls`.

Full contract: `flux4B-Wan2-storystudio/Flux-klien-4b/postprod-lite/API.md`.

**DEPLOYED and measured 2026-09-10.** Endpoint `n6252hm01qz0xh` ("PostProd-Lite"),
template `ud534tgyb1`, image `romantony/story-studio-postprod-lite:latest`,
GPU NVIDIA A40, `workersMin=0`/`workersMax=2`, no network volume. CI build
took 32m30s (cold GHA cache + baking in Whisper). All 8 modes live-tested
against real assets and verified — see the measurement table below.

**Account was at its 40-worker RunPod quota ceiling** (exactly 40/40 across
all endpoints, unrelated systems included — 3D pipeline: Trellis2 4 +
Blender-headless 2 + Hunyuan-3D 2 + 3d-rigging-skintokens 3; QM/StoryStudio:
Wan2 8 + Flux-TTS-ANIM 6 + BGM-S2T 4 + qwen-image-gen 4 + qwen-image-edit 4;
multitalk 3). Freed capacity by shrinking **multitalk 3→1** (user's call) to
give PostProd-Lite its 2 workers — confirmed multitalk still healthy after.
**This quota ceiling is a real constraint on [[qm-orchestrator-open-decisions]]
item 7 (cohort size cap)** — there is no headroom left in the account today
without either a RunPod quota increase or shrinking another endpoint further.

## Deploy

Build `flux4B-Wan2-storystudio`'s **`postprod-lite/` subfolder**, create a
**new** RunPod serverless endpoint on it (do not touch `rnqxi6c0mlq517`), env:

| Var | Value |
|---|---|
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 credentials (same account used by qwen-image-gen/edit: `R2_ACCOUNT_ID=620baa808df08b1a30d448989365f7dd`) |
| `R2_BUCKET_NAME` | `e2e-storystudio` |
| `R2_PUBLIC_URL` | `https://pub-bce4924e66d944668be30268ccf4492c.r2.dev` |

No `ENDPOINT_ROLE` needed — this image is single-purpose, every mode is always
served. No network volume needed.

Record the resulting `endpointId` in `orchestrator/src/fleet-registry.ts` when
M2 wires the planner.

## Contract

Async: `POST /run` → `{id}`, poll `GET /status/{id}` until `COMPLETED`. Or
`POST /runsync` (10-min default, `policy.executionTimeout` to extend). Every
output is a permanent public R2 URL.

| Spec step | `mode` | input `{...}` | output `{...}` |
|---|---|---|---|
| 6 av merge | `merge` | `video_url`, `audio_url`, `upscale?`(bool), `upscale_target?`(`"1080p"`) | `video`, `duration_s`, `gen_time_s` |
| 8 concat | `concat` | `video_urls`(≥2, ordered) | `video`, `duration_s`, `clip_count` |
| new: remove silence | `remove_silence` | `video_url` | `video`, `duration_s`, `trimmed`, `silence_segments_removed` |
| 9 transcribe (standalone) | `transcribe` | `audio_url`, `return_timestamps?`(`"word"`), `words_per_group?`(4) | `text`, `chunks`, `srt` |
| 10 upscale | `upscale` | `video_url`, `target_height?`(1080) — or `image_url` + `target_width/height` | `video`, `upscale`(`"realesrgan_1080p"` \| `"skipped_source_hires"`) |
| 11 burn caption | `caption` | `video_url`, `words_per_group?`(3), `font_size?`(64), `highlight_color?`(`"yellow"`), `position?`(`"bottom"`) | `video`, `srt`, `transcript`, `word_count` |
| 12 overlay bgm/sfx | `mix_bgm` | `video_url`, `bgm_url`, `bgm_volume?`(0.15), `sfx_urls?`, `sfx_volume?`(0.5) | `video`, `duration_s` |

All responses also carry `gen_time_s`; a cold job adds `load_times_s`.
Errors come back as `{"error": "..."}` in `output` with the job still
`COMPLETED` (check the field), not a FAILED job.

Full field tables: `flux4B-Wan2-storystudio/Flux-klien-4b/postprod-lite/API.md`.

## Behaviour the orchestrator must account for

- **`caption` re-runs Whisper** on the concatenated video (its own baked-in
  copy, not `bgm-s2t`'s) — it does **not** consume step 9's SRT. It extracts
  audio → Whisper word timestamps → ASS → burn, and returns its own `srt`.
  **Consequence:** step 9 (`transcribe`, now also available directly on this
  same endpoint) is only needed if the product wants a standalone `.srt` timed
  to the *pre-concat per-frame* audio; otherwise `caption.srt` is the subtitle
  deliverable and **step 9 can be dropped from the background DAG**. Planner
  decision (M2). (Wiring `caption` to accept pre-computed `chunks` instead of
  re-running Whisper is a small follow-up, noted in the API.md's known
  limitations, if step 9's output should be reused instead of re-transcribed.)
- **There is no `postprod` mode on this image** — unlike the pod2 image, steps
  stay as separate calls by construction (matches the orchestrator's own
  step-12 assembly-gate design anyway; no manual/fallback batch path exists
  here, use the separate per-mode calls).
- **`bgm_prompt` (on-the-fly ACE-Step BGM generation) is not supported** on
  this image — call `bgm-s2t`'s `bgm` mode first and pass the resulting URL as
  `bgm_url`.
- **`concat` does not per-clip normalize** (no scale/pad/fps-lock) — it assumes
  uniform i2v output and just runs the concat demuxer + a libx264 CRF-18
  re-encode. If a cohort's clips ever vary in resolution/fps, a normalize pass
  must be added to `flux4B-Wan2-storystudio` (the ECS `concat-and-trim` had one;
  this mode does not).
- **`merge` uses `-shortest`** (trim to the shorter of video/audio), not the
  fourLang `apad` padding — correct for the single-language background path.
- **`upscale` skips** when the source is already ≥ `target_height`, returning
  the original URL with `upscale: "skipped_source_hires"`.

## Measurement (feeds spec §8 and §16 q4) — DONE 2026-09-10

One real job per mode against real assets (a 25.2s TTS-narrated clip + a
4s Ken Burns clip, both from an earlier pod2 pipeline test). `delayTime` mixes
queue-wait (6 jobs fired at once against 2 workers) and cold-start — not a
clean per-mode cold-start number except the very first call. Peak VRAM not
instrumented this pass (worth adding to the handler's response next time).

| mode | gen_time_s | executionTime | delayTime | notes |
|---|---|---|---|---|
| transcribe | 3.9 | 6.3s | 171.4s | first-ever call on this endpoint — full image pull, this is the real one-time cold-start cost |
| upscale (video, 1080p) | 32.6 | 32.9s | 6.3s | Real-ESRGAN is genuinely the slow one, confirms the doc's own prediction |
| concat (2 clips) | 9.4 | 11.1s | 13.2s | |
| merge | 2.2 | 2.3s | 24.8s | |
| caption | 10.2 | 10.4s | 27.6s | includes its own internal Whisper pass |
| remove_silence | 6.7 | 6.9s | 37.3s | 8 silence segments cut from 25.2s → 22.3s on real TTS narration |
| animate | 3.0 | 3.1s | 37.6s | |
| mix_bgm | 2.5 | 2.7s | 1.1s | warm worker by this point, no queue wait — the clean number |

All outputs verified as genuinely valid media (ffprobe'd the caption output:
h264 1024x576 + aac, 25.2s, matches input) — not just clean-looking API
responses.
