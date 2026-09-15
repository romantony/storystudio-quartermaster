/**
 * Payload builders for the quality gate's model-switch fallbacks
 * (2026-09-15). A frame reaches these only after its QA-rewritten prompt
 * also failed on the primary model (agents/quality.ts sets
 * `job.fallbackRung`; steps/catalog.ts routes it):
 *
 *   image (steps 0/1) -> 'flux-4b': FLUX.2 klein 4B on qwen-image-gen
 *     (`model:"flux"`), with the Narration Premium reference image as
 *     `reference_images` so the character stays consistent. Verified live
 *     2026-09-15: i2i from the Maya reference, cold ~100 s.
 *   motion (step 3) -> 'replicate-wan22-fast': Replicate
 *     `wan-video/wan-2.2-i2v-fast` (non-distilled, follows the prompt better
 *     than the 4-step Lightning pod). Its 480p is 832x480, not the RunPod
 *     pod's 832x464, and replicate.delivery URLs expire — so the generator
 *     sends the result through postprod-lite `normalize` (crop to 832x464,
 *     16 fps, re-hosted on R2) before the row completes. DreamX (sr_scale
 *     2.25 -> 1856x1056) and concat (stream copy, no per-clip normalize)
 *     both need every clip identical.
 */
import type { BuildContext, PayloadBuilder } from './types';

const IMAGE_EDIT_STEP_SEQ = 0;
const IMAGE_STEP_SEQ = 1;
const TTS_STEP_SEQ = 2;

export const WAN_FALLBACK_WIDTH = 832;
export const WAN_FALLBACK_HEIGHT = 464;
export const WAN_FALLBACK_FPS = 16;

const FLUX_SIZES: Record<string, [number, number]> = {
  '16:9': [1344, 768],
  '9:16': [768, 1344],
  '1:1': [1024, 1024],
};

export const buildFluxImageInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const [width, height] = FLUX_SIZES[ctx.job.aspectRatio ?? '16:9'] ?? FLUX_SIZES['16:9'];
  return {
    model: 'flux',
    prompt: ctx.job.imagePrompt,
    ...(ctx.job.referenceImageUrl ? { reference_images: [ctx.job.referenceImageUrl] } : {}),
    width,
    height,
    project_id: ctx.projectId,
    ...(ctx.frameId ? { frame_id: ctx.frameId } : {}),
  };
};

/** Same duration rule as builders/i2v.ts (TTS length, ceil, clamped 3-7 s)
 * expressed as frames at 16 fps, then clamped to the model's 81-121 range. */
export function wanFallbackFrames(ttsDurationS: number | undefined, fallbackDurationS: number): number {
  const seconds = Math.min(7, Math.max(3, Math.ceil(ttsDurationS ?? fallbackDurationS)));
  return Math.min(121, Math.max(81, seconds * WAN_FALLBACK_FPS + 1));
}

export const buildReplicateWanInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const image = ctx.resolvedDeps[IMAGE_EDIT_STEP_SEQ]?.url ?? ctx.resolvedDeps[IMAGE_STEP_SEQ]?.url;
  if (!image) {
    throw new Error(`replicate wan fallback builder: no resolved image URL for frame ${ctx.frameId ?? '(none)'}`);
  }
  return {
    image,
    prompt: ctx.job.motionPrompt ?? '',
    resolution: '480p',
    num_frames: wanFallbackFrames(ctx.resolvedDeps[TTS_STEP_SEQ]?.durationS, ctx.job.durationS),
    frames_per_second: WAN_FALLBACK_FPS,
    go_fast: true,
  };
};

export function buildNormalizeInput(videoUrl: string, ctx: Pick<BuildContext, 'projectId' | 'frameId'>): Record<string, unknown> {
  return {
    mode: 'normalize',
    video_url: videoUrl,
    width: WAN_FALLBACK_WIDTH,
    height: WAN_FALLBACK_HEIGHT,
    fps: WAN_FALLBACK_FPS,
    project_id: ctx.projectId,
    ...(ctx.frameId ? { frame_id: ctx.frameId } : {}),
  };
}
