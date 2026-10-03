/**
 * Pure-logic tests for the per-asset generator model (2026-09-19): the plan it
 * compiles from a request, the fan-out of rows that plan produces, the
 * compiler's completeness judgement, the tail manifest the SFN/ECS tail reads,
 * and the §9.6 result.
 *
 * Everything here is deliberately DB-free — each of these is a pure function
 * precisely so the decisions that matter (what depends on what, what counts
 * as stuck, what the worker is told to do, what the receiver sees) can be
 * pinned down without a Postgres or a RunPod.
 */
import { compilePlan, handoffTargets, inputsSatisfied, toResolvedDeps, expectedAssetCount, clipKind, type AssetPlan } from '../src/assets/plan';
import { buildAssetRows } from '../src/assets/submit';
import { classifyProjectAssets, describeDrop, manifestFrame } from '../src/assets/compiler';
import { buildManifest, MANIFEST_VERSION } from '../src/assets/manifest';
import { buildAssetResult } from '../src/assets/result';
import { buildSfnTailInput } from '../src/steps/builders/sfn-tail';
import { ASSET_KINDS, ASSET_SPECS, totalInFlightCeiling, type AssetKind } from '../src/assets/kinds';
import { PROJECT_SCOPE, type AssetRow } from '../src/db/repo/assets';
import { RequestSchema, type OrchestratorRequest } from '../src/agents/planner';

function request(overrides: Partial<Record<string, unknown>> = {}): OrchestratorRequest {
  return RequestSchema.parse({
    requestId: 'req_1',
    projectId: 'proj_1',
    source: 'mcp',
    tier: 'narration-basic',
    product: 'documentary',
    language: 'en',
    aspectRatio: '9:16',
    resolution: '1080x1920',
    callbackUrl: 'https://convex.example/api/qm/result',
    options: {},
    frames: [
      { frameId: 'f1', imagePrompt: 'a lighthouse', narration: 'one', durationS: 5 },
      { frameId: 'f2', imagePrompt: 'a harbour', narration: 'two', durationS: 4 },
    ],
    ...overrides,
  });
}

function withOptions(o: Record<string, unknown>, extra: Record<string, unknown> = {}): OrchestratorRequest {
  return request({ options: { ...request().options, ...o }, ...extra });
}

function assetRow(over: Partial<AssetRow> & Pick<AssetRow, 'kind' | 'frameId'>): AssetRow {
  return {
    id: 1,
    projectId: 'proj_1',
    seq: 0,
    status: 'complete',
    endpointId: 'e',
    provider: 'runpod',
    requiredInputs: [],
    sources: {},
    input: {},
    stage: null,
    stages: [],
    output: null,
    assetUrl: `https://cdn/${over.kind}-${over.frameId}.mp4`,
    durationS: null,
    error: null,
    attempts: 1,
    reworks: 0,
    providerJobId: 'rp1',
    // Recent relative to the suite's `now` (12:00Z): staleness is measured
    // from submitted_at, so a row is only stuck when a test says so.
    submittedAt: new Date('2026-09-19T11:59:30Z'),
    completedAt: new Date('2026-09-19T10:01:00Z'),
    createdAt: new Date('2026-09-19T09:59:00Z'),
    updatedAt: new Date('2026-09-19T10:01:00Z'),
    ...over,
  } as AssetRow;
}

