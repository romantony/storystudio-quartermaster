/**
 * Step 7 (remove silence) payload builder. A plain per-frame step — same
 * pattern as merge.ts/i2v.ts, not a singleJobPerProject one — sitting
 * between merge (6) and concat (8): trims dead air out of each frame's
 * merged clip before they're joined, matching the real system's
 * "concat-and-trim" convention (trim happens per-clip, feeding concat, not
 * as a separate whole-video pass afterward).
 *
 * Targets postprod-lite's `remove_silence` mode
 * (orchestrator/containers/media.md): `{video_url}` -> `{video, duration_s,
 * trimmed, silence_segments_removed}`. Depends on step 6 (merge) — the
 * generator resolves that dependency's output URL into
 * `ctx.resolvedDeps[6]` before calling this builder, same mechanism i2v.ts
 * already uses for its one dependency.
 *
 * Optional (options.removeSilence) — concat's builder (concat.ts) prefers
 * this step's per-frame output when it ran, falling back to merge's
 * directly when it didn't; see concat.ts's header comment.
 */
import type { BuildContext, PayloadBuilder } from './types';

const MERGE_STEP_SEQ = 6;

export const buildRemoveSilenceInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const attribution: Record<string, unknown> = { project_id: ctx.projectId };
  if (ctx.frameId) attribution.frame_id = ctx.frameId;
  const videoUrl = ctx.resolvedDeps[MERGE_STEP_SEQ]?.url;
  if (!videoUrl) {
    throw new Error(`remove-silence builder: no resolved merge video URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  return {
    mode: 'remove_silence',
    video_url: videoUrl,
    ...attribution,
  };
};
