/**
 * Planner pure-logic tests (impl plan §6.2): step-set resolution and the
 * endpoint-affinity `drainAfter` rule. `plan()` itself (DB-touching) is
 * covered by the repo-layer integration tests against a real Postgres, not
 * here.
 */
import { _internal, RequestSchema, plan, PlanValidationError } from '../src/agents/planner';
import { catalogEntry } from '../src/steps/catalog';
import type { NewStep } from '../src/db/repo/steps';
import type { Pool } from 'pg';

describe('resolveStepSet', () => {
  const base = {
    requestId: 'req_1',
    projectId: 'proj_1',
    source: 'mcp' as const,
    tier: 'narration-premium',
    product: 'documentary',
    language: 'en',
    aspectRatio: '9:16',
    resolution: '1080x1920',
    callbackUrl: 'https://convex.example/api/qm/result',
    options: {
      bgm: false,
      subtitles: false,
      upscale: false,
      burnCaptions: false,
      removeSilence: false,
      textOverlay: false,
      qualityGates: 'full' as const,
      referenceImage: false,
      voiceEngine: 'kokoro' as const,
      shorts: { enabled: false },
    },
    frames: [{ frameId: 'f_1', imagePrompt: 'p', narration: 'n', durationS: 5 }],
  };

  it('a plain narration request resolves to 1,2,3,6,8 — no dialogue step 4, no gated steps', () => {
    expect(_internal.resolveStepSet(base)).toEqual([1, 2, 3, 6, 8]);
  });

  it('a dialogue tier adds step 4', () => {
    expect(_internal.resolveStepSet({ ...base, tier: 'dialogue-premium' })).toEqual([1, 2, 3, 4, 6, 8]);
  });

  it('options flags add their gated steps, including 12 riding on the same bgm flag as 5', () => {
    const resolved = _internal.resolveStepSet({
      ...base,
      options: { ...base.options, bgm: true, subtitles: true, upscale: true, burnCaptions: true, shorts: { enabled: true } },
    });
    expect(resolved).toEqual([1, 2, 3, 5, 6, 8, 9, 10, 11, 12, 13]);
  });

  it('step 7 (Remotion) never appears — it stays on the existing AWS Lambda, not the orchestrator plan', () => {
    expect(_internal.resolveStepSet({ ...base, options: { ...base.options, textOverlay: true } })).not.toContain(7);
  });

  it('options.referenceImage swaps step 1 (t2i) for step 0 (image-i2i) — never both', () => {
    const resolved = _internal.resolveStepSet({ ...base, options: { ...base.options, referenceImage: true } });
    expect(resolved).toEqual([0, 2, 3, 6, 8]);
    expect(resolved).not.toContain(1);
  });
});

