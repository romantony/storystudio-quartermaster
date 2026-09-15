/**
 * GPT-5 mini regenerate tool tests (prompt harness plan §8.3): the tool's
 * output must pass the same lint as the draft AND add no new nouns, or the
 * call is retried once, then abandoned. `runReplicateText` is mocked.
 */
import * as replicateModule from '../src/quality/replicate';
import { regeneratePrompt } from '../src/harness/tool/regenerate';
import { seedGuardrails } from '../src/harness/guardrails/store';
import { validContract } from './helpers/harness-fixtures';

jest.mock('../src/quality/replicate', () => ({
  ...jest.requireActual('../src/quality/replicate'),
  runReplicateText: jest.fn(),
}));

const mockText = replicateModule.runReplicateText as jest.Mock;
const replicateDeps = { apiToken: 't', apiBase: 'https://x', visionModel: '', visionModelFallback: '', pollIntervalMs: 1, maxPollAttempts: 1, timeoutMs: 1000 };
const cfg = { model: 'openai/gpt-5-mini', reasoningEffort: 'low' };
const IMAGE_GUARDRAILS = seedGuardrails('image', 'any');
// A realistic draft: what harness/prepare.ts would actually hand the tool —
// already lint-clean on everything EXCEPT the one violation under test
// (missing "alone in frame"). Using a throwaway draft that doesn't lead
// with shot size/angle or the reference anchor would fail the candidate on
// THOSE guardrails too, which isn't what these tests are checking.
const DRAFT = 'Medium shot at eye level, facing the camera. maya, from the reference image, sitting on the floor. Photorealistic cinematic film still, 16:9.';

beforeEach(() => jest.clearAllMocks());

describe('regeneratePrompt (image)', () => {
  it('accepts a clean candidate that fixes the violation', async () => {
    const candidate = 'Medium shot at eye level, facing the camera. one maya, alone in frame, from the reference image, sitting on the floor. Photorealistic cinematic film still, 16:9.';
    mockText.mockResolvedValue(JSON.stringify({ prompt: candidate, applied_guardrails: ['I-CNT-02'] }));
    const result = await regeneratePrompt(replicateDeps, cfg, {
      domain: 'image',
      targetProfile: 'Qwen-Image',
      contract: validContract(),
      draft: DRAFT,
      violations: [{ guardrailId: 'I-CNT-02', severity: 'fix', fixTarget: 'contract', message: 'needs "alone in frame"' }],
      guardrails: IMAGE_GUARDRAILS,
    });
    expect(result).toBe(candidate);
  });

  it('rejects a candidate that invents new detail not in the contract/draft, retries, then gives up', async () => {
    mockText.mockResolvedValue(
      JSON.stringify({ prompt: `${DRAFT} Her fingertips sink 5-8mm into the wood, hairline splits appearing.`, applied_guardrails: [] }),
    );
    const result = await regeneratePrompt(replicateDeps, cfg, {
      domain: 'image',
      targetProfile: 'Qwen-Image',
      contract: validContract(),
      draft: DRAFT,
      violations: [{ guardrailId: 'I-CNT-02', severity: 'fix', fixTarget: 'contract', message: 'needs "alone in frame"' }],
      guardrails: IMAGE_GUARDRAILS,
    });
    expect(result).toBeUndefined();
    expect(mockText).toHaveBeenCalledTimes(2); // one retry, per §8.3
  });

  it('rejects a candidate that still negates a defect ((avoid: ...))', async () => {
    mockText.mockResolvedValue(JSON.stringify({ prompt: `${DRAFT} (avoid: two right hands)`, applied_guardrails: [] }));
    const result = await regeneratePrompt(replicateDeps, cfg, {
      domain: 'image',
      targetProfile: 'Qwen-Image',
      contract: validContract(),
      draft: DRAFT,
      violations: [],
      guardrails: IMAGE_GUARDRAILS,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined (never throws) when the API call fails', async () => {
    mockText.mockRejectedValue(new Error('Replicate down'));
    const result = await regeneratePrompt(replicateDeps, cfg, {
      domain: 'image',
      targetProfile: 'Qwen-Image',
      contract: validContract(),
      draft: DRAFT,
      violations: [],
      guardrails: IMAGE_GUARDRAILS,
    });
    expect(result).toBeUndefined();
  });

  it('parses a fenced ```json block, not just a bare object', async () => {
    // Empty guardrail set: this test is about the fence-parsing mechanics,
    // not full lint compliance (covered by the other cases above).
    mockText.mockResolvedValue(`\`\`\`json\n${JSON.stringify({ prompt: DRAFT, applied_guardrails: [] })}\n\`\`\``);
    const result = await regeneratePrompt(replicateDeps, cfg, {
      domain: 'image',
      targetProfile: 'Qwen-Image',
      contract: validContract(),
      draft: DRAFT,
      violations: [],
      guardrails: [],
    });
    expect(result).toBe(DRAFT);
  });
});
