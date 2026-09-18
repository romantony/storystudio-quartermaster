/**
 * Corrective ladder tests (prompt harness plan §7.6). `quality/replicate`'s
 * `runReplicateText` is mocked so these never make a network call — the
 * ladder's fix-selection logic is what's under test, not GPT-5 mini itself
 * (harness-regenerate.test.ts covers the tool's own validation).
 */
import * as replicateModule from '../src/quality/replicate';
import { runVideoLadder } from '../src/harness/correct/video-ladder';
import { runImageLadder } from '../src/harness/correct/image-ladder';
import { seedGuardrails } from '../src/harness/guardrails/store';
import { applyEdit } from '../src/harness/correct/edits';
import { compileMotionPrompt } from '../src/harness/compile/motion';
import { seedForAttempt } from '../src/harness/profiles/inference';
import { validContract } from './helpers/harness-fixtures';

jest.mock('../src/quality/replicate', () => ({
  ...jest.requireActual('../src/quality/replicate'),
  runReplicateText: jest.fn(),
}));

const VIDEO_GUARDRAILS = seedGuardrails('video', 'wan2-lightning');
const IMAGE_GUARDRAILS = seedGuardrails('image', 'any');
const replicateDeps = { apiToken: 't', apiBase: 'https://x', visionModel: '', visionModelFallback: '', pollIntervalMs: 1, maxPollAttempts: 1, timeoutMs: 1000 };
const regenerateCfg = { model: 'openai/gpt-5-mini', reasoningEffort: 'low' };

beforeEach(() => jest.clearAllMocks());

describe('correct/edits.ts', () => {
  it('downgrade_move declines when the contract marks the move essential', () => {
    const contract = validContract({ camera: { ...validContract().camera, move: 'pedestal_up', essential: true } });
    const result = applyEdit('downgrade_move', contract, { guardrailId: '', severity: 'block', fixTarget: 'contract', message: '' }, 'wan2-lightning');
    expect(result).toBeUndefined();
  });

  it('downgrade_move downgrades when not essential', () => {
    const contract = validContract({ camera: { ...validContract().camera, move: 'pedestal_up', essential: false } });
    const result = applyEdit('downgrade_move', contract, { guardrailId: '', severity: 'block', fixTarget: 'contract', message: '' }, 'wan2-lightning');
    expect(result?.camera.move).toBe('static');
  });
});

