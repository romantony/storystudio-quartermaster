/**
 * Step 11 (burn captions) payload builder — a singleJobPerProject step, like
 * steps 8/10, reading whichever came last in the optional post-processing
 * chain: step 10's (upscale) output when options.upscale is on, falling back
 * to step 8's (concat) output when it's off — mirrors the `?? ` fallback
 * steps/builders/i2v.ts already uses for its two mutually-exclusive image
 * deps, except concat/upscale aren't mutually exclusive (concat always
 * runs), so the fan-in count itself needs collapsing too — see
 * agents/planner.ts's resolveDirectDependencies().
 *
 * Targets postprod-lite's `caption` mode (orchestrator/containers/media.md):
 * `{video_url, words_per_group, font_size, highlight_color, position}` ->
 * `{video, srt, transcript, word_count}`. The params below ARE the
 * "TikTok style" ask: short word bursts (not full sentences), bold oversized
 * text, a bright per-word highlight color, bottom-center placement — the
 * same preset this endpoint's own defaults already encode (confirmed
 * explicit here rather than relying on defaults, same lesson as the step 6
 * merge `mode` bug: never assume an endpoint's default matches intent).
 *
 * Re-runs its own baked-in Whisper pass on the concatenated audio rather
 * than consuming step 9's transcript (documented, accepted limitation —
 * containers/media.md's "Behaviour the orchestrator must account for") —
 * step 9 is not a dependency here for that reason.
 */
import type { BuildContext, PayloadBuilder } from './types';

const UPSCALE_STEP_SEQ = 10;
const CONCAT_STEP_SEQ = 8;

const WORDS_PER_GROUP = 3;
const FONT_SIZE = 64;
const HIGHLIGHT_COLOR = 'yellow';
const POSITION = 'bottom';

export const buildCaptionInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const videoUrl = ctx.perFrameOutputs?.[UPSCALE_STEP_SEQ]?.[0] ?? ctx.perFrameOutputs?.[CONCAT_STEP_SEQ]?.[0];
  if (!videoUrl) {
    throw new Error(`caption builder: no resolved video URL (checked upscale then concat) for project ${ctx.projectId}`);
  }
  return {
    mode: 'caption',
    video_url: videoUrl,
    words_per_group: WORDS_PER_GROUP,
    font_size: FONT_SIZE,
    highlight_color: HIGHLIGHT_COLOR,
    position: POSITION,
    project_id: ctx.projectId,
  };
};