describe('RequestSchema', () => {
  it('accepts a well-formed §9.1 request', () => {
    const parsed = RequestSchema.safeParse({
      requestId: 'req_1',
      projectId: 'proj_1',
      source: 'mcp',
      tier: 'narration-basic',
      product: 'documentary',
      language: 'en',
      aspectRatio: '9:16',
      resolution: '1080x1920',
      callbackUrl: 'https://convex.example/api/qm/result',
      frames: [{ frameId: 'f_1', imagePrompt: 'p', narration: 'n', durationS: 5 }],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects source other than "mcp" — nothing but MCP may enter the window (spec §7.1)', () => {
    const parsed = RequestSchema.safeParse({
      requestId: 'req_1',
      projectId: 'proj_1',
      source: 'api',
      tier: 'narration-basic',
      product: 'documentary',
      language: 'en',
      aspectRatio: '9:16',
      resolution: '1080x1920',
      callbackUrl: 'https://convex.example/api/qm/result',
      frames: [{ frameId: 'f_1', imagePrompt: 'p', narration: 'n', durationS: 5 }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown top-level fields (.strict())', () => {
    const parsed = RequestSchema.safeParse({
      requestId: 'req_1',
      projectId: 'proj_1',
      source: 'mcp',
      tier: 'narration-basic',
      product: 'documentary',
      language: 'en',
      aspectRatio: '9:16',
      resolution: '1080x1920',
      callbackUrl: 'https://convex.example/api/qm/result',
      frames: [{ frameId: 'f_1', imagePrompt: 'p', narration: 'n', durationS: 5 }],
      somethingUnexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the Narration Premium fields — referenceImageUrl, referenceImage/voiceEngine options, top-level voice fields', () => {
    const parsed = RequestSchema.safeParse({
      requestId: 'req_1',
      projectId: 'proj_1',
      source: 'mcp',
      tier: 'narration-premium',
      product: 'documentary',
      language: 'en',
      aspectRatio: '16:9',
      resolution: '1920x1080',
      callbackUrl: 'https://convex.example/api/qm/result',
      options: { referenceImage: true, voiceEngine: 'qwen' },
      voiceSpeaker: 'Ryan',
      voiceInstruct: 'calm, warm documentary narrator',
      voiceLanguage: 'English',
      frames: [
        { frameId: 'f_1', imagePrompt: 'p', narration: 'n', durationS: 5, referenceImageUrl: 'https://cdn.example/ref.png' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty frames array', () => {
    const parsed = RequestSchema.safeParse({
      requestId: 'req_1',
      projectId: 'proj_1',
      source: 'mcp',
      tier: 'narration-basic',
      product: 'documentary',
      language: 'en',
      aspectRatio: '9:16',
      resolution: '1080x1920',
      callbackUrl: 'https://convex.example/api/qm/result',
      frames: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('computeDrainAfter (endpoint-affinity rule, spec §6.2)', () => {
  function step(seq: number, endpointId: string): NewStep {
    return { seq, name: `s${seq}`, endpointId, workersTarget: 25, gate: null, drainAfter: true, dependsOn: [], jobTotal: 1 };
  }

  it('collapses adjacent same-endpoint steps (no drain between them)', () => {
    const steps = [step(1, 'A'), step(2, 'B'), step(3, 'C')];
    _internal.computeDrainAfter(steps);
    // all different endpoints here -> every step drains
    expect(steps.map((s) => s.drainAfter)).toEqual([true, true, true]);
  });

  it('does not drain between two steps sharing an endpoint (media tail collapse)', () => {
    const steps = [step(8, 'media'), step(10, 'media'), step(11, 'media'), step(12, 'media')];
    _internal.computeDrainAfter(steps);
    expect(steps.map((s) => s.drainAfter)).toEqual([false, false, false, true]);
  });

  it('always drains the last step regardless of the next (there is no next)', () => {
    const steps = [step(1, 'A')];
    _internal.computeDrainAfter(steps);
    expect(steps[0].drainAfter).toBe(true);
  });
});

describe('buildStepsAndJobs (pure step/job construction — singleJobPerProject fan-in, 2026-09-12)', () => {
  const req = {
    requestId: 'req_1',
    projectId: 'proj_1',
    source: 'mcp' as const,
    tier: 'narration-premium',
    product: 'documentary',
    language: 'en',
    aspectRatio: '16:9',
    resolution: '1920x1080',
    callbackUrl: 'https://convex.example/api/qm/result',
    options: {
      bgm: false,
      subtitles: false,
      upscale: false,
      burnCaptions: false,
      removeSilence: false,
      textOverlay: false,
      qualityGates: 'full' as const,
      referenceImage: false,
      voiceEngine: 'kokoro' as const,
      shorts: { enabled: false },
    },
    frames: [
      { frameId: 'f_1', imagePrompt: 'p1', narration: 'n1', durationS: 5 },
      { frameId: 'f_2', imagePrompt: 'p2', narration: 'n2', durationS: 5 },
      { frameId: 'f_3', imagePrompt: 'p3', narration: 'n3', durationS: 5 },
    ],
  };

  const mergeEntry = catalogEntry(6)!;
  const concatEntry = catalogEntry(8)!;

  it('a per-frame step (merge) still plans one job per frame — unchanged behavior', () => {
    const { steps, jobs } = _internal.buildStepsAndJobs([mergeEntry], req, 'proj_1', 25);
    expect(steps).toEqual([
      { seq: 6, name: 'merge', endpointId: mergeEntry.endpointId, workersTarget: 25, gate: null, drainAfter: true, dependsOn: [], jobTotal: 3 },
    ]);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.frameId)).toEqual(['f_1', 'f_2', 'f_3']);
    expect(jobs.every((j) => j.depsRemaining === 0)).toBe(true); // dependsOn [2,3] both uncatalogued here, filtered out
  });

  it('a singleJobPerProject step (concat) plans exactly ONE job, frameId null, fanned in on every frame', () => {
    const { steps, jobs } = _internal.buildStepsAndJobs([mergeEntry, concatEntry], req, 'proj_1', 25);
    const concatStep = steps.find((s) => s.seq === 8)!;
    expect(concatStep.jobTotal).toBe(1);

    const concatJobs = jobs.filter((j) => j.stepSeq === 8);
    expect(concatJobs).toHaveLength(1);
    expect(concatJobs[0]).toMatchObject({ frameId: null, seq: 0, projectId: 'proj_1', depsRemaining: 3, input: {} });
  });

  it('computeDrainAfter still collapses 6->8 since both target postprod-lite', () => {
    const { steps } = _internal.buildStepsAndJobs([mergeEntry, concatEntry], req, 'proj_1', 25);
    expect(steps.map((s) => s.drainAfter)).toEqual([false, true]);
  });
});

describe('plan() — options.referenceImage validation (runs before any DB access)', () => {
  const fakePool = {} as Pool;

  it('rejects a referenceImage request where a frame has no referenceImageUrl', async () => {
    const req = {
      requestId: 'req_1',
      projectId: 'proj_1',
      source: 'mcp',
      tier: 'narration-premium',
      product: 'documentary',
      language: 'en',
      aspectRatio: '16:9',
      resolution: '1920x1080',
      callbackUrl: 'https://convex.example/api/qm/result',
      options: { referenceImage: true },
      frames: [{ frameId: 'f_1', imagePrompt: 'p', narration: 'n', durationS: 5 }],
    };
    await expect(plan(fakePool, { workersHead: 25 }, req)).rejects.toThrow(PlanValidationError);
  });
});