describe('the registry', () => {
  it('has a spec for every declared kind, and every kind has its own table', () => {
    const tables = new Set<string>();
    for (const kind of ASSET_KINDS) {
      const spec = ASSET_SPECS[kind];
      expect(spec.kind).toBe(kind);
      // RunPod ids are bare; Lambda- and Step-Functions-backed kinds carry a sentinel.
      const expected =
        spec.provider === 'lambda' ? /^lambda:/ : spec.provider === 'sfn' ? /^aws-sfn:/ : /^[a-z0-9]+$/;
      expect(spec.endpointId).toMatch(expected);
      expect(tables.has(spec.table)).toBe(false);
      tables.add(spec.table);
    }
    expect(tables.size).toBe(ASSET_KINDS.length);
  });

  it('keeps the sum of per-endpoint RunPod in-flight ceilings inside the account cap', () => {
    // The whole point of a per-endpoint (not per-kind) budget: every agent
    // saturating at once must still fit in the 40-worker account. The
    // sentinel kinds (lambda, sfn) hold no worker, so they sit outside it.
    const runpodOnly = new Map<string, number>();
    for (const spec of Object.values(ASSET_SPECS)) {
      if (spec.provider !== 'runpod') continue;
      runpodOnly.set(spec.endpointId, Math.max(runpodOnly.get(spec.endpointId) ?? 0, spec.maxInFlight));
    }
    const total = [...runpodOnly.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(40);
    // The 11 workers of the 3D pipeline share the account (2026-10-02).
    expect(total + 11).toBeLessThanOrEqual(40);
  });

  it('scopes only the SFN tail to the project, everything else to a frame', () => {
    const projectScoped = ASSET_KINDS.filter((k) => ASSET_SPECS[k].scope === 'project');
    expect(projectScoped).toEqual(['sfn-tail']);
  });

  it('retired the kinds whose work moved into the tail', () => {
    for (const gone of ['dreamx-refine', 'merge', 'bgm', 'postprod-lite']) {
      expect(ASSET_KINDS as readonly string[]).not.toContain(gone);
    }
  });

  it('points every RunPod kind at the endpoint the dashboard shows for it', () => {
    expect(ASSET_SPECS.tts.endpointId).toBe('rnqxi6c0mlq517');
    expect(ASSET_SPECS.tts.maxInFlight).toBe(7);
    expect(ASSET_SPECS.mmaudio.endpointId).toBe('nzkcsef9t2iv7s');
    expect(ASSET_SPECS.mmaudio.maxInFlight).toBe(5);
    expect(ASSET_SPECS['wan2-i2v'].maxInFlight).toBe(6);
  });

  it('gives sfn-tail a timeout sized for a whole project, not one frame', () => {
    expect(ASSET_SPECS['sfn-tail'].timeoutMs).toBeGreaterThan(ASSET_SPECS['wan2-i2v'].timeoutMs as number);
    expect(ASSET_SPECS['sfn-tail'].provider).toBe('sfn');
    expect(ASSET_SPECS['sfn-tail'].cancelOnTimeout).toBe(true);
  });

  it('every kind has a positive timeout, or opts out explicitly', () => {
    for (const kind of ASSET_KINDS) {
      const t = ASSET_SPECS[kind].timeoutMs;
      // null is the deliberate opt-out for synchronous Lambda kinds, never an oversight.
      if (t === null) expect(['remotion', 'animate']).toContain(kind);
      else expect(t).toBeGreaterThan(0);
    }
  });
});

describe('compilePlan', () => {
  it('builds the default chain: image + tts -> motion, then the SFN tail', () => {
    // No dreamx-refine, no merge, no bgm kind (2026-10-02): upscaling and the
    // clip+narration mix happen in the tail, BGM is generated by it.
    const plan = compilePlan(request());
    expect(plan.frameKinds.sort()).toEqual(['qwen-image-gen', 'tts', 'wan2-i2v']);
    expect(plan.kinds).toContain('sfn-tail');
    expect(plan.requires['qwen-image-gen']).toEqual([]);
    expect(plan.requires['tts']).toEqual([]);
    expect(plan.requires['wan2-i2v']).toEqual(['qwen-image-gen', 'tts']);
    // The tail is NOT in the handoff graph — the compiler arms it.
    expect(plan.requires['sfn-tail']).toBeUndefined();
    expect(clipKind(plan)).toBe('wan2-i2v');
  });

  it('never plans the retired kinds, whatever the upscale options say', () => {
    const variants: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{}, {}],
      [{ upscale: true }, {}],
      [{ upscaleEngine: 'realesrgan' }, {}],
      [{ upscale: true, upscaleEngine: 'dreamx' }, {}],
      [{ bgm: true }, { bgmPrompt: 'p' }],
    ];
    for (const [o, extra] of variants) {
      const plan = compilePlan(withOptions(o, extra));
      for (const gone of ['dreamx-refine', 'merge', 'bgm', 'postprod-lite']) {
        expect(plan.kinds as string[]).not.toContain(gone);
      }
    }
  });

  it('plans the animate (Ken Burns Lambda) asset for motionEngine=animate, in Wan2\u2019s place (2026-10-03)', () => {
    const plan = compilePlan(withOptions({ motionEngine: 'animate' }));
    expect(plan.motionKind).toBe('animate');
    expect(plan.frameKinds.sort()).toEqual(['animate', 'qwen-image-gen', 'tts']);
    expect(plan.requires['animate']).toEqual(['qwen-image-gen', 'tts']);
    expect(clipKind(plan)).toBe('animate');
  });

  it('never plans MMAudio over a Ken Burns clip, even when sfx is requested', () => {
    const plan = compilePlan(withOptions({ motionEngine: 'animate', sfx: true }));
    expect(plan.frameKinds).not.toContain('mmaudio');
  });

  it('routes options.referenceImage through qwen-edit instead of qwen-image-gen', () => {
    const plan = compilePlan(
      request({
        options: { ...request().options, referenceImage: true },
        frames: request().frames.map((f) => ({ ...f, referenceImageUrl: 'https://cdn/ref.png' })),
      }),
    );
    expect(plan.imageKind).toBe('qwen-edit');
    expect(plan.frameKinds).not.toContain('qwen-image-gen');
    expect(plan.requires['wan2-i2v']).toEqual(['qwen-edit', 'tts']);
  });

  it('runs mmaudio right after the motion clip when sfx is on', () => {
    const plan = compilePlan(withOptions({ sfx: true }));
    expect(plan.requires['mmaudio']).toEqual(['wan2-i2v']);
    // The frame's finished clip is the most-processed one.
    expect(clipKind(plan)).toBe('mmaudio');
  });

  it('never plans SFX when there is no motion model for it to follow', () => {
    const plan = compilePlan(withOptions({ motionEngine: 'animate', sfx: true }));
    expect(plan.frameKinds).not.toContain('mmaudio');
  });

  it('records bgm as a tail flag, not a kind', () => {
    const plan = compilePlan(withOptions({ bgm: true }));
    expect(plan.kinds as string[]).not.toContain('bgm');
    expect(plan.tail.bgm).toBe(true);
  });

  it('turns the tail steps into flags on one execution, not a chain', () => {
    const plan = compilePlan(withOptions({ removeSilence: true, burnCaptions: true, bgm: true }));
    expect(plan.tail).toEqual({ removeSilence: true, burnCaptions: true, bgm: true, textOverlay: false });
  });
});

