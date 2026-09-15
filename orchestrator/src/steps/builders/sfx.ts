/**
 * Step 15 (per-frame SFX, MMAudio v2a) payload builder. Per frame: image ->
 * tts -> animation (3) -> upscale (14, optional) -> sfx (15) -> merge (6).
 * Reads step 14's upscaled clip when it ran, else step 3's — same
 * non-mutually-exclusive fallback as merge. MMAudio samples the video at
 * 8 fps (CLIP) / 25 fps (Synchformer) regardless of resolution, so the
 * upscaled clip isn't needed for quality; reading it just keeps the SFX
 * timed to exactly the clip merge will use.
 *
 * `return_video: true` (2026-09-15): MMAudio returns the clip with the
 * generated audio muxed in (`video_url`, video stream-copied, no re-encode),
 * and that mp4 — not the standalone `audio_url` mp3 — is what merge
 * consumes: postprod-lite lays the narration over the mp4's own audio
 * (builders/merge.ts, `sfx_from_video`). runpod/output.ts resolves
 * `video_url` ahead of `audio_url` for this output shape.
 *
 * `prompt` is a sound description: the frame's `audioPrompt` when the
 * request carries one, else one built from `imagePrompt`. Not motionPrompt —
 * that's camera direction ("slow push in"), which says nothing about sound.
 * `negative_prompt` keeps it from generating music or voices on top of the
 * narration and BGM. No duration_s: v2a defaults to the whole video (<= 30s;
 * clips are <= 7s).
 */
import type { BuildContext, PayloadBuilder } from './types';

const ANIMATION_STEP_SEQ = 3;
const UPSCALE_FRAME_STEP_SEQ = 14;

export function sfxPrompt(job: { audioPrompt?: string; imagePrompt: string }): string {
  if (job.audioPrompt?.trim()) return job.audioPrompt.trim();
  return `ambient environmental sound and sound effects of the scene: ${job.imagePrompt}`;
}

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
    prompt: sfxPrompt(ctx.job),
    negative_prompt: 'music, speech, voice, singing',
    return_video: true,
    ...attribution,
  };
};
