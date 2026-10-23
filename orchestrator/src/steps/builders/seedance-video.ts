/**
 * `seedance-video` payload builder — Seedance 2 Mini on KIE (Dialogue Premium, 2026-10-23).
 *
 * One frame is one clip: the frame's still (qwen-image-gen, or the qwen-image-edit composite of
 * its characters' sheets) is the first frame, `motionPrompt` is the whole Seedance prompt — camera,
 * action AND the quoted spoken lines with a voice description per speaker — and Seedance voices
 * it. There is no TTS and no lip-sync pass, so unlike comfy-video the clip length is the caller's
 * (`durationS`), clamped to KIE's integer 4-15 s.
 */
import { clampSeedanceDuration, seedanceAspect } from '../../kie/seedance';
import { SKIP_URL_PREFIX, type BuildContext, type PayloadBuilder } from './types';

const IMAGE_EDIT_STEP_SEQ = 0;
const IMAGE_STEP_SEQ = 1;

export const buildSeedanceVideoInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const frame = ctx.frameId ?? ctx.job.frameId;
  // A narration frame's clip is LTX-2.3 (`comfy-video`), sized to its TTS.
  if (ctx.job.engine === 'ltx') return { __passthroughUrl: `${SKIP_URL_PREFIX}ltx` };
  const firstFrameUrl = ctx.resolvedDeps[IMAGE_EDIT_STEP_SEQ]?.url ?? ctx.resolvedDeps[IMAGE_STEP_SEQ]?.url;
  if (!firstFrameUrl) throw new Error(`seedance-video builder: no resolved image URL for frame ${frame}`);
  if (!ctx.job.motionPrompt) throw new Error(`seedance-video builder: no motionPrompt for frame ${frame}`);
  return {
    firstFrameUrl,
    prompt: ctx.job.motionPrompt,
    durationS: clampSeedanceDuration(ctx.job.durationS),
    aspectRatio: seedanceAspect(ctx.job.aspectRatio),
    projectId: ctx.projectId,
    frameId: frame,
  };
};