describe('the remotion agent', () => {
  it('is planned for a project with on-screen text, over Wan2 or the Ken Burns clip', () => {
    expect(compilePlan(request()).frameKinds).not.toContain('remotion');
    expect(compilePlan(withOptions({ textOverlay: true })).frameKinds).toContain('remotion');
    // Narration-basic explainers keep their text (2026-10-03): Remotion
    // renders onto the animate Lambda's clip.
    const basic = compilePlan(withOptions({ textOverlay: true, motionEngine: 'animate' }));
    expect(basic.requires['remotion']).toEqual(['animate']);
    expect(clipKind(basic)).toBe('remotion');
  });

  it('renders over the most-processed clip and becomes the frame\u2019s clip', () => {
    const plain = compilePlan(withOptions({ textOverlay: true }));
    expect(plain.requires['remotion']).toEqual(['wan2-i2v']);
    expect(clipKind(plain)).toBe('remotion');

    const withSfx = compilePlan(withOptions({ textOverlay: true, sfx: true }));
    expect(withSfx.requires['remotion']).toEqual(['mmaudio']);
    expect(clipKind(withSfx)).toBe('remotion');
  });

  it('dispatches via Lambda, not RunPod', () => {
    expect(ASSET_SPECS.remotion.provider).toBe('lambda');
    expect(ASSET_SPECS.remotion.endpointId).toBe('lambda:qm-remotion-overlay');
    expect(ASSET_SPECS.remotion.gate).toBeNull();
    expect(ASSET_SPECS.animate.provider).toBe('lambda');
    expect(ASSET_SPECS.animate.endpointId).toBe('lambda:qm-animate');
    // Every other kind stays on RunPod, except the SFN tail.
    for (const k of ASSET_KINDS.filter((x) => x !== 'remotion' && x !== 'animate' && x !== 'sfn-tail')) {
      expect(ASSET_SPECS[k].provider).toBe('runpod');
    }
  });

  it('puts the overlaid clip in the manifest, not the raw one', () => {
    const plan = compilePlan(withOptions({ textOverlay: true }));
    const entry = manifestFrame(
      plan,
      {
        frameId: 'f1',
        seq: 0,
        rows: [
          assetRow({ kind: 'qwen-image-gen', frameId: 'f1', assetUrl: 'https://cdn/f1.png' }),
          assetRow({ kind: 'tts', frameId: 'f1', assetUrl: 'https://cdn/f1.mp3' }),
          assetRow({ kind: 'wan2-i2v', frameId: 'f1', assetUrl: 'https://cdn/raw.mp4' }),
          assetRow({ kind: 'remotion', frameId: 'f1', assetUrl: 'https://cdn/overlaid.mp4' }),
        ],
      },
      request(),
    );
    expect(entry.videoUrl).toBe('https://cdn/overlaid.mp4');
  });
});

describe('QA exemption by product', () => {
  it('exempts explainer and educational products from the gate entirely', () => {
    for (const product of ['explainer', 'Educational', 'education']) {
      expect(compilePlan(request({ product })).qaExempt).toBe(true);
    }
  });

  it('does not exempt an ordinary product', () => {
    expect(compilePlan(request({ product: 'documentary' })).qaExempt).toBe(false);
    expect(compilePlan(request({ product: 'sci-fi' })).qaExempt).toBe(false);
  });

  it('is decided by the product, not by whether the project has a text overlay', () => {
    // A sci-fi project with captions still has diffusion-generated frames
    // worth checking; an explainer without them still does not.
    expect(compilePlan(withOptions({ textOverlay: true })).qaExempt).toBe(false);
    expect(compilePlan(request({ product: 'explainer' })).qaExempt).toBe(true);
  });
});

describe('handoff edges', () => {
  it('are the requires graph read backwards — no agent names its own successor', () => {
    const plan = compilePlan(withOptions({ sfx: true }));
    expect(handoffTargets(plan, 'qwen-image-gen')).toEqual(['wan2-i2v']);
    // tts feeds only wan2-i2v now (real clip length); the narration itself is
    // mixed in by the tail, which reads it from the manifest.
    expect(handoffTargets(plan, 'tts')).toEqual(['wan2-i2v']);
    expect(handoffTargets(plan, 'wan2-i2v')).toEqual(['mmaudio']);
    // The end of the per-frame chain hands off to nothing — the compiler
    // takes over from there.
    expect(handoffTargets(plan, 'mmaudio')).toEqual([]);
  });

  it('never hands off to a project-scoped kind', () => {
    const plan = compilePlan(withOptions({ bgm: true, sfx: true }));
    for (const kind of plan.kinds) {
      for (const target of handoffTargets(plan, kind)) {
        expect(ASSET_SPECS[target].scope).toBe('frame');
      }
    }
  });

  it('every handoff target is a kind the plan actually contains', () => {
    const plan = compilePlan(withOptions({ sfx: true }));
    for (const kind of plan.kinds) {
      for (const target of handoffTargets(plan, kind)) expect(plan.kinds).toContain(target);
    }
  });
});

