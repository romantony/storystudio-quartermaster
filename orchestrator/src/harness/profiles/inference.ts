/**
 * Versioned INFERENCE profiles + the seed manager — the "parameter
 * controller" and "seed bank" halves of the harness. profiles/types.ts's
 * VideoProfile says what a model can be asked to DO (camera moves, motion
 * level); this says what it is RUN WITH, and pins a version id to it so a
 * finding is attributable to an exact sampler configuration.
 *
 * ── Why most of these fields are `workerPinned` and not sent ──────────────
 * The self-hosted rung is NOT "base Wan 2.2 + a Lightning LoRA at inference
 * time". It is LightX2V's already-distilled 4-step FP8 DiT pair, loaded
 * directly (romantony/storystudio-wan-i2v-4steps, endpoint nd7wloyvj09xwy,
 * model_server.py). Its sampler settings were verified against LightX2V's
 * own published wan22 configs and deliberately differ from the values a
 * generic "Wan2.2-Lightning LoRA" writeup gives:
 *
 *   shift       7.0   (480p I2V — NOT the base model's 5.0, and not the 3.0
 *                      a base-model 480p recipe recommends)
 *   guide_scale (3.5, 3.5) per DiT, with CFG DISABLED (enable_cfg=false):
 *                      the patched loop skips the unconditional branch
 *                      entirely rather than running it at weight 1.0
 *   solver      unipc (not Euler)
 *   DiT switch  at the step-index midpoint, not the base boundary=0.9
 *   LoRA        none to weight — the distillation is baked into the FP8
 *                      weights, so there is no lora_strength to set
 *
 * Sending our own values for those would silently de-calibrate a worker
 * that is already correct, so they live here as DOCUMENTATION of what the
 * clip was made with, and the payload builders send only the fields the
 * worker actually accepts (`sendable`).
 *
 * The Replicate fallback IS the non-distilled model at real CFG, so it
 * carries its own profile with its own (different, sendable) numbers.
 */

export interface InferenceProfile {
  /** Versioned id, stamped onto the job so a clip is traceable to exactly
   * this configuration. Bump the suffix when any field below changes. */
  id: string;
  /** The capability profile (profiles/types.ts) this pairs with. */
  videoProfile: string;
  resolution: '480p' | '720p';
  fps: number;
  /** Inclusive duration bounds the endpoint will accept, in whole seconds. */
  minDurationS: number;
  maxDurationS: number;
  /** Fields the payload builders actually put on the wire. */
  sendable: { sampleSteps?: number; goFast?: boolean };
  /** Fields the worker owns. Recorded, never sent — see the header. */
  workerPinned: Record<string, string | number | boolean>;
}

/** Self-hosted LightX2V 4-step distilled Wan 2.2 I2V-A14B (steps/builders/i2v.ts). */
export const WAN22_LIGHTNING_I2V_480P_V1: InferenceProfile = {
  id: 'wan22-lightning-i2v-480p-v1',
  videoProfile: 'wan2-lightning',
  resolution: '480p',
  fps: 16,
  minDurationS: 3,
  maxDurationS: 7,
  sendable: { sampleSteps: 4 },
  workerPinned: {
    shift: 7.0,
    guideScaleHighNoise: 3.5,
    guideScaleLowNoise: 3.5,
    cfgEnabled: false,
    solver: 'unipc',
    ditSwitch: 'step_index_midpoint',
    distillation: 'baked_into_fp8_weights',
    negativePromptHonored: false,
  },
};

/** Replicate `wan-video/wan-2.2-i2v-fast` (steps/builders/fallbacks.ts). */
export const REPLICATE_WAN22_FAST_480P_V1: InferenceProfile = {
  id: 'replicate-wan22-fast-480p-v1',
  videoProfile: 'replicate-wan22-fast',
  resolution: '480p',
  fps: 16,
  minDurationS: 3,
  maxDurationS: 7,
  sendable: { goFast: true },
  workerPinned: { hostedBy: 'replicate', cfgEnabled: true },
};

const INFERENCE_PROFILES: Record<string, InferenceProfile> = {
  'wan2-lightning': WAN22_LIGHTNING_I2V_480P_V1,
  'replicate-wan22-fast': REPLICATE_WAN22_FAST_480P_V1,
};

export function inferenceProfile(videoProfileName: string): InferenceProfile {
  return INFERENCE_PROFILES[videoProfileName] ?? WAN22_LIGHTNING_I2V_480P_V1;
}

// ── Seed manager ─────────────────────────────────────────────────────────
//
// A fixed seed buys REPRODUCIBILITY, not quality: a seed that is good for
// one source image is unremarkable on the next. So the bank is fixed and
// ordered, but where a frame ENTERS it is derived from the frame's own
// identity, and each corrective reseed steps one place along it.
//
// Before this existed, the worker ran seed=-1 (fresh RNG per job) and the
// ladder's `reseed` measure was a placebo: it resubmitted and hoped the
// sample landed differently, could not guarantee a DIFFERENT seed, and
// could never reproduce a good clip. Stepping the bank guarantees both.

export const SEED_BANK: readonly number[] = [42137, 78291, 16384, 55721, 93852];

/** FNV-1a 32-bit. Node's own string hashing is salted per process, which
 * would make the "same request, same seed" property hold only within a
 * single run. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The seed for one frame's Nth video attempt. Deterministic in
 * (projectId, frameId, attempt), so attempt N+1 is guaranteed to differ from
 * attempt N rather than merely likely to.
 *
 * Re-running an identical request reproduces a VISUALLY identical clip, not a
 * bit-identical one — measured live 2026-09-18 on endpoint nd7wloyvj09xwy:
 * two same-seed runs differed by at most 18/255 in any pixel (p99 = 4/255,
 * 0.012% of pixels above 8/255), while two different seeds differed by up to
 * 233/255 (p99 = 85/255, 6% of pixels above 8/255). The residue is GPU/kernel
 * nondeterminism across workers (the two runs landed on different pods), not
 * the seed failing to take. Don't build anything on byte-equality of outputs.
 */
export function seedForAttempt(projectId: string, frameId: string | null, attempt: number): number {
  const entry = fnv1a32(`${projectId}:${frameId ?? ''}`);
  return SEED_BANK[(entry + Math.max(0, attempt)) % SEED_BANK.length];
}
