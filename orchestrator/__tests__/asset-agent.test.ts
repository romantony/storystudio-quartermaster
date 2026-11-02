/**
 * Unit tests for assets/agent.ts — the loop all the generator agents share.
 *
 * Same convention as generator.test.ts: the repo layer is mocked rather than
 * hit for real (the SQL itself is covered against a live Postgres in
 * asset-repo.integration.test.ts), and RunpodClient is driven by a fake
 * fetch. What is under test here is the agent's *decisions* — how much it
 * dispatches, what it does with each kind of provider answer, and whether a
 * bad row can take anything else down with it.
 */
import { RunpodClient } from '../src/runpod/client';
import { runAssetAgentTick, usesGeminiTts, applyAssetSuccess, completeRunpodAsset, assetWebhookToken, resolveHandoffs, type AssetAgentDeps } from '../src/assets/agent';
import { webhookToken } from '../src/agents/generator';
import { compilePlan } from '../src/assets/plan';
import { executionName, type SfnImpl, type SfnExecution } from '../src/aws/sfn';
import { ASSET_SPECS } from '../src/assets/kinds';
import { RequestSchema } from '../src/agents/planner';
import * as assetsRepo from '../src/db/repo/assets';
import * as costsRepo from '../src/db/repo/asset-costs';
import * as pipelineRepo from '../src/db/repo/pipeline';
import type { AssetRow } from '../src/db/repo/assets';
import * as conform from '../src/assets/conform-media';
import * as r2Client from '../src/r2/client';
import { GEMINI_BASE, GEMINI_TTS_DEFAULT_MODEL, geminiTtsRequestFromRunpod, pcmToWav, runGeminiTts, ttsPayloadGender } from '../src/google/tts';

jest.mock('../src/db/repo/assets');
jest.mock('../src/db/repo/asset-costs');
jest.mock('../src/db/repo/pipeline');

const RUNPOD_CFG = {
  runpodApiBase: 'https://api.runpod.ai/v2',
  runpodRestBase: 'https://rest.runpod.io/v1',
  runpodApiKey: 'test-key',
  runpodMaxRetries: 0,
  runpodTimeoutMs: 1000,
};

const CFG: AssetAgentDeps['cfg'] = {
  workerRateUsdS: 0.00021,
  maxAttempts: 2,
  maxResourceAttempts: 5,
  assetReconcileAfterMs: 60_000,
  assetDispatchBatchSize: 10,
  lambdaRenderRateUsdS: 0.000127,
  kieSeedanceRateUsdS: 0.04,
  comfyRateUsdS: 0.0005,
  animateLambdaRateUsdS: 0.000167,
  kieQwenFallback: true,
  kieQwenRateUsdImage: 0.03,
  geminiTtsFallback: true,
  geminiTtsVoiceMale: 'Enzo',
  geminiTtsVoiceFemale: 'Tova',
  geminiTtsRateUsdS: 0.0005,
};

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
    callbackUrl: 'https://convex.example/api/qm/result',
    options: {},
    frames: [
      { frameId: 'f1', imagePrompt: 'a lighthouse at dusk', narration: 'one', durationS: 5 },
      { frameId: 'f2', imagePrompt: 'a harbour', narration: 'two', durationS: 4 },
    ],
  }),
);

function fakeRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function row(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: 101,
    kind: 'qwen-image-gen',
    projectId: 'proj_1',
    frameId: 'f1',
    seq: 0,
    status: 'pending',
    endpointId: ASSET_SPECS['qwen-image-gen'].endpointId,
    provider: 'runpod',
    requiredInputs: [],
    sources: {},
    input: { frameId: 'f1', imagePrompt: 'a lighthouse at dusk', narration: 'one', durationS: 5, aspectRatio: '9:16' },
    stage: null,
    stages: [],
    output: null,
    assetUrl: null,
    durationS: null,
    error: null,
    attempts: 0,
    reworks: 0,
    providerJobId: null,
    submittedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as AssetRow;
}

/** A pool whose inline SELECTs answer with a scripted row, so the agent's own
 * under-lock re-checks behave like a real database. */
