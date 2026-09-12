/**
 * Step 12 (bgm overlay) payload builder — the last step in the assembly
 * tail. Targets postprod-lite's `mix_bgm` mode
 * (orchestrator/containers/media.md): `{video_url, bgm_url, bgm_volume?}` ->
 * `{video, duration_s}`.
 *
 * Reads whichever came last in the optional post-processing chain (11 ->
 * burn captions, 10 -> upscale, 8 -> concat — same three-level fallback
 * steps/builders/caption.ts already uses, and the same reason
 * agents/planner.ts's resolveDirectDependencies() has to collapse the
 * shadowed entries out of the fan-in count: none of 11/10/8 are mutually
 * exclusive with each other), plus step 5's bgm track. dependsOn therefore
 * lists the full chain, [11, 10, 8, 5] — declaring it explicitly (not just
 * the two that usually survive) is what lets resolveDirectDependencies()
 * shadow the intermediate video steps correctly; see steps/catalog.ts.
 */
import type { BuildContext, PayloadBuilder } from './types';

const CAPTION_STEP_SEQ = 11;
const UPSCALE_STEP_SEQ = 10;
const CONCAT_STEP_SEQ = 8;
const BGM_STEP_SEQ = 5;

const BGM_VOLUME = 0.15;

export const buildBgmOverlayInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const videoUrl =
    ctx.perFrameOutputs?.[CAPTION_STEP_SEQ]?.[0] ??
    ctx.perFrameOutputs?.[UPSCALE_STEP_SEQ]?.[0] ??
    ctx.perFrameOutputs?.[CONCAT_STEP_SEQ]?.[0];
  if (!videoUrl) {
    throw new Error(`bgm-overlay builder: no resolved video URL (checked caption, upscale, concat) for project ${ctx.projectId}`);
  }
  const bgmUrl = ctx.perFrameOutputs?.[BGM_STEP_SEQ]?.[0];
  if (!bgmUrl) {
    throw new Error(`bgm-overlay builder: no resolved bgm track URL for project ${ctx.projectId}`);
  }
  return {
    mode: 'mix_bgm',
    video_url: videoUrl,
    bgm_url: bgmUrl,
    bgm_volume: BGM_VOLUME,
    project_id: ctx.projectId,
  };
};
