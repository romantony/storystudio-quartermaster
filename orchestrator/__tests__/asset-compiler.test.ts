/**
 * Tests for the project compiler's tick — the fan-in decision, the repair
 * pass, arming the one-shot tail, and collecting its result.
 *
 * The repo layer is mocked (its SQL is covered against a real Postgres in
 * asset-repo.integration.test.ts). What is under test is the agent's
 * judgement: when it waits, when it reworks, what manifest it hands the
 * worker, and that it never calls postprod-lite itself — arming the
 * project-scoped row is what puts the dispatch under the endpoint's pod
 * limit, which is what makes "one pod, one project" true.
 */
import { RunpodClient } from '../src/runpod/client';
import { compileProject, type CompilerDeps } from '../src/assets/compiler';
import { compilePlan } from '../src/assets/plan';
import { ASSET_SPECS } from '../src/assets/kinds';
import { PROJECT_SCOPE, type AssetRow } from '../src/db/repo/assets';
import { RequestSchema, type OrchestratorRequest } from '../src/agents/planner';
import type { TailManifest } from '../src/assets/manifest';
import * as assetsRepo from '../src/db/repo/assets';
import * as pipelineRepo from '../src/db/repo/pipeline';
import * as projectsRepo from '../src/db/repo/projects';
import * as resultMod from '../src/assets/result';

jest.mock('../src/db/repo/assets');
jest.mock('../src/db/repo/pipeline');
jest.mock('../src/db/repo/projects');
jest.mock('../src/assets/result');

const RUNPOD_CFG = {
  runpodApiBase: 'https://api.runpod.ai/v2',
  runpodRestBase: 'https://rest.runpod.io/v1',
  runpodApiKey: 'test-key',
  runpodMaxRetries: 0,
  runpodTimeoutMs: 1000,
};

function request(options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): OrchestratorRequest {
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
    options,
    frames: [
      { frameId: 'f1', imagePrompt: 'a lighthouse', narration: 'one', durationS: 5 },
      { frameId: 'f2', imagePrompt: 'a harbour', narration: 'two', durationS: 4 },
    ],
    ...extra,
  });
}

function assetRow(over: Partial<AssetRow> & Pick<AssetRow, 'kind' | 'frameId'>): AssetRow {
  return {
    id: Math.floor(Math.random() * 1e6),
    projectId: 'proj_1',
    seq: over.frameId === 'f2' ? 1 : 0,
    status: 'complete',
    endpointId: ASSET_SPECS[over.kind].endpointId,
    provider: 'runpod',
    requiredInputs: [],
    sources: {},
    input: { frameId: over.frameId, narration: over.frameId === 'f2' ? 'two' : 'one' },
    // A gated kind is only "done" once a verdict landed — see
    // classifyProjectAssets(). The fixture represents an already-judged asset.
    qualityStatus: ASSET_SPECS[over.kind].gate ? 'pass' : 'ungated',
    qualityAttempts: 0,
    qualityScore: null,
    qualityIssues: [],
    stage: null,
    stages: [],
    output: null,
    assetUrl: `https://cdn/${over.kind}-${over.frameId}.mp4`,
    durationS: 5,
    error: null,
    attempts: 1,
    reworks: 0,
    providerJobId: 'rp-x',
    submittedAt: new Date(),
    completedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as AssetRow;
}

/** Every frame-scoped asset complete, plus an unarmed tail row. */
function generatedProject(req: OrchestratorRequest, options: Record<string, unknown> = {}): AssetRow[] {
  const plan = compilePlan(request(options));
  const rows = plan.frameKinds.flatMap((kind) => req.frames.map((f) => assetRow({ kind, frameId: f.frameId })));
  rows.push(assetRow({ kind: 'postprod-lite', frameId: PROJECT_SCOPE, status: 'blocked', assetUrl: null }));
  if (plan.kinds.includes('bgm')) rows.push(assetRow({ kind: 'bgm', frameId: PROJECT_SCOPE, assetUrl: 'https://cdn/bgm.mp3' }));
  return rows;
}

function fakeRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function deps(fetchImpl: jest.Mock = jest.fn()): CompilerDeps {
  const pool = {
    connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() })),
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as CompilerDeps['pool'];
  return {
    pool,
    runpod: new RunpodClient(RUNPOD_CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined }),
    cfg: { workerRateUsdS: 0.00021 } as unknown as CompilerDeps['cfg'],
    sleepImpl: async () => undefined,
  };
}