describe('inputsSatisfied', () => {
  it('is vacuously true for a chain head, and false until every input arrives', () => {
    expect(inputsSatisfied([], {})).toBe(true);
    expect(inputsSatisfied(['tts', 'wan2-i2v'], { tts: { url: 'a' } })).toBe(false);
    expect(inputsSatisfied(['tts', 'wan2-i2v'], { tts: { url: 'a' }, 'wan2-i2v': { url: 'b' } })).toBe(true);
  });
});

describe('toResolvedDeps', () => {
  it('translates asset-kind sources into the seq map the existing builders read', () => {
    const deps = toResolvedDeps({
      'qwen-image-gen': { url: 'https://cdn/img.png' },
      tts: { url: 'https://cdn/vo.mp3', durationS: 6.2 },
      'wan2-i2v': { url: 'https://cdn/clip.mp4' },
    });
    expect(deps[1]?.url).toBe('https://cdn/img.png');
    expect(deps[2]).toEqual({ url: 'https://cdn/vo.mp3', durationS: 6.2 });
    expect(deps[3]?.url).toBe('https://cdn/clip.mp4');
  });
});

describe('buildAssetRows', () => {
  it('writes one row per (frame kind, frame) plus the one tail row', () => {
    const req = withOptions({ bgm: true }, { bgmPrompt: 'soft piano' });
    const plan = compilePlan(req);
    const rows = buildAssetRows(req, plan);

    expect(rows).toHaveLength(expectedAssetCount(plan));
    expect(rows).toHaveLength(3 * 2 + 1); // image/tts/motion per frame + the SFN tail

    const projectRows = rows.filter((r) => r.frameId === PROJECT_SCOPE);
    expect(projectRows.map((r) => r.kind)).toEqual(['sfn-tail']);
  });

  it('starts the tail blocked: the compiler arms it with the manifest', () => {
    const rows = buildAssetRows(request(), compilePlan(request()));
    const tail = rows.find((r) => r.kind === 'sfn-tail')!;
    expect(tail.requiredInputs).toEqual([]);
    expect(tail.initialStatus).toBe('blocked');
    // The chain heads stay runnable from submission.
    const runnable = rows.filter((r) => r.kind !== 'sfn-tail' && r.requiredInputs.length === 0).map((r) => r.kind);
    expect(runnable.sort()).toEqual(['qwen-image-gen', 'qwen-image-gen', 'tts', 'tts']);
  });

  it('stamps the sfx flag so "not requested" stays distinguishable from "missing"', () => {
    const req = withOptions({ sfx: true });
    const rows = buildAssetRows(req, compilePlan(req));
    const motion = rows.find((r) => r.kind === 'wan2-i2v')!;
    expect((motion.input as { sfx?: boolean }).sfx).toBe(true);
    expect((motion.input as { upscaleFrames?: boolean }).upscaleFrames).toBeUndefined();
  });

  it('gives each row its own kind’s endpoint', () => {
    const req = withOptions({ bgm: true }, { bgmPrompt: 'p' });
    for (const r of buildAssetRows(req, compilePlan(req))) {
      expect(r.endpointId).toBe(ASSET_SPECS[r.kind as AssetKind].endpointId);
    }
  });
});

