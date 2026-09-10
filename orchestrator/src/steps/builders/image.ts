/**
 * Step 1 (image) payload builder. Ported from src/adapters/runpod.ts's `t2i`
 * case (~line 119) — targets the `qwen-image-gen` endpoint, Flux Klein 4B
 * model. M2 scope: text-to-image only, no reference-image/i2i support (see
 * the M2 plan's decision 1) — a frame carrying reference images would need
 * a separate step/catalog entry pointed at `qwen-image-edit`, not built yet.
 */
import type { BuildContext, PayloadBuilder } from './types';

export const buildImageInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const attribution: Record<string, unknown> = { project_id: ctx.projectId };
  if (ctx.frameId) attribution.frame_id = ctx.frameId;
  return {
    model: 'qwen',
    prompt: ctx.job.imagePrompt,
    aspect_ratio: ctx.job.aspectRatio ?? '16:9',
    ...attribution,
  };
};
