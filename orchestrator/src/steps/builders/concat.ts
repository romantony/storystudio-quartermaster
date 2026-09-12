/**
 * Step 8 (concat) payload builder — the first `singleJobPerProject` step
 * (steps/catalog.ts). Targets postprod-lite's `concat` mode
 * (orchestrator/containers/media.md): `{video_urls}` (≥2, ordered) ->
 * `{video, duration_s, clip_count}`.
 *
 * Unlike every other builder, this job has no single frame — its one job per
 * project depends on ALL of that project's step-6 (merge) outputs at once.
 * agents/generator.ts's resolveProjectDeps() gathers them, already ordered by
 * each frame's original narrative position, into `ctx.perFrameOutputs[6]`
 * before calling this builder (see steps/builders/types.ts). No `frame_id`
 * attribution — this output belongs to the whole project, not one frame.
 */
import type { BuildContext, PayloadBuilder } from './types';

const MERGE_STEP_SEQ = 6;

export const buildConcatInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const videoUrls = ctx.perFrameOutputs?.[MERGE_STEP_SEQ] ?? [];
  if (videoUrls.length < 2) {
    throw new Error(`concat builder: need at least 2 merged clips, got ${videoUrls.length} for project ${ctx.projectId}`);
  }
  return {
    mode: 'concat',
    video_urls: videoUrls,
    project_id: ctx.projectId,
  };
};
