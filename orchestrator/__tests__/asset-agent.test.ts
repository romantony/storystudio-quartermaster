/**
 * Unit tests for assets/agent.ts — the loop all eight generator agents share.
 *
 * Same convention as generator.test.ts: the repo layer is mocked rather than
 * hit for real (the SQL itself is covered against a live Postgres in
 * asset-repo.integration.test.ts), and RunpodClient is driven by a fake
 * fetch. What is under test here is the agent's *decisions* — how much it
 * dispatches, what it does with each kind of provider answer, and whether a
 * bad row can take anything else down with it.
 */
import { RunpodClient } from '../src/runpod/client';
import { runAssetAgentTick, applyAssetSuccess, assetWebhookToken, resolveHandoffs, type AssetAgentDeps } from '../src/assets/agent';
import { webhookToken } from '../src/agents/generator';
import { compilePlan } from '../src/assets/plan';
import { ASSET_SPECS } from '../src/assets/kinds';
import { RequestSchema } from '../src/agents/planner';
import * as assetsRepo from '../src/db/repo/assets';
import * as costsRepo from '../src/db/repo/asset-costs';
import * as pipelineRepo from '../src/db/repo/pipeline';
import type { AssetRow } from '../src/db/repo/assets';

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
    expect(gated).toBe(false);
    expect(handoffs.map((h: { kind: string }) => h.kind)).toEqual(['wan2-i2v']);
    expect(costsRepo.recordAssetCost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ assetId: 101, executionMs: 4200, delayMs: 100 }),
    );
  });

  it('hands off immediately for an UNGATED kind', async () => {
    const poolLike = fakePool({ successRow: { asset_kind: 'tts', endpoint_id: ASSET_SPECS.tts.endpointId } });
    const outcome = await applyAssetSuccess(deps(jest.fn(), poolLike), 101, 'tts', {
      audio: 'https://cdn/f1.mp3',
      duration_s: 5.4,
    });

    expect(outcome).toBe('completed');
    const [, , , handoffs, gated] = (assetsRepo.completeAsset as jest.Mock).mock.calls[0];
    expect(gated).toBe(false);
    expect(handoffs.map((h: { kind: string }) => h.kind)).toEqual(['wan2-i2v']);
  });

  it('refuses a COMPLETED whose output carries a worker error string', async () => {
    // postprod-lite reports its own failures inside a COMPLETED job
    // (containers/media.md). Treating that as success is exactly how rows end
    // up "complete" with no asset behind them.
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

  it('does nothing when the row is no longer submitted (webhook racing reconcile)', async () => {
    const poolLike = fakePool({ successRow: { status: 'complete' } });
    const outcome = await applyAssetSuccess(deps(jest.fn(), poolLike), 101, 'qwen-image-gen', { image: 'https://cdn/x.png' });
    expect(outcome).toBe('noop');
    expect(assetsRepo.completeAsset).not.toHaveBeenCalled();
  });

  it('dispatches the project-scoped tail as one manifest call, not a per-frame payload', async () => {
    const tailRow = row({
      id: 900,
      kind: 'postprod-lite',
      frameId: '*',
      endpointId: ASSET_SPECS['postprod-lite'].endpointId,
      input: { manifestUrl: 'https://cdn/manifests/proj_1.json' },
    });
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([tailRow]);
    const sent: Array<{ body: string }> = [];
    const fetchImpl = jest.fn(async (_url: string, init: { body: string }) => {
      sent.push(init);
      return fakeRes(200, { id: 'rp-tail', status: 'IN_QUEUE' });
    });

    const summary = await runAssetAgentTick(deps(fetchImpl as unknown as jest.Mock), 'postprod-lite');

    expect(summary.submitted).toBe(1);
    const body = JSON.parse(sent[0].body);
    expect(body.input).toEqual({
      mode: 'postprod',
      manifest_url: 'https://cdn/manifests/proj_1.json',
      project_id: 'proj_1',
    });
  });

  it('fails the tail row when it was released without a manifest', async () => {
    (assetsRepo.claimPending as jest.Mock).mockResolvedValue([
      row({ id: 901, kind: 'postprod-lite', frameId: '*', endpointId: ASSET_SPECS['postprod-lite'].endpointId, input: {} }),
    ]);
    const fetchImpl = jest.fn();
    const poolLike = fakePool();

    const summary = await runAssetAgentTick(deps(fetchImpl, poolLike), 'postprod-lite');

    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(poolLike.queries.some((q) => q.sql.includes("status = 'failed'"))).toBe(true);
  });

  it('records the tail\u2019s completion url, with nothing to hand off to', async () => {
    const poolLike = fakePool({
      successRow: { asset_kind: 'postprod-lite', frame_id: '*', endpoint_id: ASSET_SPECS['postprod-lite'].endpointId },
    });
    const outcome = await applyAssetSuccess(deps(jest.fn(), poolLike), 900, 'postprod-lite', {
      video: 'https://cdn/final.mp4',
      duration_s: 44.2,
    });

    expect(outcome).toBe('completed');
    const [, , result, handoffs] = (assetsRepo.completeAsset as jest.Mock).mock.calls[0];
    expect(result).toMatchObject({ assetUrl: 'https://cdn/final.mp4', durationS: 44.2 });
    expect(handoffs).toEqual([]);
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

  it('times postprod-lite out at the pod\u2019s own limit, without cancelling', () => {
    expect(ASSET_SPECS['postprod-lite'].timeoutMs).toBe(900_000);
    expect(ASSET_SPECS['postprod-lite'].cancelOnTimeout).toBe(false);
  });

  it('gives bgm the same budget as mmaudio', () => {
    expect(ASSET_SPECS.bgm.timeoutMs).toBe(ASSET_SPECS.mmaudio.timeoutMs);
  });

  it('carries the operator\u2019s timeout budgets', () => {
    expect(ASSET_SPECS['qwen-image-gen'].timeoutMs).toBe(150_000);
    expect(ASSET_SPECS['qwen-edit'].timeoutMs).toBe(150_000);
    expect(ASSET_SPECS.tts.timeoutMs).toBe(150_000);
    expect(ASSET_SPECS['dreamx-refine'].timeoutMs).toBe(150_000);
    expect(ASSET_SPECS.mmaudio.timeoutMs).toBe(150_000);
    expect(ASSET_SPECS['wan2-i2v'].timeoutMs).toBe(300_000);
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
        options: { upscale: true, upscaleEngine: 'dreamx' },
        frames: [{ frameId: 'f1', imagePrompt: 'p', narration: 'n', durationS: 5 }],
      }),
    );
    const handoffs = resolveHandoffs(plan, 'wan2-i2v', {});
    // Only the frame-scoped successor. The project-scoped tail is armed by
    // the compiler, never reached by a handoff.
    expect(handoffs.map((h) => h.kind)).toEqual(['dreamx-refine']);

    const refine = handoffs[0];
    expect(refine.endpointId).toBe(ASSET_SPECS['dreamx-refine'].endpointId);
    expect(refine.requiredInputs).toEqual(['wan2-i2v']);
    expect(refine.stage).toBeNull();
  });
});

describe('webhook tokens', () => {
  it('are namespaced apart from the cohort path’s, so one can never validate the other', () => {
    expect(assetWebhookToken('shhh', 42)).not.toBe(webhookToken('shhh', 42));
    expect(assetWebhookToken('shhh', 42)).toHaveLength(32);
  });
});
