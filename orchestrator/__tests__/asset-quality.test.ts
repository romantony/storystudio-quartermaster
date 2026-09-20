/**
 * Tests for the asset pipeline's quality gate.
 *
 * Two halves, matching the agent's own two tiers:
 *
 *   * `quality/local.ts` — the statistics are pure functions over Buffers, so
 *     they are tested on synthetic pixel data with no ffmpeg at all, and the
 *     check functions are tested against a stubbed ffmpeg transport.
 *   * `assets/quality.ts` — the verdict/correction/rework decisions, with the
 *     repo mocked.
 *
 * The defect classes asserted here are the ones this pipeline has actually
 * shipped: frozen clips, blank frames, wrong aspect ratios, clips that do not
 * match their narration.
 */
import {
  aspectOf,
  checkImageLocally,
  checkVideoLocally,
  correctionFor,
  meanFrameDelta,
  parseProbe,
  scoreLocal,
  stddev,
  DEFAULT_LOCAL_THRESHOLDS,
  type FfmpegTransport,
} from '../src/quality/local';
import { combineVerdicts, correctedInput, gateOneAsset, refreshProjectQa, runAssetQaTick, type AssetQualityDeps } from '../src/assets/quality';
import { drawFor, salienceOf, shouldSampleForVlm, weightedProbability, DEFAULT_SAMPLING } from '../src/quality/sampling';
import { compilePlan } from '../src/assets/plan';
import { RequestSchema } from '../src/agents/planner';
import type { AssetRow } from '../src/db/repo/assets';
import type { GateResult, Issue } from '../src/quality/rubric';
import * as assetsRepo from '../src/db/repo/assets';
import * as pipelineRepo from '../src/db/repo/pipeline';
import * as projectsRepo from '../src/db/repo/projects';

jest.mock('../src/db/repo/assets');
jest.mock('../src/db/repo/pipeline');
jest.mock('../src/db/repo/projects');

// ── fixtures ──────────────────────────────────────────────────────────────

const PLAN = compilePlan(
  RequestSchema.parse({
    requestId: 'req_1',
    projectId: 'proj_1',
    source: 'mcp',
    tier: 'narration-basic',
    product: 'documentary',
    language: 'en',
    aspectRatio: '9:16',
    resolution: '1080x1920',
    callbackUrl: 'https://convex.example/cb',
    options: {},
    frames: [
      { frameId: 'f1', imagePrompt: 'a lighthouse', narration: 'one', durationS: 5 },
      { frameId: 'f2', imagePrompt: 'a harbour', narration: 'two', durationS: 4 },
    ],
  }),
);

function row(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: 1,
    kind: 'qwen-image-gen',
    projectId: 'proj_1',
    frameId: 'f1',
    seq: 0,
    status: 'complete',
    endpointId: 'e',
    provider: 'runpod',
    requiredInputs: [],
    sources: {},
    input: { frameId: 'f1', imagePrompt: 'a lighthouse at dusk', narration: 'one', durationS: 5, aspectRatio: '9:16', seed: 100 },
    stage: null,
    stages: [],
    output: null,
    assetUrl: 'https://cdn/f1.png',
    durationS: null,
    error: null,
    attempts: 1,
    reworks: 0,
    qualityStatus: null,
    qualityAttempts: 0,
    qualityScore: null,
    qualityIssues: [],
    providerJobId: 'rp1',
    submittedAt: new Date(),
    completedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as AssetRow;
}

/** A raw greyscale strip of `frames` frames, each filled with `values[i]`. */
function strip(values: number[], frameBytes = 32 * 32): Buffer {
  return Buffer.concat(values.map((v) => Buffer.alloc(frameBytes, v)));
}

/** Pixel noise, so stddev is comfortably above the blank threshold. */
function noisy(bytes: number, seed = 1): Buffer {
  const b = Buffer.alloc(bytes);
  let x = seed;
  for (let i = 0; i < bytes; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b[i] = x % 256;
  }
  return b;
}

function stubFfmpeg(over: Partial<{ probe: string; raw: Buffer; throwOn: 'probe' | 'run' }> = {}): FfmpegTransport {
  return {
    async probe() {
      if (over.throwOn === 'probe') throw new Error('no such file');
      return over.probe ?? JSON.stringify({ streams: [{ width: 1080, height: 1920, duration: '5.0' }] });
    },
    async run() {
      if (over.throwOn === 'run') throw new Error('decode failed');
      return over.raw ?? noisy(32 * 32 * 3);
    },
  };
}

