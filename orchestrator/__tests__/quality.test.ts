/**
 * Unit tests for agents/quality.ts's gateStep() — jest.mock'd repo layer
 * and Replicate transport, same convention as generator.test.ts. Exercises
 * the PASS/REWORK/exhausted/GATED branches and the loop's exit condition.
 */
import type { Pool } from 'pg';
import { gateStep, type QualityDeps } from '../src/agents/quality';
import type { CatalogEntry } from '../src/steps/catalog';
import * as qualityRepo from '../src/db/repo/quality';
import * as stepsRepo from '../src/db/repo/steps';
import * as replicateTransport from '../src/quality/replicate';

jest.mock('../src/db/repo/quality');
jest.mock('../src/db/repo/steps');
jest.mock('../src/quality/replicate');

function fakePool() {
  const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
  return { connect: jest.fn(async () => client) } as unknown as Pool;
}

const IMAGE_STEP: CatalogEntry = {
  seq: 1,
  name: 'image',
  endpointId: 'e165se4r3eo5hp',
  gate: 'image',
  dependsOn: [],
  builder: (() => ({})) as CatalogEntry['builder'],
};

const MOTION_STEP: CatalogEntry = {
  seq: 3,
  name: 'animation',
  endpointId: 'nd7wloyvj09xwy',
  gate: 'motion',
  dependsOn: [1],
  builder: (() => ({})) as CatalogEntry['builder'],
};

const UNGATED_STEP: CatalogEntry = { ...IMAGE_STEP, seq: 2, name: 'tts', gate: null };

const DEPS: QualityDeps = {
  pool: fakePool(),
  replicate: {
    apiToken: 'test',
    apiBase: 'https://api.replicate.com/v1',
    visionModel: 'google/gemini-2.5-flash',
    visionModelFallback: 'google/gemini-3-pro',
    pollIntervalMs: 1,
    maxPollAttempts: 3,
    timeoutMs: 1000,
  },
  cfg: {
    qualityGates: 'full',
    maxAttempts: 2,
    reconcileIntervalMs: 1,
    qualityVlmCostUsd: 0.002,
    qualityImagePassThreshold: 8.0,
    qualityImageReviewThreshold: 7.0,
    qualityVideoGateThreshold: 7.5,
    qualityVideoPassThreshold: 5.0,
    qualityVideoReviewThreshold: 5.0,
  },
};

