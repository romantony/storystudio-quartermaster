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
export const DIALOGUE_AUDIO_SEQ = 18;

export const LTX_MIN_S = 5;
export const LTX_MAX_S = 10;
/** Lead-in before narration/speech starts, and action time when the caller
 * sends none (handoff formula: min(10, max(5, leadS + ttsSeconds + actionS))). */
export const LTX_LEAD_S = 0.4;
export const LTX_NARRATION_ACTION_S = 2;
export const LTX_DIALOGUE_ACTION_S = 1;

/** Whole seconds (the i2v workflows take an int). At the cap the action is
 * squeezed, never the speech. Without a real TTS length falls back to the
 * caller's estimate. */
export function ltxDurationS(ttsS: number | undefined, estimateS: number, actionS: number = LTX_NARRATION_ACTION_S, leadS: number = LTX_LEAD_S): number {
  const raw = Math.ceil(ttsS === undefined ? estimateS : leadS + ttsS + actionS);
  return Math.min(LTX_MAX_S, Math.max(LTX_MIN_S, raw));
}

export const buildComfyVideoInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const frame = ctx.frameId ?? ctx.job.frameId;
  const firstImageUrl = ctx.resolvedDeps[IMAGE_EDIT_STEP_SEQ]?.url ?? ctx.resolvedDeps[IMAGE_STEP_SEQ]?.url;
  if (!firstImageUrl) throw new Error(`comfy-video builder: no resolved image URL for frame ${frame}`);
  const kind = ctx.job.shotKind;
  if (kind !== 'i2v' && kind !== 'flf' && kind !== 'ia2v' && kind !== 'flf_ia2v') {
    throw new Error(`comfy-video builder: unsupported shotKind '${kind}' for frame ${frame}`);
  }
  if (!ctx.job.motionPrompt) throw new Error(`comfy-video builder: no motionPrompt for frame ${frame}`);
  const withLast = kind === 'flf' || kind === 'flf_ia2v';
  const lastImageUrl = withLast ? ctx.resolvedDeps[COMFY_LAST_SEQ]?.url : undefined;
  if (withLast && (!lastImageUrl || lastImageUrl === firstImageUrl)) {
    throw new Error(`comfy-video builder: ${kind} frame ${frame} has no distinct last frame`);
  }
  const dialogueShot = kind === 'ia2v' || kind === 'flf_ia2v';
  let durationS: number;
  let audioUrl: string | undefined;
  if (dialogueShot) {
    // The padded line fixes the clip length: the audio must be exactly as long.
    const a = ctx.resolvedDeps[DIALOGUE_AUDIO_SEQ];
    if (!a?.url || !(typeof a.durationS === 'number' && a.durationS > 0)) {
      throw new Error(`comfy-video builder: ${kind} frame ${frame} has no padded dialogue audio`);
    }
    audioUrl = a.url;
    durationS = a.durationS;
  } else {
    // An action frame (sfx-only) has no speech: actionS is the whole shot.
    durationS = ctx.job.audioMode === 'sfx-only'
      ? Math.min(LTX_MAX_S, Math.max(LTX_MIN_S, Math.ceil(ctx.job.actionS ?? ctx.job.durationS)))
      : ltxDurationS(ctx.resolvedDeps[TTS_STEP_SEQ]?.durationS, ctx.job.durationS, ctx.job.actionS);
  }
  const workflow = { i2v: 'ltx23_i2v', flf: 'ltx23_flf2v', ia2v: 'ltx23_ia2v', flf_ia2v: 'ltx23_flf_ia2v' }[kind];
  return {
    workflow,
    firstImageUrl,
    ...(lastImageUrl ? { lastImageUrl } : {}),
    ...(audioUrl ? { audioUrl } : {}),
    prompt: ctx.job.motionPrompt,
    ...(ctx.job.negativePrompt ? { negativePrompt: ctx.job.negativePrompt } : {}),
    durationS,
    portrait: /^9\s*:\s*16$/.test(ctx.job.aspectRatio ?? ''),
    ...(typeof ctx.job.seed === 'number' ? { seed: ctx.job.seed } : {}),
    projectId: ctx.projectId,
    frameId: frame,
  };
};
