---
name: plan-generation
description: "Live QM capacity plan — real RunPod fleet state, hosted models, baselines, queue depth -> a generation plan (grant/defer, sequencing, ETA) for a specific project or a fleet health check"
trigger: /plan-generation
---

# /plan-generation

Produces a generation plan grounded in **live** Quartermaster (QM) fleet state, not
assumptions: how many RunPod pods exist per endpoint, which models are hosted where,
real gen-time baselines (EWMA from actual completed jobs), and current queue/inflight
depth per endpoint. Use it before admitting a project you're unsure will fit, or as a
general fleet health check.

## Usage

```
/plan-generation                              # fleet health check — no specific project
/plan-generation narration-premium 90         # plan for a project: projectType + duration (seconds)
/plan-generation narration-basic 300
```

## What to do when invoked

1. **Gather live context** — run the context script from the `quartermaster` repo root:
   ```bash
   cd /home/roman-antony/quartermaster && npx ts-node scripts/plan-generation-context.ts [projectType] [durationSeconds]
   ```
   This is read-only (no admission decision is made or written) and returns one JSON
   blob: `fleet` (account cap, jobs/worker, per-endpoint idle floor + live inflight/
   queued/reserved workers), `endpoints` (GPU type, cold-start time, hosted models, and
   real baseline gen-time per operation — falls back to a documented seed if no real
   samples exist yet), `activeReservations`, and (if projectType+duration given)
   `requestedProject` (frame count + projected job count per endpoint).

2. **Reason over it, don't just repeat it back.** Compute, using the same math QM's
   own admission gate uses (`src/handlers/admission.ts`'s `decide()` — read it if you
   want the exact formula):
   - Per touched endpoint: `workersNeeded = ceil(min(frameCount, sfnMapMaxConcurrency) / jobsPerWorker)`.
   - `projectedFleetTotal = fleet.totalActiveWorkersNow + sum(workersNeeded across touched endpoints)`.
   - **Grant** if `projectedFleetTotal <= fleet.accountCap` AND no endpoint's drain
     estimate (`perEndpoint[ck] * baselineGenTimeMs[ck] / workersNeeded`, roughly)
     exceeds ~30 min. **Defer** otherwise, and say by how much it's over and which
     endpoint is the constraint.
   - If deferred purely on `cap_committed` (fleet numbers alone don't justify it —
     e.g. `fleet.totalActiveWorkersNow` is 0 or low), say so explicitly: that's a
     structural ceiling (a solo project's own footprint exceeds the account cap),
     not congestion — don't imply something is "stuck" when it isn't.

3. **Sequencing recommendation**, when relevant: note that the live per-frame pipeline
   order for `narration-premium` is image (i2i) → Wan2 i2v → Qwen3-TTS → merge (fail
   fast on image/video before spending on TTS) and for `narration-basic` is image → TTS
   → Flux animate → Flux merge — don't propose a different order without a stated
   reason; if the fleet is contended, the useful lever is usually *which endpoint to
   pre-warm first* (§Locked decisions on pre-warm in project memory `qm-admission-gate`),
   not reordering the per-frame steps.

4. **Present the plan** in this shape:
   - One-line verdict: **grant now** / **defer, retry in ~Ns** / **fleet is idle, no
     plan needed**.
   - A small table: endpoint → workers needed → workers available (idle floor +
     headroom) → real bottleneck if any.
   - ETA breakdown (which endpoint's baseline dominates the estimate, and whether
     that number is a real GPU-compute estimate — e.g. Wan2 at ~92s/frame — versus a
     seeded default that hasn't been validated by real traffic yet, flagged as such
     if `baselineGenTimeByOp` is empty for that endpoint).
   - If deferred: what would need to change for a grant (raise `RUNPOD_ACCOUNT_CAP`,
     wait for other reservations to release, etc.) — don't just state the number.

## What this skill does NOT do

- It doesn't call `POST /admission` or touch any reservation — it's read-only
  reasoning support for a human deciding what to do next (raise the cap? wait? tell
  StoryStudio to retry?), not a production decision-maker. If you want to actually
  grant/defer for real, that's `src/handlers/admission.ts`'s live `decide()` via the
  real `POST /admission` call — this skill mirrors that math for visibility, it
  doesn't replace it.
- It doesn't call out to any external LLM — the reasoning in step 2-4 is done by
  you (the assistant) directly, using the gathered JSON as grounding. There's no
  separate "send this to an LLM" hop.

## Reference: current fleet shape (as of 2026-07-04 — verify via the script, don't trust this if it's gone stale)

| Endpoint | Pods (idle floor) | Hosted models |
|---|---|---|
| `runpod:flux-tts-s2t` | 3 | Flux image (basic), Kokoro TTS (basic), Qwen3-TTS voice design (premium), Whisper SRT, ACE-Step BGM, post-production (animate/merge/concat/caption/mix_bgm) |
| `runpod:qwen-image-gen` | 2 | Qwen-Image t2i |
| `runpod:qwen-image-edit` | 2 | Qwen-Image-Edit i2i — narration-premium's real usage (character reference) |
| `runpod:wan2-i2v` | 3 | Wan 2.2 I2V-A14B — narration-premium video |

Idle floors sum to exactly `RUNPOD_ACCOUNT_CAP` (10) — this is why a solo
`narration-premium` project (needs ~4 workers × 3 endpoints = 12) always defers on
a cold fleet; it's not a bug (see project memory `qm-admission-gate`).

## Worked examples (both tiers, verified against a live idle fleet on 2026-07-04)

**`narration-premium`, 90s** — `frameCount=18`, touches 3 endpoints (`qwen-image-edit`,
`flux-tts-s2t`, `wan2-i2v`), `workersNeeded = ceil(min(18,15)/4) = 4` on *each*, so
`thisProjectWorkers = 12`. Against an idle fleet (`totalActiveWorkersNow=0`):
`12 > accountCap(10)` → **defer, `cap_committed`** — structural, not congestion; a
solo premium project always exceeds the cap by itself today. ETA driver: Wan2 i2v at
its real baseline (~92s/frame, not a seed — `baseline.narrationPremium` samples exist
once premium runs for real) dominates any drain estimate once granted.

**`narration-basic`, 300s** — `frameCount=60`, touches one endpoint (`flux-tts-s2t`),
`workersNeeded = ceil(min(60,15)/4) = 4`. Against an idle fleet: `4 ≤ 10` →
**capacity is fine.** But check the *drain* estimate too, not just the worker count:
`total jobs (242) × blended baseline (~29.9s, averaged across image/TTS/animate/
merge/BGM on that shared endpoint) ÷ 4 workers ≈ 30.2 min` — that's *over* the
30-minute drain ceiling (`MAX_DRAIN_MS`), so this defers on **`queue_busy`** even
though the fleet is completely idle. This is a real limitation of the blended-average
baseline (it overstates cost for the cheap job types — animate ~11s, merge ~7.5s — by
smearing in the expensive ones — image t2i ~80s), not a queue problem. Call this out
explicitly rather than reporting "fleet busy" when it isn't — a shorter narration-basic
project (or one where the per-op baselines are more separated) may not hit this at all.