function fakePool(script: { claimStatus?: string; successRow?: Record<string, unknown> } = {}) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      // Two different `SELECT status` re-checks, distinguished the way the
      // real ones are: the claim uses SKIP LOCKED and expects 'pending', the
      // terminal-transition one does not and expects 'submitted'.
      if (sql.includes('SELECT status FROM assets')) {
        const status = sql.includes('SKIP LOCKED') ? (script.claimStatus ?? 'pending') : 'submitted';
        return { rows: [{ status }], rowCount: 1 };
      }
      if (sql.includes('SELECT id, asset_kind, project_id')) {
        return {
          rows: [
            {
              id: 101,
              asset_kind: 'qwen-image-gen',
              project_id: 'proj_1',
              frame_id: 'f1',
              seq: 0,
              status: 'submitted',
              stage: null,
              stages: [],
              input: {},
              sources: {},
              asset_url: null,
              duration_s: null,
              provider_job_id: 'rp-1',
              endpoint_id: ASSET_SPECS['qwen-image-gen'].endpointId,
              ...script.successRow,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(async () => client),
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as AssetAgentDeps['pool'];
  return { pool, client, queries };
}

function deps(fetchImpl: jest.Mock, poolLike = fakePool()): AssetAgentDeps & { queries: Array<{ sql: string }> } {
  return {
    pool: poolLike.pool,
    runpod: new RunpodClient(RUNPOD_CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined }),
    cfg: CFG,
    publicBaseUrl: 'https://orchestrator.example',
    webhookSecret: 'shhh',
    sleepImpl: async () => undefined,
    queries: poolLike.queries,
  } as AssetAgentDeps & { queries: Array<{ sql: string }> };
}

beforeEach(() => {
  jest.clearAllMocks();
  (pipelineRepo.getPipelineProject as jest.Mock).mockResolvedValue({ projectId: 'proj_1', plan: PLAN });
  (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([]);
  (assetsRepo.claimPending as jest.Mock).mockResolvedValue([]);
  (assetsRepo.countInFlightForEndpoint as jest.Mock).mockResolvedValue(0);
  (assetsRepo.markSubmitted as jest.Mock).mockResolvedValue(undefined);
  (assetsRepo.completeAsset as jest.Mock).mockResolvedValue(undefined);
  (assetsRepo.advanceStage as jest.Mock).mockResolvedValue(undefined);
  (assetsRepo.failOrRetryAsset as jest.Mock).mockResolvedValue(true);
  (costsRepo.recordAssetCost as jest.Mock).mockResolvedValue(undefined);
});

describe('dispatch', () => {
  it('never puts more jobs on an endpoint than it has pods', async () => {
    const spec = ASSET_SPECS['qwen-image-gen'];
    (assetsRepo.countInFlightForEndpoint as jest.Mock).mockResolvedValue(spec.maxInFlight);
    const fetchImpl = jest.fn();

    const summary = await runAssetAgentTick(deps(fetchImpl), 'qwen-image-gen');

    expect(summary.skippedNoRoom).toBe(true);
    expect(summary.submitted).toBe(0);
    expect(assetsRepo.claimPending).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('claims only up to the remaining room on its endpoint', async () => {
    const spec = ASSET_SPECS['qwen-image-gen'];
    (assetsRepo.countInFlightForEndpoint as jest.Mock).mockResolvedValue(spec.maxInFlight - 1);
    const fetchImpl = jest.fn(async () => fakeRes(200, { id: 'rp-1', status: 'IN_QUEUE' }));

    await runAssetAgentTick(deps(fetchImpl as unknown as jest.Mock), 'qwen-image-gen');

    expect(assetsRepo.claimPending).toHaveBeenCalledWith(expect.anything(), 'qwen-image-gen', 1);
  });

  it('submits with a per-asset webhook URL and records the provider job id', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([row()]);
    const sent: Array<{ url: string; init: { body: string } }> = [];
    const fetchImpl = jest.fn(async (url: string, init: { body: string }) => {
      sent.push({ url, init });
      return fakeRes(200, { id: 'rp-42', status: 'IN_QUEUE' });
    });

    const summary = await runAssetAgentTick(deps(fetchImpl as unknown as jest.Mock), 'qwen-image-gen');

    expect(summary.submitted).toBe(1);
    const body = JSON.parse(sent[0].init.body);
    expect(body.webhook).toBe(`https://orchestrator.example/v1/webhooks/asset/${assetWebhookToken('shhh', 101)}`);
    // The payload is the existing builder's, unchanged.
    expect(body.input.prompt).toContain('a lighthouse at dusk');
    expect(assetsRepo.markSubmitted).toHaveBeenCalledWith(expect.anything(), 101, 'qwen-image-gen', 'rp-42');
  });

  it('fails only the offending row when its payload cannot be built', async () => {
    // wan2-i2v with no resolved image — builders/i2v.ts throws. The tick must
    // survive it: one frame's broken upstream cannot abort the agent.
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([
      row({ id: 7, kind: 'wan2-i2v', endpointId: ASSET_SPECS['wan2-i2v'].endpointId, sources: {} }),
    ]);
    const fetchImpl = jest.fn();
    const poolLike = fakePool();

    const summary = await runAssetAgentTick(deps(fetchImpl, poolLike), 'wan2-i2v');

    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    const failWrite = poolLike.queries.find((q) => q.sql.includes("status = 'failed'"));
    expect(failWrite).toBeDefined();
  });

  it('does not submit a row another worker already claimed', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([row()]);
    const fetchImpl = jest.fn();
    const poolLike = fakePool({ claimStatus: 'submitted' });

    const summary = await runAssetAgentTick(deps(fetchImpl, poolLike), 'qwen-image-gen');

    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('completion', () => {
  it('hands off a GATED kind immediately — QA does not block the chain', async () => {
    const outcome = await applyAssetSuccess(deps(jest.fn()), 101, 'qwen-image-gen', { image: 'https://cdn/f1.png' }, {
      executionMs: 4200,
      delayMs: 100,
    });

    expect(outcome).toBe('completed');
    const [, rowArg, result, handoffs, gated] = (assetsRepo.completeAsset as jest.Mock).mock.calls[0];
    expect(rowArg).toMatchObject({ id: 101, kind: 'qwen-image-gen', projectId: 'proj_1', frameId: 'f1' });
    expect(result.assetUrl).toBe('https://cdn/f1.png');
    // Operator's call (2026-09-19): downstream generation starts at once and
    // the verdict lands in parallel. What the verdict gates is ASSEMBLY — the
    // compiler will not compile until every gated asset has one.
    //
    // `gated: true` means ONLY "leave quality_status NULL so the QA agent
    // queues it". Conflating it with "defer the handoff" deadlocked a live
    // project: every asset completed 'ungated', the QA queue stayed empty and
    // the project verdict never left 'pending'. The handoff below is what
    // proves the two are now separate.
    expect(gated).toBe(true);
    expect(handoffs.map((h: { kind: string }) => h.kind)).toEqual(['wan2-i2v']);
    expect(costsRepo.recordAssetCost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ assetId: 101, executionMs: 4200, delayMs: 100 }),
    );
  });

  it('marks an UNGATED kind judged at completion, so it never enters the QA queue', async () => {
    const poolLike = fakePool({ successRow: { asset_kind: 'tts', endpoint_id: ASSET_SPECS.tts.endpointId } });
    const outcome = await applyAssetSuccess(deps(jest.fn(), poolLike), 101, 'tts', {
      audio: 'https://cdn/f1.mp3',
      duration_s: 5.4,
    });

    expect(outcome).toBe('completed');
    const [, , , handoffs, gated] = (assetsRepo.completeAsset as jest.Mock).mock.calls[0];
    expect(gated).toBe(false);
    // tts feeds wan2-i2v (real clip length); the narration itself is read by
    // the tail from the manifest, so nothing else waits on it.
    expect(handoffs.map((h: { kind: string }) => h.kind)).toEqual(['wan2-i2v']);
  });

  it('refuses a COMPLETED whose output carries a worker error string', async () => {
    // Workers report their own failures inside a COMPLETED job. Treating that
    // as success is exactly how rows end up "complete" with no asset behind
    // them.
    const outcome = await applyAssetSuccess(deps(jest.fn()), 101, 'qwen-image-gen', { error: 'ffmpeg exited 1' });

    expect(outcome).toBe('noop'); // retried
    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
    expect(assetsRepo.failOrRetryAsset).toHaveBeenCalled();
  });

  it('refuses a COMPLETED with no URL anywhere in its output', async () => {
    const outcome = await applyAssetSuccess(deps(jest.fn()), 101, 'qwen-image-gen', { ok: true });
    expect(outcome).toBe('noop');
    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
  });

  it('completes a skip: passthrough (not an http url) and leaves it ungated — live bug 2026-10-04', async () => {
    const poolLike = fakePool({ successRow: { asset_kind: 'qwen-image-gen', endpoint_id: ASSET_SPECS['qwen-image-gen'].endpointId } });
    const outcome = await applyAssetSuccess(deps(jest.fn(), poolLike), 101, 'qwen-image-gen', {
      image: 'skip:char', __passthrough: true, __passthroughUrl: 'skip:char',
    });
    expect(outcome).toBe('completed');
    expect(assetsRepo.failOrRetryAsset).not.toHaveBeenCalled();
    const [, , result, , gated] = (assetsRepo.completeAsset as jest.Mock).mock.calls[0];
    expect(result.assetUrl).toBe('skip:char');
    expect(gated).toBe(false); // a gated kind's skip row must not enter QA
  });

  it('does nothing when the row is no longer submitted (webhook racing reconcile)', async () => {
    const poolLike = fakePool({ successRow: { status: 'complete' } });
    const outcome = await applyAssetSuccess(deps(jest.fn(), poolLike), 101, 'qwen-image-gen', { image: 'https://cdn/x.png' });
    expect(outcome).toBe('noop');
    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
  });

});

describe('completion conforms stills to the project size (2026-10-17)', () => {
  const row = (aspectRatio?: string) => ({ id: 101, projectId: 'proj_1', frameId: 'f1', input: { aspectRatio } as AssetRow['input'] });
  const R2 = { accountId: 'a', bucket: 'b', publicUrl: 'https://r2.example', accessKeyId: 'k', secretAccessKey: 's' };
  afterEach(() => jest.restoreAllMocks());

  it('re-hosts a wrong-size still and completes with the conformed url', async () => {
    jest.spyOn(conform, 'conformStill').mockResolvedValue(Buffer.from('png'));
    const put = jest.spyOn(r2Client, 'putBytesToR2').mockResolvedValue('https://r2.example/stills/proj_1/f1-qwen-image-gen.png');
    const outcome = await completeRunpodAsset({ ...deps(jest.fn()), r2: R2 }, row('16:9'), 'qwen-image-gen', { image_url: 'https://worker/x.png' });
    expect(outcome).toBe('completed');
    expect(conform.conformStill).toHaveBeenCalledWith('https://worker/x.png', [1280, 720]);
    expect(put.mock.calls[0][1]).toBe('stills/proj_1/f1-qwen-image-gen.png');
    expect((assetsRepo.completeAsset as jest.Mock).mock.calls[0][2].assetUrl).toBe('https://r2.example/stills/proj_1/f1-qwen-image-gen.png');
  });
  it('keeps the worker url when the still is already the size', async () => {
    jest.spyOn(conform, 'conformStill').mockResolvedValue(null);
    await completeRunpodAsset({ ...deps(jest.fn()), r2: R2 }, row('9:16'), 'qwen-image-gen', { image: 'https://worker/x.png' });
    expect((assetsRepo.completeAsset as jest.Mock).mock.calls[0][2].assetUrl).toBe('https://worker/x.png');
  });
  it('conforms a generated Wan2 clip and completes with the re-hosted url', async () => {
    jest.spyOn(conform, 'conformClipUrl').mockResolvedValue(Buffer.from('mp4'));
    const put = jest.spyOn(r2Client, 'putBytesToR2').mockResolvedValue('https://r2.example/clips/proj_1/f1-wan2-i2v.mp4');
    const poolLike = fakePool({ successRow: { asset_kind: 'wan2-i2v', endpoint_id: ASSET_SPECS['wan2-i2v'].endpointId } });
    await completeRunpodAsset({ ...deps(jest.fn(), poolLike), r2: R2 }, row('16:9'), 'wan2-i2v', { video: 'https://worker/c.mp4' });
    expect(conform.conformClipUrl).toHaveBeenCalledWith('https://worker/c.mp4', [1280, 720]);
    expect(put.mock.calls[0][3]).toBe('video/mp4');
    expect((assetsRepo.completeAsset as jest.Mock).mock.calls[0][2].assetUrl).toBe('https://r2.example/clips/proj_1/f1-wan2-i2v.mp4');
  });
  it('leaves non-image kinds, other aspects and worker errors alone', async () => {
    const spy = jest.spyOn(conform, 'conformStill');
    const poolLike = fakePool({ successRow: { asset_kind: 'tts', endpoint_id: ASSET_SPECS.tts.endpointId } });
    await completeRunpodAsset({ ...deps(jest.fn(), poolLike), r2: R2 }, row('16:9'), 'tts', { audio: 'https://cdn/a.mp3' });
    await completeRunpodAsset({ ...deps(jest.fn()), r2: R2 }, row('1:1'), 'qwen-image-gen', { image: 'https://worker/x.png' });
    await completeRunpodAsset({ ...deps(jest.fn()), r2: R2 }, row('16:9'), 'qwen-image-gen', { error: 'oom' });
    expect(spy).not.toHaveBeenCalled();
  });
  it('fails the attempt (never completes at the wrong size) when conforming fails', async () => {
    jest.spyOn(conform, 'conformStill').mockRejectedValue(new Error('ffmpeg: boom'));
    const outcome = await completeRunpodAsset({ ...deps(jest.fn()), r2: R2 }, row('16:9'), 'qwen-edit', { image: 'https://worker/x.png' });
    expect(outcome).toBe('noop'); // retried
    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
    expect(assetsRepo.failOrRetryAsset).toHaveBeenCalled();
  });
});

describe('the Step Functions-backed sfn-tail agent', () => {
  const MANIFEST = 'https://cdn/pipeline-manifests/proj_1/m.json';
  const ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:Tail';

  function tailRow(over: Partial<AssetRow> = {}): AssetRow {
    return row({
      id: 900,
      kind: 'sfn-tail',
      frameId: '*',
      provider: 'sfn',
      endpointId: ASSET_SPECS['sfn-tail'].endpointId,
      input: {
        manifestUrl: MANIFEST,
        aspectRatio: '9:16',
        language: 'en',
        options: { removeSilence: true, captions: true, bgm: true, bgmPrompt: 'soft piano', sfx: false },
        totalDurationS: 9,
      },
      ...over,
    });
  }

  function running(over: Partial<AssetRow> = {}): AssetRow {
    return tailRow({ status: 'submitted', providerJobId: 'arn:exec:proj_1', submittedAt: new Date(Date.now() - 60_000), ...over });
  }

  function sfnDeps(impl: Partial<SfnImpl>, poolLike = fakePool()): AssetAgentDeps & { queries: Array<{ sql: string }> } {
    const d = deps(jest.fn(), poolLike);
    d.sfn = {
      stateMachineArn: ARN,
      region: 'us-east-1',
      impl: {
        start: jest.fn(async () => ({ executionArn: 'arn:exec:default' })),
        describe: jest.fn(async () => ({ status: 'RUNNING' }) as SfnExecution),
        stop: jest.fn(async () => undefined),
        ...impl,
      },
    };
    return d;
  }

  const tailPool = () =>
    fakePool({ successRow: { asset_kind: 'sfn-tail', frame_id: '*', endpoint_id: ASSET_SPECS['sfn-tail'].endpointId } });

  it('starts one execution with references only, and records its ARN as the provider job id', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([tailRow()]);
    const start = jest.fn(async () => ({ executionArn: 'arn:exec:proj_1' }));

    const summary = await runAssetAgentTick(sfnDeps({ start }), 'sfn-tail');

    expect(summary.submitted).toBe(1);
    const [arn, name, input] = start.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(arn).toBe(ARN);
    // Deterministic: attempt number + a hash of THIS manifest, so a replayed
    // start adopts the running execution and a recompile gets a fresh name.
    expect(name).toBe(executionName('proj_1', 1, MANIFEST));
    expect(input).toEqual({
      projectId: 'proj_1',
      manifestUrl: MANIFEST,
      aspectRatio: '9:16',
      language: 'en',
      options: { removeSilence: true, captions: true, bgm: true, bgmPrompt: 'soft piano', sfx: false },
      totalDurationS: 9,
      outputPrefix: 'projects/proj_1/tail/',
    });
    expect(assetsRepo.markSubmitted).toHaveBeenCalledWith(expect.anything(), 900, 'sfn-tail', 'arn:exec:proj_1');
  });

  it('never calls RunPod for the tail', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([tailRow()]);
    const runpodFetch = jest.fn();
    const d = sfnDeps({});
    (d as { runpod: unknown }).runpod = new RunpodClient(RUNPOD_CFG, {
      fetchImpl: runpodFetch as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });

    await runAssetAgentTick(d, 'sfn-tail');

    expect(runpodFetch).not.toHaveBeenCalled();
  });

  it('fails the row, without calling AWS, when it was armed without a manifest url', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([tailRow({ input: { aspectRatio: '9:16' } })]);
    const start = jest.fn();
    const poolLike = fakePool();

    const summary = await runAssetAgentTick(sfnDeps({ start }, poolLike), 'sfn-tail');

    expect(summary.submitted).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(poolLike.queries.some((q) => q.sql.includes("status = 'failed'"))).toBe(true);
  });

  it('does not submit when no sfn transport is configured', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([tailRow()]);

    const summary = await runAssetAgentTick(deps(jest.fn()), 'sfn-tail');

    expect(summary.submitted).toBe(0);
    expect(assetsRepo.markSubmitted).not.toHaveBeenCalled();
  });

  it('keeps polling while the execution is RUNNING, and touches the row', async () => {
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([running()]);
    const describeFn = jest.fn(async () => ({ status: 'RUNNING' }) as SfnExecution);

    await runAssetAgentTick(sfnDeps({ describe: describeFn }), 'sfn-tail');

    expect(describeFn).toHaveBeenCalledWith('arn:exec:proj_1');
    expect(assetsRepo.touchAsset).toHaveBeenCalledWith(expect.anything(), 900, 'sfn-tail');
    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
  });

  it('completes the row on SUCCEEDED, with the final url, its duration and the per-frame clips', async () => {
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([running()]);
    const frames = [{ frameId: 'f1', url: 'https://cdn/f1-merged.mp4' }];
    const d = sfnDeps(
      {
        describe: jest.fn(
          async () => ({ status: 'SUCCEEDED', output: { videoUrl: 'https://cdn/final.mp4', durationSec: 44.2, frames } }) as SfnExecution,
        ),
      },
      tailPool(),
    );

    const summary = await runAssetAgentTick(d, 'sfn-tail');

    expect(summary.completed).toBe(1);
    const [, , result, handoffs] = (assetsRepo.completeAsset as jest.Mock).mock.calls[0];
    expect(result).toMatchObject({ assetUrl: 'https://cdn/final.mp4', durationS: 44.2 });
    expect(result.output.frames).toEqual(frames);
    expect(handoffs).toEqual([]);
    // An execution has no worker-seconds rate: nothing is billed as GPU time.
    expect(costsRepo.recordAssetCost).not.toHaveBeenCalled();
  });

  it('treats SUCCEEDED with no video url as a failure, never a complete row with nothing behind it', async () => {
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([running()]);
    const d = sfnDeps({ describe: jest.fn(async () => ({ status: 'SUCCEEDED', output: {} }) as SfnExecution) }, tailPool());

    await runAssetAgentTick(d, 'sfn-tail');

    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
    expect(assetsRepo.failOrRetryAsset).toHaveBeenCalled();
  });

  it.each(['FAILED', 'TIMED_OUT', 'ABORTED'] as const)('routes a %s execution through the shared failure path', async (status) => {
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([running()]);
    const d = sfnDeps({ describe: jest.fn(async () => ({ status, error: 'ECSTaskFailed', cause: 'ffmpeg exited 1' }) as SfnExecution) });

    await runAssetAgentTick(d, 'sfn-tail');

    const [, , , err] = (assetsRepo.failOrRetryAsset as jest.Mock).mock.calls[0];
    expect(err).toMatchObject({ provider: 'sfn', status });
    expect(err.error).toContain('ffmpeg exited 1');
  });

  it('stops an execution still RUNNING past the wall-clock budget, then requeues the row', async () => {
    const spec = ASSET_SPECS['sfn-tail'];
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([
      running({ submittedAt: new Date(Date.now() - (spec.timeoutMs as number) - 1_000) }),
    ]);
    (assetsRepo.reworkAsset as jest.Mock).mockResolvedValue(true);
    const stop = jest.fn(async () => undefined);

    const summary = await runAssetAgentTick(sfnDeps({ stop }), 'sfn-tail');

    expect(summary.timedOut).toBe(1);
    expect(stop).toHaveBeenCalledWith('arn:exec:proj_1', expect.stringContaining('timeout'));
    expect(assetsRepo.reworkAsset).toHaveBeenCalled();
  });

  it('retries the status check next tick when AWS errors, rather than failing the row', async () => {
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([running()]);
    const d = sfnDeps({
      describe: jest.fn(async () => {
        throw new Error('ThrottlingException');
      }),
    });

    await runAssetAgentTick(d, 'sfn-tail');

    expect(assetsRepo.failOrRetryAsset).not.toHaveBeenCalled();
    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
  });

  it('is capped at its own concurrency ceiling, not a pod count', async () => {
    (assetsRepo.countInFlightForEndpoint as jest.Mock).mockResolvedValue(ASSET_SPECS['sfn-tail'].maxInFlight);

    const summary = await runAssetAgentTick(sfnDeps({}), 'sfn-tail');

    expect(summary.skippedNoRoom).toBe(true);
    expect(assetsRepo.claimPending).not.toHaveBeenCalled();
  });
});

describe('request timeouts', () => {
  // The budget is GENERATION time, not wall clock. Measured live 2026-09-19
  // with only 18 frames: wan2-i2v's worst job was 199.3s queued + 100.2s
  // executing = 299.5s against a 300s budget. Counting the queue would have
  // cancelled a healthy job — and under 111 frames against 4 pods it would
  // cancel nearly all of them, forever.
  function statusFetch(body: Record<string, unknown>) {
    return jest.fn(async (url: string) => {
      if (url.includes('/cancel/')) return fakeRes(200, { status: 'CANCELLED' });
      return fakeRes(200, body);
    });
  }

  it('does NOT time out a job that is only sitting in the queue', async () => {
    const spec = ASSET_SPECS['wan2-i2v'];
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([
      row({ id: 310, kind: 'wan2-i2v', endpointId: spec.endpointId, status: 'submitted', providerJobId: 'rp-queued',
            submittedAt: new Date(Date.now() - (spec.timeoutMs as number) - 60_000) }),
    ]);
    const fetchImpl = statusFetch({ id: 'rp-queued', status: 'IN_QUEUE' });

    const summary = await runAssetAgentTick(deps(fetchImpl as unknown as jest.Mock), 'wan2-i2v');

    expect(summary.timedOut).toBe(0);
    expect(assetsRepo.reworkAsset).not.toHaveBeenCalled();
  });

  it('subtracts RunPod\u2019s own queue time before judging the budget', async () => {
    const spec = ASSET_SPECS['wan2-i2v'];
    // 290s outstanding, of which 250s was queue: only 40s of generation.
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([
      row({ id: 311, kind: 'wan2-i2v', endpointId: spec.endpointId, status: 'submitted', providerJobId: 'rp-running',
            submittedAt: new Date(Date.now() - 290_000) }),
    ]);
    const fetchImpl = statusFetch({ id: 'rp-running', status: 'IN_PROGRESS', delayTime: 250_000 });

    const summary = await runAssetAgentTick(deps(fetchImpl as unknown as jest.Mock), 'wan2-i2v');

    expect(summary.timedOut).toBe(0);
    expect(assetsRepo.reworkAsset).not.toHaveBeenCalled();
  });

  it('cancels and resubmits when GENERATION outruns the budget', async () => {
    const spec = ASSET_SPECS['qwen-image-gen'];
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([
      row({ id: 312, status: 'submitted', providerJobId: 'rp-wedged',
            submittedAt: new Date(Date.now() - (spec.timeoutMs as number) - 30_000) }),
    ]);
    (assetsRepo.reworkAsset as jest.Mock).mockResolvedValue(true);
    const fetchImpl = statusFetch({ id: 'rp-wedged', status: 'IN_PROGRESS', delayTime: 5_000 });

    const summary = await runAssetAgentTick(deps(fetchImpl as unknown as jest.Mock), 'qwen-image-gen');

    expect(summary.timedOut).toBe(1);
    const urls = fetchImpl.mock.calls.map((c) => (c as unknown as string[])[0]);
    expect(urls.some((u) => u.includes('/cancel/rp-wedged'))).toBe(true);
    expect(assetsRepo.reworkAsset).toHaveBeenCalledWith(
      expect.anything(), 312, 'qwen-image-gen', expect.objectContaining({ reason: 'timeout' }),
    );
  });

  it('eventually recovers a job that never leaves the queue at all', async () => {
    const spec = ASSET_SPECS.tts;
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([
      row({ id: 313, kind: 'tts', endpointId: spec.endpointId, status: 'submitted', providerJobId: 'rp-stuck',
            submittedAt: new Date(Date.now() - (spec.timeoutMs as number) * 25) }),
    ]);
    (assetsRepo.reworkAsset as jest.Mock).mockResolvedValue(true);
    const fetchImpl = statusFetch({ id: 'rp-stuck', status: 'IN_QUEUE' });

    const summary = await runAssetAgentTick(deps(fetchImpl as unknown as jest.Mock), 'tts');

    expect(summary.timedOut).toBe(1);
  });

  it('exempts remotion from timeouts and cancellation entirely', () => {
    expect(ASSET_SPECS.remotion.timeoutMs).toBeNull();
    expect(ASSET_SPECS.remotion.cancelOnTimeout).toBe(false);
  });

  it('stops an sfn-tail execution on timeout rather than letting it run on', () => {
    expect(ASSET_SPECS['sfn-tail'].cancelOnTimeout).toBe(true);
    // The state machine's own 90-minute timeout must fire before ours.
    expect(ASSET_SPECS['sfn-tail'].timeoutMs).toBeGreaterThan(90 * 60_000);
  });

  it('carries the operator\u2019s timeout budgets', () => {
    expect(ASSET_SPECS['qwen-image-gen'].timeoutMs).toBe(300_000);
    expect(ASSET_SPECS['qwen-edit'].timeoutMs).toBe(300_000);
    expect(ASSET_SPECS.tts.timeoutMs).toBe(300_000);
    expect(ASSET_SPECS.mmaudio.timeoutMs).toBe(150_000);
    expect(ASSET_SPECS['wan2-i2v'].timeoutMs).toBe(300_000);
  });
});

describe('the lambda-backed animate (Ken Burns) agent (2026-10-03)', () => {
  function animateRow() {
    return row({
      id: 800,
      kind: 'animate',
      endpointId: ASSET_SPECS.animate.endpointId,
      sources: {
        'qwen-image-gen': { url: 'https://cdn/f1.png' },
        tts: { url: 'https://cdn/f1.mp3', durationS: 3.47 },
      },
      input: { frameId: 'f1', imagePrompt: 'p', narration: 'n', durationS: 5, animateEffect: 'pan_left' },
    });
  }

  it('invokes QM-animate sized to the REAL narration, completes on its S3 clip — no RunPod, no re-host', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([animateRow()]);
    const runpodFetch = jest.fn();
    const invoked: unknown[] = [];
    const invokeImpl = jest.fn(async (_fn: string, _region: string, payload: unknown) => {
      invoked.push(payload);
      return { videoUrl: 'https://s3/projects/proj_1/animate/f1.mp4', durationS: 3.5625 };
    });
    const put = jest.fn(async () => undefined);
    const d = deps(runpodFetch, fakePool({ successRow: { asset_kind: 'animate', endpoint_id: ASSET_SPECS.animate.endpointId } }));
    d.animateLambda = { functionName: 'QM-animate', region: 'us-east-1', invokeImpl };
    d.r2 = { accountId: 'a', bucket: 'b', publicUrl: 'https://cdn', accessKeyId: 'k', secretAccessKey: 's', putImpl: put };

    const summary = await runAssetAgentTick(d, 'animate');

    expect(summary.submitted).toBe(1);
    expect(runpodFetch).not.toHaveBeenCalled();
    expect(invokeImpl.mock.calls[0][0]).toBe('QM-animate');
    expect(invoked[0]).toEqual({
      imageUrl: 'https://cdn/f1.png',
      durationS: 3.47, // TTS's real length, not the 5s estimate
      effect: 'pan_left',
      fps: 16,
      projectId: 'proj_1',
      frameId: 'f1',
    });
    expect(put).not.toHaveBeenCalled(); // already in QM's own bucket
    const [, , result] = (assetsRepo.completeAsset as jest.Mock).mock.calls[0];
    expect(result.assetUrl).toBe('https://s3/projects/proj_1/animate/f1.mp4');
    expect(result.durationS).toBe(3.5625);
  });

  it('fails the row (not the agent) when the Lambda errors', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([animateRow()]);
    const d = deps(jest.fn(), fakePool({ successRow: { asset_kind: 'animate', endpoint_id: ASSET_SPECS.animate.endpointId } }));
    d.animateLambda = { functionName: 'QM-animate', region: 'us-east-1', invokeImpl: async () => { throw new Error('ffmpeg Ken Burns failed'); } };

    await expect(runAssetAgentTick(d, 'animate')).resolves.toBeDefined();
    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
  });
});

