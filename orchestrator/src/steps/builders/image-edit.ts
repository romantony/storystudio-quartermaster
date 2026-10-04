/**
 * Step 0 (image-i2i) payload builder — Narration Premium's reference-image
 * flow. Ported from src/adapters/runpod.ts's `i2i` case (~line 135) —
 * targets the standalone `qwen-image-edit` endpoint. Unlike step 1's t2i
 * builder, there is no `model` field: qwen-image-edit is a dedicated
 * single-model endpoint, selected only by `image_url` being present.
 *
 * Mutually exclusive with step 1 (see agents/planner.ts's STEP_TOPOLOGY —
 * gated by options.referenceImage) but consumed the same way by step 3's
 * i2v builder (steps/builders/i2v.ts checks seq 0 before falling back to
 * seq 1), so a project either runs this or step 1, never both.
 */
import type { BuildContext, PayloadBuilder } from './types';

const IMAGE_STEP_SEQ = 1;
const CHAR_REF_SEQ = 19;

export const buildImageEditInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const attribution: Record<string, unknown> = { project_id: ctx.projectId };
  if (ctx.frameId) attribution.frame_id = ctx.frameId;
  // LTX project with characters: edit the frame's character reference
  // (builders/char-ref.ts) into the scene; a frame with no characters already
  // has its still from the t2i kind, which this row passes through.
  if (ctx.job.characterRefs) {
    const ref = ctx.resolvedDeps[CHAR_REF_SEQ]?.url;
    if (ctx.job.characterRefs.length === 0) {
      const still = ctx.resolvedDeps[IMAGE_STEP_SEQ]?.url;
      if (!still) throw new Error(`image-edit builder: no t2i still for frame ${ctx.frameId ?? '(none)'}`);
      return { __passthroughUrl: still };
    }
    if (!ref) throw new Error(`image-edit builder: no character reference for frame ${ctx.frameId ?? '(none)'}`);
    return { image_url: ref, prompt: ctx.job.imagePrompt, ...attribution };
  }
  if (!ctx.job.referenceImageUrl) {
    throw new Error(`image-edit builder: no referenceImageUrl for frame ${ctx.frameId ?? '(none)'}`);
  }
  return {
    image_url: ctx.job.referenceImageUrl,
    prompt: ctx.job.imagePrompt,
    ...attribution,
  };
};
