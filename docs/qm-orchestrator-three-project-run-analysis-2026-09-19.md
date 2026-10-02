# Three-project live run — generation analysis, defects and cost

**Date:** 2026-09-19 (analysis written 2026-09-20)
**Pipeline:** per-asset generator agents (`ORCH_PIPELINE_MODE=assets`), first run
carrying three real StoryStudio projects concurrently.
**Outcome:** all three completed, **zero failed assets, zero dropped frames** —
and **two of the three videos are unusable**, for a reason no test and no gate
could have caught.

---

## 1. What ran

| # | Project | Product | Frames | Assets | Wall clock | Tail | Verdict |
|---|---------|---------|-------:|-------:|-----------:|-----:|---------|
| 2 | `js79srd1…__a1` (Maya) | narration-premium | 18 | 92/92 | 37.8 min | 137s | **clean** |
| 3 | `js79cyk7…__a1` (UPI) | educational | 95 | 477/477 | 38.7 min | 506s | defective |
| 1 | `js71jt6r…__a1` | explainer | 111 | 557/557 | 46.7 min | 644s | defective |

Final URLs:

```
#2 https://pub-bce4924e66d944668be30268ccf4492c.r2.dev/storystudio/video/20260919151205_0f75afa6-8a3d-4110-af34-5e91eeb71140-u1_final.mp4
#3 https://pub-bce4924e66d944668be30268ccf4492c.r2.dev/storystudio/video/20260919155237_a8c9e366-92f7-40c2-9805-7e88a8097c89-u2_final.mp4
#1 https://pub-bce4924e66d944668be30268ccf4492c.r2.dev/storystudio/video/20260919164035_fc810960-32a9-4bf9-a993-48fc35f8c32b-u1_final.mp4
```

The generation layer did its job perfectly. Every defect below is in **assembly**
or in **what StoryStudio sent us**, not in the agents.

---

## 2. The headline defect: mixed-format concat

### What was measured

| | sum of clips | final video | final audio | silent tail |
|---|---:|---:|---:|---:|
| #2 Maya | 87.98s | 88.00s | 87.77s | 0.2s — clean |
| #3 UPI | 386.75s | **409.47s** | 386.62s | **22.9s** |
| #1 explainer | 457.43s | **482.93s** | 457.41s | **25.5s** |

In both broken projects the **audio matches the sum of the clips exactly**. It is
the **video that is too long** — by 5.9% and 5.6% respectively. Audio levels hold
at ~-33 dB right up to the audio's end and then stop dead; the tail is pure
silence, and everything before it is progressively desynced.

### Root cause

`_concat_local()` in `postprod-lite/handler.py` uses the ffmpeg **concat
demuxer** (`-f concat`), which requires every input to share stream parameters.
It was handed a list that did not:

| | frames rendered by Remotion | format |
|---|---:|---|
| Remotion-overlaid frames | 17 of 95 (#3), 16 of 111 (#1) | **1920×1080 @ 30fps** |
| Passthrough frames | 78 of 95, 95 of 111 | **832×464 @ 16fps** |

With mixed resolution *and* frame rate, ffmpeg re-encodes to the first file's
parameters and the later files' timestamps are mangled — the video stretches,
the audio stays correct, and the difference falls off the end as silence.

Maya was uniformly 1056×1856 @ 16fps, which is the *only* reason it is clean.
**This bug has been latent since the one-shot tail was built** and will fire on
any project with heterogeneous clips.

### Two consequences, not one

1. **Desync + silent tail** (above).
2. **Resolution collapse.** 78/95 and 95/111 frames are natively **832×464** and
   get blown up ~2.3× to 1080p during concat. Those scenes are visibly soft.
   The educational/explainer path correctly has no DreamX — Remotion is meant to
   be the 1080p source — but that only holds if Remotion renders *every* frame.

---

## 3. The upstream cause: Remotion coverage is ~15%

| project | real renders | passthrough | coverage |
|---|---:|---:|---:|
| #3 UPI | 17 | 78 | **17.9%** |
| #1 explainer | 16 | 95 | **14.4%** |

A frame only gets a Remotion render when it carries a `textManifest`; otherwise
`invokeLambdaRow()` takes its `__passthrough` branch and the raw Wan2 clip
goes straight through. Both projects arrived with a manifest on roughly one
frame in six.

The passthrough itself is deliberate — its comment in `agent.ts` says a mixed
project would otherwise "drop the uncaptioned ones out of the chain entirely."
The design anticipated mixed projects; the **concat did not**. That is the gap.

This is the more important of the two fixes. It is what creates the format
mixing in the first place, and it means the products that are *supposed* to be
Remotion-rendered are ~85% not-Remotion.

**Open question for StoryStudio:** is ~15% `textManifest` coverage intentional
for educational/explainer, or is the manifest being dropped upstream? The answer
changes which fix is correct (normalise formats vs. render every frame).

---

## 4. Other defects found

### 4.1 BGM stops at 2 minutes

`bgm` generates a **120s** track. It was mixed under a 409s and a 483s video.
`_mix_bgm_local()` uses `amix=inputs=N:duration=first` with no `aloop` and no
`apad`, so music covers the first 25–29% of the video and then simply stops.
Maya (88s) is under 120s, so it was never exposed.

### 4.2 Nothing gates the assembled video

This is the most important process finding. On #3, **49 images were VLM-judged
and every one passed** — and the delivered video was still broken. The QA ladder
judges individual assets; no check of any kind runs on the concatenated output.
A single ffprobe assertion (`|video_duration − audio_duration| < 1s`) would have
caught both failures instantly, for free, before the callback fired.

### 4.3 Timeout headroom is thin on two kinds

Measured **execution** time (queue excluded, matching how the budget is applied):

| kind | budget | max observed | headroom |
|---|---:|---:|---|
| qwen-image-gen | 150s | **139.6s** | **7%** ⚠ |
| dreamx-refine | 150s | **127.8s** | **15%** ⚠ |
| bgm | 150s | 96.5s | 36% |
| tts | 150s | 91.6s | 39% |
| wan2-i2v | 300s | 141.0s | 53% |
| mmaudio | 150s | 36.6s | 76% |
| postprod-lite | 900s | **628.6s** | **30%**, and scales with frames |

`qwen-image-gen` came within 10.4 seconds of a false timeout — a cold pod plus
any variance tips it over, and a false timeout costs a cancel + full resubmit.

The postprod tail scales at roughly **5.4s per frame** (137s/18, 506s/95,
644s/111 — including upload). Extrapolating, **~165 frames is where the 900s pod
budget runs out.**

### 4.4 Endpoint fill

23 of 60 samples showed an endpoint with a free pod and runnable work, vs 4/60
on Maya. Broken down, it is mostly benign:

| kind | starved samples | longest streak |
|---|---:|---:|
| remotion | 16 | 3 (90s) |
| mmaudio | 7 | 1 |
| wan2-i2v | 5 | 1 |
| tts | 2 | 2 |

Everything except `remotion` is single-sample refill lag: `maxInFlight` equals
the endpoint's exact pod count, so no job is ever queued at RunPod and a pod
idles until the next tick. Harmless but leaves throughput on the table.

`remotion` is genuinely capped: `agent.ts` renders a Lambda batch under
`Promise.all`, but the whole tick blocks until the batch finishes and the batch
is `assetDispatchBatchSize` = 4. Effective concurrency is 4 against 8 slots.

---

## 5. Cost

Billed RunPod execution only (idle/ready workers are free). RunPod endpoints
bill at $0.00021/s; Remotion Lambda at $0.000127/s.

### Per project

| # | Project | Frames | Total | Per frame | GPU-seconds | Per min of video |
|---|---------|-------:|------:|----------:|------------:|-----------------:|
| 2 | Maya (premium) | 18 | **$0.9680** | **$0.0538** | 4,610s | $0.66 |
| 3 | UPI (educational) | 95 | **$2.2703** | **$0.0239** | 10,925s | $0.35 |
| 1 | Explainer | 111 | **$2.7948** | **$0.0252** | 13,420s | $0.37 |

*Per-minute figures use the correct (sum-of-clips) duration, not the inflated
video length.*

**Total for the three-project run: $6.03.**

### Per kind

**#1 explainer — $2.7948 / 111 frames**

| kind | n | cost | share | avg exec |
|---|---:|---:|---:|---:|
| wan2-i2v | 111 | $2.0025 | **71.6%** | 85.9s |
| qwen-image-gen | 111 | $0.3779 | 13.5% | 16.2s |
| mmaudio | 111 | $0.1446 | 5.2% | 6.2s |
| postprod-lite | 1 | $0.1320 | 4.7% | 628.6s |
| tts | 111 | $0.0832 | 3.0% | 3.6s |
| remotion | 16 | $0.0358 | 1.3% | 17.6s |
| bgm | 1 | $0.0188 | 0.7% | 89.7s |

**#3 UPI — $2.2703 / 95 frames**

| kind | n | cost | share | avg exec |
|---|---:|---:|---:|---:|
| wan2-i2v | 95 | $1.6143 | **71.1%** | 80.9s |
| qwen-image-gen | 95 | $0.3272 | 14.4% | 16.4s |
| mmaudio | 95 | $0.1326 | 5.8% | 6.6s |
| postprod-lite | 1 | $0.1024 | 4.5% | 487.7s |
| tts | 95 | $0.0374 | 1.6% | 1.9s |
| remotion | 17 | $0.0367 | 1.6% | 17.0s |
| bgm | 1 | $0.0196 | 0.9% | 93.4s |

**#2 Maya — $0.9680 / 18 frames**

| kind | n | cost | share | avg exec |
|---|---:|---:|---:|---:|
| wan2-i2v | 18 | $0.3693 | 38.2% | 97.7s |
| dreamx-refine | 18 | $0.3599 | **37.2%** | 95.2s |
| tts | 18 | $0.1120 | 11.6% | 29.6s |
| qwen-image-gen | 18 | $0.0467 | 4.8% | 12.4s |
| mmaudio | 18 | $0.0336 | 3.5% | 8.9s |
| postprod-lite | 1 | $0.0263 | 2.7% | 125.2s |
| bgm | 1 | $0.0203 | 2.1% | 96.5s |

### Cost observations

- **Premium costs 2.2× per frame** ($0.0538 vs $0.0245) and it is entirely
  DreamX: 37% of Maya's bill for the per-frame upscale.
- **Wan2 is ~72% of every non-premium project.** Nothing else is worth
  optimising until Wan2 is.
- The educational/explainer path at **$0.024/frame** is roughly **half** the
  2026-09-18 baseline of $0.045/frame, because it skips DreamX.
- Assembly is cheap: the one-shot tail is 3–5% of project cost.
- **Parallelism:** #1 packed 13,420 GPU-seconds into 2,802s wall (4.8×), #3 4.7×,
  Maya 2.0×. The big projects saturate the fleet well; small ones cannot.

---

## 6. What to fix, in priority order

### P0 — correctness, blocks delivery

1. **Normalise clips before concat.** In `_concat_local()`, either switch to the
   concat *filter* with per-input `scale` + `fps`, or pre-normalise every clip
   to a common resolution/fps/timebase. Must not depend on inputs happening to
   match. *This is the only fix that makes today's two videos correct.*
2. **Assert A/V duration parity in the tail** before upload. Fail the project
   loudly rather than deliver a desynced video. One ffprobe call, no GPU.

### P1 — quality

3. **Resolve Remotion coverage with StoryStudio.** ~15% `textManifest` coverage
   is either an upstream bug or a spec misunderstanding. If every frame is meant
   to be Remotion-rendered, that also removes the format mixing at source.
4. **Loop/pad BGM to video length** — `aloop=loop=-1` + trim, or `apad`. Any
   project over 120s is currently silent on music for most of its runtime.
5. **Decide the 832×464 path.** If passthrough frames are legitimate, they need
   DreamX or an upscale before concat; shipping 2.3×-upscaled 832×464 as "1080p"
   is not acceptable output.

### P2 — robustness and throughput

6. **Raise `qwen-image-gen` 150s → 240s** (7% headroom observed) and
   **`dreamx-refine` 150s → 300s** (15%).
7. **Guard the postprod budget.** At ~5.4s/frame the 900s pod ceiling is reached
   near 165 frames. Either raise the pod timeout or split assembly into chunks
   before a project that size arrives.
8. **Let the Lambda path use all 8 slots** — decouple `remotion` from
   `assetDispatchBatchSize`, or don't block the tick on the batch.
9. **Allow queue depth of pods+1** on RunPod endpoints so a freed worker always
   has a job waiting. Queued jobs are unbilled, so this is free throughput.

---

## 7. What worked, and should not be disturbed

- **Zero failures across 1,126 assets and three concurrent projects.** No
  timeouts fired, no cancellations, no dropped frames.
- **Retries stayed rare:** 10 assets total, all on Maya, all resolved on
  attempt 2. The big projects needed none.
- **The QA exemption for explainer/educational works** — `qa_status: bypassed`
  on both, no VLM spend, no gate stalls.
- **Cross-project saturation is real.** 4.7–4.8× average parallelism on the
  large projects is the whole point of the per-asset architecture, and it
  delivered.
- **The compiler handled three concurrent projects** with no cross-contamination
  of assets.

---

## 8. Caveats on this data

- #3's QA sample counts (49 judged of 95 images, vs a 30% target) are
  **contaminated**: the explainer/educational QA exemption was deployed
  mid-flight and #3's plan was patched to `qaExempt` while it ran. Its images
  were judged before the patch, its videos after. Do not read a sampling rate
  off this project.
- Maya's sampling (8/18 images, 1/18 videos) is a clean but tiny sample.
- Cost figures are RunPod execution time only. They exclude R2 storage/egress,
  the VPS, Postgres, and Replicate VLM calls.