// ── pure statistics ───────────────────────────────────────────────────────

describe('local statistics', () => {
  it('stddev is zero for a solid frame and positive for a varied one', () => {
    expect(stddev(Buffer.alloc(1024, 17))).toBe(0);
    expect(stddev(noisy(1024))).toBeGreaterThan(20);
    expect(stddev(Buffer.alloc(0))).toBe(0);
  });

  it('meanFrameDelta is zero for a frozen clip and large for a moving one', () => {
    expect(meanFrameDelta(strip([50, 50, 50, 50]), 1024)).toBe(0);
    expect(meanFrameDelta(strip([0, 40, 80, 120]), 1024)).toBeCloseTo(40, 5);
    // A single frame has no motion to measure.
    expect(meanFrameDelta(strip([50]), 1024)).toBe(0);
  });

  it('aspectOf parses both the WxH and W:H forms', () => {
    expect(aspectOf('1080x1920')).toBeCloseTo(0.5625, 4);
    expect(aspectOf('9:16')).toBeCloseTo(0.5625, 4);
    expect(aspectOf('16:9')).toBeCloseTo(1.7778, 4);
    expect(aspectOf(undefined)).toBeNull();
    expect(aspectOf('portrait')).toBeNull();
  });

  it('parseProbe falls back to the format duration and survives junk', () => {
    expect(parseProbe(JSON.stringify({ streams: [{ width: 832, height: 464 }], format: { duration: '4.5' } }))).toEqual({
      width: 832,
      height: 464,
      durationS: 4.5,
    });
    expect(parseProbe('not json')).toEqual({ width: null, height: null, durationS: null });
  });

  it('scores a P0 down to zero and a P2 only slightly', () => {
    const issue = (priority: Issue['priority']): Issue => ({ category: 'X', priority, description: '' });
    expect(scoreLocal([])).toBe(10);
    expect(scoreLocal([issue('P0')])).toBe(0);
    expect(scoreLocal([issue('P2')])).toBe(8.5);
  });
});

// ── image checks ──────────────────────────────────────────────────────────

describe('checkImageLocally', () => {
  it('passes a well-formed image of the requested shape', async () => {
    const r = await checkImageLocally(stubFfmpeg(), 'https://cdn/f1.png', { aspectRatio: '9:16' });
    expect(r.issues).toEqual([]);
    expect(r.score).toBe(10);
    expect(r.facts).toMatchObject({ width: 1080, height: 1920 });
  });

  it('flags a blank frame as a P0 — the silent-degradation class', async () => {
    const r = await checkImageLocally(stubFfmpeg({ raw: Buffer.alloc(32 * 32 * 3, 12) }), 'https://cdn/f1.png', {});
    expect(r.issues.map((i) => i.category)).toEqual(['DEGENERATE']);
    expect(r.issues[0].priority).toBe('P0');
    expect(r.score).toBe(0);
  });

  it('flags a 16:9 image delivered against a 9:16 request', async () => {
    const wide = stubFfmpeg({ probe: JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }) });
    const r = await checkImageLocally(wide, 'https://cdn/f1.png', { aspectRatio: '9:16' });
    expect(r.issues.map((i) => i.category)).toContain('ASPECT_MISMATCH');
  });

  it('accepts a small rounding difference in dimensions', async () => {
    // 832x464 against a 16:9 request is 1.793 vs 1.778 — within tolerance.
    const ff = stubFfmpeg({ probe: JSON.stringify({ streams: [{ width: 832, height: 464 }] }) });
    const r = await checkImageLocally(ff, 'https://cdn/f1.png', { aspectRatio: '16:9' });
    expect(r.issues.map((i) => i.category)).not.toContain('ASPECT_MISMATCH');
  });

  it('reports an unreachable asset rather than throwing', async () => {
    const r = await checkImageLocally(stubFfmpeg({ throwOn: 'probe' }), 'https://cdn/gone.png', {});
    expect(r.issues[0].category).toBe('UNREACHABLE');
    expect(r.score).toBe(0);
  });

  it('flags a truncated decode', async () => {
    const r = await checkImageLocally(stubFfmpeg({ raw: noisy(100) }), 'https://cdn/f1.png', {});
    expect(r.issues.map((i) => i.category)).toEqual(['TRUNCATED']);
  });
});

