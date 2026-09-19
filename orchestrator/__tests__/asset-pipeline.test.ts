/**
 * Pure-logic tests for the per-asset generator model (2026-09-19): the plan it
 * compiles from a request, the fan-out of rows that plan produces, the
 * compiler's completeness judgement, the tail manifest handed to
 * postprod-lite's one-shot, and the §9.6 result.
 *
 * Everything here is deliberately DB-free — each of these is a pure function
 * precisely so the decisions that matter (what depends on what, what counts
 * as stuck, what the worker is told to do, what the receiver sees) can be
 * pinned down without a Postgres or a RunPod.
 */
import { compilePlan, handoffTargets, inputsSatisfied, toResolvedDeps, expectedAssetCount, clipKind } from '../src/assets/plan';
import { buildAssetRows } from '../src/assets/submit';
import { classifyProjectAssets, describeDrop, manifestFrame } from '../src/assets/compiler';
import { buildManifest, MANIFEST_VERSION } from '../src/assets/manifest';
import { buildAssetResult } from '../src/assets/result';
import { buildPostprodInput, INLINE_MANIFEST_MAX_BYTES } from '../src/steps/builders/postprod';
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
    submittedAt: new Date('2026-09-19T10:00:00Z'),
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
      // RunPod ids are bare; the one Lambda-backed kind carries a sentinel.
      expect(spec.endpointId).toMatch(spec.provider === 'lambda' ? /^lambda:/ : /^[a-z0-9]+$/);
      expect(tables.has(spec.table)).toBe(false);
      tables.add(spec.table);
    }
    expect(tables.size).toBe(ASSET_KINDS.length);
  });

  it('keeps the sum of per-endpoint in-flight ceilings inside the RunPod account cap', () => {
    // The whole point of a per-endpoint (not per-kind) budget: every agent
    // saturating at once must still fit in the 40-worker account.
    expect(totalInFlightCeiling()).toBeLessThanOrEqual(40);
  });

  it('scopes bgm and postprod-lite to the project, everything else to a frame', () => {
    const projectScoped = ASSET_KINDS.filter((k) => ASSET_SPECS[k].scope === 'project');
    expect(projectScoped.sort()).toEqual(['bgm', 'postprod-lite']);
  });

  it('gives postprod-lite a stuck budget sized for a whole project, not one frame', () => {
    expect(ASSET_SPECS['postprod-lite'].stuckAfterMs).toBeGreaterThanOrEqual(ASSET_SPECS['wan2-i2v'].stuckAfterMs);
  });
});

