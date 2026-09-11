/**
 * Step 6 (av merge) payload builder. Targets postprod-lite's `merge` mode
 * (orchestrator/containers/media.md): `{video_url, audio_url}` ->
 * `{video, duration_s, gen_time_s}`. Depends on step 2 (tts, the audio) and
 * step 3 (animation, the video) — the generator resolves both dependencies'
 * output URLs into `ctx.resolvedDeps` before calling this builder (see
 * steps/builders/types.ts), same mechanism i2v.ts already uses for its one
 * dependency.
 *
 * No `upscale`/`upscale_target` yet — that's step 10, a separate catalog
 * entry, not a flag on this one (M5 phase 1 scope: step 6 only).
 */
import type { BuildContext, PayloadBuilder } from './types';

const TTS_STEP_SEQ = 2;
const ANIMATION_STEP_SEQ = 3;

export const buildMergeInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const attribution: Record<string, unknown> = { project_id: ctx.projectId };
  if (ctx.frameId) attribution.frame_id = ctx.frameId;
  const audioUrl = ctx.resolvedDeps[TTS_STEP_SEQ]?.url;
  const videoUrl = ctx.resolvedDeps[ANIMATION_STEP_SEQ]?.url;
  if (!audioUrl) {
    throw new Error(`merge builder: no resolved tts audio URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  if (!videoUrl) {
    throw new Error(`merge builder: no resolved animation video URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  return {
    video_url: videoUrl,
    audio_url: audioUrl,
    ...attribution,
  };
};