describe('classifyProjectAssets', () => {
  const req = request();
  const plan = compilePlan(req);
  const frames = [
    { frameId: 'f1', seq: 0 },
    { frameId: 'f2', seq: 1 },
  ];
  const stuckAfter = () => 60_000;
  const now = Date.parse('2026-09-19T12:00:00Z');

  function fullSet(status: string, p = plan): AssetRow[] {
    return p.frameKinds.flatMap((kind) =>
      frames.map((f) =>
        assetRow({ kind, frameId: f.frameId, seq: f.seq, status, updatedAt: new Date(now), submittedAt: new Date(now - 1_000) }),
      ),
    );
  }

  it('is generated only when nothing is missing, stranded, stuck or working', () => {
    const state = classifyProjectAssets(plan, frames, fullSet('complete'), now, stuckAfter);
    expect(state.generated).toBe(true);
    expect(state.readyFrames).toHaveLength(2);
    expect(state.droppedFrames).toHaveLength(0);
  });

  it('reports a row the plan expects but that does not exist', () => {
    const rows = fullSet('complete').filter((r) => !(r.kind === 'tts' && r.frameId === 'f2'));
    const state = classifyProjectAssets(plan, frames, rows, now, stuckAfter);
    expect(state.generated).toBe(false);
    expect(state.missing).toEqual([{ kind: 'tts', frameId: 'f2', seq: 1 }]);
  });

  it('calls a submitted row stuck once it is quiet past its kind’s budget, not before', () => {
    // Measured from submitted_at. `updated_at` is deliberately kept FRESH on
    // the stuck row: reconcile touches it on every poll, so a clock based on
    // it could never age — the bug this replaced (2026-09-19).
    const rows = fullSet('complete');
    rows[0] = assetRow({ ...rows[0], status: 'submitted', submittedAt: new Date(now - 30_000) });
    expect(classifyProjectAssets(plan, frames, rows, now, stuckAfter).stuck).toHaveLength(0);

    rows[0] = assetRow({ ...rows[0], status: 'submitted', submittedAt: new Date(now - 90_000), updatedAt: new Date(now) });
    const state = classifyProjectAssets(plan, frames, rows, now, stuckAfter);
    expect(state.stuck).toHaveLength(1);
    expect(state.generated).toBe(false);
  });

  it('separates a lost handoff (blocked with inputs present) from an honest wait', () => {
    const rows = fullSet('complete').filter((r) => r.kind !== 'wan2-i2v');
    rows.push(assetRow({ kind: 'wan2-i2v', frameId: 'f1', status: 'blocked', requiredInputs: ['qwen-image-gen', 'tts'], sources: { tts: { url: 'a' } } }));
    rows.push(assetRow({ kind: 'wan2-i2v', frameId: 'f2', status: 'blocked', requiredInputs: ['qwen-image-gen', 'tts'], sources: { tts: { url: 'a' }, 'qwen-image-gen': { url: 'b' } } }));
    const state = classifyProjectAssets(plan, frames, rows, now, stuckAfter);
    expect(state.strandedBlocked).toHaveLength(1);
    expect(state.inProgress).toHaveLength(1);
  });

  it('drops a permanently failed frame instead of blocking the project', () => {
    const rows = fullSet('complete').map((r) =>
      r.frameId === 'f2' && r.kind === 'wan2-i2v' ? assetRow({ ...r, status: 'failed', assetUrl: null }) : r,
    );
    const state = classifyProjectAssets(plan, frames, rows, now, stuckAfter);
    expect(state.generated).toBe(true);
    expect(state.readyFrames.map((f) => f.frameId)).toEqual(['f1']);
    expect(state.droppedFrames[0].frameId).toBe('f2');
  });
});

describe('describeDrop', () => {
  it('names the asset that broke, not just "missing"', () => {
    const reason = describeDrop([
      assetRow({ kind: 'qwen-image-gen', frameId: 'f2', status: 'failed', assetUrl: null, error: { error: 'CUDA out of memory' } }),
    ]);
    expect(reason).toContain('qwen-image-gen');
    expect(reason).toContain('CUDA out of memory');
  });
});

