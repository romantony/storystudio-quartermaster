/**
 * Step 14 (per-frame upscale, DreamX SR-DiT refiner) payload builder. A
 * plain per-frame step, like i2v/merge — NOT singleJobPerProject like step
 * 10 (postprod-lite's Real-ESRGAN upscale of the whole concat video). It
 * has to be per-frame: the refiner rejects any input over 241 frames
 * (~10s), which a single Wan2 clip (<= 7s) always fits and a concatenated
 * project video never does. Steps 14 and 10 are mutually exclusive per
 * request (agents/planner.ts's STEP_TOPOLOGY, options.upscaleEngine).
 *
 * Depends on step 3 (animation) only; step 6 (merge) then prefers this
 * step's output over step 3's — see steps/builders/merge.ts.
 *
 * sr_scale 2.25 (the refiner's max), NOT target_height 1080: Wan2's "480p"
 * (steps/builders/i2v.ts) is really 832x464, so target_height 1080 asks for
 * 2.328x and the worker rejects it outright ("scale 2.328x (from 464p) must
 * be between 1.0 and 2.25") — real failure, first live run 2026-09-14. A
 * fixed scale is immune to Wan2's exact source height; live result was
 * 1856x1056, 81 frames / 5.06s preserved, 66s on one RTX 6000 Ada. 2K
 * (1440p) is out of reach from this source — it would need >= 640p in.
 */
import type { BuildContext, PayloadBuilder } from './types';

const ANIMATION_STEP_SEQ = 3;
const SR_SCALE = 2.25;

export const buildUpscaleFrameInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const attribution: Record<string, unknown> = { project_id: ctx.projectId };
  if (ctx.frameId) attribution.frame_id = ctx.frameId;
  const videoUrl = ctx.resolvedDeps[ANIMATION_STEP_SEQ]?.url;
  if (!videoUrl) {
    throw new Error(`upscale-frame builder: no resolved animation video URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  return {
    video_url: videoUrl,
    sr_scale: SR_SCALE,
    ...attribution,
  };
};