function pipelineRow(plan: ReturnType<typeof compilePlan>, over: Record<string, unknown> = {}) {
  return {
    projectId: 'proj_1',
    status: 'generating',
    plan,
    manifest: null,
    manifestUrl: null,
    tailStage: null,
    tailJobId: null,
    attempts: 0,
    startedAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** The manifest the compiler handed to armProjectAsset on this tick. */
function armedManifest(): TailManifest | undefined {
  const call = (assetsRepo.armProjectAsset as jest.Mock).mock.calls[0];
  return call?.[3]?.manifest;
}

beforeEach(() => {
  jest.clearAllMocks();
  (projectsRepo.getProject as jest.Mock).mockResolvedValue({
    id: 'proj_1', requestId: 'req_1', request: request(), callbackUrl: 'https://convex.example/api/qm/result',
  });
  (assetsRepo.releaseSatisfiedBlocked as jest.Mock).mockResolvedValue(0);
  (assetsRepo.listStaleUngated as jest.Mock).mockResolvedValue([]);
  (assetsRepo.gateAssetSkipped as jest.Mock).mockResolvedValue(true);
  (assetsRepo.insertAssets as jest.Mock).mockResolvedValue(1);
  (assetsRepo.reworkAsset as jest.Mock).mockResolvedValue(true);
  (assetsRepo.armProjectAsset as jest.Mock).mockResolvedValue(true);
  (pipelineRepo.beginAssembly as jest.Mock).mockResolvedValue(true);
  (pipelineRepo.finishPipelineProject as jest.Mock).mockResolvedValue(undefined);
  (pipelineRepo.returnToGenerating as jest.Mock).mockResolvedValue(undefined);
  (pipelineRepo.touchPipelineProject as jest.Mock).mockResolvedValue(undefined);
  (resultMod.finalizeAssetProject as jest.Mock).mockResolvedValue(undefined);
});

describe('while generating', () => {
  it('does nothing but touch the project while assets are still working', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    const rows = generatedProject(request()).map((r) => (r.kind === 'wan2-i2v' ? assetRow({ ...r, status: 'submitted' }) : r));
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(rows);

    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('waiting');
    expect(assetsRepo.armProjectAsset).not.toHaveBeenCalled();
    expect(pipelineRepo.touchPipelineProject).toHaveBeenCalled();
  });

  it('waits for the project’s bgm track before arming the tail', async () => {
    const req = request({ bgm: true }, { bgmPrompt: 'soft piano' });
    const plan = compilePlan(req);
    (projectsRepo.getProject as jest.Mock).mockResolvedValue({ id: 'proj_1', requestId: 'req_1', request: req, callbackUrl: null });
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    const rows = generatedProject(req, { bgm: true }).map((r) =>
      r.kind === 'bgm' ? assetRow({ ...r, status: 'submitted', assetUrl: null }) : r,
    );
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(rows);

    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('waiting');
    expect(assetsRepo.armProjectAsset).not.toHaveBeenCalled();
  });

  it('cancels a stuck provider job and resubmits it as rework', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    const stale = new Date(Date.now() - 60 * 60_000);
    const rows = generatedProject(request()).map((r) =>
      r.kind === 'wan2-i2v' && r.frameId === 'f1'
        ? assetRow({ ...r, status: 'submitted', providerJobId: 'rp-wedged', updatedAt: stale })
        : r,
    );
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(rows);

    const fetchImpl = jest.fn(async () => fakeRes(200, { id: 'rp-wedged', status: 'CANCELLED' }));
    const res = await compileProject(deps(fetchImpl as unknown as jest.Mock), 'proj_1');

    expect(res.action).toBe('repaired');
    expect((fetchImpl.mock.calls[0] as unknown as string[])[0]).toContain('/cancel/rp-wedged');
    expect(assetsRepo.reworkAsset).toHaveBeenCalledWith(
      expect.anything(), expect.any(Number), 'wan2-i2v', expect.objectContaining({ reason: 'stuck' }),
    );
    expect(assetsRepo.armProjectAsset).not.toHaveBeenCalled();
  });

  it('will not arm the tail while a gated asset is still unjudged', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    // The LAST kind in the frame chain hands off to nothing, so nothing
    // downstream stays blocked on it — without the gate check, an unjudged
    // clip would sail straight into the manifest.
    const rows = generatedProject(request()).map((r) =>
      r.kind === 'wan2-i2v' ? assetRow({ ...r, qualityStatus: null }) : r,
    );
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(rows);

    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('waiting');
    expect(assetsRepo.armProjectAsset).not.toHaveBeenCalled();
  });

  it('releases an asset left unjudged past the grace window rather than waiting forever', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    const stale = assetRow({ kind: 'qwen-image-gen', frameId: 'f1', qualityStatus: null });
    const rows = generatedProject(request()).map((r) => (r.kind === 'qwen-image-gen' && r.frameId === 'f1' ? stale : r));
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(rows);
    (assetsRepo.listStaleUngated as jest.Mock).mockResolvedValue([stale]);

    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('repaired');
    expect(assetsRepo.gateAssetSkipped).toHaveBeenCalledWith(
      expect.anything(),
      stale,
      expect.objectContaining({ url: stale.assetUrl }),
      // Releasing it unjudged still writes the handoff it was holding.
      [expect.objectContaining({ kind: 'wan2-i2v' })],
    );
  });

  it('recreates a row the plan expects but that does not exist', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    const rows = generatedProject(request()).filter((r) => !(r.kind === 'tts' && r.frameId === 'f2'));
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(rows);

    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('repaired');
    expect(assetsRepo.insertAssets).toHaveBeenCalledWith(
      expect.anything(), [expect.objectContaining({ kind: 'tts', frameId: 'f2', seq: 1 })],
    );
  });
});