describe('the lambda-backed remotion agent', () => {
  function lambdaRow() {
    return row({
      id: 700,
      kind: 'remotion',
      endpointId: ASSET_SPECS.remotion.endpointId,
      sources: { 'wan2-i2v': { url: 'https://cdn/raw.mp4', durationS: 5 } },
      input: {
        frameId: 'f1',
        imagePrompt: 'p',
        narration: 'n',
        durationS: 5,
        textManifest: { fps: 30, durationInFrames: 150, background: { type: 'video', src: '' }, textElements: [] },
      },
    });
  }

  it('invokes Lambda, re-hosts the render in R2 and completes — no RunPod call', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([lambdaRow()]);
    const runpodFetch = jest.fn();
    const invoked: Array<{ clipUrl: string; textManifest: string }> = [];
    const invokeImpl = jest.fn(async (_fn: string, _region: string, payload: unknown) => {
      invoked.push(payload as { clipUrl: string; textManifest: string });
      return { overlayRenderedUrl: 'https://remotion-s3/out.mp4' };
    });
    const put = jest.fn(async () => undefined);
    const d = deps(runpodFetch, fakePool({ successRow: { asset_kind: 'remotion', endpoint_id: ASSET_SPECS.remotion.endpointId } }));
    d.lambda = { functionName: 'QM-remotion-overlay', region: 'us-east-1', invokeImpl };
    d.r2 = { accountId: 'a', bucket: 'b', publicUrl: 'https://cdn', accessKeyId: 'k', secretAccessKey: 's', putImpl: put, fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8), headers: { get: () => 'video/mp4' } }) };

    const summary = await runAssetAgentTick(d, 'remotion');

    expect(summary.submitted).toBe(1);
    // Never touches RunPod: the endpoint id is a sentinel.
    expect(runpodFetch).not.toHaveBeenCalled();
    const payload = invoked[0];
    expect(payload.clipUrl).toBe('https://cdn/raw.mp4');
    // The clip is injected as the composition's background.
    expect(JSON.parse(payload.textManifest).background).toEqual({ type: 'video', src: 'https://cdn/raw.mp4' });
    // Re-hosted, never completed on Remotion's own expiring S3 URL.
    expect(put).toHaveBeenCalled();
    const [, , result] = (assetsRepo.completeAsset as jest.Mock).mock.calls[0];
    expect(result.assetUrl).toMatch(/^https:\/\/cdn\/remotion-overlay\/proj_1\/f1\.mp4$/);
  });

  it('passes a frame with no textManifest straight through, never invoking Lambda', async () => {
    const noText = lambdaRow();
    (noText.input as Record<string, unknown>).textManifest = undefined;
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([noText]);
    const invokeImpl = jest.fn();
    const d = deps(jest.fn(), fakePool({ successRow: { asset_kind: 'remotion', endpoint_id: ASSET_SPECS.remotion.endpointId } }));
    d.lambda = { functionName: 'f', region: 'r', invokeImpl };

    await runAssetAgentTick(d, 'remotion');

    expect(invokeImpl).not.toHaveBeenCalled();
    const [, , result] = (assetsRepo.completeAsset as jest.Mock).mock.calls[0];
    // The clip passes through unchanged, so a mixed project does not drop it.
    expect(result.assetUrl).toBe('https://cdn/raw.mp4');
  });

  it('fails the row rather than completing on Remotion\u2019s own expiring URL', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([lambdaRow()]);
    const d = deps(jest.fn(), fakePool({ successRow: { asset_kind: 'remotion', endpoint_id: ASSET_SPECS.remotion.endpointId } }));
    d.lambda = { functionName: 'f', region: 'r', invokeImpl: async () => ({ overlayRenderedUrl: 'https://remotion-s3/out.mp4' }) };
    d.r2 = {
      accountId: 'a', bucket: 'b', publicUrl: 'https://cdn', accessKeyId: 'k', secretAccessKey: 's',
      putImpl: async () => { throw new Error('R2 down'); },
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8), headers: { get: () => 'video/mp4' } }),
    };

    await runAssetAgentTick(d, 'remotion');

    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
    expect(assetsRepo.failOrRetryAsset).toHaveBeenCalled();
  });

  it('requeues a lambda row left submitted — there is no job id to poll', async () => {
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([
      row({ id: 701, kind: 'remotion', status: 'submitted', providerJobId: 'lambda:701:1', endpointId: ASSET_SPECS.remotion.endpointId }),
    ]);
    const runpodFetch = jest.fn();
    const d = deps(runpodFetch);

    await runAssetAgentTick(d, 'remotion');

    expect(runpodFetch).not.toHaveBeenCalled();
    expect(assetsRepo.failOrRetryAsset).toHaveBeenCalled();
  });
});