describe('compilePlan', () => {
  it('builds the default chain: image -> motion, with tts feeding motion and the tail', () => {
    const plan = compilePlan(request());
    expect(plan.frameKinds.sort()).toEqual(['qwen-image-gen', 'tts', 'wan2-i2v']);
    expect(plan.kinds).toContain('postprod-lite');
    expect(plan.requires['qwen-image-gen']).toEqual([]);
    expect(plan.requires['tts']).toEqual([]);
    expect(plan.requires['wan2-i2v']).toEqual(['qwen-image-gen', 'tts']);
    // The tail is NOT in the handoff graph — the compiler arms it.
    expect(plan.requires['postprod-lite']).toBeUndefined();
  });

  it('plans no motion asset at all for motionEngine=animate — the tail Ken Burns the still', () => {
    const plan = compilePlan(withOptions({ motionEngine: 'animate' }));
    expect(plan.motionKind).toBeNull();
    expect(plan.frameKinds.sort()).toEqual(['qwen-image-gen', 'tts']);
    expect(clipKind(plan)).toBeNull();
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

  it('inserts dreamx-refine and mmaudio into the chain in order when both are on', () => {
    const plan = compilePlan(withOptions({ upscale: true, upscaleEngine: 'dreamx', sfx: true }));
    expect(plan.requires['dreamx-refine']).toEqual(['wan2-i2v']);
    expect(plan.requires['mmaudio']).toEqual(['dreamx-refine']);
    // The frame's finished clip is the most-processed one.
    expect(clipKind(plan)).toBe('mmaudio');
  });

  it('never plans a per-frame refiner or SFX when there is no motion model to refine', () => {
    const plan = compilePlan(withOptions({ motionEngine: 'animate', upscale: true, upscaleEngine: 'dreamx', sfx: true }));
    expect(plan.frameKinds).not.toContain('dreamx-refine');
    expect(plan.frameKinds).not.toContain('mmaudio');
  });

  it('adds the bgm agent, project-scoped, when options.bgm is on', () => {
    const plan = compilePlan(withOptions({ bgm: true }));
    expect(plan.kinds).toContain('bgm');
    expect(plan.frameKinds).not.toContain('bgm');
    expect(plan.tail.bgm).toBe(true);
  });

  it('turns the tail steps into flags on one call, not a chain', () => {
    const plan = compilePlan(withOptions({ removeSilence: true, burnCaptions: true, bgm: true }));
    expect(plan.tail).toEqual({ removeSilence: true, burnCaptions: true, upscale: false, bgm: true, textOverlay: false });
  });

  it('leaves whole-video upscale off when DreamX already upscaled each frame', () => {
    const dreamx = compilePlan(withOptions({ upscale: true, upscaleEngine: 'dreamx' }));
    expect(dreamx.tail.upscale).toBe(false);
    expect(dreamx.frameKinds).toContain('dreamx-refine');

    // Only an explicit realesrgan request turns the whole-video pass on.
    const esrgan = compilePlan(withOptions({ upscale: true, upscaleEngine: 'realesrgan' }));
    expect(esrgan.tail.upscale).toBe(true);
    expect(esrgan.frameKinds).not.toContain('dreamx-refine');
  });
});

describe('the remotion agent', () => {
  it('is planned only for a project with on-screen text AND a clip to render over', () => {
    expect(compilePlan(request()).frameKinds).not.toContain('remotion');
    expect(compilePlan(withOptions({ textOverlay: true })).frameKinds).toContain('remotion');
    // No motion model means no clip yet — the still is animated inside the
    // one-shot, well after this would have run.
    expect(compilePlan(withOptions({ textOverlay: true, motionEngine: 'animate' })).frameKinds).not.toContain('remotion');
  });

  it('renders over the most-processed clip and becomes the frame\u2019s clip', () => {
    const plain = compilePlan(withOptions({ textOverlay: true }));
    expect(plain.requires['remotion']).toEqual(['wan2-i2v']);
    expect(clipKind(plain)).toBe('remotion');

    const full = compilePlan(withOptions({ textOverlay: true, upscale: true, upscaleEngine: 'dreamx', sfx: true }));
    expect(full.requires['remotion']).toEqual(['mmaudio']);
    expect(clipKind(full)).toBe('remotion');
  });

  it('dispatches via Lambda, not RunPod', () => {
    expect(ASSET_SPECS.remotion.provider).toBe('lambda');
    expect(ASSET_SPECS.remotion.endpointId).toBe('lambda:qm-remotion-overlay');
    expect(ASSET_SPECS.remotion.gate).toBeNull();
    // Every other kind stays on RunPod.
    for (const k of ASSET_KINDS.filter((x) => x !== 'remotion')) {
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

describe('handoff edges', () => {
  it('are the requires graph read backwards — no agent names its own successor', () => {
    const plan = compilePlan(withOptions({ upscale: true, upscaleEngine: 'dreamx' }));
    expect(handoffTargets(plan, 'qwen-image-gen')).toEqual(['wan2-i2v']);
    expect(handoffTargets(plan, 'tts')).toEqual(['wan2-i2v']);
    expect(handoffTargets(plan, 'wan2-i2v')).toEqual(['dreamx-refine']);
    // The end of the per-frame chain hands off to nothing — the compiler
    // takes over from there.
    expect(handoffTargets(plan, 'dreamx-refine')).toEqual([]);
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
  it('writes one row per (frame kind, frame) plus one per project-scoped kind', () => {
    const req = withOptions({ bgm: true }, { bgmPrompt: 'soft piano' });
    const plan = compilePlan(req);
    const rows = buildAssetRows(req, plan);

    expect(rows).toHaveLength(expectedAssetCount(plan));
    expect(rows).toHaveLength(3 * 2 + 2); // image/tts/motion per frame + bgm + tail

    const projectRows = rows.filter((r) => r.frameId === PROJECT_SCOPE);
    expect(projectRows.map((r) => r.kind).sort()).toEqual(['bgm', 'postprod-lite']);
  });

  it('starts only the chain heads and bgm runnable; the tail waits for the compiler', () => {
    const req = withOptions({ bgm: true }, { bgmPrompt: 'soft piano' });
    const rows = buildAssetRows(req, compilePlan(req));
    const runnable = rows.filter((r) => r.requiredInputs.length === 0).map((r) => r.kind);
    // bgm has nothing to wait for, so it generates in parallel from submission.
    expect(runnable).toContain('bgm');
    // The tail has no `requires` either — but it is created `blocked` and only
    // the compiler arms it. That distinction lives in insertAssets/armProjectAsset,
    // and is covered against a real database in asset-repo.integration.test.ts.
    expect(rows.find((r) => r.kind === 'postprod-lite')!.requiredInputs).toEqual([]);
  });

  it('carries the bgm prompt and the project total duration onto the bgm row', () => {
    const req = withOptions({ bgm: true }, { bgmPrompt: 'soft piano' });
    const bgm = buildAssetRows(req, compilePlan(req)).find((r) => r.kind === 'bgm')!;
    expect(bgm.input).toMatchObject({ bgmPrompt: 'soft piano', totalDurationS: 9 });
  });

  it('stamps the no-silent-degrade flags so merge can tell "not requested" from "missing"', () => {
    const req = withOptions({ upscale: true, upscaleEngine: 'dreamx', sfx: true });
    const rows = buildAssetRows(req, compilePlan(req));
    const motion = rows.find((r) => r.kind === 'wan2-i2v')!;
    expect((motion.input as { upscaleFrames?: boolean }).upscaleFrames).toBe(true);
    expect((motion.input as { sfx?: boolean }).sfx).toBe(true);
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
      frames.map((f) => assetRow({ kind, frameId: f.frameId, seq: f.seq, status, updatedAt: new Date(now) })),
    );
  }

  it('is generated only when nothing is missing, stranded, stuck or working', () => {
    const state = classifyProjectAssets(plan, frames, fullSet('complete'), now, stuckAfter);
    expect(state.generated).toBe(true);
    expect(state.readyFrames).toHaveLength(2);
    expect(state.droppedFrames).toHaveLength(0);
  });

  it('waits for the bgm track too, since the tail needs it', () => {
    const bgmPlan = compilePlan(withOptions({ bgm: true }, { bgmPrompt: 'p' }));
    const rows = fullSet('complete', bgmPlan);
    // Frames are all done but the project's music is still generating.
    rows.push(assetRow({ kind: 'bgm', frameId: PROJECT_SCOPE, status: 'submitted', updatedAt: new Date(now) }));
    const state = classifyProjectAssets(bgmPlan, frames, rows, now, stuckAfter);
    expect(state.generated).toBe(false);
    expect(state.inProgress.map((r) => r.kind)).toEqual(['bgm']);
  });

  it('reports a row the plan expects but that does not exist', () => {
    const rows = fullSet('complete').filter((r) => !(r.kind === 'tts' && r.frameId === 'f2'));
    const state = classifyProjectAssets(plan, frames, rows, now, stuckAfter);
    expect(state.generated).toBe(false);
    expect(state.missing).toEqual([{ kind: 'tts', frameId: 'f2', seq: 1 }]);
  });

  it('calls a submitted row stuck once it is quiet past its kind’s budget, not before', () => {
    const rows = fullSet('complete');
    rows[0] = assetRow({ ...rows[0], status: 'submitted', updatedAt: new Date(now - 30_000) });
    expect(classifyProjectAssets(plan, frames, rows, now, stuckAfter).stuck).toHaveLength(0);

    rows[0] = assetRow({ ...rows[0], status: 'submitted', updatedAt: new Date(now - 90_000) });
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

  it('flags sfxFromVideo when the clip came from MMAudio, which already muxed it in', () => {
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

  it('sends the still plus a Ken Burns instruction when there is no motion model', () => {
    const plan = compilePlan(withOptions({ motionEngine: 'animate' }));
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

  function manifest(plan = compilePlan(req), bgmUrl?: string) {
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
      bgmUrl,
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
    expect(manifest().steps).toEqual({ removeSilence: false, burnCaptions: false, upscale: false });
    expect(manifest().captions).toBeUndefined();

    const captioned = manifest(compilePlan(withOptions({ burnCaptions: true, removeSilence: true })));
    expect(captioned.steps).toEqual({ removeSilence: true, burnCaptions: true, upscale: false });
    expect(captioned.captions).toMatchObject({ wordsPerGroup: 3, position: 'bottom' });
  });

  it('includes the bgm block only when the track actually exists', () => {
    const plan = compilePlan(withOptions({ bgm: true }, { bgmPrompt: 'p' }));
    expect(manifest(plan).bgm).toBeUndefined();
    expect(manifest(plan, 'https://cdn/bgm.mp3').bgm).toEqual({ url: 'https://cdn/bgm.mp3', volume: 0.15 });
  });
});

describe('buildPostprodInput', () => {
  const ctx = { job: {}, resolvedDeps: {}, projectId: 'proj_1', frameId: null } as never;

  it('sends the manifest URL when the compiler wrote a file', () => {
    expect(
      buildPostprodInput({ ...(ctx as object), job: { manifestUrl: 'https://cdn/m.json' } } as never),
    ).toEqual({ mode: 'postprod', manifest_url: 'https://cdn/m.json', project_id: 'proj_1' });
  });

  it('falls back to an inline manifest when R2 was unavailable', () => {
    const payload = buildPostprodInput({ ...(ctx as object), job: { manifest: { version: 2, frames: [] } } } as never);
    expect(payload).toMatchObject({ mode: 'postprod', project_id: 'proj_1' });
    expect(payload.manifest).toEqual({ version: 2, frames: [] });
  });

  it('refuses an oversized inline manifest rather than repeating the 256KB incidents', () => {
    const huge = { frames: Array.from({ length: 5000 }, (_, i) => ({ frameId: `f${i}`, videoUrl: 'https://cdn/x'.padEnd(120, 'y') })) };
    expect(JSON.stringify(huge).length).toBeGreaterThan(INLINE_MANIFEST_MAX_BYTES);
    expect(() => buildPostprodInput({ ...(ctx as object), job: { manifest: huge } } as never)).toThrow(/configure R2/);
  });

  it('refuses a row that has no manifest at all', () => {
    expect(() => buildPostprodInput({ ...(ctx as object), job: {} } as never)).toThrow(/no manifest/);
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
      assetRow({ kind: 'postprod-lite', frameId: PROJECT_SCOPE, assetUrl: 'https://cdn/final.mp4', durationS: 9.3 }),
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
    });
    // Always null here: the one-shot keeps per-frame merged clips on the
    // worker's local disk and uploads only the final video.
    expect(result.assets.frames[0].mergedClipUrl).toBeNull();
    expect(result.assets.frames[1]).toMatchObject({ frameId: 'f2', status: 'failed', imageUrl: null });
    expect(result.errors[0].reason).toContain('CUDA out of memory');
    expect(result.metrics.gpuCostUsd).toBe(0.09);
  });

  it('prefers the most-processed clip for a frame’s clipUrl', () => {
    const sfxPlan = compilePlan(withOptions({ upscale: true, upscaleEngine: 'dreamx', sfx: true }));
    const rows: AssetRow[] = [
      assetRow({ kind: 'wan2-i2v', frameId: 'f1', assetUrl: 'https://cdn/raw.mp4' }),
      assetRow({ kind: 'dreamx-refine', frameId: 'f1', assetUrl: 'https://cdn/hi.mp4' }),
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
    expect(result.assets.frames[0].clipUrl).toBeNull();
    expect(result.assets.frames[1].status).toBe('failed');
  });
});