// ── video checks ──────────────────────────────────────────────────────────

describe('checkVideoLocally', () => {
  const probe = JSON.stringify({ streams: [{ width: 832, height: 464, duration: '5.0' }] });

  it('passes a moving clip that matches its narration', async () => {
    const ff = stubFfmpeg({ probe, raw: Buffer.concat([noisy(1024, 1), noisy(1024, 9), noisy(1024, 77)]) });
    const r = await checkVideoLocally(ff, 'https://cdn/f1.mp4', { aspectRatio: '16:9', durationS: 5 });
    expect(r.issues).toEqual([]);
    expect(r.facts.frameDelta).toBeGreaterThan(DEFAULT_LOCAL_THRESHOLDS.minFrameDelta);
  });

  it('flags a frozen clip — the 2026-08-14 frozen-camera class', async () => {
    // Every frame identical but not blank: pretty, and completely still.
    const frame = noisy(1024, 5);
    const ff = stubFfmpeg({ probe, raw: Buffer.concat([frame, frame, frame, frame]) });
    const r = await checkVideoLocally(ff, 'https://cdn/f1.mp4', {});
    expect(r.issues.map((i) => i.category)).toEqual(['FROZEN']);
    expect(r.issues[0].priority).toBe('P0');
  });

  it('flags a blank clip before it bothers measuring motion', async () => {
    const ff = stubFfmpeg({ probe, raw: Buffer.alloc(1024 * 4, 0) });
    const r = await checkVideoLocally(ff, 'https://cdn/f1.mp4', {});
    expect(r.issues.map((i) => i.category)).toEqual(['DEGENERATE']);
  });

  it('flags a clip that does not match its narration length', async () => {
    const ff = stubFfmpeg({ probe, raw: Buffer.concat([noisy(1024, 1), noisy(1024, 9)]) });
    const r = await checkVideoLocally(ff, 'https://cdn/f1.mp4', { durationS: 12 });
    expect(r.issues.map((i) => i.category)).toContain('DURATION_MISMATCH');
  });

  it('tolerates a sub-second difference from the narration', async () => {
    const ff = stubFfmpeg({ probe, raw: Buffer.concat([noisy(1024, 1), noisy(1024, 9)]) });
    const r = await checkVideoLocally(ff, 'https://cdn/f1.mp4', { durationS: 5.4 });
    expect(r.issues.map((i) => i.category)).not.toContain('DURATION_MISMATCH');
  });

  it('flags a clip with a single decodable frame', async () => {
    const ff = stubFfmpeg({ probe, raw: noisy(1024) });
    const r = await checkVideoLocally(ff, 'https://cdn/f1.mp4', {});
    expect(r.issues.map((i) => i.category)).toEqual(['TRUNCATED']);
  });
});

// ── correction policy ─────────────────────────────────────────────────────

describe('correctionFor', () => {
  const i = (category: string): Issue => ({ category, priority: 'P0', description: '' });

  it('reseeds for a structural defect — a frozen sample is not a prompt problem', () => {
    expect(correctionFor([i('FROZEN')])).toBe('reseed');
    expect(correctionFor([i('DEGENERATE'), i('DURATION_MISMATCH')])).toBe('reseed');
  });

  it('rewrites the prompt when a VLM saw something semantic', () => {
    expect(correctionFor([i('HALLUCINATION_VISUAL')])).toBe('rewrite');
    // Mixed: anything semantic makes it a prompt problem.
    expect(correctionFor([i('FROZEN'), i('PROMPT_VISUAL_MISMATCH')])).toBe('rewrite');
  });

  it('does nothing for a defect regeneration cannot fix', () => {
    expect(correctionFor([i('ASPECT_MISMATCH')])).toBe('none');
    expect(correctionFor([])).toBe('none');
  });
});

// ── verdict combination ───────────────────────────────────────────────────

