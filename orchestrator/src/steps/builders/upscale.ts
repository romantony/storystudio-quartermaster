/**
 * Step 10 (upscale) payload builder — a singleJobPerProject step, like step
 * 8 (concat), but depending on ANOTHER singleJobPerProject step rather than
 * fanning in on every frame: step 8 produces exactly one project video, so
 * this job's fan-in is 1, not req.frames.length (see agents/planner.ts's
 * buildStepsAndJobs()). Targets postprod-lite's `upscale` mode
 * (orchestrator/containers/media.md): `{video_url, target_height}` ->
 * `{video, upscale}` — Wan2's native i2v output is 480p, so the default
 * target is 1080p, matching the real product's Finalize step. `upscale`
 * skips (returns the source URL, `upscale:"skipped_source_hires"`) when the
 * source is already >= target_height — nothing this builder needs to branch
 * on, postprod-lite handles it.
 */
import type { BuildContext, PayloadBuilder } from './types';

const CONCAT_STEP_SEQ = 8;
const DEFAULT_TARGET_HEIGHT = 1080;

export const buildUpscaleInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const videoUrl = ctx.perFrameOutputs?.[CONCAT_STEP_SEQ]?.[0];
  if (!videoUrl) {
    throw new Error(`upscale builder: no resolved concat video URL for project ${ctx.projectId}`);
  }
  return {
    mode: 'upscale',
    video_url: videoUrl,
    target_height: DEFAULT_TARGET_HEIGHT,
    project_id: ctx.projectId,
  };
};
