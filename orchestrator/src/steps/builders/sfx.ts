/**
 * Step 15 (per-frame SFX, MMAudio v2a) payload builder. Per frame: image ->
 * tts -> animation (3) -> upscale (14, optional) -> sfx (15) -> merge (6).
 * Reads step 14's upscaled clip when it ran, else step 3's — same
 * non-mutually-exclusive fallback as merge. MMAudio samples the video at
 * 8 fps (CLIP) / 25 fps (Synchformer) regardless of resolution, so the
 * upscaled clip isn't needed for quality; reading it just keeps the SFX
 * timed to exactly the clip merge will use.
 *
 * `prompt` is the frame's motionPrompt: MMAudio conditions on the visuals
 * already, and a scene description steers it better than nothing.
 * `negative_prompt` keeps it from generating music or voices on top of the
 * narration and BGM. Only the generated track (`audio_url`) is consumed —
 * postprod-lite's merge mixes it under the narration (builders/merge.ts).
 * No duration_s: v2a defaults to the whole video (<= 30s; clips are <= 7s).
 */
import type { BuildContext, PayloadBuilder } from './types';

const ANIMATION_STEP_SEQ = 3;
const UPSCALE_FRAME_STEP_SEQ = 14;

export const buildSfxInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const attribution: Record<string, unknown> = { project_id: ctx.projectId };
  if (ctx.frameId) attribution.frame_id = ctx.frameId;
  if (ctx.job.upscaleFrames && !ctx.resolvedDeps[UPSCALE_FRAME_STEP_SEQ]?.url) {
    throw new Error(`sfx builder: upscale was planned but no resolved upscaled video URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  const videoUrl = ctx.resolvedDeps[UPSCALE_FRAME_STEP_SEQ]?.url ?? ctx.resolvedDeps[ANIMATION_STEP_SEQ]?.url;
  if (!videoUrl) {
    throw new Error(`sfx builder: no resolved video URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  return {
    mode: 'v2a',
    video_url: videoUrl,
    prompt: ctx.job.motionPrompt ?? '',
    negative_prompt: 'music, speech, voice, singing',
    ...attribution,
  };
};
