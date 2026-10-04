/**
 * `comfy-video` payload builder — LTX-2.3 on Comfy Cloud (2026-10-04).
 *
 * Takes Wan2's place in the per-frame chain for `options.motionEngine: 'ltx'`.
 * Narration shots only (`i2v`, `flf`): every spoken line is our TTS and the
 * clip carries its own SFX, which the tail mixes under the narration.
 *
 * QM, not StoryStudio, owns the workflow choice and the duration: the clip is
 * sized from the REAL TTS length (+ a 1 s tail), clamped to 5-10 s, never the
 * caller's estimate (same rule as builders/i2v.ts — the tail's `-shortest` mux
 * would clip the narration otherwise).
 */
import type { BuildContext, PayloadBuilder } from './types';

const IMAGE_EDIT_STEP_SEQ = 0;
const IMAGE_STEP_SEQ = 1;
const TTS_STEP_SEQ = 2;
export const COMFY_LAST_SEQ = 17;

export const LTX_MIN_S = 5;
export const LTX_MAX_S = 10;
export const LTX_TAIL_S = 1;

export function ltxDurationS(ttsS: number | undefined, estimateS: number): number {
  const raw = Math.ceil((ttsS ?? estimateS) + (ttsS === undefined ? 0 : LTX_TAIL_S));
  return Math.min(LTX_MAX_S, Math.max(LTX_MIN_S, raw));
}

export const buildComfyVideoInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const frame = ctx.frameId ?? ctx.job.frameId;
  const firstImageUrl = ctx.resolvedDeps[IMAGE_EDIT_STEP_SEQ]?.url ?? ctx.resolvedDeps[IMAGE_STEP_SEQ]?.url;
  if (!firstImageUrl) throw new Error(`comfy-video builder: no resolved image URL for frame ${frame}`);
  const kind = ctx.job.shotKind;
  if (kind !== 'i2v' && kind !== 'flf') throw new Error(`comfy-video builder: unsupported shotKind '${kind}' for frame ${frame}`);
  if (!ctx.job.motionPrompt) throw new Error(`comfy-video builder: no motionPrompt for frame ${frame}`);
  const lastImageUrl = kind === 'flf' ? ctx.resolvedDeps[COMFY_LAST_SEQ]?.url : undefined;
  if (kind === 'flf' && (!lastImageUrl || lastImageUrl === firstImageUrl)) {
    throw new Error(`comfy-video builder: flf frame ${frame} has no distinct last frame`);
  }
  return {
    workflow: kind === 'flf' ? 'ltx23_flf2v' : 'ltx23_i2v',
    firstImageUrl,
    ...(lastImageUrl ? { lastImageUrl } : {}),
    prompt: ctx.job.motionPrompt,
    ...(ctx.job.negativePrompt ? { negativePrompt: ctx.job.negativePrompt } : {}),
    durationS: ltxDurationS(ctx.resolvedDeps[TTS_STEP_SEQ]?.durationS, ctx.job.durationS),
    portrait: /^9\s*:\s*16$/.test(ctx.job.aspectRatio ?? ''),
    ...(typeof ctx.job.seed === 'number' ? { seed: ctx.job.seed } : {}),
    projectId: ctx.projectId,
    frameId: frame,
  };
};
