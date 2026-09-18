/**
 * Inference profile + seed manager (harness/profiles/inference.ts).
 *
 * The properties under test are the ones the seed bank exists to buy:
 * reproducibility across runs, and a GUARANTEED-different seed on a retry
 * rather than a hoped-for one. Before this, the worker ran seed=-1 and the
 * ladder's `reseed` measure could not promise either.
 */
import {
  SEED_BANK,
  WAN22_LIGHTNING_I2V_480P_V1,
  inferenceProfile,
  seedForAttempt,
} from '../src/harness/profiles/inference';

describe('seedForAttempt', () => {
  it('is deterministic — the same project/frame/attempt reproduces the same seed', () => {
    expect(seedForAttempt('proj_8812', 'f_001', 0)).toBe(seedForAttempt('proj_8812', 'f_001', 0));
  });

  it('always yields a seed from the bank', () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      expect(SEED_BANK).toContain(seedForAttempt('proj_8812', 'f_001', attempt));
    }
  });

  it('a retry gets a DIFFERENT seed from the attempt it follows', () => {
    for (let attempt = 0; attempt < SEED_BANK.length * 2; attempt++) {
      expect(seedForAttempt('proj_8812', 'f_001', attempt + 1)).not.toBe(seedForAttempt('proj_8812', 'f_001', attempt));
    }
  });

  it('different frames of one project do not all start on the same bank entry', () => {
    const starts = new Set(['f_001', 'f_002', 'f_003', 'f_004', 'f_005', 'f_006'].map((f) => seedForAttempt('proj_8812', f, 0)));
    expect(starts.size).toBeGreaterThan(1);
  });

  it('tolerates a null frameId (singleJobPerProject) and a negative attempt', () => {
    expect(SEED_BANK).toContain(seedForAttempt('proj_8812', null, 0));
    expect(seedForAttempt('proj_8812', 'f_001', -3)).toBe(seedForAttempt('proj_8812', 'f_001', 0));
  });
});

describe('inferenceProfile', () => {
  it('pins the LightX2V-verified sampler settings as worker-owned, NOT as fields we send', () => {
    // Guards the real trap: a generic "Wan2.2-Lightning LoRA" recipe says
    // shift 3.0 / cfg 1.0 / Euler, but this endpoint runs LightX2V's
    // distilled FP8 DiTs at shift 7.0 / guide_scale 3.5 / unipc with CFG
    // off. Sending the generic numbers would de-calibrate a correct worker.
    expect(WAN22_LIGHTNING_I2V_480P_V1.workerPinned).toMatchObject({
      shift: 7.0,
      guideScaleHighNoise: 3.5,
      guideScaleLowNoise: 3.5,
      cfgEnabled: false,
      solver: 'unipc',
    });
    expect(WAN22_LIGHTNING_I2V_480P_V1.sendable).toEqual({ sampleSteps: 4 });
  });

  it('resolves by capability-profile name and falls back to the self-hosted rung', () => {
    expect(inferenceProfile('wan2-lightning').id).toBe('wan22-lightning-i2v-480p-v1');
    expect(inferenceProfile('replicate-wan22-fast').id).toBe('replicate-wan22-fast-480p-v1');
    expect(inferenceProfile('something-unknown').id).toBe('wan22-lightning-i2v-480p-v1');
  });
});