describe('KIE Nano Banana 2.1 fallback for the RunPod Qwen image kinds (2026-11-01)', () => {
  const KIE = 'https://api.kie.ai/api/v1/jobs';
  const R2 = { accountId: 'a', bucket: 'b', publicUrl: 'https://cdn', accessKeyId: 'k', secretAccessKey: 's' };
  afterEach(() => jest.restoreAllMocks());

  /** One fetch for everything: RunPod (must not be called on the KIE route), KIE create/poll. */
  function kieFetch(created: Array<Record<string, any>>, state: 'success' | 'fail' = 'success') {
    return jest.fn(async (url: string, init?: { body?: string }) => {
      if (url === `${KIE}/createTask`) {
        created.push(JSON.parse(init!.body!));
        return fakeRes(200, { code: 200, data: { taskId: 'kie-task-1' } });
      }
      if (url.startsWith(`${KIE}/recordInfo`)) {
        return fakeRes(200, state === 'success'
          ? { code: 200, data: { state, resultJson: JSON.stringify({ resultUrls: ['https://tempfile.kie/x.png'] }) } }
          : { code: 200, data: { state, failCode: 500, failMsg: 'internal' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  function kieDeps(fetchImpl: jest.Mock, kind = 'qwen-image-gen') {
    const runpodFetch = jest.fn();
    const d = deps(runpodFetch, fakePool({ successRow: { asset_kind: kind, endpoint_id: ASSET_SPECS[kind as 'qwen-edit'].endpointId } }));
    d.kie = { apiKey: 'kie-key', fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined, pollIntervalMs: 1 };
    d.r2 = R2;
    jest.spyOn(r2Client, 'persistToR2').mockImplementation(async (_t, _u, key) => `https://cdn/${key}`);
    jest.spyOn(conform, 'conformStill').mockResolvedValue(null);
    return { d, runpodFetch };
  }

  it('sends a FIRST attempt to RunPod as before', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([row()]);
    const created: Array<Record<string, any>> = [];
    const { d } = kieDeps(kieFetch(created));
    const runpodFetch = jest.fn(async () => fakeRes(200, { id: 'rp-1', status: 'IN_QUEUE' }));
    d.runpod = new RunpodClient(RUNPOD_CFG, { fetchImpl: runpodFetch as unknown as typeof fetch, sleepImpl: async () => undefined });
    await runAssetAgentTick(d, 'qwen-image-gen');
    expect(runpodFetch).toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('retries a row RunPod FAILED on KIE nano-banana-2-1, re-hosts it and completes — no RunPod call', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([row({ attempts: 1, error: { status: 'FAILED', error: 'CUDA out of memory' } })]);
    const created: Array<Record<string, any>> = [];
    const { d, runpodFetch } = kieDeps(kieFetch(created));

    const summary = await runAssetAgentTick(d, 'qwen-image-gen');

    expect(summary.submitted).toBe(1);
    expect(runpodFetch).not.toHaveBeenCalled();
    expect(created).toEqual([{ model: 'nano-banana-2-1', input: { prompt: expect.stringContaining('a lighthouse at dusk'), aspect_ratio: '9:16', resolution: '1K', output_format: 'png' } }]);
    expect(assetsRepo.markSubmitted).toHaveBeenCalledWith(expect.anything(), 101, 'qwen-image-gen', 'kie-qwen:101:2');
    expect(r2Client.persistToR2).toHaveBeenCalledWith(R2, 'https://tempfile.kie/x.png', 'stills/proj_1/f1-qwen-image-gen-kie.png');
    // Conformed to the frame size like any RunPod still.
    expect(conform.conformStill).toHaveBeenCalledWith('https://cdn/stills/proj_1/f1-qwen-image-gen-kie.png', [720, 1280]);
    const [, , result] = (assetsRepo.completeAsset as jest.Mock).mock.calls[0];
    expect(result.assetUrl).toBe('https://cdn/stills/proj_1/f1-qwen-image-gen-kie.png');
    expect(costsRepo.recordAssetCost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ providerJobId: 'kie-qwen:kie-task-1', workerRateUsdS: 0.03 }));
  });

  it('sends an edit kind to nano-banana-2-1 with image_input and the frame’s aspect', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([
      row({
        kind: 'qwen-edit', endpointId: ASSET_SPECS['qwen-edit'].endpointId, attempts: 1, error: { error: 'timed out' },
        input: { frameId: 'f1', imagePrompt: 'put the hat on him', narration: 'n', durationS: 5, aspectRatio: '16:9', referenceImageUrl: 'https://cdn/ref.png' },
      }),
    ]);
    const created: Array<Record<string, any>> = [];
    const { d } = kieDeps(kieFetch(created), 'qwen-edit');

    await runAssetAgentTick(d, 'qwen-edit');

    expect(created[0]).toEqual({ model: 'nano-banana-2-1', input: { prompt: 'put the hat on him', image_input: ['https://cdn/ref.png'], aspect_ratio: '16:9', resolution: '1K', output_format: 'png' } });
    expect(assetsRepo.completeAsset).toHaveBeenCalled();
  });

  it('a failed KIE task goes through the ordinary retry ceiling', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([row({ attempts: 1, error: { error: 'x' } })]);
    const { d } = kieDeps(kieFetch([], 'fail'));
    await runAssetAgentTick(d, 'qwen-image-gen');
    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
    expect(assetsRepo.failOrRetryAsset).toHaveBeenCalledWith(expect.anything(), 101, 'qwen-image-gen', expect.objectContaining({ provider: 'kie-qwen' }), expect.any(Number));
  });

  it('stays on RunPod when the fallback is switched off, or for a kind it does not cover', async () => {
    const created: Array<Record<string, any>> = [];
    const { d } = kieDeps(kieFetch(created));
    d.cfg = { ...CFG, kieQwenFallback: false };
    const runpodFetch = jest.fn(async () => fakeRes(200, { id: 'rp-1', status: 'IN_QUEUE' }));
    d.runpod = new RunpodClient(RUNPOD_CFG, { fetchImpl: runpodFetch as unknown as typeof fetch, sleepImpl: async () => undefined });
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([row({ attempts: 1, error: { error: 'x' } })]);
    await runAssetAgentTick(d, 'qwen-image-gen');
    expect(created).toHaveLength(0);
    expect(runpodFetch).toHaveBeenCalled();
  });

  it('never polls RunPod with a KIE job id; an orphaned KIE row is requeued after the window', async () => {
    const { d, runpodFetch } = kieDeps(kieFetch([]));
    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([
      row({ status: 'submitted', providerJobId: 'kie-qwen:kie-task-1', submittedAt: new Date(Date.now() - 60_000), attempts: 2 }),
    ]);
    await runAssetAgentTick(d, 'qwen-image-gen');
    expect(runpodFetch).not.toHaveBeenCalled();
    expect(assetsRepo.failOrRetryAsset).not.toHaveBeenCalled();

    (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([
      row({ status: 'submitted', providerJobId: 'kie-qwen:kie-task-1', submittedAt: new Date(Date.now() - 11 * 60_000), attempts: 2 }),
    ]);
    await runAssetAgentTick(d, 'qwen-image-gen');
    expect(runpodFetch).not.toHaveBeenCalled();
    expect(assetsRepo.failOrRetryAsset).toHaveBeenCalled();
  });
});

describe('Google Gemini TTS fallback for the RunPod tts kind (2026-11-02)', () => {
  const R2 = { accountId: 'a', bucket: 'b', publicUrl: 'https://cdn', accessKeyId: 'k', secretAccessKey: 's' };
  const VOICES = { male: 'Enzo', female: 'Tova' };
  afterEach(() => jest.restoreAllMocks());

  /** 1 s of 24 kHz s16 mono silence as a RIFF WAV, base64 like Gemini returns it. */
  const wav1s = pcmToWav(Buffer.alloc(48_000), 24_000);
  const geminiOk = (data: Buffer = wav1s, mimeType = 'audio/wav') =>
    fakeRes(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType, data: data.toString('base64') } }] } }], usageMetadata: { candidatesTokenCount: 25 } });

  function ttsRow(over: Partial<AssetRow> = {}): AssetRow {
    return row({
      kind: 'tts', endpointId: ASSET_SPECS.tts.endpointId, attempts: 1, error: { status: 'FAILED', error: 'worker died' },
      input: { frameId: 'f1', imagePrompt: 'p', narration: 'Hello there.', durationS: 5, aspectRatio: '16:9', voiceId: 'am_michael' },
      ...over,
    });
  }

  function geminiDeps(fetchImpl: jest.Mock) {
    const runpodFetch = jest.fn();
    const d = deps(runpodFetch, fakePool({ successRow: { asset_kind: 'tts', endpoint_id: ASSET_SPECS.tts.endpointId } }));
    d.gemini = { apiKey: 'g-key', model: 'gemini-3.8-flash-lite-tts', fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined };
    d.r2 = R2;
    jest.spyOn(r2Client, 'putBytesToR2').mockImplementation(async (_t, key) => `https://cdn/${key}`);
    return { d, runpodFetch };
  }

  describe('voice mapping', () => {
    it('maps Kokoro ids by their gender letter', () => {
      expect(ttsPayloadGender({ engine: 'kokoro', voice: 'af_heart' })).toBe('female');
      expect(ttsPayloadGender({ engine: 'kokoro', voice: 'bf_emma' })).toBe('female');
      expect(ttsPayloadGender({ engine: 'kokoro', voice: 'am_michael' })).toBe('male');
      expect(ttsPayloadGender({ engine: 'kokoro' })).toBe('male');
    });
    it('maps Qwen speakers and a female instruct hint; a clone request defaults to male', () => {
      expect(ttsPayloadGender({ engine: 'qwen', speaker: 'Vivian' })).toBe('female');
      expect(ttsPayloadGender({ engine: 'qwen', speaker: 'Ryan' })).toBe('male');
      expect(ttsPayloadGender({ engine: 'qwen', speaker: 'Ryan', instruct: 'a warm woman, calm' })).toBe('female');
      expect(ttsPayloadGender({ engine: 'qwen', clone_artifact_url: 'https://x/clone' })).toBe('male');
    });
    it('builds the request from the configured voices and rejects empty text', () => {
      expect(geminiTtsRequestFromRunpod({ engine: 'kokoro', voice: 'af_heart', text: ' hi ' }, VOICES)).toEqual({ text: 'hi', voice: 'Tova', gender: 'female' });
      expect(() => geminiTtsRequestFromRunpod({ engine: 'kokoro', text: '  ' }, VOICES)).toThrow(/no text/);
    });
  });

  describe('runGeminiTts', () => {
    const req = { text: 'Hello there.', voice: 'Enzo', gender: 'male' as const };

    it('posts the transcript + prebuilt voice and returns the WAV with its duration', async () => {
      const calls: Array<{ url: string; init: any }> = [];
      const fetchImpl = jest.fn(async (url: string, init: any) => { calls.push({ url, init }); return geminiOk(); });
      const out = await runGeminiTts({ apiKey: 'g-key', fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined }, req);
      expect(out.durationS).toBe(1);
      expect(out.audioTokens).toBe(25);
      expect(calls[0].url).toBe(`${GEMINI_BASE}/models/${GEMINI_TTS_DEFAULT_MODEL}:generateContent`);
      expect(calls[0].init.headers['x-goog-api-key']).toBe('g-key');
      const body = JSON.parse(calls[0].init.body);
      expect(body.contents[0].parts[0].text).toContain('Hello there.');
      expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Enzo');
    });

    it('wraps raw audio/L16 PCM in a WAV header', async () => {
      const fetchImpl = jest.fn(async () => geminiOk(Buffer.alloc(48_000), 'audio/L16;rate=24000'));
      const out = await runGeminiTts({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined }, req);
      expect(out.wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(out.durationS).toBe(1);
    });

    it('retries a 429/5xx then succeeds, but fails fast on a 400', async () => {
      const flaky = jest.fn()
        .mockResolvedValueOnce(fakeRes(503, { error: 'busy' }))
        .mockResolvedValueOnce(fakeRes(429, { error: 'slow down' }))
        .mockResolvedValueOnce(geminiOk());
      const sleeps: number[] = [];
      await runGeminiTts({ apiKey: 'k', fetchImpl: flaky as unknown as typeof fetch, sleepImpl: async (ms) => { sleeps.push(ms); } }, req);
      expect(flaky).toHaveBeenCalledTimes(3);
      expect(sleeps).toEqual([2_000, 4_000]);

      const bad = jest.fn(async () => fakeRes(400, { error: 'bad voice' }));
      await expect(runGeminiTts({ apiKey: 'k', fetchImpl: bad as unknown as typeof fetch, sleepImpl: async () => undefined }, req)).rejects.toThrow(/HTTP 400/);
      expect(bad).toHaveBeenCalledTimes(1);
    });

    it('throws when the response carries no audio', async () => {
      const fetchImpl = jest.fn(async () => fakeRes(200, { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }));
      await expect(runGeminiTts({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: async () => undefined }, req)).rejects.toThrow(/no audio.*SAFETY/);
    });
  });

  describe('agent routing', () => {
    it('sends a FIRST attempt to RunPod as before', async () => {
      (assetsRepo.claimPending as jest.Mock).mockResolvedValue([ttsRow({ attempts: 0, error: null })]);
      const gemini = jest.fn();
      const { d } = geminiDeps(gemini);
      const runpodFetch = jest.fn(async () => fakeRes(200, { id: 'rp-1', status: 'IN_QUEUE' }));
      d.runpod = new RunpodClient(RUNPOD_CFG, { fetchImpl: runpodFetch as unknown as typeof fetch, sleepImpl: async () => undefined });
      await runAssetAgentTick(d, 'tts');
      expect(runpodFetch).toHaveBeenCalled();
      expect(gemini).not.toHaveBeenCalled();
    });

    it('retries a row RunPod FAILED on Gemini, re-hosts the WAV and completes — no RunPod call', async () => {
      (assetsRepo.claimPending as jest.Mock).mockResolvedValue([ttsRow({ input: { frameId: 'f1', imagePrompt: 'p', narration: 'Hello there.', durationS: 5, aspectRatio: '16:9', voiceId: 'af_heart' } })]);
      const bodies: any[] = [];
      const fetchImpl = jest.fn(async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return geminiOk(); });
      const { d, runpodFetch } = geminiDeps(fetchImpl);

      const summary = await runAssetAgentTick(d, 'tts');

      expect(summary.submitted).toBe(1);
      expect(runpodFetch).not.toHaveBeenCalled();
      expect(bodies[0].generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Tova');
      expect(assetsRepo.markSubmitted).toHaveBeenCalledWith(expect.anything(), 101, 'tts', 'gemini-tts:101:2');
      expect(r2Client.putBytesToR2).toHaveBeenCalledWith(R2, 'audio/proj_1/f1-tts-gemini-2.wav', expect.any(Buffer), 'audio/wav');
      expect(assetsRepo.completeAsset).toHaveBeenCalled();
      expect(costsRepo.recordAssetCost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        providerJobId: 'gemini-tts:101:2', executionMs: 1000, workerRateUsdS: 0.0005,
      }));
    });

    it('a failed Gemini call goes through the ordinary retry ceiling', async () => {
      (assetsRepo.claimPending as jest.Mock).mockResolvedValue([ttsRow()]);
      const { d } = geminiDeps(jest.fn(async () => fakeRes(400, { error: 'nope' })));
      await runAssetAgentTick(d, 'tts');
      expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
      expect(assetsRepo.failOrRetryAsset).toHaveBeenCalledWith(expect.anything(), 101, 'tts', expect.objectContaining({ provider: 'gemini-tts' }), expect.any(Number));
    });

    it('stays on RunPod when switched off, when there is no Gemini key, or for a kind it does not cover', async () => {
      const failed = { attempts: 1, error: { error: 'x' } };
      expect(usesGeminiTts({ gemini: { apiKey: 'k' }, cfg: CFG }, 'tts', failed)).toBe(true);
      expect(usesGeminiTts({ gemini: { apiKey: 'k' }, cfg: { ...CFG, geminiTtsFallback: false } }, 'tts', failed)).toBe(false);
      expect(usesGeminiTts({ gemini: undefined, cfg: CFG }, 'tts', failed)).toBe(false);
      expect(usesGeminiTts({ gemini: { apiKey: 'k' }, cfg: CFG }, 'qwen-image-gen', failed)).toBe(false);
      expect(usesGeminiTts({ gemini: { apiKey: 'k' }, cfg: CFG }, 'tts', { attempts: 0, error: null })).toBe(false);
    });

    it('a row the compiler reworked as stuck (RunPod never returned FAILED) goes to Gemini next, not back to RunPod', () => {
      // reworkAsset keeps attempts and records {reason:'stuck'} as the error — exactly the trigger.
      expect(usesGeminiTts({ gemini: { apiKey: 'k' }, cfg: CFG }, 'tts', { attempts: 1, error: { reason: 'stuck', stalledForMs: 1_229_669 } })).toBe(true);
    });

    it('never polls RunPod with a Gemini job id; an orphaned Gemini row is failed after the window', async () => {
      const { d, runpodFetch } = geminiDeps(jest.fn());
      (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([
        ttsRow({ status: 'submitted', providerJobId: 'gemini-tts:101:2', submittedAt: new Date(Date.now() - 60_000), attempts: 2 }),
      ]);
      await runAssetAgentTick(d, 'tts');
      expect(runpodFetch).not.toHaveBeenCalled();
      expect(assetsRepo.failOrRetryAsset).not.toHaveBeenCalled();

      (assetsRepo.listStaleSubmitted as jest.Mock).mockResolvedValue([
        ttsRow({ status: 'submitted', providerJobId: 'gemini-tts:101:2', submittedAt: new Date(Date.now() - 11 * 60_000), attempts: 2 }),
      ]);
      await runAssetAgentTick(d, 'tts');
      expect(runpodFetch).not.toHaveBeenCalled();
      expect(assetsRepo.failOrRetryAsset).toHaveBeenCalledWith(expect.anything(), 101, 'tts', expect.objectContaining({ provider: 'gemini-tts' }), expect.any(Number));
    });
  });
});

