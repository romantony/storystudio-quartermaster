/**
 * `char-ref` payload builder — the frame's character reference(s) as one edit
 * source (2026-10-04). StoryStudio generates each character and sends its
 * `referenceImageUrl`; QM never makes sheets.
 *   0 characters -> skipped (`skip:` url; the t2i kind then generates the still)
 *   1 character  -> that reference, passed through
 *   2 characters -> side-by-side composite (assets/char-ref-composite.ts)
 */
import { SKIP_URL_PREFIX, type BuildContext, type PayloadBuilder } from './types';

export const buildCharRefInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const refs = ctx.job.characterRefs ?? [];
  if (refs.length === 0) return { __passthroughUrl: `${SKIP_URL_PREFIX}none` };
  if (refs.length === 1) return { __passthroughUrl: refs[0] };
  return { refs, projectId: ctx.projectId, frameId: ctx.frameId ?? ctx.job.frameId };
};
