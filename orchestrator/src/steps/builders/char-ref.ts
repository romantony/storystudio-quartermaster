/**
 * `char-ref` payload builder — the frame's character reference(s) as one edit
 * source (2026-10-04). StoryStudio generates each character and sends its
 * `referenceImageUrl`; QM never makes sheets.
 *   0 characters -> skipped (`skip:` url; the t2i kind then generates the still)
 *   1 character  -> that reference, passed through
 *   2 characters -> side-by-side composite (assets/char-ref-composite.ts)
 *   refs2 frame  -> characters[0] alone, padded onto a 16:9 (9:16) grey canvas:
 *                   reference 1 of the MiniMax H3 shot (2026-10-17). Qwen edit
 *                   keeps its source's aspect, so a square sheet gives a square
 *                   still; the canvas is what makes the reference 16:9.
 */
import { SKIP_URL_PREFIX, type BuildContext, type PayloadBuilder } from './types';

/** The canvas a refs2 reference is padded onto, from the project's aspect. */
export function refCanvas(aspectRatio: string | undefined): [number, number] {
  return /^9\s*:\s*16$/.test(aspectRatio ?? '') ? [720, 1280] : [1280, 720];
}

export const buildCharRefInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const refs = ctx.job.characterRefs ?? [];
  if (refs.length === 0) return { __passthroughUrl: `${SKIP_URL_PREFIX}none` };
  if (ctx.job.shotKind === 'refs2') {
    return { refs: [refs[0]], canvas: refCanvas(ctx.job.aspectRatio), projectId: ctx.projectId, frameId: ctx.frameId ?? ctx.job.frameId };
  }
  if (refs.length === 1) return { __passthroughUrl: refs[0] };
  return { refs, projectId: ctx.projectId, frameId: ctx.frameId ?? ctx.job.frameId };
};