describe('arming the tail', () => {
  it('compiles the manifest and arms the tail row — it never calls postprod-lite itself', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(generatedProject(request()));

    const fetchImpl = jest.fn();
    const res = await compileProject(deps(fetchImpl), 'proj_1');

    expect(res.action).toBe('armed');
    // The dispatch belongs to the postprod-lite agent, under its pod limit.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(pipelineRepo.beginAssembly).toHaveBeenCalled();
    expect(assetsRepo.armProjectAsset).toHaveBeenCalledWith(
      expect.anything(), 'proj_1', 'postprod-lite', expect.objectContaining({ frameId: PROJECT_SCOPE }),
    );

    const m = armedManifest()!;
    expect(m.frames.map((f) => f.frameId)).toEqual(['f1', 'f2']);
    expect(m.frames[0]).toMatchObject({ videoUrl: 'https://cdn/wan2-i2v-f1.mp4', audioUrl: 'https://cdn/tts-f1.mp4' });
    expect(m.droppedFrames).toEqual([]);
  });

  it('writes the manifest as a file when R2 is configured, and arms with the url', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(generatedProject(request()));

    const put = jest.fn(async () => undefined);
    const d = deps();
    d.r2 = { accountId: 'a', bucket: 'b', publicUrl: 'https://cdn', accessKeyId: 'k', secretAccessKey: 's', putImpl: put };

    const res = await compileProject(d, 'proj_1');

    expect(res.action).toBe('armed');
    expect(put).toHaveBeenCalled();
    const armed = (assetsRepo.armProjectAsset as jest.Mock).mock.calls[0][3];
    expect(armed.manifestUrl).toMatch(/^https:\/\/cdn\/pipeline-manifests\/proj_1\//);
    expect(armed.manifest).toBeUndefined();
  });

  it('falls back to an inline manifest when the upload fails', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(generatedProject(request()));

    const d = deps();
    d.r2 = {
      accountId: 'a', bucket: 'b', publicUrl: 'https://cdn', accessKeyId: 'k', secretAccessKey: 's',
      putImpl: async () => { throw new Error('R2 down'); },
    };

    const res = await compileProject(d, 'proj_1');
    expect(res.action).toBe('armed');
    expect(armedManifest()).toBeDefined();
  });

  it('carries the bgm track and the tail flags into the manifest', async () => {
    const req = request({ bgm: true, removeSilence: true, burnCaptions: true }, { bgmPrompt: 'soft piano' });
    const plan = compilePlan(req);
    (projectsRepo.getProject as jest.Mock).mockResolvedValue({ id: 'proj_1', requestId: 'req_1', request: req, callbackUrl: null });
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(
      generatedProject(req, { bgm: true, removeSilence: true, burnCaptions: true }),
    );

    await compileProject(deps(), 'proj_1');

    const m = armedManifest()!;
    expect(m.steps).toEqual({ removeSilence: true, burnCaptions: true, upscale: false });
    expect(m.bgm).toEqual({ url: 'https://cdn/bgm.mp3', volume: 0.15 });
    expect(m.captions).toBeDefined();
  });

  it('sends stills with a Ken Burns instruction when there is no motion model', async () => {
    const req = request({ motionEngine: 'animate' });
    const plan = compilePlan(req);
    (projectsRepo.getProject as jest.Mock).mockResolvedValue({ id: 'proj_1', requestId: 'req_1', request: req, callbackUrl: null });
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(generatedProject(req, { motionEngine: 'animate' }));

    await compileProject(deps(), 'proj_1');

    const m = armedManifest()!;
    expect(m.chain.motion).toBeNull();
    expect(m.frames[0].videoUrl).toBeUndefined();
    expect(m.frames[0].imageUrl).toBe('https://cdn/qwen-image-gen-f1.mp4');
    expect(m.frames[0].animate).toEqual({ effect: 'zoom_in', fps: 16 });
  });

  it('names a dropped frame in the manifest rather than silently omitting it', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    const rows = generatedProject(request()).map((r) =>
      r.kind === 'wan2-i2v' && r.frameId === 'f2'
        ? assetRow({ ...r, status: 'failed', assetUrl: null, error: { error: 'CUDA out of memory' } })
        : r,
    );
    // One surviving frame is not enough to concat, so add a third that works.
    const req3 = request({}, {
      frames: [
        { frameId: 'f1', imagePrompt: 'a', narration: 'one', durationS: 5 },
        { frameId: 'f2', imagePrompt: 'b', narration: 'two', durationS: 4 },
        { frameId: 'f3', imagePrompt: 'c', narration: 'three', durationS: 4 },
      ],
    });
    (projectsRepo.getProject as jest.Mock).mockResolvedValue({ id: 'proj_1', requestId: 'req_1', request: req3, callbackUrl: null });
    for (const kind of plan.frameKinds) rows.push(assetRow({ kind, frameId: 'f3', seq: 2 }));
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(rows);

    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('armed');
    const m = armedManifest()!;
    expect(m.frames.map((f) => f.frameId)).toEqual(['f1', 'f3']);
    expect(m.droppedFrames[0].frameId).toBe('f2');
    expect(m.droppedFrames[0].reason).toContain('CUDA out of memory');
  });

  it('fails the project rather than assembling fewer than two frames', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    const rows = generatedProject(request()).map((r) =>
      r.frameId === 'f2' && r.kind === 'wan2-i2v' ? assetRow({ ...r, status: 'failed', assetUrl: null }) : r,
    );
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(rows);

    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('failed');
    expect(res.detail).toBe('fewer than two usable frames');
    expect(assetsRepo.armProjectAsset).not.toHaveBeenCalled();
    expect(resultMod.finalizeAssetProject).toHaveBeenCalledWith(expect.anything(), 'proj_1', { status: 'failed', finalUrl: null });
  });

  it('does not arm twice when another tick already claimed assembly', async () => {
    const plan = compilePlan(request());
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(pipelineRow(plan));
    (pipelineRepo.beginAssembly as jest.Mock).mockResolvedValue(false);
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(generatedProject(request()));

    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('waiting');
    expect(assetsRepo.armProjectAsset).not.toHaveBeenCalled();
  });
});

