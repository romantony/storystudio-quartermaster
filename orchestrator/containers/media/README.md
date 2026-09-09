# `media` — RunPod serverless endpoint

The ffmpeg tail of the background pipeline. One image, five ops
(spec §3 steps 6, 8, 10, 11, 12); the planner collapses them onto a single
warm allocation via endpoint affinity (spec §3.1).

| `op` | Step | Does |
|---|---|---|
| `merge` | 6 | mux audio onto video; pad short audio (`apad whole_dur`) or trim to shorter; `additive` mixes a spot SFX over existing audio. Video `-c:v copy`. |
| `concat` | 8 | normalise every clip (scale/pad/fps/format, synth silence where missing) then concat; batched path >40 clips. NVENC or libx264. |
| `upscale` | 10 | Real-ESRGAN (ncnn-vulkan, frame-by-frame) or a `lanczos` no-model fallback. |
| `caption` | 11 | burn SRT/ASS (libass); audio `-c:a copy`. |
| `bgm_overlay` | 12 | loop a BGM bed, mix under existing audio, optional sidechain duck. Video `-c:v copy`. |

## Contract

```jsonc
// request
{ "input": { "op": "concat", "videos": [...], "aspectRatio": "9:16",
             "outputKey": "cohorts/win_.../concat/proj_8812.mp4" } }
// success
{ "url": "https://media.ai-storystudio.com/cohorts/.../proj_8812.mp4",
  "durationS": 312.4, "op": "concat", "elapsedMs": 41230, "clips": 69 }
// failure  (RunPod marks the job FAILED)
{ "error": "concat.normalize failed (exit 1): ...", "op": "concat", "elapsedMs": 812 }
```

Per-op inputs: see each module's `REQUIRED` tuple and docstring in `media/ops/`.

## Config (endpoint env)

| Var | Default | |
|---|---|---|
| `R2_ENDPOINT` | — | `https://<acct>.r2.cloudflarestorage.com` |
| `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | — | R2 credentials (writes only; reads are plain HTTP) |
| `R2_PUBLIC_BASE` | — | public origin for the returned URL, e.g. `https://media.ai-storystudio.com` |
| `MEDIA_VIDEO_ENCODER` | `h264_nvenc` | `libx264` to force CPU (local / no-GPU). One switch, every op. |
| `MEDIA_NVENC_PRESET` / `MEDIA_X264_PRESET` | `p5` / `medium` | |
| `MEDIA_TARGET_FPS` | `30` | concat fps lock |
| `MEDIA_UPSCALE_MODEL` | `realesrgan-x4plus` | or `realesrgan-x4plus-anime`, or `lanczos` |
| `MEDIA_DEBUG` | unset | include a stack trace in the error envelope |

The endpoint also needs `NVIDIA_DRIVER_CAPABILITIES` to include `video` (NVENC)
and `graphics` (Real-ESRGAN Vulkan) — RunPod defaults to `compute,utility`.

## Build & deploy

```sh
docker build -t <registry>/qm-media:<tag> orchestrator/containers/media
docker push <registry>/qm-media:<tag>
# create/point a RunPod serverless endpoint at the image; set the env above.
```

## Tests

```sh
python orchestrator/containers/media/test/test_ffmpeg_args.py   # pure argv builders, no ffmpeg
python orchestrator/containers/media/test/smoke_local.py        # real ffmpeg, libx264/lanczos, no R2/GPU
```

The GPU half — NVENC, Real-ESRGAN Vulkan, VRAM per op — only runs on a real
endpoint: `probe.md` (spec §12.3).
