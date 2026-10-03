/**
 * `animate` (Ken Burns) payload builder — the QM-animate Lambda
 * (infra/docker/animate-lambda/handler.ts), 2026-10-03.
 *
 * Narration-basic's motion: the still is moved, not generated into a clip.
 * It runs per frame during generation, in Wan2's place in the chain, so a
 * Remotion overlay has a clip to draw on and every frame renders in parallel.
 *
 * Sized off TTS's ACTUAL duration, never the script estimate — the same rule
 * (and the same incident) as builders/i2v.ts: the tail merges with
 * `-shortest`, so an under-length clip clips the narration. The Lambda itself
 * rounds up to whole frames.
 */
import type { BuildContext, PayloadBuilder } from './types';

const IMAGE_EDIT_STEP_SEQ = 0;
const IMAGE_STEP_SEQ = 1;
const TTS_STEP_SEQ = 2;

export const ANIMATE_EFFECTS = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right'] as const;
export const ANIMATE_FPS = 16;

/** A frame's move when the request names none: cycled through the four by
 * narrative position, so consecutive frames never all push the same way. */
export function defaultAnimateEffect(index: number): string {
  return ANIMATE_EFFECTS[((index % ANIMATE_EFFECTS.length) + ANIMATE_EFFECTS.length) % ANIMATE_EFFECTS.length];
}

export const buildAnimateInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const imageUrl = ctx.resolvedDeps[IMAGE_EDIT_STEP_SEQ]?.url ?? ctx.resolvedDeps[IMAGE_STEP_SEQ]?.url;
  if (!imageUrl) throw new Error(`animate builder: no resolved image URL for frame ${ctx.frameId ?? '(none)'}`);
  const durationS = ctx.resolvedDeps[TTS_STEP_SEQ]?.durationS ?? ctx.job.durationS;
  if (!(typeof durationS === 'number' && durationS > 0)) {
    throw new Error(`animate builder: no narration duration for frame ${ctx.frameId ?? '(none)'}`);
  }
  const effect = (ANIMATE_EFFECTS as readonly string[]).includes(ctx.job.animateEffect ?? '') ? ctx.job.animateEffect : 'zoom_in';
  return {
    imageUrl,
    durationS,
    effect,
    fps: ANIMATE_FPS,
    projectId: ctx.projectId,
    frameId: ctx.frameId ?? ctx.job.frameId,
  };
};
