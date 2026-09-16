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
      promptHarness: 'off' as const,
      referenceImage: false,
      voiceEngine: 'kokoro' as const,
      upscaleEngine: 'realesrgan' as 'dreamx' | 'realesrgan',
      sfx: false,
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

  it('step 7 is NOT the spec\'s Remotion (options.textOverlay gates step 16 instead, via the existing AWS Lambda)', () => {
    const resolved = _internal.resolveStepSet({ ...base, options: { ...base.options, textOverlay: true } });
    expect(resolved).not.toContain(7);
    expect(resolved).toEqual([1, 2, 3, 6, 16, 8]);
  });

  it('options.textOverlay plans step 16 between remove-silence (7) and concat (8) when both are on', () => {
    const resolved = _internal.resolveStepSet({ ...base, options: { ...base.options, textOverlay: true, removeSilence: true } });
    expect(resolved).toEqual([1, 2, 3, 6, 7, 16, 8]);
  });

  it('step 7 (repurposed for remove-silence, 2026-09-12) appears only when options.removeSilence is true', () => {
    expect(_internal.resolveStepSet(base)).not.toContain(7);
    expect(_internal.resolveStepSet({ ...base, options: { ...base.options, removeSilence: true } })).toEqual([1, 2, 3, 6, 7, 8]);
  });

  it('options.upscale with upscaleEngine dreamx plans step 14 (per-frame DreamX), never step 10', () => {
    const resolved = _internal.resolveStepSet({ ...base, options: { ...base.options, upscale: true, upscaleEngine: 'dreamx' } });
    expect(resolved).toEqual([1, 2, 3, 6, 8, 14]);
    expect(resolved).not.toContain(10);
  });

  it('options.upscale with upscaleEngine realesrgan plans step 10, never step 14', () => {
    const resolved = _internal.resolveStepSet({ ...base, options: { ...base.options, upscale: true } });
    expect(resolved).toEqual([1, 2, 3, 6, 8, 10]);
  });

  it('upscaleEngine alone (upscale false) plans neither upscale step', () => {
    const resolved = _internal.resolveStepSet({ ...base, options: { ...base.options, upscaleEngine: 'dreamx' } });
    expect(resolved).toEqual([1, 2, 3, 6, 8]);
  });

  it('options.sfx plans step 15 (MMAudio), alone or after step 14', () => {
    expect(_internal.resolveStepSet({ ...base, options: { ...base.options, sfx: true } })).toEqual([1, 2, 3, 6, 8, 15]);
    expect(
      _internal.resolveStepSet({ ...base, options: { ...base.options, sfx: true, upscale: true, upscaleEngine: 'dreamx' } }),
    ).toEqual([1, 2, 3, 6, 8, 14, 15]);
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

  it('accepts a top-level bgmPrompt (options.bgm — step 5/12)', () => {
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
      options: { bgm: true },
      bgmPrompt: 'cinematic orchestral, warm and reflective, no vocals',
      frames: [{ frameId: 'f_1', imagePrompt: 'p', narration: 'n', durationS: 5 }],
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
      promptHarness: 'off' as const,
      referenceImage: false,
      voiceEngine: 'kokoro' as const,
      upscaleEngine: 'realesrgan' as 'dreamx' | 'realesrgan',
      sfx: false,
      shorts: { enabled: false },
    },
    frames: [
      { frameId: 'f_1', imagePrompt: 'p1', narration: 'n1', durationS: 5 },
      { frameId: 'f_2', imagePrompt: 'p2', narration: 'n2', durationS: 5 },
      { frameId: 'f_3', imagePrompt: 'p3', narration: 'n3', durationS: 5 },
    ],
  };

  const bgmEntry = catalogEntry(5)!;
  const mergeEntry = catalogEntry(6)!;
  const removeSilenceEntry = catalogEntry(7)!;
  const remotionEntry = catalogEntry(16)!;
  const concatEntry = catalogEntry(8)!;
  const upscaleEntry = catalogEntry(10)!;
  const captionEntry = catalogEntry(11)!;
  const bgmOverlayEntry = catalogEntry(12)!;

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

  it('remove-silence (7, per-frame, NOT singleJobPerProject) plans one job per frame, and concat (dependsOn:[7,6]) collapses to [7] when it ran', () => {
    const { steps, jobs } = _internal.buildStepsAndJobs([mergeEntry, removeSilenceEntry, concatEntry], req, 'proj_1', 25);
    const removeSilenceStep = steps.find((s) => s.seq === 7)!;
    expect(removeSilenceStep.jobTotal).toBe(3); // per-frame, unlike every singleJobPerProject step added this session
    expect(jobs.filter((j) => j.stepSeq === 7)).toHaveLength(3);

    const concatStep = steps.find((s) => s.seq === 8)!;
    // Without the collapse this would be [7,6]; 6 is shadowed since 7
    // already depends on it.
    expect(concatStep.dependsOn).toEqual([7]);
    const concatJobs = jobs.filter((j) => j.stepSeq === 8);
    // Still 3 (frames.length), not double-counted — both 7 and 6 are
    // per-frame producers, so only ONE of them should ever be counted.
    expect(concatJobs[0].depsRemaining).toBe(3);
  });

  it('concat depends only on step 6 when remove-silence did not run (7 uncatalogued for this request)', () => {
    const { steps } = _internal.buildStepsAndJobs([mergeEntry, concatEntry], req, 'proj_1', 25);
    const concatStep = steps.find((s) => s.seq === 8)!;
    expect(concatStep.dependsOn).toEqual([6]);
  });

  it('step 16 (text overlay, per-frame, source lambda) plans one job per frame, and concat (dependsOn:[16,7,6]) collapses to [16] when the whole chain ran', () => {
    const { steps, jobs } = _internal.buildStepsAndJobs([mergeEntry, removeSilenceEntry, remotionEntry, concatEntry], req, 'proj_1', 25);
    const remotionStep = steps.find((s) => s.seq === 16)!;
    expect(remotionStep.jobTotal).toBe(3); // per-frame, like remove-silence
    expect(jobs.filter((j) => j.stepSeq === 16)).toHaveLength(3);

    const concatStep = steps.find((s) => s.seq === 8)!;
    // Without the collapse this would be [16,7,6]; both 7 and 6 are shadowed
    // since 16 already (transitively, via its own dependsOn) covers them.
    expect(concatStep.dependsOn).toEqual([16]);
    const concatJobs = jobs.filter((j) => j.stepSeq === 8);
    expect(concatJobs[0].depsRemaining).toBe(3); // not double/triple-counted
  });

  it('concat depends on [16,6] (no 7) when text overlay ran without remove-silence', () => {
    const { steps } = _internal.buildStepsAndJobs([mergeEntry, remotionEntry, concatEntry], req, 'proj_1', 25);
    const concatStep = steps.find((s) => s.seq === 8)!;
    // remotionEntry.dependsOn is [7,6]; 7 isn't catalogued here, so
    // resolveDirectDependencies only sees [6] as remotion's real dependency
    // and collapses it the same way.
    expect(concatStep.dependsOn).toEqual([16]);
  });

  it('computeDrainAfter still collapses 6->8 since both target postprod-lite', () => {
    const { steps } = _internal.buildStepsAndJobs([mergeEntry, concatEntry], req, 'proj_1', 25);
    expect(steps.map((s) => s.drainAfter)).toEqual([false, true]);
  });

  it('a singleJobPerProject step depending on ANOTHER singleJobPerProject step fans in on 1, not frames.length (step 10/upscale <- step 8/concat)', () => {
    const { steps, jobs } = _internal.buildStepsAndJobs([mergeEntry, concatEntry, upscaleEntry], req, 'proj_1', 25);
    const upscaleStep = steps.find((s) => s.seq === 10)!;
    expect(upscaleStep.jobTotal).toBe(1);

    const upscaleJobs = jobs.filter((j) => j.stepSeq === 10);
    expect(upscaleJobs).toHaveLength(1);
    // NOT 3 (req.frames.length) — concat only ever completes once.
    expect(upscaleJobs[0]).toMatchObject({ frameId: null, seq: 0, projectId: 'proj_1', depsRemaining: 1, input: {} });
  });

  it('burn-captions (dependsOn:[10,8]) collapses 8 out of the fan-in when 10 is also present — concat/upscale are NOT mutually exclusive like image steps 0/1', () => {
    const { steps, jobs } = _internal.buildStepsAndJobs([mergeEntry, concatEntry, upscaleEntry, captionEntry], req, 'proj_1', 25);
    const captionStep = steps.find((s) => s.seq === 11)!;
    // Without the collapse this would be [10,8]; 8 is shadowed since 10
    // already depends on it, so only 10 should remain a direct dependency.
    expect(captionStep.dependsOn).toEqual([10]);

    const captionJobs = jobs.filter((j) => j.stepSeq === 11);
    expect(captionJobs).toHaveLength(1);
    // Would be 2 (double-counting 8 and 10) without the collapse, and would
    // never reach 0 since concat's completion only decrements once.
    expect(captionJobs[0].depsRemaining).toBe(1);
  });

  it('burn-captions depends only on step 8 when upscale did not run (10 uncatalogued for this request)', () => {
    const { steps, jobs } = _internal.buildStepsAndJobs([mergeEntry, concatEntry, captionEntry], req, 'proj_1', 25);
    const captionStep = steps.find((s) => s.seq === 11)!;
    expect(captionStep.dependsOn).toEqual([8]);

    const captionJobs = jobs.filter((j) => j.stepSeq === 11);
    expect(captionJobs[0].depsRemaining).toBe(1);
  });

  it('step 5 (bgm) has dependsOn:[] so its one job is immediately claimable, and carries bgmPrompt/totalDurationS since it has no dependency output to read', () => {
    const reqWithBgm = { ...req, bgmPrompt: 'cinematic orchestral, warm and reflective, no vocals' };
    const { steps, jobs } = _internal.buildStepsAndJobs([bgmEntry], reqWithBgm, 'proj_1', 25);
    expect(steps).toEqual([
      { seq: 5, name: 'bgm', endpointId: bgmEntry.endpointId, workersTarget: 25, gate: null, drainAfter: true, dependsOn: [], jobTotal: 1 },
    ]);
    const bgmJobs = jobs.filter((j) => j.stepSeq === 5);
    expect(bgmJobs).toHaveLength(1);
    expect(bgmJobs[0]).toMatchObject({
      frameId: null,
      depsRemaining: 0,
      input: { bgmPrompt: 'cinematic orchestral, warm and reflective, no vocals', totalDurationS: 15 }, // 3 frames x 5s
    });
  });

  it('step 12 (bgm-overlay, dependsOn:[11,10,8,5]) collapses down to [11,5] when the whole chain is present — 11 already covers 10 and 8', () => {
    const { steps, jobs } = _internal.buildStepsAndJobs(
      [bgmEntry, mergeEntry, concatEntry, upscaleEntry, captionEntry, bgmOverlayEntry],
      req,
      'proj_1',
      25,
    );
    const overlayStep = steps.find((s) => s.seq === 12)!;
    expect(overlayStep.dependsOn).toEqual([11, 5]);

    const overlayJobs = jobs.filter((j) => j.stepSeq === 12);
    expect(overlayJobs).toHaveLength(1);
    // Would be 4 (double/triple-counting 8, 10, and 11) without the collapse.
    expect(overlayJobs[0].depsRemaining).toBe(2);
  });

  it('step 12 (bgm-overlay) depends on [8,5] when only concat and bgm ran (no upscale, no captions)', () => {
    const { steps, jobs } = _internal.buildStepsAndJobs([bgmEntry, mergeEntry, concatEntry, bgmOverlayEntry], req, 'proj_1', 25);
    const overlayStep = steps.find((s) => s.seq === 12)!;
    expect(overlayStep.dependsOn).toEqual([8, 5]);

    const overlayJobs = jobs.filter((j) => j.stepSeq === 12);
    expect(overlayJobs[0].depsRemaining).toBe(2);
  });

  describe('step 15 (per-frame MMAudio SFX)', () => {
    const ttsEntry = catalogEntry(2)!;
    const animationEntry = catalogEntry(3)!;
    const upscaleFrameEntry = catalogEntry(14)!;
    const sfxEntry = catalogEntry(15)!;

    it('is bulk, capped at 4 workers, and depends on 14 when upscale is planned (3 collapsed)', () => {
      const { steps } = _internal.buildStepsAndJobs([animationEntry, upscaleFrameEntry, sfxEntry], req, 'proj_1', 25);
      expect(sfxEntry.scope).toBe('bulk');
      expect(steps.find((s) => s.seq === 15)).toMatchObject({ workersTarget: 4, dependsOn: [14], jobTotal: 3 });
    });

    it('depends on 3 directly when upscale is not planned', () => {
      const { steps } = _internal.buildStepsAndJobs([animationEntry, sfxEntry], req, 'proj_1', 25);
      expect(steps.find((s) => s.seq === 15)!.dependsOn).toEqual([3]);
    });

    it('carries each frame\'s optional audioPrompt onto its jobs, and the schema accepts it', () => {
      const withAudio = {
        ...req,
        frames: [{ ...req.frames[0], audioPrompt: 'rain on a tin roof' }, req.frames[1], req.frames[2]],
      };
      expect(RequestSchema.safeParse(withAudio).success).toBe(true);
      const { jobs } = _internal.buildStepsAndJobs([animationEntry, sfxEntry], withAudio, 'proj_1', 25);
      const sfxJobs = jobs.filter((j) => j.stepSeq === 15);
      expect((sfxJobs[0].input as { audioPrompt?: string }).audioPrompt).toBe('rain on a tin roof');
      expect((sfxJobs[1].input as { audioPrompt?: string }).audioPrompt).toBeUndefined();
    });

    it('merge fans in on [15] alone for the full chain, and every merge job carries sfx + upscaleFrames', () => {
      const { steps, jobs } = _internal.buildStepsAndJobs(
        [ttsEntry, animationEntry, mergeEntry, upscaleFrameEntry, sfxEntry],
        req,
        'proj_1',
        25,
      );
      expect(steps.find((s) => s.seq === 6)!.dependsOn).toEqual([15]);
      const mergeJobs = jobs.filter((j) => j.stepSeq === 6);
      expect(mergeJobs.every((j) => j.depsRemaining === 1)).toBe(true);
      expect(mergeJobs.every((j) => (j.input as { sfx?: boolean; upscaleFrames?: boolean }).sfx === true)).toBe(true);
      expect(mergeJobs.every((j) => (j.input as { sfx?: boolean; upscaleFrames?: boolean }).upscaleFrames === true)).toBe(true);
    });
  });

  describe('step 14 (per-frame DreamX upscale)', () => {
    const ttsEntry = catalogEntry(2)!;
    const animationEntry = catalogEntry(3)!;
    const upscaleFrameEntry = catalogEntry(14)!;

    it('is a bulk per-frame step capped at the endpoint\'s 3 workers, not cfg.workersHead', () => {
      const { steps, jobs } = _internal.buildStepsAndJobs([animationEntry, upscaleFrameEntry], req, 'proj_1', 25);
      const step = steps.find((s) => s.seq === 14)!;
      expect(upscaleFrameEntry.scope).toBe('bulk');
      expect(step).toMatchObject({ workersTarget: 3, dependsOn: [3], jobTotal: 3 });
      expect(steps.find((s) => s.seq === 3)!.workersTarget).toBe(25); // uncapped steps unchanged
      expect(jobs.filter((j) => j.stepSeq === 14).every((j) => j.depsRemaining === 1)).toBe(true);
    });

    it('merge (dependsOn:[2,14,3]) collapses to [14] when 14 is planned, and every per-frame job carries upscaleFrames', () => {
      const { steps, jobs } = _internal.buildStepsAndJobs([ttsEntry, animationEntry, mergeEntry, upscaleFrameEntry], req, 'proj_1', 25);
      // 3 is shadowed by 14 (14 depends on 3), 2 by 3 (animation depends on
      // tts since 2026-09-12) — merge still RESOLVES all three at build time
      // (generator.ts reads the catalog's dependsOn), this is only the fan-in.
      expect(steps.find((s) => s.seq === 6)!.dependsOn).toEqual([14]);
      const mergeJobs = jobs.filter((j) => j.stepSeq === 6);
      expect(mergeJobs.every((j) => j.depsRemaining === 1)).toBe(true);
      expect(mergeJobs.every((j) => (j.input as { upscaleFrames?: boolean }).upscaleFrames === true)).toBe(true);
    });

    it('merge fans in on [3] and has no upscaleFrames flag when 14 is not planned', () => {
      const { steps, jobs } = _internal.buildStepsAndJobs([ttsEntry, animationEntry, mergeEntry], req, 'proj_1', 25);
      expect(steps.find((s) => s.seq === 6)!.dependsOn).toEqual([3]);
      expect(jobs.filter((j) => j.stepSeq === 6).every((j) => (j.input as { upscaleFrames?: boolean }).upscaleFrames === undefined)).toBe(true);
    });
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

  it('rejects an options.bgm request with no bgmPrompt', async () => {
    const req = {
      requestId: 'req_2',
      projectId: 'proj_2',
      source: 'mcp',
      tier: 'narration-premium',
      product: 'documentary',
      language: 'en',
      aspectRatio: '16:9',
      resolution: '1920x1080',
      callbackUrl: 'https://convex.example/api/qm/result',
      options: { bgm: true },
      frames: [{ frameId: 'f_1', imagePrompt: 'p', narration: 'n', durationS: 5 }],
    };
    await expect(plan(fakePool, { workersHead: 25 }, req)).rejects.toThrow(PlanValidationError);
  });
});
