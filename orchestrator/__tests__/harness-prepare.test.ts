/**
 * Plan-time frame preparation tests (prompt harness plan §6.1-§6.2).
 * `quality/replicate` is mocked; the caller-supplied-`shot` tests never
 * call it at all (that's the point — a valid contract skips extraction).
 */
import * as replicateModule from '../src/quality/replicate';
import { prepareFrame } from '../src/harness/prepare';
import { validContract } from './helpers/harness-fixtures';

jest.mock('../src/quality/replicate', () => ({
  ...jest.requireActual('../src/quality/replicate'),
  runReplicateText: jest.fn(),
}));

const mockText = replicateModule.runReplicateText as jest.Mock;
const deps = {
  replicate: { apiToken: 't', apiBase: 'https://x', visionModel: '', visionModelFallback: '', pollIntervalMs: 1, maxPollAttempts: 1, timeoutMs: 1000 },
  extractCfg: { model: 'openai/gpt-5-mini', reasoningEffort: 'low' },
  regenerateCfg: { model: 'openai/gpt-5-mini', reasoningEffort: 'low' },
  // pool omitted: pure/dry-run — no learned-guardrail DB lookup, matching
  // the CLI/lint-dry-run use (harness/index.ts's lintRequest()).
};

beforeEach(() => jest.clearAllMocks());

describe('prepareFrame — caller-supplied shot (no LLM calls)', () => {
  it('a clean contract compiles both prompts and needs no tool call at all', async () => {
    const shot = validContract({ frameId: 'f_02' });
    const out = await prepareFrame(deps, {
      frameId: 'f_02',
      imagePrompt: 'ignored — the shot wins',
      motionPrompt: 'ignored',
      referenceImage: true,
      aspectRatio: '16:9',
      shot,
    });
    expect(out.harnessError).toBeUndefined();
    expect(out.contract).toBeDefined();
    expect(out.imagePrompt).toMatch(/alone in frame/);
    expect(out.motionPrompt.length).toBeGreaterThan(0);
    expect(out.splitShot).toBe(false);
    expect(mockText).not.toHaveBeenCalled();
  });

  it("f18's reversed contract is fixed before compiling, and produces no fallback rung (the fix is structural, not a route)", async () => {
    const shot = validContract({
      frameId: 'f_18',
      camera: { ...validContract().camera, side: 'front', move: 'tracking' },
      subjects: [{ id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera' }],
      action: { subjectId: 'maya', verb: 'walks down the stairs', screenDirection: 'away_from_camera', motionLevel: 'low', ambient: [] },
    });
    const out = await prepareFrame(deps, { frameId: 'f_18', imagePrompt: 'x', motionPrompt: 'x', referenceImage: true, shot });
    expect(out.contract.subjects[0].facing).toBe('away');
    expect(out.contract.camera.side).toBe('back');
    expect(out.contract.camera.move).toBe('static');
    expect(out.motionFallbackRung).toBeUndefined();
    expect(mockText).not.toHaveBeenCalled();
  });

  it('f13\'s hand-contact contract sets imageFallbackRung to flux-4b', async () => {
    const shot = validContract({
      frameId: 'f_13',
      camera: { ...validContract().camera, shotSize: 'close_up' },
      subjects: [{ id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera', handContact: true }],
    });
    const out = await prepareFrame(deps, { frameId: 'f_13', imagePrompt: 'x', motionPrompt: 'x', referenceImage: true, shot });
    expect(out.imageFallbackRung).toBe('flux-4b');
    expect(mockText).not.toHaveBeenCalled();
  });

  it('f20\'s state-change transformation is flagged splitShot but still produces a best-effort prompt', async () => {
    const shot = validContract({ frameId: 'f_20', transformation: 'state_change' });
    const out = await prepareFrame(deps, { frameId: 'f_20', imagePrompt: 'x', motionPrompt: 'x', referenceImage: true, shot });
    expect(out.splitShot).toBe(true);
    expect(out.contract.transformation).toBe('continuation'); // normalized for generation
    expect(out.imagePrompt.length).toBeGreaterThan(0);
  });

  it('an invalid caller-supplied shot falls back to extraction', async () => {
    mockText.mockResolvedValue(JSON.stringify(validContract({ frameId: 'f_bad' })));
    const out = await prepareFrame(deps, {
      frameId: 'f_bad',
      imagePrompt: 'a girl in a hallway',
      motionPrompt: 'she walks',
      referenceImage: false,
      shot: { not: 'a valid contract' },
    });
    expect(mockText).toHaveBeenCalledTimes(1); // extraction, not regenerate
    expect(out.contract).toBeDefined();
  });
});

describe('prepareFrame — extraction path', () => {
  it('falls back to the original prompts, unharnessed, when extraction fails', async () => {
    mockText.mockRejectedValue(new Error('Replicate down'));
    const out = await prepareFrame(deps, {
      frameId: 'f_x',
      imagePrompt: 'the original image prompt',
      motionPrompt: 'the original motion prompt',
      referenceImage: false,
    });
    expect(out.contract).toBeUndefined();
    expect(out.harnessError).toBeDefined();
    expect(out.imagePrompt).toBe('the original image prompt');
    expect(out.motionPrompt).toBe('the original motion prompt');
  });
});