describe('collecting the tail', () => {
  function assembling(over: Record<string, unknown> = {}, tail: Partial<AssetRow> = {}) {
    const plan = compilePlan(request());
    const manifest = { droppedFrames: [], frames: [] } as unknown as TailManifest;
    (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue(
      pipelineRow(plan, { status: 'assembling', manifest, attempts: 1, ...over }),
    );
    const rows = generatedProject(request()).filter((r) => r.kind !== 'postprod-lite');
    rows.push(assetRow({ kind: 'postprod-lite', frameId: PROJECT_SCOPE, status: 'submitted', assetUrl: null, ...tail }));
    (assetsRepo.listProjectAssets as jest.Mock).mockResolvedValue(rows);
  }

  it('waits while the postprod-lite agent still holds the job', async () => {
    assembling();
    const res = await compileProject(deps(), 'proj_1');
    expect(res.action).toBe('waiting');
    expect(pipelineRepo.finishPipelineProject).not.toHaveBeenCalled();
  });

  it('finishes the project on the final url the one-shot returned', async () => {
    assembling({}, { status: 'complete', assetUrl: 'https://cdn/final.mp4', durationS: 44.2 });
    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('assembled');
    expect(pipelineRepo.finishPipelineProject).toHaveBeenCalledWith(
      expect.anything(), 'proj_1', { status: 'completed', finalUrl: 'https://cdn/final.mp4' },
    );
    expect(resultMod.finalizeAssetProject).toHaveBeenCalledWith(
      expect.anything(), 'proj_1', { status: 'completed', finalUrl: 'https://cdn/final.mp4' },
    );
  });

  it('reports partial when the manifest dropped a frame', async () => {
    const manifest = { droppedFrames: [{ frameId: 'f2', reason: 'x' }], frames: [] } as unknown as TailManifest;
    assembling({ manifest }, { status: 'complete', assetUrl: 'https://cdn/final.mp4' });
    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('assembled');
    expect(pipelineRepo.finishPipelineProject).toHaveBeenCalledWith(
      expect.anything(), 'proj_1', expect.objectContaining({ status: 'partial' }),
    );
  });

  it('recompiles and retries when the tail failed and attempts remain', async () => {
    assembling({ attempts: 1 }, { status: 'failed', assetUrl: null, error: { error: 'ffmpeg exited 1' } });
    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('failed');
    expect(res.detail).toContain('ffmpeg');
    expect(pipelineRepo.returnToGenerating).toHaveBeenCalled();
    expect(pipelineRepo.finishPipelineProject).not.toHaveBeenCalled();
  });

  it('gives up once the assembly attempts are exhausted', async () => {
    assembling({ attempts: 5 }, { status: 'failed', assetUrl: null, error: { error: 'ffmpeg exited 1' } });
    const res = await compileProject(deps(), 'proj_1');

    expect(res.action).toBe('failed');
    expect(pipelineRepo.finishPipelineProject).toHaveBeenCalledWith(
      expect.anything(), 'proj_1', expect.objectContaining({ status: 'failed' }),
    );
    expect(resultMod.finalizeAssetProject).toHaveBeenCalledWith(expect.anything(), 'proj_1', { status: 'failed', finalUrl: null });
  });
});
