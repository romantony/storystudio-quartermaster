/**
 * Projected asset load for a batch project — the single source of truth shared by
 * the admission gate (capacity decision) and the provisioner (worker sizing).
 *
 * Given a projectType + duration, it computes how many generation jobs will land
 * on each internal RunPod endpoint (by `counterKey`). This is deterministic so the
 * admission math and the provisioner never drift.
 *
 * Endpoint mapping (see src/catalog/background.json + docs/qm-implementation-plan.md):
 *   runpod:flux-tts-s2t   — narration-basic image/animate/merge, all TTS, SRT, BGM
 *   runpod:qwen-image-edit — narration-premium image (i2i — frames carry a character
 *                            reference image, per real usage; t2i would hit qwen-image-gen)
 *   runpod:wan2-i2v        — narration-premium video (Wan2 i2v)
 */

export const FLUX_TTS_S2T = 'runpod:flux-tts-s2t';
export const QWEN_IMAGE_GEN = 'runpod:qwen-image-gen';
export const QWEN_IMAGE_EDIT = 'runpod:qwen-image-edit';
export const WAN2_I2V = 'runpod:wan2-i2v';

/**
 * Seconds of finished video per generated frame (capacity estimate — the real
 * frame count comes from the storyboard, unknown at admission time). 300→60,
 * 600→120; 90→18 (~20). Tune once real storyboards are sampled.
 */
export const SECONDS_PER_FRAME = Number(process.env.SECONDS_PER_FRAME ?? 5);
const FRAME_MIN = Number(process.env.FRAME_COUNT_MIN ?? 1);
const FRAME_MAX = Number(process.env.FRAME_COUNT_MAX ?? 200);

export interface AssetLoad {
  projectType: string;
  tier: string;
  durationSeconds: number;
  frameCount: number;
  /** counterKey → projected job count for the whole project. */
  perEndpoint: Record<string, number>;
  /** Total jobs across all endpoints. */
  total: number;
  /** False when projectType is unknown (perEndpoint is then empty). */
  supported: boolean;
}

interface LoadSpec {
  tier: string;
  /** counterKey → jobs generated per frame. */
  perFrame: Record<string, number>;
  /** counterKey → fixed jobs per project (e.g. 1 SRT + 1 BGM). */
  perProject: Record<string, number>;
}

/**
 * Per-frame + per-project job counts by projectType. Kept as data (not code) so a
 * new project type or an endpoint re-architecture (e.g. splitting flux-tts-s2t) is
 * a one-line change consumed identically by admission and provisioning.
 */
const LOAD_SPECS: Record<string, LoadSpec> = {
  // Basic: image + TTS + Flux animate + Flux merge per frame, all on flux-tts-s2t,
  // plus 1 SRT + 1 BGM for the project. (90s → 20 frames → 4*20+2 = 82 jobs.)
  'narration-basic': {
    tier: 'basic',
    perFrame: { [FLUX_TTS_S2T]: 4 },
    perProject: { [FLUX_TTS_S2T]: 2 },
  },
  // Premium: image (Qwen i2i — frames carry a character reference image) + Wan2
  // i2v + TTS + a per-frame merge step (silent Wan2 video + TTS voice, on
  // flux-tts-s2t — same generic Flux-TTS-S2T merge rung narration-basic uses, via
  // the video.narrationPremium.merge alias) per frame, plus 1 SRT + 1 BGM for the
  // project. A reference-less frame would fall back to t2i (qwen-image-gen), but
  // real usage is i2i-dominant, so that's what capacity is projected against.
  'narration-premium': {
    tier: 'premium',
    perFrame: { [QWEN_IMAGE_EDIT]: 1, [FLUX_TTS_S2T]: 2, [WAN2_I2V]: 1 },
    perProject: { [FLUX_TTS_S2T]: 2 },
  },
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Frames a project generates for a given duration. */
export function frameCount(durationSeconds: number): number {
  return clamp(Math.round(durationSeconds / SECONDS_PER_FRAME), FRAME_MIN, FRAME_MAX);
}

/**
 * Project the per-endpoint job load for a project. Unknown projectTypes return
 * `supported:false` with an empty load so callers can reject/handle explicitly.
 */
export function projectAssetLoad(projectType: string, durationSeconds: number): AssetLoad {
  const key = projectType.toLowerCase();
  const spec = LOAD_SPECS[key];
  const frames = frameCount(durationSeconds);

  if (!spec) {
    return {
      projectType, tier: 'unknown', durationSeconds, frameCount: frames,
      perEndpoint: {}, total: 0, supported: false,
    };
  }

  const perEndpoint: Record<string, number> = {};
  for (const [ck, per] of Object.entries(spec.perFrame)) {
    perEndpoint[ck] = (perEndpoint[ck] ?? 0) + per * frames;
  }
  for (const [ck, fixed] of Object.entries(spec.perProject)) {
    perEndpoint[ck] = (perEndpoint[ck] ?? 0) + fixed;
  }

  const total = Object.values(perEndpoint).reduce((a, b) => a + b, 0);
  return { projectType, tier: spec.tier, durationSeconds, frameCount: frames, perEndpoint, total, supported: true };
}