describe('manifestFrame', () => {
  const req = request();

  it('sends the generated clip when there is a motion model', () => {
    const plan = compilePlan(req);
    const entry = manifestFrame(
      plan,
      {
        frameId: 'f1',
        seq: 0,
        rows: [
          assetRow({ kind: 'qwen-image-gen', frameId: 'f1', assetUrl: 'https://cdn/f1.png' }),
          assetRow({ kind: 'tts', frameId: 'f1', assetUrl: 'https://cdn/f1.mp3', durationS: 5.4 }),
          assetRow({ kind: 'wan2-i2v', frameId: 'f1', assetUrl: 'https://cdn/f1.mp4' }),
        ],
      },
      req,
    );
    expect(entry).toMatchObject({ frameId: 'f1', videoUrl: 'https://cdn/f1.mp4', audioUrl: 'https://cdn/f1.mp3', durationS: 5.4 });
    expect(entry.imageUrl).toBeUndefined();
    expect(entry.sfxFromVideo).toBeUndefined();
  });

  it('flags sfxFromVideo when SFX is planned, so the tail mixes the clip\u2019s own track under the narration', () => {
    const plan = compilePlan(withOptions({ sfx: true }));
    const entry = manifestFrame(
      plan,
      {
        frameId: 'f1',
        seq: 0,
        rows: [
          assetRow({ kind: 'qwen-image-gen', frameId: 'f1', assetUrl: 'https://cdn/f1.png' }),
          assetRow({ kind: 'tts', frameId: 'f1', assetUrl: 'https://cdn/f1.mp3' }),
          assetRow({ kind: 'wan2-i2v', frameId: 'f1', assetUrl: 'https://cdn/raw.mp4' }),
          assetRow({ kind: 'mmaudio', frameId: 'f1', assetUrl: 'https://cdn/sfx.mp4' }),
        ],
      },
      req,
    );
    expect(entry.videoUrl).toBe('https://cdn/sfx.mp4');
    expect(entry.sfxFromVideo).toBe(true);
  });

  it('keeps sfxFromVideo when a Remotion overlay was rendered over the SFX clip', () => {
    const plan = compilePlan(withOptions({ sfx: true, textOverlay: true }));
    const entry = manifestFrame(
      plan,
      {
        frameId: 'f1',
        seq: 0,
        rows: [
          assetRow({ kind: 'qwen-image-gen', frameId: 'f1', assetUrl: 'https://cdn/f1.png' }),
          assetRow({ kind: 'tts', frameId: 'f1', assetUrl: 'https://cdn/f1.mp3' }),
          assetRow({ kind: 'wan2-i2v', frameId: 'f1', assetUrl: 'https://cdn/raw.mp4' }),
          assetRow({ kind: 'mmaudio', frameId: 'f1', assetUrl: 'https://cdn/sfx.mp4' }),
          assetRow({ kind: 'remotion', frameId: 'f1', assetUrl: 'https://cdn/overlaid.mp4' }),
        ],
      },
      req,
    );
    expect(entry.videoUrl).toBe('https://cdn/overlaid.mp4');
    expect(entry.sfxFromVideo).toBe(true);
  });

  it('sends the animate Lambda\u2019s clip as the frame video', () => {
    const plan = compilePlan(withOptions({ motionEngine: 'animate' }));
    const entry = manifestFrame(
      plan,
      {
        frameId: 'f1',
        seq: 0,
        rows: [
          assetRow({ kind: 'qwen-image-gen', frameId: 'f1', assetUrl: 'https://cdn/f1.png' }),
          assetRow({ kind: 'tts', frameId: 'f1', assetUrl: 'https://cdn/f1.mp3' }),
          assetRow({ kind: 'animate', frameId: 'f1', assetUrl: 'https://cdn/f1-kb.mp4' }),
        ],
      },
      request(),
    );
    expect(entry.videoUrl).toBe('https://cdn/f1-kb.mp4');
    expect(entry.imageUrl).toBeUndefined();
    expect(entry.animate).toBeUndefined();
    expect(entry.sfxFromVideo).toBeUndefined();
  });

  it('a LEGACY plan (no motion kind, compiled before 2026-10-03) still sends the still plus a Ken Burns instruction', () => {
    const plan = { ...compilePlan(withOptions({ motionEngine: 'animate' })), motionKind: null, frameKinds: ['qwen-image-gen', 'tts'] } as AssetPlan;
    const animReq = request({
      frames: [{ frameId: 'f1', imagePrompt: 'p', narration: 'one', durationS: 5, animateEffect: 'pan_left' }],
    });
    const entry = manifestFrame(
      plan,
      {
        frameId: 'f1',
        seq: 0,
        rows: [
          assetRow({ kind: 'qwen-image-gen', frameId: 'f1', assetUrl: 'https://cdn/f1.png' }),
          assetRow({ kind: 'tts', frameId: 'f1', assetUrl: 'https://cdn/f1.mp3' }),
        ],
      },
      animReq,
    );
    expect(entry.imageUrl).toBe('https://cdn/f1.png');
    expect(entry.videoUrl).toBeUndefined();
    expect(entry.animate).toEqual({ effect: 'pan_left', fps: 16 });
  });

  it('refuses a frame with no narration rather than shipping a silent scene', () => {
    const plan = compilePlan(req);
    expect(() =>
      manifestFrame(plan, { frameId: 'f1', seq: 0, rows: [assetRow({ kind: 'wan2-i2v', frameId: 'f1' })] }, req),
    ).toThrow(/no narration audio/);
  });
});

describe('buildManifest', () => {
  const req = request();

  function manifest(plan = compilePlan(req), bgmPrompt?: string) {
    return buildManifest({
      projectId: 'proj_1',
      requestId: 'req_1',
      plan,
      request: {
        tier: req.tier,
        product: req.product,
        language: req.language,
        aspectRatio: req.aspectRatio,
        resolution: req.resolution,
        options: req.options as unknown as Record<string, unknown>,
      },
      frames: [
        { frameId: 'f2', seq: 1, videoUrl: 'https://cdn/2.mp4', audioUrl: 'https://cdn/2.mp3', durationS: 4, narration: 'two' },
        { frameId: 'f1', seq: 0, videoUrl: 'https://cdn/1.mp4', audioUrl: 'https://cdn/1.mp3', durationS: 5, narration: 'one' },
      ],
      droppedFrames: [{ frameId: 'f3', reason: 'wan2-i2v: failed' }],
      bgmPrompt,
      compiledAt: new Date('2026-09-19T12:00:00Z'),
    });
  }

  it('orders frames by narrative position and records which were dropped', () => {
    const m = manifest();
    expect(m.version).toBe(MANIFEST_VERSION);
    expect(m.frames.map((f) => f.frameId)).toEqual(['f1', 'f2']);
    expect(m.droppedFrames).toHaveLength(1);
    expect(m.chain).toEqual({ image: 'qwen-image-gen', motion: 'wan2-i2v', overlay: false });
  });

  it('carries the tail as flags, with captions only when they are burned', () => {
    expect(manifest().steps).toEqual({ removeSilence: false, burnCaptions: false });
    expect(manifest().captions).toBeUndefined();

    const captioned = manifest(compilePlan(withOptions({ burnCaptions: true, removeSilence: true })));
    expect(captioned.steps).toEqual({ removeSilence: true, burnCaptions: true });
    expect(captioned.captions).toMatchObject({ wordsPerGroup: 3, position: 'bottom' });
  });

  it('includes the bgm block only when there is a prompt to generate from', () => {
    const plan = compilePlan(withOptions({ bgm: true }, { bgmPrompt: 'p' }));
    expect(manifest(plan).bgm).toBeUndefined();
    // The tail generates the music; the manifest carries the PROMPT, not a url.
    expect(manifest(plan, 'soft piano').bgm).toEqual({ prompt: 'soft piano', volume: 0.15 });
    expect(manifest(compilePlan(req), 'soft piano').bgm).toBeUndefined(); // options.bgm is off
  });
});