describe('combineVerdicts', () => {
  const vlm = (score: number, issues: Issue[] = []): GateResult => ({
    weightedScore: score,
    scores: {},
    issues,
    summary: '',
    passStatus: 'PASS',
  });

  it('takes the worse of the two tiers', () => {
    const v = combineVerdicts({ score: 10, issues: [], facts: {} }, vlm(4.2), 7);
    expect(v.score).toBe(4.2);
    expect(v.passStatus).toBe('REWORK');
    expect(v.tiers).toEqual({ local: 10, vlm: 4.2 });
  });

  it('rejects on a local P0 even when the VLM was delighted', () => {
    const local = { score: 0, issues: [{ category: 'DEGENERATE', priority: 'P0' as const, description: '' }], facts: {} };
    const v = combineVerdicts(local, vlm(9.8), 7);
    expect(v.passStatus).toBe('REWORK');
  });

  it('passes on the local tier alone when the VLM is not configured', () => {
    const v = combineVerdicts({ score: 10, issues: [], facts: {} }, null, 7);
    expect(v.passStatus).toBe('PASS');
    expect(v.tiers.vlm).toBeNull();
  });
});

// ── VLM sampling ──────────────────────────────────────────────────────────

describe('salienceOf', () => {
  it('reads the shot contract when the harness produced one', () => {
    const base = { action: { motionLevel: 'low', screenDirection: 'none' }, camera: { move: 'static' }, transformation: 'none' };
    expect(salienceOf({ contract: base as never })).toBe('static');
    expect(salienceOf({ contract: { ...base, action: { motionLevel: 'high', screenDirection: 'none' } } as never })).toBe('motion');
    expect(salienceOf({ contract: { ...base, transformation: 'state_change' } as never })).toBe('motion');
    // Medium motion only counts as movement-heavy with a direction or a move.
    expect(salienceOf({ contract: { ...base, action: { motionLevel: 'medium', screenDirection: 'none' } } as never })).toBe('ordinary');
    expect(salienceOf({ contract: { ...base, action: { motionLevel: 'medium', screenDirection: 'screen_left' } } as never })).toBe('motion');
  });

  it('falls back to prompt language when there is no contract', () => {
    expect(salienceOf({ motionPrompt: 'she walks toward the camera as it pushes in' })).toBe('motion');
    expect(salienceOf({ imagePrompt: 'a still portrait of a lighthouse at dusk' })).toBe('static');
    // One signal alone is not enough to call it movement-heavy.
    expect(salienceOf({ motionPrompt: 'a slow pan left' })).toBe('ordinary');
  });
});

