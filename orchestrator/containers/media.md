# `media` endpoint — contract

**There is no container to build here.** The `media` endpoint is the existing
**`romantony/flux4B-Wan2-storystudio`** worker (the same codebase that already
runs `flux-tts-s2t` and `bgm-s2t` for the live path), deployed with a role that
enables the assembly modes. Its `merge` / `concat` / `upscale` / `caption` /
`mix_bgm` are production code, already write to Cloudflare R2, and were built
anticipating this — see that repo's role-table comment: *"concat/mix_bgm … stay
resident on media but QM-New doesn't route to them yet (that assembly runs in
ECS Fargate today, and moves to a dedicated service later)."*

Building a parallel implementation (reverted, was commit `059a4ad`) is the
"build on, do not rebuild" mistake from impl plan §1.

## Deploy

Build `flux4B-Wan2-storystudio`'s **root `Dockerfile`**, create a RunPod
serverless endpoint on it, env:

| Var | Value |
|---|---|
| `ENDPOINT_ROLE` | `all` — media modes + Whisper (needed for `caption`) + `postprod` |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 credentials |
| `R2_BUCKET_NAME` | e.g. `e2e-storystudio` |
| `R2_PUBLIC_URL` | public origin, e.g. `https://pub-….r2.dev` or a custom domain |

`ENDPOINT_ROLE=media` alone does **not** serve `caption` (it's in `_AUDIO_MODES`
because it needs Whisper). Use `all`, or add Whisper to the media role in that
repo.

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
| 10 upscale | `upscale` | `video_url`, `target_height?`(1080) — or `image_url` + `target_width/height` | `video`, `upscale`(`"realesrgan_1080p"` \| `"skipped_source_hires"`) |
| 11 burn caption | `caption` | `video_url`, `words_per_group?`(3), `font_size?`(64), `highlight_color?`(`"yellow"`), `position?`(`"bottom"`) | `video`, `srt`, `transcript`, `word_count` |
| 12 overlay bgm | `mix_bgm` | `video_url`, `bgm_url` (or `bgm_prompt`), `bgm_volume?`(0.15) | `video`, `duration_s` |

All responses also carry `gen_time_s`; a cold job adds `load_times_s`.
Errors come back as `{"error": "..."}` in `output` with the job still
`COMPLETED` (check the field), not a FAILED job.

Full field tables: `flux4B-Wan2-storystudio/API.md`.

## Behaviour the orchestrator must account for

- **`caption` re-runs Whisper** on the concatenated video — it does **not**
  consume step 9's SRT. It extracts audio → Whisper word timestamps → ASS →
  burn, and returns its own `srt`. **Consequence:** step 9 (`transcribe` on
  `bgm-s2t`) is only needed if the product wants a standalone `.srt` timed to
  the *pre-concat per-frame* audio; otherwise `caption.srt` is the subtitle
  deliverable and **step 9 can be dropped from the background DAG**. Planner
  decision (M2).
- **`postprod` is NOT used.** It chains 6→8→10→11→12 in one call, but the
  orchestrator keeps them as separate allocations so the step-12 assembly gate
  (spec §6.1) can act. `postprod` stays available as a manual/fallback path.
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
