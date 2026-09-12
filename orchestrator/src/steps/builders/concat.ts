/**
 * Step 8 (concat) payload builder — the first `singleJobPerProject` step
 * (steps/catalog.ts). Targets postprod-lite's `concat` mode
 * (orchestrator/containers/media.md): `{video_urls}` (≥2, ordered) ->
 * `{video, duration_s, clip_count}`.
 *
 * Unlike every other builder, this job has no single frame — its one job per
 * project depends on ALL of that project's per-frame clips at once, from
 * whichever of step 7 (remove-silence, if options.removeSilence ran) or
 * step 6 (merge, always) produced them — agents/generator.ts's
 * resolveProjectDeps() gathers both into `ctx.perFrameOutputs[7]`/`[6]`
 * (empty array for whichever didn't run), already ordered by each frame's
 * original narrative position. Checked by `.length`, not `??`, since an
 * unresolved step still comes back as `[]` (truthy), not `undefined`. No
 * `frame_id` attribution — this output belongs to the whole project, not
 * one frame.
 */
import type { BuildContext, PayloadBuilder } from './types';

const REMOVE_SILENCE_STEP_SEQ = 7;
const MERGE_STEP_SEQ = 6;

export const buildConcatInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const trimmed = ctx.perFrameOutputs?.[REMOVE_SILENCE_STEP_SEQ] ?? [];
  const videoUrls = trimmed.length > 0 ? trimmed : (ctx.perFrameOutputs?.[MERGE_STEP_SEQ] ?? []);
  if (videoUrls.length < 2) {
    throw new Error(`concat builder: need at least 2 merged clips, got ${videoUrls.length} for project ${ctx.projectId}`);
  }
  return {
    mode: 'concat',
    video_urls: videoUrls,
    project_id: ctx.projectId,
  };
};
