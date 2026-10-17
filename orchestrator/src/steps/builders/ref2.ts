/**
 * Reference 2 of a `refs2` frame (two characters, MiniMax H3; 2026-10-17):
 * the SECOND character alone, made the way the first-frame still is made.
 *   `ref2-sheet` -> characters[1]'s sheet padded onto a 16:9 (9:16) grey canvas
 *                   (in process, like char-ref)
 *   `ref2-edit`  -> a qwen-image-edit of that canvas with `secondReferencePrompt`
 *                   (carried as the row's `imagePrompt`, see assets/submit.ts)
 * Every other frame passes through with a `skip:` url so the chain stays uniform.
 */
import { refCanvas } from './char-ref';
import { SKIP_URL_PREFIX, type BuildContext, type PayloadBuilder } from './types';

export const REF2_SHEET_SEQ = 20;
export const REF2_EDIT_SEQ = 21;

export const buildRef2SheetInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  if (ctx.job.shotKind !== 'refs2') return { __passthroughUrl: `${SKIP_URL_PREFIX}none` };
  const ref = ctx.job.characterRefs?.[1];
  if (!ref) throw new Error(`ref2-sheet builder: refs2 frame ${ctx.frameId ?? '(none)'} has no second character reference`);
  return { refs: [ref], canvas: refCanvas(ctx.job.aspectRatio), projectId: ctx.projectId, frameId: ctx.frameId ?? ctx.job.frameId };
};

export const buildRef2EditInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  if (ctx.job.shotKind !== 'refs2') return { __passthroughUrl: `${SKIP_URL_PREFIX}none` };
  const sheet = ctx.resolvedDeps[REF2_SHEET_SEQ]?.url;
  if (!sheet) throw new Error(`ref2-edit builder: no padded second-character sheet for frame ${ctx.frameId ?? '(none)'}`);
  return {
    image_url: sheet,
    prompt: ctx.job.imagePrompt,
    project_id: ctx.projectId,
    // The endpoint names its output <project_id>_<frame_id>_image_edit.png;
    // reference 1 (qwen-edit) owns <frame_id> (the comfy-last overwrite lesson).
    ...(ctx.frameId ? { frame_id: `${ctx.frameId}_ref2` } : {}),
  };
};