describe('runVideoLadder', () => {
  it('f21 signature (move_not_executed) on an essential+banned move routes to Replicate instead of downgrading', async () => {
    const contract = validContract({ camera: { ...validContract().camera, move: 'pedestal_up', essential: true } });
    const currentPrompt = compileMotionPrompt(contract);
    const outcome = await runVideoLadder({
      profile: 'wan2-lightning',
      contract,
      currentPrompt,
      signature: 'video.camera.move_not_executed',
      guardrails: VIDEO_GUARDRAILS,
      regenerateDeps: replicateDeps,
      regenerateCfg,
      targetModelLabel: 'Wan 2.2 Lightning',
      triedMeasures: [],
    });
    expect(outcome.measure).toBe('route:replicate-wan22-fast');
    expect(outcome.route).toBe('replicate-wan22-fast');
    expect(outcome.contract).toBe(contract); // unchanged — routing, not editing
    expect(replicateModule.runReplicateText).not.toHaveBeenCalled(); // never needed the tool
  });

  it('f21 signature on a non-essential banned move downgrades the contract and recompiles, no tool call', async () => {
    const contract = validContract({ camera: { ...validContract().camera, move: 'pedestal_up', essential: false } });
    const currentPrompt = compileMotionPrompt(contract);
    const outcome = await runVideoLadder({
      profile: 'wan2-lightning',
      contract,
      currentPrompt,
      signature: 'video.camera.move_not_executed',
      guardrails: VIDEO_GUARDRAILS,
      regenerateDeps: replicateDeps,
      regenerateCfg,
      targetModelLabel: 'Wan 2.2 Lightning',
      triedMeasures: [],
    });
    expect(outcome.measure).toBe('contract_edit:downgrade_move');
    expect(outcome.contract.camera.move).toBe('static');
    expect(outcome.prompt).not.toBe(currentPrompt);
    expect(replicateModule.runReplicateText).not.toHaveBeenCalled();
  });

  it('once downgrade_move is in triedMeasures, the ladder falls through to route', async () => {
    const contract = validContract({ camera: { ...validContract().camera, move: 'pedestal_up', essential: false } });
    const outcome = await runVideoLadder({
      profile: 'wan2-lightning',
      contract,
      currentPrompt: 'x',
      signature: 'video.camera.move_not_executed',
      guardrails: VIDEO_GUARDRAILS,
      regenerateDeps: replicateDeps,
      regenerateCfg,
      targetModelLabel: 'Wan 2.2 Lightning',
      triedMeasures: ['contract_edit:downgrade_move'],
    });
    expect(outcome.measure).toBe('route:replicate-wan22-fast');
  });

  it('f18 signature (direction reversed) applies align_facing and flags crossDomainFixDeferred', async () => {
    const contract = validContract({
      camera: { ...validContract().camera, side: 'front' },
      subjects: [{ id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera' }],
      action: { subjectId: 'maya', verb: 'walks down the stairs', screenDirection: 'away_from_camera', motionLevel: 'low', ambient: [] },
    });
    const outcome = await runVideoLadder({
      profile: 'wan2-lightning',
      contract,
      currentPrompt: 'x',
      signature: 'video.direction.reversed',
      guardrails: VIDEO_GUARDRAILS,
      regenerateDeps: replicateDeps,
      regenerateCfg,
      targetModelLabel: 'Wan 2.2 Lightning',
      triedMeasures: [],
    });
    expect(outcome.contract.subjects[0].facing).toBe('away');
    expect(outcome.contract.camera.side).toBe('back');
    expect(outcome.crossDomainFixDeferred).toBe(true);
  });

  it('an uncovered signature with a failing tool call falls back to reseed (no crash)', async () => {
    (replicateModule.runReplicateText as jest.Mock).mockRejectedValue(new Error('network down'));
    const contract = validContract();
    const outcome = await runVideoLadder({
      profile: 'wan2-lightning',
      contract,
      currentPrompt: 'the current prompt',
      signature: 'video.uncovered.temporal_drift',
      guardrails: VIDEO_GUARDRAILS,
      regenerateDeps: replicateDeps,
      regenerateCfg,
      targetModelLabel: 'Wan 2.2 Lightning',
      triedMeasures: [],
    });
    expect(outcome.measure).toBe('reseed:uncovered');
    expect(outcome.prompt).toBe('the current prompt');
  });

  it('a reseed outcome carries the NEXT bank seed, so the retry is a different sample by construction', async () => {
    (replicateModule.runReplicateText as jest.Mock).mockRejectedValue(new Error('network down'));
    const seedKey = { projectId: 'proj_8812', frameId: 'f_001', attempt: 1 };
    const outcome = await runVideoLadder({
      profile: 'wan2-lightning',
      contract: validContract(),
      currentPrompt: 'the current prompt',
      signature: 'video.uncovered.temporal_drift',
      guardrails: VIDEO_GUARDRAILS,
      regenerateDeps: replicateDeps,
      regenerateCfg,
      targetModelLabel: 'Wan 2.2 Lightning',
      triedMeasures: [],
      seedKey,
    });
    expect(outcome.seed).toBe(seedForAttempt(seedKey.projectId, seedKey.frameId, seedKey.attempt + 1));
    expect(outcome.seed).not.toBe(seedForAttempt(seedKey.projectId, seedKey.frameId, seedKey.attempt));
  });

  it('omits the seed when no seedKey is supplied (image domain — those endpoints are unseeded here)', async () => {
    (replicateModule.runReplicateText as jest.Mock).mockRejectedValue(new Error('network down'));
    const outcome = await runVideoLadder({
      profile: 'wan2-lightning',
      contract: validContract(),
      currentPrompt: 'the current prompt',
      signature: 'video.uncovered.temporal_drift',
      guardrails: VIDEO_GUARDRAILS,
      regenerateDeps: replicateDeps,
      regenerateCfg,
      targetModelLabel: 'Wan 2.2 Lightning',
      triedMeasures: [],
    });
    expect(outcome.seed).toBeUndefined();
  });
});

describe('runImageLadder', () => {
  it('f13 signature (hand contact) routes to flux-4b', async () => {
    const contract = validContract({
      camera: { ...validContract().camera, shotSize: 'close_up' },
      subjects: [{ id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera', handContact: true }],
    });
    const outcome = await runImageLadder({
      profile: 'any',
      contract,
      currentPrompt: 'x',
      signature: 'image.anatomy.defect',
      guardrails: IMAGE_GUARDRAILS,
      regenerateDeps: replicateDeps,
      regenerateCfg,
      targetModelLabel: 'Qwen-Image-Edit',
      triedMeasures: [],
    });
    expect(outcome.measure).toBe('route:flux-4b');
    expect(outcome.route).toBe('flux-4b');
  });

  it('f12 signature (duplicate girl) via I-CNT-02 recompiles from the contract — no tool call needed', async () => {
    const contract = validContract(); // already a single character, count 1
    const outcome = await runImageLadder({
      profile: 'any',
      contract,
      currentPrompt: 'maya sitting on the floor.', // the ORIGINAL prompt never said "alone"
      signature: 'image.hallucination.duplicate_or_extra',
      guardrails: IMAGE_GUARDRAILS,
      regenerateDeps: replicateDeps,
      regenerateCfg,
      targetModelLabel: 'Qwen-Image',
      triedMeasures: [],
    });
    expect(outcome.measure).toBe('contract_edit:render_counts');
    expect(outcome.prompt).toContain('alone in frame');
    expect(replicateModule.runReplicateText).not.toHaveBeenCalled();
  });
});
