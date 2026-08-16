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
export const BGM_S2T = 'runpod:bgm-s2t';

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

/** Dialogue Premium's per-shot-kind breakdown (storystudio-dialogue-qm-sfn-
 * handoff.md §2/§7.2) — sent by StoryStudio precisely so admission doesn't
 * have to guess Wan2 demand from duration, which a dialogue-dense film would
 * badly overstate (§2: "a dialogue-dense film may have only 20% action shots"). */
export interface ShotCounts {
  total: number;
  monologue: number;
  dialogue: number;
  action: number;
  /** New 2026-08-16 (narration addendum) — narrator-voiced VO over a silent
   * Wan2 visual. Optional for backward compat with callers not yet sending
   * it (defaults to 0 in fromShotCounts below). */
  narration?: number;
}

interface LoadSpec {
  tier: string;
  /** counterKey → jobs generated per frame. Used when the caller has no
   * shotCounts (or the spec has no fromShotCounts estimator). */
  perFrame: Record<string, number>;
  /** counterKey → fixed jobs per project (e.g. 1 SRT + 1 BGM). Always added,
   * regardless of which per-frame/per-shot estimate was used. */
  perProject: Record<string, number>;
  /** When set and the caller supplies shotCounts, this REPLACES the
   * perFrame x frameCount(duration) estimate for the per-frame portion —
   * a shot-mix-driven job count is more accurate than a duration-derived one
   * whenever demand isn't proportional to duration (Wan2 for dialogue-premium:
   * only `action` shots use it, and the action share varies film to film). */
  fromShotCounts?: (shotCounts: ShotCounts) => Record<string, number>;
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
  // Dialogue Basic: Wan2-heavy in the same proportion as narration-premium
  // (~1 clip per 5s of output — storystudio-dialogue-qm-sfn-handoff.md §2),
  // plus a scene image per frame (qwen-image-gen — image.dialogueBasic.t2i).
  // Narrator persona (1) + per-segment TTS land on RunPod (qwen-image-gen +
  // flux-tts-s2t) and ARE counted; the narrator's InfiniteTalk lip-sync runs
  // on RunComfy, which is external/not RunPod-fleet-managed, so it
  // deliberately has no counterKey here (see fleet.ts's dialogue-basic entry
  // for the same omission on the pre-warm side). Segment count (~duration/35s)
  // isn't captured either — TTS+InfiniteTalk demand is real but off this
  // RunPod-only capacity model by design.
  'dialogue-basic': {
    tier: 'basic',
    perFrame: { [WAN2_I2V]: 1, [QWEN_IMAGE_GEN]: 1 },
    perProject: { [QWEN_IMAGE_GEN]: 1, [FLUX_TTS_S2T]: 2, [BGM_S2T]: 2 },
  },
  // Dialogue Premium: Wan2 demand is NOT derivable from duration (§2) — a
  // dialogue-dense film may be 80% monologue/dialogue shots (RunComfy, not
  // RunPod) and only 20% action (Wan2). fromShotCounts computes the accurate
  // per-endpoint estimate when the caller supplies shotCounts (§7.2); perFrame
  // below is only the fallback used when a caller has no shotCounts yet
  // (duration/5, same proportion as narration-premium — an overestimate for
  // a dialogue-heavy film, which is exactly the inaccuracy shotCounts exists
  // to fix). Every shot gets one image (mostly i2i — coverage singles anchor
  // on a character reference, §7.10.2) and roughly one TTS turn-pair;
  // monologue/dialogue lip-sync itself is RunComfy (external, no counterKey).
  // `narration` shots (2026-08-16 addendum) render a Wan2 clip identically to
  // `action` plus exactly one narrator TTS call (no lip-sync, so no RunComfy).
  'dialogue-premium': {
    tier: 'premium',
    perFrame: { [WAN2_I2V]: 1, [QWEN_IMAGE_EDIT]: 1, [FLUX_TTS_S2T]: 2 },
    perProject: { [BGM_S2T]: 3 }, // SRT + project BGM + a representative ambience-bed call
    fromShotCounts: (shotCounts) => ({
      [WAN2_I2V]: shotCounts.action + (shotCounts.narration ?? 0),
      [QWEN_IMAGE_EDIT]: shotCounts.total,
      [FLUX_TTS_S2T]: shotCounts.monologue + shotCounts.dialogue * 2 + (shotCounts.narration ?? 0), // 1 turn (mono/narration) / 2 turns (dialogue)
    }),
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
 *
 * `shotCounts` (Dialogue Premium only, storystudio-dialogue-qm-sfn-handoff.md
 * §7.2) lets a caller replace the duration-derived perFrame estimate with an
 * accurate per-shot-kind one, via the project type's `fromShotCounts` spec.
 * Every other caller/project type ignores this parameter entirely — the
 * signature stays backward compatible.
 */
export function projectAssetLoad(
  projectType: string, durationSeconds: number, shotCounts?: ShotCounts,
): AssetLoad {
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
  const perFrameEndpoint = shotCounts && spec.fromShotCounts
    ? spec.fromShotCounts(shotCounts)
    : mapValues(spec.perFrame, per => per * frames);
  for (const [ck, jobs] of Object.entries(perFrameEndpoint)) {
    perEndpoint[ck] = (perEndpoint[ck] ?? 0) + jobs;
  }
  for (const [ck, fixed] of Object.entries(spec.perProject)) {
    perEndpoint[ck] = (perEndpoint[ck] ?? 0) + fixed;
  }

  const total = Object.values(perEndpoint).reduce((a, b) => a + b, 0);
  return { projectType, tier: spec.tier, durationSeconds, frameCount: frames, perEndpoint, total, supported: true };
}

function mapValues(rec: Record<string, number>, fn: (n: number) => number): Record<string, number> {
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, fn(v)]));
}