describe('handoff resolution', () => {
  it('carries the downstream kind’s own required inputs, endpoint and stages', async () => {
    const plan = compilePlan(
      RequestSchema.parse({
        requestId: 'r',
        projectId: 'proj_1',
        source: 'mcp',
        tier: 'narration-basic',
        product: 'documentary',
        language: 'en',
        aspectRatio: '9:16',
        resolution: '1080x1920',
        callbackUrl: 'https://convex.example/cb',
        options: { sfx: true },
        frames: [{ frameId: 'f1', imagePrompt: 'p', narration: 'n', durationS: 5 }],
      }),
    );
    const handoffs = resolveHandoffs(plan, 'wan2-i2v', {});
    // Only the frame-scoped successor. The project-scoped tail is armed by
    // the compiler, never reached by a handoff.
    expect(handoffs.map((h) => h.kind)).toEqual(['mmaudio']);

    const sfx = handoffs[0];
    expect(sfx.endpointId).toBe(ASSET_SPECS['mmaudio'].endpointId);
    expect(sfx.requiredInputs).toEqual(['wan2-i2v']);
    expect(sfx.stage).toBeNull();
  });
});

describe('webhook tokens', () => {
  it('are namespaced apart from the cohort path’s, so one can never validate the other', () => {
    expect(assetWebhookToken('shhh', 42)).not.toBe(webhookToken('shhh', 42));
    expect(assetWebhookToken('shhh', 42)).toHaveLength(32);
  });
});