describe('shouldSampleForVlm', () => {
  it('never samples an explainer or educational project — Remotion renders those', () => {
    for (const product of ['explainer', 'Educational', 'education']) {
      const d = shouldSampleForVlm({ projectId: 'p', frameId: 'f1', kind: 'qwen-image-gen', product });
      expect(d.sampled).toBe(false);
      expect(d.reason).toBe('remotion-product');
    }
    const overlay = shouldSampleForVlm({ projectId: 'p', frameId: 'f1', kind: 'qwen-image-gen', product: 'documentary', textOverlay: true });
    expect(overlay.sampled).toBe(false);
  });

  it('is deterministic — the same asset always gets the same decision', () => {
    const input = { projectId: 'p', frameId: 'f1', kind: 'qwen-image-gen', product: 'documentary' };
    const first = shouldSampleForVlm(input);
    for (let i = 0; i < 5; i += 1) expect(shouldSampleForVlm(input).sampled).toBe(first.sampled);
  });

  it('decides a frame\u2019s image and its clip independently', () => {
    const draws = ['qwen-image-gen', 'wan2-i2v'].map((k) => drawFor('p', 'f1', k));
    expect(draws[0]).not.toBe(draws[1]);
  });

  it('weights movement-heavy shots up and static ones down', () => {
    const motion = shouldSampleForVlm(
      { projectId: 'p', frameId: 'f1', kind: 'wan2-i2v', product: 'documentary', motionPrompt: 'she runs screen left as the camera tracks' },
    );
    const still = shouldSampleForVlm(
      { projectId: 'p', frameId: 'f1', kind: 'wan2-i2v', product: 'documentary', imagePrompt: 'a quiet empty room' },
    );
    expect(motion.salience).toBe('motion');
    expect(still.salience).toBe('static');
    // Odds-weighted, so a balanced project still averages back to the rate.
    expect(motion.probability).toBeCloseTo(0.517, 3);
    expect(still.probability).toBeCloseTo(0.146, 3);
  });

  it('lands a mixed project near the headline rate, concentrated on movement', () => {
    const frames = Array.from({ length: 300 }, (_, i) => `f${i}`);
    const decide = (frameId: string, moving: boolean) =>
      shouldSampleForVlm({
        projectId: 'p',
        frameId,
        kind: 'wan2-i2v',
        product: 'documentary',
        motionPrompt: moving ? 'she walks toward the camera, pushing in' : 'a quiet still room',
      });
    // Half movement-heavy, half static: (0.517 + 0.146) / 2 ≈ 0.33, i.e. the
    // headline 30% the config asked for.
    const sampled = frames.filter((f, i) => decide(f, i % 2 === 0).sampled).length;
    const rate = sampled / frames.length;
    expect(rate).toBeGreaterThan(0.25);
    expect(rate).toBeLessThan(0.42);

    // And the spend really is concentrated: movement-heavy frames are sampled
    // multiples more often than static ones. (Deterministic draws, so this is
    // a fixed value, not a flaky one — the expected ratio is ~3.5x and 150
    // frames per bucket lands it at ~2.7x.)
    const movingSampled = frames.filter((f, i) => i % 2 === 0 && decide(f, true).sampled).length;
    const stillSampled = frames.filter((f, i) => i % 2 === 1 && decide(f, false).sampled).length;
    expect(movingSampled).toBeGreaterThan(stillSampled * 2);
  });

  it('a rate of 0 disables the VLM tier without touching the local one', () => {
    const d = shouldSampleForVlm({ projectId: 'p', frameId: 'f1', kind: 'wan2-i2v', product: 'documentary' }, { ...DEFAULT_SAMPLING, rate: 0 });
    expect(d.sampled).toBe(false);
    expect(d.reason).toBe('rate-zero');
  });

  it('weighting is applied to the odds, so the config number means what it says', () => {
    // w = 1 is exactly the rate, whatever the rate.
    for (const rate of [0.1, 0.3, 0.9]) {
      expect(weightedProbability(rate, 1)).toBeCloseTo(rate, 10);
    }
    expect(weightedProbability(0, 5)).toBe(0);
    expect(weightedProbability(1, 0.4)).toBe(1);
  });

  it('a rate of 1 samples everything, movement or not', () => {
    const d = shouldSampleForVlm({ projectId: 'p', frameId: 'f1', kind: 'wan2-i2v', product: 'documentary', imagePrompt: 'a quiet room' }, { ...DEFAULT_SAMPLING, rate: 1 });
    expect(d.sampled).toBe(true);
  });
});

// ── the agent ─────────────────────────────────────────────────────────────