describe('buildSfnTailInput', () => {
  const ctx = { job: {}, resolvedDeps: {}, projectId: 'proj_1', frameId: null } as never;
  const row = {
    manifestUrl: 'https://cdn/m.json',
    aspectRatio: '9:16',
    language: 'hi',
    options: { removeSilence: true, captions: true, bgm: true, bgmPrompt: 'soft piano', sfx: false },
    totalDurationS: 9,
  };

  it('sends references only: the manifest URL, the language, the options the state machine branches on, an output prefix', () => {
    expect(buildSfnTailInput({ ...(ctx as object), job: row } as never)).toEqual({
      projectId: 'proj_1',
      manifestUrl: 'https://cdn/m.json',
      aspectRatio: '9:16',
      language: 'hi',
      options: row.options,
      totalDurationS: 9,
      outputPrefix: 'projects/proj_1/tail/',
    });
  });

  it('never carries an inline manifest — Step Functions caps its input at 256KB', () => {
    const payload = buildSfnTailInput({ ...(ctx as object), job: { ...row, manifest: { frames: [1, 2, 3] } } } as never);
    expect(payload).not.toHaveProperty('manifest');
    expect(JSON.stringify(payload).length).toBeLessThan(1_000);
  });

  it('refuses a row with no manifestUrl rather than starting a tail with nothing to assemble', () => {
    expect(() => buildSfnTailInput({ ...(ctx as object), job: { aspectRatio: '9:16' } } as never)).toThrow(/no manifestUrl/);
    expect(() => buildSfnTailInput({ ...(ctx as object), job: { manifest: { frames: [] }, aspectRatio: '9:16' } } as never)).toThrow(/configure R2/);
  });

  it('refuses a row with no aspect ratio', () => {
    expect(() => buildSfnTailInput({ ...(ctx as object), job: { manifestUrl: 'https://cdn/m.json' } } as never)).toThrow(/no aspectRatio/);
  });
});

