import {
  projectAssetLoad, frameCount, SECONDS_PER_FRAME,
  FLUX_TTS_S2T, QWEN_IMAGE_GEN, QWEN_IMAGE_EDIT, WAN2_I2V, BGM_S2T,
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
  it('splits image (i2i) / tts+merge+srt+bgm / video across three endpoints', () => {
    const load = projectAssetLoad('narration-premium', 100); // 20 frames
    expect(load.perEndpoint[QWEN_IMAGE_EDIT]).toBe(20);       // images — i2i (character reference), real usage
    expect(load.perEndpoint[QWEN_IMAGE_GEN]).toBeUndefined(); // t2i not projected — i2i is the dominant case
    expect(load.perEndpoint[FLUX_TTS_S2T]).toBe(20 * 2 + 2);  // (tts + merge)*frames + srt + bgm
    expect(load.perEndpoint[WAN2_I2V]).toBe(20);              // video
    expect(load.total).toBe(20 + 42 + 20);
    expect(load.tier).toBe('premium');
  });
});

describe('projectAssetLoad — dialogue-basic (duration-derived, no shotCounts concept)', () => {
  it('100s → 20 frames → Wan2 + qwen-image-gen scale with frames, flux-tts-s2t/bgm-s2t are fixed per-project', () => {
    const load = projectAssetLoad('dialogue-basic', 100);
    expect(load.frameCount).toBe(20);
    expect(load.perEndpoint[WAN2_I2V]).toBe(20);
    expect(load.perEndpoint[QWEN_IMAGE_GEN]).toBe(20 + 1); // t2i per frame + 1 persona
    expect(load.perEndpoint[FLUX_TTS_S2T]).toBe(2);        // per-segment TTS not modeled here — fixed per-project
    expect(load.perEndpoint[BGM_S2T]).toBe(2);             // SRT + BGM
    expect(load.tier).toBe('basic');
  });
});

describe('projectAssetLoad — dialogue-premium (shotCounts-aware)', () => {
  it('falls back to duration-derived perFrame when no shotCounts supplied', () => {
    const load = projectAssetLoad('dialogue-premium', 100); // 20 frames
    expect(load.perEndpoint[WAN2_I2V]).toBeUndefined(); // 2026-08-17: video.dialoguePremium.i2v routes to Replicate, off the RunPod fleet model
    expect(load.perEndpoint[QWEN_IMAGE_EDIT]).toBe(20);
    expect(load.perEndpoint[FLUX_TTS_S2T]).toBe(20 * 2); // perFrame only — the fixed +3 lands on BGM_S2T, not this endpoint
    expect(load.perEndpoint[BGM_S2T]).toBe(3);
    expect(load.tier).toBe('premium');
  });

  it('uses shotCounts instead of duration when supplied — Wan2 stays off the RunPod fleet model (Replicate-routed)', () => {
    // A dialogue-dense film: long duration but very few action shots — the
    // whole point of shotCounts (handoff doc §2): duration-derived estimate
    // would badly overstate demand on endpoints this tier still uses.
    const load = projectAssetLoad('dialogue-premium', 300, { total: 68, monologue: 45, dialogue: 3, action: 20 });
    expect(load.perEndpoint[WAN2_I2V]).toBeUndefined();
    expect(load.perEndpoint[QWEN_IMAGE_EDIT]).toBe(68);    // every shot gets an image
    expect(load.perEndpoint[FLUX_TTS_S2T]).toBe(45 + 3 * 2); // mono 1 turn + dialogue 2 turns (fromShotCounts REPLACES perFrame; perProject's +3 still lands on BGM_S2T)
    expect(load.perEndpoint[BGM_S2T]).toBe(3);
    expect(load.supported).toBe(true);
  });

  it('folds narration shots into TTS (1 narrator call each), same as a mono turn; video stays off Wan2 fleet capacity', () => {
    const load = projectAssetLoad('dialogue-premium', 300, { total: 26, monologue: 14, dialogue: 2, action: 8, narration: 2 });
    expect(load.perEndpoint[WAN2_I2V]).toBeUndefined();
    expect(load.perEndpoint[QWEN_IMAGE_EDIT]).toBe(26);          // every shot (incl. narration) gets an image
    expect(load.perEndpoint[FLUX_TTS_S2T]).toBe(14 + 2 * 2 + 2); // mono 1 turn + dialogue 2 turns + narration 1 call each
    expect(load.perEndpoint[BGM_S2T]).toBe(3);
    expect(load.supported).toBe(true);
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