describe('gateOneAsset', () => {
  function deps(over: Partial<AssetQualityDeps> = {}): AssetQualityDeps {
    const client = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() };
    return {
      pool: { connect: jest.fn(async () => client), query: jest.fn(async () => ({ rows: [], rowCount: 0 })) } as never,
      cfg: {
        assetQa: 'local',
        assetQaBatchSize: 8,
        qualityImagePassThreshold: 8,
        qualityImageReviewThreshold: 7,
        qualityVideoPassThreshold: 5,
        qualityVideoReviewThreshold: 5,
        replicateRewriteModel: 'openai/gpt-5-mini',
        replicateRewriteReasoning: 'low',
        assetQaSampleRate: 0.3,
        assetQaMotionWeight: 2.5,
        assetQaStaticWeight: 0.4,
      } as AssetQualityDeps['cfg'],
      ffmpeg: stubFfmpeg(),
      ...over,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (assetsRepo.gateAssetPass as jest.Mock).mockResolvedValue(true);
    (assetsRepo.gateAssetSkipped as jest.Mock).mockResolvedValue(true);
    (assetsRepo.gateAssetRework as jest.Mock).mockResolvedValue(true);
    (assetsRepo.resetDescendants as jest.Mock).mockResolvedValue(1);
    (assetsRepo.projectGateState as jest.Mock).mockResolvedValue({ total: 2, judged: 2, exhausted: 0, pendingKinds: [] });
    (pipelineRepo.setProjectQa as jest.Mock).mockResolvedValue(undefined);
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue({ projectId: 'proj_1', plan: PLAN });
    (projectsRepo.getProject as jest.Mock).mockResolvedValue({ id: 'proj_1', request: { product: 'documentary' } });
  });

  it('passes a good image and releases the handoff it was holding', async () => {
    const outcome = await gateOneAsset(deps(), row(), PLAN);
    expect(outcome).toBe('pass');
    const [, , verdict, , handoffs] = (assetsRepo.gateAssetPass as jest.Mock).mock.calls[0];
    expect(verdict).toMatchObject({ status: 'pass', score: 10 });
    // The handoff deferred at completion happens here, not before.
    expect(handoffs.map((h: { kind: string }) => h.kind)).toEqual(['wan2-i2v']);
  });

  it('reworks a blank image and reseeds rather than rewriting', async () => {
    const d = deps({ ffmpeg: stubFfmpeg({ raw: Buffer.alloc(32 * 32 * 3, 7) }) });
    const outcome = await gateOneAsset(d, row(), PLAN);

    expect(outcome).toBe('rework');
    expect(assetsRepo.gateAssetPass).not.toHaveBeenCalled();
    const [, , verdict, patched] = (assetsRepo.gateAssetRework as jest.Mock).mock.calls[0];
    expect(verdict.score).toBe(0);
    // Same prompt, stepped seed — a blank sample is not a prompt problem.
    expect(patched.imagePrompt).toBe('a lighthouse at dusk');
    expect(patched.seed).toBe(101);
  });

  it('reworks a frozen clip on the motion gate', async () => {
    const frame = noisy(1024, 3);
    const d = deps({
      ffmpeg: stubFfmpeg({
        probe: JSON.stringify({ streams: [{ width: 832, height: 464, duration: '5.0' }] }),
        raw: Buffer.concat([frame, frame, frame]),
      }),
    });
    const clip = row({ kind: 'wan2-i2v', assetUrl: 'https://cdn/f1.mp4', input: { frameId: 'f1', motionPrompt: 'slow push in', aspectRatio: '16:9', durationS: 5, seed: 7 } });

    const outcome = await gateOneAsset(d, clip, PLAN);

    expect(outcome).toBe('rework');
    const [, , verdict] = (assetsRepo.gateAssetRework as jest.Mock).mock.calls[0];
    expect(verdict.issues.map((i: Issue) => i.category)).toEqual(['FROZEN']);
  });

  it('accepts a bad asset flagged once the rework budget is gone', async () => {
    const d = deps({ ffmpeg: stubFfmpeg({ raw: Buffer.alloc(32 * 32 * 3, 7) }) });
    const outcome = await gateOneAsset(d, row({ qualityAttempts: 4 }), PLAN);

    expect(outcome).toBe('exhausted');
    expect(assetsRepo.gateAssetRework).not.toHaveBeenCalled();
    const [, , verdict] = (assetsRepo.gateAssetPass as jest.Mock).mock.calls[0];
    expect(verdict.status).toBe('exhausted');
  });

  it('does not rework on an aspect mismatch alone — regenerating cannot fix it', async () => {
    const wide = stubFfmpeg({ probe: JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }) });
    const d = deps({ ffmpeg: wide });
    const outcome = await gateOneAsset(d, row(), PLAN);

    // It is still a rejection (P1 drops the score below the review threshold)
    // but the correction is a no-op, so the retry is a fresh sample, not a
    // pointless prompt rewrite.
    expect(outcome).toBe('rework');
    const [, , , patched] = (assetsRepo.gateAssetRework as jest.Mock).mock.calls[0];
    expect(patched.imagePrompt).toBe('a lighthouse at dusk');
  });

  it('resets the frame\u2019s downstream assets on rework, so the gate is not decorative', async () => {
    // QA no longer blocks the handoff, so by the time a verdict rejects this
    // image its clip may already exist — made from the rejected image.
    const d = deps({ ffmpeg: stubFfmpeg({ raw: Buffer.alloc(32 * 32 * 3, 7) }) });
    const outcome = await gateOneAsset(d, row(), PLAN);

    expect(outcome).toBe('rework');
    const [, projectId, frameId, descendants, from] = (assetsRepo.resetDescendants as jest.Mock).mock.calls[0];
    expect(projectId).toBe('proj_1');
    expect(frameId).toBe('f1');
    // The whole downstream chain for this frame, not just the direct child.
    // dreamx-refine and merge are both on by default now, between wan2-i2v
    // and postprod-lite.
    expect(descendants).toEqual(
      ['wan2-i2v', 'dreamx-refine', 'merge', 'postprod-lite'].filter((k) => PLAN.frameKinds.includes(k as never)),
    );
    expect(from).toBe('qwen-image-gen');
  });

  it('does not reset anything when the asset passes', async () => {
    await gateOneAsset(deps(), row(), PLAN);
    expect(assetsRepo.resetDescendants).not.toHaveBeenCalled();
  });

  it('releases a QA-exempt product\u2019s asset without judging it', async () => {
    const d2 = deps({ ffmpeg: stubFfmpeg({ raw: Buffer.alloc(32 * 32 * 3, 7) }) });
    // Deliberately a BLANK image: even a defect the local tier would catch is
    // not judged, because the product is not diffused.
    const outcome = await gateOneAsset(d2, row(), { ...PLAN, qaExempt: true });
    expect(outcome).toBe('pass');
    expect(assetsRepo.gateAssetSkipped).toHaveBeenCalled();
    expect(assetsRepo.gateAssetRework).not.toHaveBeenCalled();
  });

  it('releases without judging when gating is switched off', async () => {
    const d = deps({ cfg: { ...deps().cfg, assetQa: 'off' } });
    const outcome = await gateOneAsset(d, row(), PLAN);
    expect(outcome).toBe('pass');
    expect(assetsRepo.gateAssetSkipped).toHaveBeenCalled();
    expect(assetsRepo.gateAssetPass).not.toHaveBeenCalled();
  });

  it('releases an ungated kind immediately', async () => {
    const outcome = await gateOneAsset(deps(), row({ kind: 'tts', assetUrl: 'https://cdn/f1.mp3' }), PLAN);
    expect(outcome).toBe('pass');
    expect(assetsRepo.gateAssetSkipped).toHaveBeenCalled();
  });

  it('reports a race with another QA tick instead of double-handing-off', async () => {
    (assetsRepo.gateAssetPass as jest.Mock).mockResolvedValue(false);
    expect(await gateOneAsset(deps(), row(), PLAN)).toBe('raced');
  });
});

