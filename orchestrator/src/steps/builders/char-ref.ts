/**
 * `char-ref` payload builder — the frame's character reference(s) as one edit
 * source (2026-10-04). StoryStudio generates each character and sends its
 * `referenceImageUrl`; QM never makes sheets.
 *   0 characters -> skipped (`skip:` url; the t2i kind then generates the still)
 *   1 character  -> that reference, padded onto a 16:9 (9:16) grey canvas
 *   2 characters -> side-by-side composite (assets/char-ref-composite.ts)
 *   refs2 frame  -> characters[0] alone, padded the same way: reference 1 of
 *                   the MiniMax H3 shot (2026-10-17)
 * Qwen edit keeps its SOURCE's aspect, so a square sheet passed through gave a
 * square still (the 1024x1024 bug that made every character project `partial`,
 * 2026-10-05); the canvas is what makes the still the frame's aspect.
 */
import { SKIP_URL_PREFIX, type BuildContext, type PayloadBuilder } from './types';

/** The canvas a single reference is padded onto, from the project's aspect. */
export function refCanvas(aspectRatio: string | undefined): [number, number] {
  return /^9\s*:\s*16$/.test(aspectRatio ?? '') ? [720, 1280] : [1280, 720];
}

export const buildCharRefInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const refs = ctx.job.characterRefs ?? [];
  if (refs.length === 0) return { __passthroughUrl: `${SKIP_URL_PREFIX}none` };
  if (refs.length === 1 || ctx.job.shotKind === 'refs2') {
    return { refs: [refs[0]], canvas: refCanvas(ctx.job.aspectRatio), projectId: ctx.projectId, frameId: ctx.frameId ?? ctx.job.frameId };
  }
  return { refs, projectId: ctx.projectId, frameId: ctx.frameId ?? ctx.job.frameId };
};
