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
Not yet deployed as of this doc's edit — CI build + RunPod endpoint creation
are the next steps.

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

## Measurement (feeds spec §8 and §16 q4)

On a real cohort's assets, one job per mode, record `gen_time_s` + RunPod
`executionTime` + peak VRAM (the SR model is the outlier). That rebuilds the §8
rate card for steps 6/8/10/11/12 and sizes the GPU for this role (NVENC + the
SRVGG model's working set).