describe('correctedInput', () => {
  const baseDeps = {
    pool: {} as never,
    cfg: { replicateRewriteModel: 'm', replicateRewriteReasoning: 'low' } as AssetQualityDeps['cfg'],
  } as AssetQualityDeps;

  it('steps the seed further on each successive attempt', async () => {
    const verdict = { score: 0, issues: [{ category: 'FROZEN', priority: 'P0' as const, description: '' }], passStatus: 'REWORK' as const, tiers: { local: 0, vlm: null }, facts: {} };
    const first = await correctedInput(baseDeps, row({ qualityAttempts: 0 }), verdict, 'image');
    const second = await correctedInput(baseDeps, row({ qualityAttempts: 1 }), verdict, 'image');
    expect(first.input.seed).toBe(101);
    expect(second.input.seed).toBe(102);
  });

  it('falls back to a reseed when no rewriter is configured', async () => {
    const verdict = { score: 3, issues: [{ category: 'HALLUCINATION_VISUAL', priority: 'P0' as const, description: '' }], passStatus: 'REWORK' as const, tiers: { local: 10, vlm: 3 }, facts: {} };
    const { correction, input } = await correctedInput(baseDeps, row(), verdict, 'image');
    expect(correction).toBe('reseed-fallback');
    expect(input.imagePrompt).toBe('a lighthouse at dusk');
  });
});

