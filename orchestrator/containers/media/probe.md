# §12.3 — the media-container probe

**Question it answers (spec §16 q2):** can `concat`, `upscale`, `caption` and
`bgm_overlay` — four workloads with very different VRAM/compute profiles — share
**one image and one warm allocation**? If not, the pipeline tail is four
scale-ups instead of one, and the warm-up figure rises ~$1.51 a cohort
(spec §3.1).

Also settles **§16 q3** (NVENC vs libx264 for `concat`) and feeds **§16 q4**
(GPU choice — the media endpoint wants NVENC + little VRAM).

## Setup

1. Build and push the image; create a RunPod serverless endpoint on it.
   - GPU: start with the cheapest NVENC-capable card (e.g. RTX 2000/4000-class).
   - Env: `R2_*` set, `NVIDIA_DRIVER_CAPABILITIES=compute,utility,video,graphics`.
2. Put four fixtures in R2 (or any public URL):
   - `probe/frames/` — ~69 short clips for `concat` (a real cohort's animation output)
   - `probe/assembled.mp4` — one concatenated video (~5 min) for `upscale` / `caption` / `bgm_overlay`
   - `probe/subs.srt`, `probe/bed.mp3`

## Run — one job per op

```sh
EP=https://api.runpod.ai/v2/<endpointId>
KEY=<RUNPOD_API_KEY>
post() { curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
           -d "$1" "$EP/runsync"; }

post '{"input":{"op":"concat","videos":[{"videoUrl":"…/0001.mp4","frameNumber":1}, …],
                "aspectRatio":"9:16","outputKey":"probe/out/concat.mp4"}}'

post '{"input":{"op":"upscale","videoUrl":"…/assembled.mp4","scale":2,
                "model":"realesrgan-x4plus","outputKey":"probe/out/upscale.mp4"}}'

post '{"input":{"op":"caption","videoUrl":"…/assembled.mp4","subtitlesUrl":"…/subs.srt",
                "outputKey":"probe/out/caption.mp4"}}'

post '{"input":{"op":"bgm_overlay","videoUrl":"…/assembled.mp4","bgmUrl":"…/bed.mp3",
                "bgmVolume":0.18,"outputKey":"probe/out/bgm.mp4"}}'
```

Repeat `concat` with the endpoint env flipped to `MEDIA_VIDEO_ENCODER=libx264`
for the q3 comparison.

## Record

| op | `elapsedMs` | peak VRAM (nvidia-smi / RunPod metrics) | GPU util | cold-start ms | notes |
|---|---|---|---|---|---|
| concat (nvenc) | | | | | |
| concat (x264) | | | | | |
| upscale x2 | | | | | |
| caption | | | | | |
| bgm_overlay | | | | | |

Watch VRAM with the endpoint logs or `nvidia-smi dmon` on a rented pod running
the same image.

## Decide

- **Share one image?** Yes if peak VRAM across all four fits the smallest card
  you'd want to buy *and* no op needs a driver/lib the others break on. `upscale`
  (Real-ESRGAN) is the VRAM outlier — if it dominates, consider `model:"lanczos"`
  as the default and reserve ML SR for an opt-in.
- **NVENC or libx264 for concat?** Compare `elapsedMs` and output size/quality.
  NVENC only earns its place if it's meaningfully faster on the assembled-video
  encodes; the tail is ~10 jobs, so a few seconds each may not matter.
- **GPU class:** smallest card that holds the peak VRAM above with NVENC. Record
  the real `WORKER_RATE_USD_S` from the endpoint's billing for the §8 rebuild.

Write the numbers back into spec §8 and §16 q2–q4.
