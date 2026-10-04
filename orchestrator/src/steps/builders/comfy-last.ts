/**
 * `comfy-last` payload builder — the LAST frame of an LTX `flf` shot (2026-10-04).
 *
 * StoryStudio sends `lastFrameEdit`: an edit applied to the FIRST frame, so the
 * pair shares identity, set and lighting. Runs on the qwen-image-edit endpoint
 * with the frame's still as `image_url`. A frame that is not `flf` has no last
 * frame: the row passes the still straight through (`__passthroughUrl`, handled
 * generically in assets/agent.ts) so the per-frame chain stays uniform.
 */
import type { BuildContext, PayloadBuilder } from './types';

const IMAGE_EDIT_STEP_SEQ = 0;
const IMAGE_STEP_SEQ = 1;

export const buildComfyLastInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const imageUrl = ctx.resolvedDeps[IMAGE_EDIT_STEP_SEQ]?.url ?? ctx.resolvedDeps[IMAGE_STEP_SEQ]?.url;
  if (!imageUrl) throw new Error(`comfy-last builder: no resolved first-frame URL for frame ${ctx.frameId ?? '(none)'}`);
  if ((ctx.job.shotKind !== 'flf' && ctx.job.shotKind !== 'flf_ia2v') || !ctx.job.lastFrameEdit) return { __passthroughUrl: imageUrl };
  return {
    image_url: imageUrl,
    prompt: ctx.job.lastFrameEdit,
    project_id: ctx.projectId,
    ...(ctx.frameId ? { frame_id: ctx.frameId } : {}),
  };
};
