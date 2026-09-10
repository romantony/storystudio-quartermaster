/**
 * Step 3 (animation/i2v) payload builder. Ported from src/adapters/runpod.ts's
 * `i2v` case (~line 325) — Wan 2.2 I2V-A14B, 4-step Lightning, targets the
 * standalone `wan2-i2v` endpoint. Depends on step 1 (image) — the generator
 * resolves that dependency's output URL into `ctx.resolvedDeps[1]` before
 * calling this builder (see steps/builders/types.ts).
 *
 * duration_s must be one of [3,4,5,6,7] — the pod rejects anything else
 * outright. Math.ceil, not Math.round: overshoot, never undershoot, so a
 * later merge's `-shortest` never clips the last syllable of narration
 * (same bug/fix runpod.ts documents at its i2v case).
 */
import type { BuildContext, PayloadBuilder } from './types';

const IMAGE_STEP_SEQ = 1;

export const buildI2vInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const attribution: Record<string, unknown> = { project_id: ctx.projectId };
  if (ctx.frameId) attribution.frame_id = ctx.frameId;
  const imageUrl = ctx.resolvedDeps[IMAGE_STEP_SEQ]?.url;
  if (!imageUrl) {
    throw new Error(`i2v builder: no resolved image URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  return {
    image: imageUrl,
    prompt: ctx.job.motionPrompt ?? '',
    resolution: '480p',
    duration_s: Math.min(7, Math.max(3, Math.ceil(ctx.job.durationS))),
    sample_steps: 4,
    ...attribution,
  };
};