function job(overrides: Partial<qualityRepo.UngatedJob> = {}): qualityRepo.UngatedJob {
  return {
    id: 1,
    projectId: 'proj_1',
    frameId: 'f_01',
    qualityAttempts: 0,
    input: { frameId: 'f_01', imagePrompt: 'a cat', motionPrompt: 'slow zoom', narration: 'x', durationS: 5 },
    output: { image_url: 'https://x/img.png' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (stepsRepo.updateStepStatus as jest.Mock).mockResolvedValue(undefined);
  (qualityRepo.getQualityGatesOption as jest.Mock).mockResolvedValue('full');
  (qualityRepo.countInFlightForGatedStep as jest.Mock).mockResolvedValue(0);
});

describe('gateStep() — image gate', () => {
  it('resolves immediately, no queries, for an ungated step (gate: null)', async () => {
    await gateStep(DEPS, 'win_test', UNGATED_STEP, 5);
    expect(qualityRepo.listUngated).not.toHaveBeenCalled();
    expect(stepsRepo.updateStepStatus).not.toHaveBeenCalled();
  });

  it('PASS verdict calls applyPass, not applyRework/applyExhausted', async () => {
    (qualityRepo.listUngated as jest.Mock).mockResolvedValueOnce([job()]).mockResolvedValue([]);
    (qualityRepo.countUngated as jest.Mock).mockResolvedValue(0);
    (replicateTransport.callVisionJson as jest.Mock).mockResolvedValue({
      scores: { prompt_alignment: 9, character_identity: 9, environment_setting: 9, composition_framing: 9, hallucination_control: 9, anatomy_correctness: 9 },
      issues: [],
      summary: 'looks good',
    });

    await gateStep(DEPS, 'win_test', IMAGE_STEP, 5);

    expect(qualityRepo.applyPass).toHaveBeenCalledTimes(1);
    expect(qualityRepo.applyRework).not.toHaveBeenCalled();
    expect(qualityRepo.applyExhausted).not.toHaveBeenCalled();
    expect(stepsRepo.updateStepStatus).toHaveBeenCalledWith(DEPS.pool, 'win_test', 1, 'gating');
  });

  it('REWORK verdict with attempts remaining calls applyRework with promptField="imagePrompt"', async () => {
    (qualityRepo.listUngated as jest.Mock).mockResolvedValueOnce([job({ qualityAttempts: 0 })]).mockResolvedValue([]);
    (qualityRepo.countUngated as jest.Mock).mockResolvedValue(0);
    (replicateTransport.callVisionJson as jest.Mock).mockResolvedValue({
      scores: { prompt_alignment: 7, character_identity: 7, environment_setting: 7, composition_framing: 7, hallucination_control: 7, anatomy_correctness: 7 },
      issues: [{ category: 'HALLUCINATION_VISUAL', priority: 'P0', description: 'extra hand' }],
      summary: 'defect found',
    });

    await gateStep(DEPS, 'win_test', IMAGE_STEP, 5);

    expect(qualityRepo.applyRework).toHaveBeenCalledTimes(1);
    const [, , opts] = (qualityRepo.applyRework as jest.Mock).mock.calls[0];
    expect(opts.promptField).toBe('imagePrompt');
    expect(opts.correctedPrompt).toContain('extra hand');
    expect(opts.rungLabel).toBe('image:prompt-correction:1');
    expect(qualityRepo.applyExhausted).not.toHaveBeenCalled();
  });

  it('at maxAttempts, a failing verdict calls applyExhausted, not applyRework', async () => {
    (qualityRepo.listUngated as jest.Mock).mockResolvedValueOnce([job({ qualityAttempts: 2 })]).mockResolvedValue([]);
    (qualityRepo.countUngated as jest.Mock).mockResolvedValue(0);
    (replicateTransport.callVisionJson as jest.Mock).mockResolvedValue({
      scores: { prompt_alignment: 2, character_identity: 2, environment_setting: 2, composition_framing: 2, hallucination_control: 2, anatomy_correctness: 2 },
      issues: [],
      summary: 'still bad',
    });

    await gateStep(DEPS, 'win_test', IMAGE_STEP, 5);

    expect(qualityRepo.applyExhausted).toHaveBeenCalledTimes(1);
    expect(qualityRepo.applyRework).not.toHaveBeenCalled();
  });

  it('a Replicate call failure does not call any apply* function (infra failure, not a verdict)', async () => {
    (qualityRepo.listUngated as jest.Mock).mockResolvedValueOnce([job()]).mockResolvedValue([]);
    (qualityRepo.countUngated as jest.Mock).mockResolvedValueOnce(1).mockResolvedValue(0);
    (replicateTransport.callVisionJson as jest.Mock).mockRejectedValue(new Error('replicate down'));

    await gateStep(DEPS, 'win_test', IMAGE_STEP, 5);

    expect(qualityRepo.applyPass).not.toHaveBeenCalled();
    expect(qualityRepo.applyRework).not.toHaveBeenCalled();
    expect(qualityRepo.applyExhausted).not.toHaveBeenCalled();
  });

  it('a missing image URL is a real FAIL verdict (not an infra failure) and consumes an attempt', async () => {
    (qualityRepo.listUngated as jest.Mock).mockResolvedValueOnce([job({ output: {} })]).mockResolvedValue([]);
    (qualityRepo.countUngated as jest.Mock).mockResolvedValue(0);

    await gateStep(DEPS, 'win_test', IMAGE_STEP, 5);

    expect(replicateTransport.callVisionJson).not.toHaveBeenCalled();
    expect(qualityRepo.applyRework).toHaveBeenCalledTimes(1); // attempts=0 < maxAttempts=2
  });

  it('loops until listUngated returns empty AND nothing is in flight', async () => {
    (qualityRepo.listUngated as jest.Mock)
      .mockResolvedValueOnce([]) // nothing ready yet
      .mockResolvedValueOnce([]) // still generating
      .mockResolvedValueOnce([]); // now done
    (qualityRepo.countUngated as jest.Mock).mockResolvedValue(0);
    (qualityRepo.countInFlightForGatedStep as jest.Mock)
      .mockResolvedValueOnce(3) // still submitted
      .mockResolvedValueOnce(1) // one left
      .mockResolvedValueOnce(0); // done

    await gateStep(DEPS, 'win_test', IMAGE_STEP, 5);

    expect(qualityRepo.listUngated).toHaveBeenCalledTimes(3);
  });
});

describe('gateStep() — motion gate', () => {
  it('GATED (image score below gate threshold) calls applyPass, not a rework', async () => {
    (qualityRepo.listUngated as jest.Mock)
      .mockResolvedValueOnce([job({ output: { video_url: 'https://x/vid.mp4' } })])
      .mockResolvedValue([]);
    (qualityRepo.countUngated as jest.Mock).mockResolvedValue(0);
    (qualityRepo.latestImageScoreForFrame as jest.Mock).mockResolvedValue(3.0); // below 7.5 gate

    await gateStep(DEPS, 'win_test', MOTION_STEP, 5);

    expect(replicateTransport.callVisionJson).not.toHaveBeenCalled();
    expect(qualityRepo.applyPass).toHaveBeenCalledTimes(1);
    const [, write] = (qualityRepo.applyPass as jest.Mock).mock.calls[0];
    expect(write.verdict).toBe('GATED');
  });

  it('with no image score yet on record, skips the job and retries next tick (no crash)', async () => {
    (qualityRepo.listUngated as jest.Mock)
      .mockResolvedValueOnce([job({ output: { video_url: 'https://x/vid.mp4' } })])
      .mockResolvedValue([]);
    (qualityRepo.countUngated as jest.Mock).mockResolvedValue(0);
    (qualityRepo.latestImageScoreForFrame as jest.Mock).mockResolvedValue(null);

    await gateStep(DEPS, 'win_test', MOTION_STEP, 5);

    expect(qualityRepo.applyPass).not.toHaveBeenCalled();
    expect(qualityRepo.applyRework).not.toHaveBeenCalled();
  });
});

describe('gateStep() — options.qualityGates', () => {
  it("'off' skips evaluation and calls applySkipped, never touches Replicate", async () => {
    (qualityRepo.listUngated as jest.Mock).mockResolvedValueOnce([job()]).mockResolvedValue([]);
    (qualityRepo.countUngated as jest.Mock).mockResolvedValue(0);
    (qualityRepo.getQualityGatesOption as jest.Mock).mockResolvedValue('off');

    await gateStep(DEPS, 'win_test', IMAGE_STEP, 5);

    expect(replicateTransport.callVisionJson).not.toHaveBeenCalled();
    expect(qualityRepo.applySkipped).toHaveBeenCalledWith(DEPS.pool, 1);
  });

  it("'image-only' skips the motion gate specifically", async () => {
    (qualityRepo.listUngated as jest.Mock)
      .mockResolvedValueOnce([job({ output: { video_url: 'https://x/vid.mp4' } })])
      .mockResolvedValue([]);
    (qualityRepo.countUngated as jest.Mock).mockResolvedValue(0);
    (qualityRepo.getQualityGatesOption as jest.Mock).mockResolvedValue('image-only');

    await gateStep(DEPS, 'win_test', MOTION_STEP, 5);

    expect(replicateTransport.callVisionJson).not.toHaveBeenCalled();
    expect(qualityRepo.applySkipped).toHaveBeenCalledWith(DEPS.pool, 1);
  });
});