describe('buildAssetResult', () => {
  const req = request();
  const plan = compilePlan(req);

  it('produces the §9.6 shape the cohort path does, sourced from asset rows', () => {
    const rows: AssetRow[] = [
      assetRow({ kind: 'qwen-image-gen', frameId: 'f1', seq: 0, assetUrl: 'https://cdn/f1.png' }),
      assetRow({ kind: 'tts', frameId: 'f1', seq: 0, assetUrl: 'https://cdn/f1.mp3', durationS: 5.4 }),
      assetRow({ kind: 'wan2-i2v', frameId: 'f1', seq: 0, assetUrl: 'https://cdn/f1.mp4' }),
      assetRow({
        kind: 'sfn-tail',
        frameId: PROJECT_SCOPE,
        assetUrl: 'https://cdn/final.mp4',
        durationS: 9.3,
        // The state machine reports each frame's hosted merged clip.
        output: { frames: [{ frameId: 'f1', url: 'https://cdn/f1-merged.mp4' }] },
      }),
      assetRow({ kind: 'qwen-image-gen', frameId: 'f2', seq: 1, status: 'failed', assetUrl: null, error: { error: 'CUDA out of memory' } }),
    ];

    const result = buildAssetResult({
      project: { id: 'proj_1', requestId: 'req_1', createdAt: new Date('2026-09-19T09:00:00Z'), request: req },
      plan,
      rows,
      status: 'partial',
      finalUrl: 'https://cdn/final.mp4',
      finalDurationS: 9.3,
      gpuCostUsd: 0.09,
      startedAt: new Date('2026-09-19T09:00:00Z'),
      finishedAt: new Date('2026-09-19T09:33:00Z'),
    });

    expect(result.status).toBe('partial');
    expect(result.assets.final?.url).toBe('https://cdn/final.mp4');
    expect(result.assets.frames[0]).toMatchObject({
      frameId: 'f1',
      status: 'completed',
      imageUrl: 'https://cdn/f1.png',
      narrationAudioUrl: 'https://cdn/f1.mp3',
      narrationDurationS: 5.4,
      clipUrl: 'https://cdn/f1.mp4',
      mergedClipUrl: 'https://cdn/f1-merged.mp4',
    });
    expect(result.assets.frames[1]).toMatchObject({ frameId: 'f2', status: 'failed', imageUrl: null });
    expect(result.errors[0].reason).toContain('CUDA out of memory');
    expect(result.metrics.gpuCostUsd).toBe(0.09);
  });

  it('marks a QA-flagged frame and explains it in errors; a project-level reason comes first (2026-10-03)', () => {
    const rows: AssetRow[] = [
      assetRow({ kind: 'qwen-image-gen', frameId: 'f1', seq: 0, assetUrl: 'https://cdn/f1.png' }),
      assetRow({ kind: 'tts', frameId: 'f1', seq: 0, assetUrl: 'https://cdn/f1.mp3' }),
      assetRow({
        kind: 'wan2-i2v',
        frameId: 'f1',
        seq: 0,
        assetUrl: 'https://cdn/f1.mp4',
        qualityStatus: 'exhausted',
        qualityAttempts: 4,
        qualityIssues: [{ priority: 'P0', category: 'FROZEN', description: 'nothing moves in the clip' }],
      }),
    ];
    const result = buildAssetResult({
      project: { id: 'proj_1', requestId: 'req_1', createdAt: new Date(), request: req },
      plan,
      rows,
      status: 'failed',
      finalUrl: null,
      finalDurationS: null,
      gpuCostUsd: null,
      startedAt: new Date(),
      projectReason: 'assembly tail failed: ffmpeg exited 1',
    });
    expect(result.assets.frames[0].qualityFlagged).toBe(true);
    expect(result.errors[0]).toMatchObject({ frameId: null, agent: 'orchestrator', reason: 'assembly tail failed: ffmpeg exited 1' });
    expect(result.errors[1]).toMatchObject({ frameId: 'f1', agent: 'quality', step: 3 });
    expect(result.errors[1].reason).toBe(
      'wan2-i2v: failed quality checks after 4 attempt(s), accepted flagged (P0 FROZEN: nothing moves in the clip)',
    );
  });

  it('leaves mergedClipUrl null when the tail reported no per-frame clips', () => {
    const rows: AssetRow[] = [
      assetRow({ kind: 'qwen-image-gen', frameId: 'f1', seq: 0, assetUrl: 'https://cdn/f1.png' }),
      assetRow({ kind: 'tts', frameId: 'f1', seq: 0, assetUrl: 'https://cdn/f1.mp3' }),
      assetRow({ kind: 'wan2-i2v', frameId: 'f1', seq: 0, assetUrl: 'https://cdn/f1.mp4' }),
      assetRow({ kind: 'sfn-tail', frameId: PROJECT_SCOPE, assetUrl: 'https://cdn/final.mp4', output: { video: 'https://cdn/final.mp4' } }),
    ];
    const result = buildAssetResult({
      project: { id: 'proj_1', requestId: 'req_1', createdAt: new Date(), request: req },
      plan,
      rows,
      status: 'completed',
      finalUrl: 'https://cdn/final.mp4',
      finalDurationS: null,
      gpuCostUsd: null,
      startedAt: new Date(),
    });
    expect(result.assets.frames[0].mergedClipUrl).toBeNull();
  });

  it('prefers the most-processed clip for a frame’s clipUrl', () => {
    const sfxPlan = compilePlan(withOptions({ sfx: true }));
    const rows: AssetRow[] = [
      assetRow({ kind: 'qwen-image-gen', frameId: 'f1', assetUrl: 'https://cdn/f1.png' }),
      assetRow({ kind: 'tts', frameId: 'f1', assetUrl: 'https://cdn/f1.mp3' }),
      assetRow({ kind: 'wan2-i2v', frameId: 'f1', assetUrl: 'https://cdn/raw.mp4' }),
      assetRow({ kind: 'mmaudio', frameId: 'f1', assetUrl: 'https://cdn/sfx.mp4' }),
    ];
    const result = buildAssetResult({
      project: { id: 'proj_1', requestId: 'req_1', createdAt: new Date(), request: req },
      plan: sfxPlan,
      rows,
      status: 'completed',
      finalUrl: 'https://cdn/final.mp4',
      finalDurationS: null,
      gpuCostUsd: null,
      startedAt: new Date(),
    });
    expect(result.assets.frames[0].clipUrl).toBe('https://cdn/sfx.mp4');
  });

  it('marks a frame completed off its own assets, not off a merged clip that no longer exists', () => {
    const animPlan = compilePlan(withOptions({ motionEngine: 'animate' }));
    const rows: AssetRow[] = [
      assetRow({ kind: 'qwen-image-gen', frameId: 'f1', assetUrl: 'https://cdn/f1.png' }),
      assetRow({ kind: 'tts', frameId: 'f1', assetUrl: 'https://cdn/f1.mp3' }),
      assetRow({ kind: 'animate', frameId: 'f1', assetUrl: 'https://cdn/f1-kb.mp4' }),
    ];
    const result = buildAssetResult({
      project: { id: 'proj_1', requestId: 'req_1', createdAt: new Date(), request: req },
      plan: animPlan,
      rows,
      status: 'partial',
      finalUrl: 'https://cdn/final.mp4',
      finalDurationS: null,
      gpuCostUsd: null,
      startedAt: new Date(),
    });
    expect(result.assets.frames[0].status).toBe('completed');
    expect(result.assets.frames[0].clipUrl).toBe('https://cdn/f1-kb.mp4');
    expect(result.assets.frames[1].status).toBe('failed');
  });
});