describe('refreshProjectQa', () => {
  function d(over: Partial<AssetQualityDeps['cfg']> = {}): AssetQualityDeps {
    return {
      pool: { query: jest.fn(), connect: jest.fn() } as never,
      cfg: { assetQa: 'full', assetQaBatchSize: 8, ...over } as AssetQualityDeps['cfg'],
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (pipelineRepo.setProjectQa as jest.Mock).mockResolvedValue(undefined);
  });

  it('is pending while any gated asset is unjudged — the compiler must wait', async () => {
    (assetsRepo.projectGateState as jest.Mock).mockResolvedValue({ total: 4, judged: 2, exhausted: 0, pendingKinds: ['wan2-i2v'] });
    expect(await refreshProjectQa(d(), 'proj_1', PLAN)).toBe('pending');
    const [, , status, detail] = (pipelineRepo.setProjectQa as jest.Mock).mock.calls[0];
    expect(status).toBe('pending');
    expect(detail.waitingOn).toEqual(['wan2-i2v']);
  });

  it('passes once every gated asset is judged and acceptable', async () => {
    (assetsRepo.projectGateState as jest.Mock).mockResolvedValue({ total: 4, judged: 4, exhausted: 0, pendingKinds: [] });
    expect(await refreshProjectQa(d(), 'proj_1', PLAN)).toBe('passed');
  });

  it('fails the project when an asset exhausted its rework budget and still fails', async () => {
    (assetsRepo.projectGateState as jest.Mock).mockResolvedValue({ total: 4, judged: 4, exhausted: 1, pendingKinds: [] });
    expect(await refreshProjectQa(d(), 'proj_1', PLAN)).toBe('failed');
    const [, , , detail] = (pipelineRepo.setProjectQa as jest.Mock).mock.calls[0];
    expect(detail.exhausted).toBe(1);
  });

  it('bypasses an explainer or educational project without looking at any asset', async () => {
    const exempt = { ...PLAN, qaExempt: true };
    expect(await refreshProjectQa(d(), 'proj_1', exempt)).toBe('bypassed');
    // Never even queries the asset rows — there is nothing to judge.
    expect(assetsRepo.projectGateState).not.toHaveBeenCalled();
  });

  it('bypasses when gating is switched off', async () => {
    expect(await refreshProjectQa(d({ assetQa: 'off' }), 'proj_1', PLAN)).toBe('bypassed');
    expect(assetsRepo.projectGateState).not.toHaveBeenCalled();
  });

  it('bypasses when no gated asset survived generation', async () => {
    (assetsRepo.projectGateState as jest.Mock).mockResolvedValue({ total: 0, judged: 0, exhausted: 0, pendingKinds: [] });
    expect(await refreshProjectQa(d(), 'proj_1', PLAN)).toBe('bypassed');
  });

  it('re-opens a passed project when a rework leaves work unjudged again', async () => {
    (assetsRepo.projectGateState as jest.Mock).mockResolvedValue({ total: 4, judged: 4, exhausted: 0, pendingKinds: [] });
    expect(await refreshProjectQa(d(), 'proj_1', PLAN)).toBe('passed');
    // A rework cleared one verdict: recomputed from the rows, so it cannot
    // stay stale at 'passed'.
    (assetsRepo.projectGateState as jest.Mock).mockResolvedValue({ total: 4, judged: 3, exhausted: 0, pendingKinds: ['qwen-image-gen'] });
    expect(await refreshProjectQa(d(), 'proj_1', PLAN)).toBe('pending');
  });
});

describe('runAssetQaTick', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue({ projectId: 'proj_1', plan: PLAN });
    (projectsRepo.getProject as jest.Mock).mockResolvedValue({ id: 'proj_1', request: { product: 'documentary' } });
    (assetsRepo.gateAssetPass as jest.Mock).mockResolvedValue(true);
  });

  it('keeps going when one asset cannot be judged', async () => {
    (assetsRepo.listUngatedAssets as jest.Mock).mockResolvedValue([row({ id: 1 }), row({ id: 2 })]);
    const client = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() };
    let calls = 0;
    const d: AssetQualityDeps = {
      pool: { connect: jest.fn(async () => client), query: jest.fn() } as never,
      cfg: { assetQa: 'local', assetQaBatchSize: 8, qualityImageReviewThreshold: 7 } as AssetQualityDeps['cfg'],
      ffmpeg: {
        async probe() {
          calls += 1;
          if (calls === 1) throw new Error('boom');
          return JSON.stringify({ streams: [{ width: 1080, height: 1920 }] });
        },
        async run() {
          return noisy(32 * 32 * 3);
        },
      },
    };

    const summary = await runAssetQaTick(d, 'qwen-image-gen');
    // The first asset's probe failure becomes an UNREACHABLE verdict rather
    // than an exception, so both are judged.
    expect(summary.judged).toBe(2);
  });

  it('skips an asset whose project has no plan rather than crashing the queue', async () => {
    (assetsRepo.listUngatedAssets as jest.Mock).mockResolvedValue([row()]);
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(undefined);
    const d: AssetQualityDeps = {
      pool: { connect: jest.fn(), query: jest.fn() } as never,
      cfg: { assetQa: 'local', assetQaBatchSize: 8 } as AssetQualityDeps['cfg'],
      ffmpeg: stubFfmpeg(),
    };
    const summary = await runAssetQaTick(d, 'qwen-image-gen');
    expect(summary.judged).toBe(0);
  });
});
