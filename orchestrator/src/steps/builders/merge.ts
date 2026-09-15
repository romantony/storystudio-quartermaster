/**
 * Step 6 (av merge) payload builder. Targets postprod-lite's `merge` mode
 * (orchestrator/containers/media.md): `{mode:'merge', video_url, audio_url}`
 * -> `{video, duration_s, gen_time_s}` — `mode` is required (postprod-lite
 * hosts 8 functions on one endpoint; a missing/null mode 400s with "Invalid
 * mode 'None'") and was missing here until the first real live run of this
 * step (2026-09-12) failed all 36 frames with exactly that error — M5
 * phase 1 had never actually reached step 6 live before that. Depends on
 * step 2 (tts, the audio) and
 * step 3 (animation, the video) — the generator resolves both dependencies'
 * output URLs into `ctx.resolvedDeps` before calling this builder (see
 * steps/builders/types.ts), same mechanism i2v.ts already uses for its one
 * dependency.
 *
 * No `upscale`/`upscale_target` flag on this step — upscaling is either
 * step 14 (per-frame, upstream of this step: its clip replaces step 3's
 * below) or step 10 (whole concat video, downstream). Step 15's SFX track,
 * when planned, rides along as `sfx_url` (postprod-lite mixes it under the
 * narration — requires the 2026-09-14 postprod-lite image).
 */
import type { BuildContext, PayloadBuilder } from './types';

const TTS_STEP_SEQ = 2;
const ANIMATION_STEP_SEQ = 3;
const UPSCALE_FRAME_STEP_SEQ = 14;
const SFX_STEP_SEQ = 15;

export const buildMergeInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const attribution: Record<string, unknown> = { project_id: ctx.projectId };
  if (ctx.frameId) attribution.frame_id = ctx.frameId;
  const audioUrl = ctx.resolvedDeps[TTS_STEP_SEQ]?.url;
  if (!audioUrl) {
    throw new Error(`merge builder: no resolved tts audio URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  // A failed step 14 job still decrements this job's fan-in
  // (db/repo/jobs.ts's markTerminal()), so a missing upscaled clip here
  // means that frame's upscale failed — fail the merge rather than falling
  // back to the 480p clip and silently mixing resolutions in the concat.
  if (ctx.job.upscaleFrames && !ctx.resolvedDeps[UPSCALE_FRAME_STEP_SEQ]?.url) {
    throw new Error(`merge builder: upscale was planned but no resolved upscaled video URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  const videoUrl = ctx.resolvedDeps[UPSCALE_FRAME_STEP_SEQ]?.url ?? ctx.resolvedDeps[ANIMATION_STEP_SEQ]?.url;
  if (!videoUrl) {
    throw new Error(`merge builder: no resolved animation video URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  // Same no-silent-degrade rule as upscale above, for step 15's SFX track.
  const sfxUrl = ctx.resolvedDeps[SFX_STEP_SEQ]?.url;
  if (ctx.job.sfx && !sfxUrl) {
    throw new Error(`merge builder: sfx was planned but no resolved sfx audio URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  return {
    mode: 'merge',
    video_url: videoUrl,
    audio_url: audioUrl,
    // postprod-lite mixes it under the narration at its default sfx_volume
    // 0.22 — the level set for Dialogue Basic SFX (2026-08-13).
    ...(sfxUrl ? { sfx_url: sfxUrl } : {}),
    ...attribution,
  };
};
