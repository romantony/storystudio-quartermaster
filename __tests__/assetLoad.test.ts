import {
  projectAssetLoad, frameCount, SECONDS_PER_FRAME,
  FLUX_TTS_S2T, QWEN_IMAGE_GEN, WAN2_I2V,
} from '../src/shared/assetLoad';

describe('frameCount', () => {
  it('scales duration by SECONDS_PER_FRAME (5): 90→18, 300→60, 600→120', () => {
    expect(SECONDS_PER_FRAME).toBe(5);
    expect(frameCount(90)).toBe(18);   // round(90/5)=18
    expect(frameCount(300)).toBe(60);
    expect(frameCount(600)).toBe(120);
  });
});

describe('projectAssetLoad — narration-basic (all on flux-tts-s2t)', () => {
  it('90s → 20 frames → 82 jobs on one endpoint', () => {
    // 90s at SECONDS_PER_FRAME=5 rounds to 18; use a duration that yields 20 frames.
    const load = projectAssetLoad('narration-basic', 100); // round(100/5)=20
    expect(load.frameCount).toBe(20);
    expect(load.supported).toBe(true);
    expect(load.perEndpoint[FLUX_TTS_S2T]).toBe(20 * 4 + 2); // 82
    expect(load.perEndpoint[QWEN_IMAGE_GEN]).toBeUndefined();
    expect(load.perEndpoint[WAN2_I2V]).toBeUndefined();
    expect(load.total).toBe(82);
    expect(load.tier).toBe('basic');
  });

  it('600s → 120 frames → 482 jobs on flux-tts-s2t', () => {
    const load = projectAssetLoad('narration-basic', 600);
    expect(load.frameCount).toBe(120);
    expect(load.perEndpoint[FLUX_TTS_S2T]).toBe(120 * 4 + 2); // 482
    expect(load.total).toBe(482);
  });
});

describe('projectAssetLoad — narration-premium (three endpoints)', () => {
  it('splits image / tts+merge+srt+bgm / video across three endpoints', () => {
    const load = projectAssetLoad('narration-premium', 100); // 20 frames
    expect(load.perEndpoint[QWEN_IMAGE_GEN]).toBe(20);        // images
    expect(load.perEndpoint[FLUX_TTS_S2T]).toBe(20 * 2 + 2);  // (tts + merge)*frames + srt + bgm
    expect(load.perEndpoint[WAN2_I2V]).toBe(20);              // video
    expect(load.total).toBe(20 + 42 + 20);
    expect(load.tier).toBe('premium');
  });
});

describe('projectAssetLoad — unknown type', () => {
  it('returns supported:false with empty load (case-insensitive lookup)', () => {
    const load = projectAssetLoad('movie-epic', 90);
    expect(load.supported).toBe(false);
    expect(load.perEndpoint).toEqual({});
    expect(load.total).toBe(0);
  });

  it('is case-insensitive on projectType', () => {
    expect(projectAssetLoad('Narration-Basic', 100).supported).toBe(true);
  });
});
