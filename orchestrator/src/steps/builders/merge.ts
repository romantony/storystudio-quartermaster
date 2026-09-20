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
 * below) or step 10 (whole concat video, downstream). When step 15 is
 * planned, its MMAudio mp4 (the same clip with SFX/ambience muxed in,
 * video stream-copied) replaces the step 14/3 clip, and `sfx_from_video`
 * tells postprod-lite to use that mp4's own audio as the SFX layer under the
 * narration — requires the 2026-09-15 postprod-lite image. The standalone
 * SFX mp3 is not used.
 *
 * Step 16 (Remotion text overlay) added 2026-09-20 for the asset pipeline's
 * new `merge` kind (assets/kinds.ts): there, `merge` can sit downstream of
 * `remotion` (assets/plan.ts's chain ends [...overlay, sfx, refine,
 * motionKind]), unlike the cohort model where remotion runs AFTER merge —
 * see steps/builders/remotion-overlay.ts's own header. No planned-but-
 * missing guard needed the way upscale/sfx above have one: the asset
 * model's handoff never runs this builder until every kind in `requires`
 * has WRITTEN a url (assets/plan.ts's `inputsSatisfied`), and the remotion
 * agent itself always completes a row — with the original clip passed
 * through unchanged when a frame has no textManifest, never left missing —
 * so resolvedDeps[16] is populated whenever remotion was planned, by the
 * time this builder can even run. Harmless no-op for the cohort model,
 * where this seq is never populated before merge.
 */
import type { BuildContext, PayloadBuilder } from './types';

const TTS_STEP_SEQ = 2;
const ANIMATION_STEP_SEQ = 3;
const UPSCALE_FRAME_STEP_SEQ = 14;
const SFX_STEP_SEQ = 15;
const REMOTION_STEP_SEQ = 16;

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
  // Same no-silent-degrade rule as upscale above, for step 15's SFX mp4.
  const sfxVideoUrl = ctx.job.sfx ? ctx.resolvedDeps[SFX_STEP_SEQ]?.url : undefined;
  if (ctx.job.sfx && !sfxVideoUrl) {
    throw new Error(`merge builder: sfx was planned but no resolved sfx video URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  // An audio-only URL here means MMAudio didn't return the muxed mp4
  // (return_video missing/ignored) — fail rather than hand ffmpeg an mp3
  // as the video input.
  if (sfxVideoUrl && /\.(mp3|wav|flac|m4a|aac)(\?|$)/i.test(sfxVideoUrl)) {
    throw new Error(`merge builder: sfx output for frame ${ctx.frameId ?? '(none)'} is audio-only (${sfxVideoUrl}), expected MMAudio's mp4`);
  }
  const videoUrl =
    ctx.resolvedDeps[REMOTION_STEP_SEQ]?.url ??
    sfxVideoUrl ??
    ctx.resolvedDeps[UPSCALE_FRAME_STEP_SEQ]?.url ??
    ctx.resolvedDeps[ANIMATION_STEP_SEQ]?.url;
  if (!videoUrl) {
    throw new Error(`merge builder: no resolved animation video URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  return {
    mode: 'merge',
    video_url: videoUrl,
    audio_url: audioUrl,
    // postprod-lite mixes the mp4's own audio under the narration at its
    // default sfx_volume 0.22 (loudness-normalized to the narration first).
    ...(sfxVideoUrl ? { sfx_from_video: true } : {}),
    ...attribution,
  };
};
