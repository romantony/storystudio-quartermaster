/**
 * Model-switch fallbacks (2026-09-15): payload builders, catalog routing,
 * rewrite output cleanup, and the generator's Replicate -> normalize hops.
 */
import { RunpodClient } from '../src/runpod/client';
import { buildFluxImageInput, buildNormalizeInput, buildReplicateWanInput, wanFallbackFrames } from '../src/steps/builders/fallbacks';
import { auxiliaryEndpoints, catalogEntry, fallbackRouteFor } from '../src/steps/catalog';
import { POSTPROD_LITE_ENDPOINT_ID } from '../src/steps/tail-endpoints';
import { cleanRewrite } from '../src/quality/rewrite';
import { jobEndpointId, reconcileTick, runStep, type GeneratorDeps } from '../src/agents/generator';
import type { BuildContext, FrameJobInput } from '../src/steps/builders/types';
import * as jobsRepo from '../src/db/repo/jobs';
import * as stepsRepo from '../src/db/repo/steps';
import * as endpointStateRepo from '../src/db/repo/endpoint-state';
import * as qualityRepo from '../src/db/repo/quality';
import * as replicate from '../src/quality/replicate';

jest.mock('../src/db/repo/jobs');
jest.mock('../src/db/repo/steps');
jest.mock('../src/db/repo/endpoint-state');
jest.mock('../src/db/repo/quality');
jest.mock('../src/db/repo/costs');
jest.mock('../src/quality/replicate');

const job: FrameJobInput = {
  frameId: 'f13',
  imagePrompt: 'the girl from the reference image, exactly one girl, two hands on the door',
  narration: 'By morning, fear had turned into something else.',
  durationS: 5,
  motionPrompt: 'her hand slowly sinks into the door',
  aspectRatio: '16:9',
  referenceImageUrl: 'https://r2/ref.png',
};
const ctx = (over: Partial<BuildContext> = {}): BuildContext => ({ job, resolvedDeps: {}, projectId: 'proj', frameId: 'f13', ...over });

describe('fallback payload builders', () => {
  it('Flux-4B: model "flux" on qwen-image-gen with the character reference as reference_images, 16:9 size', () => {
    expect(buildFluxImageInput(ctx())).toEqual({
      model: 'flux',
      prompt: job.imagePrompt,
      reference_images: ['https://r2/ref.png'],
      width: 1344,
      height: 768,
      project_id: 'proj',
      frame_id: 'f13',
    });
    expect(buildFluxImageInput(ctx({ job: { ...job, referenceImageUrl: undefined, aspectRatio: '9:16' } }))).not.toHaveProperty('reference_images');
  });

  it('Replicate Wan 2.2 fast: frames sized from the real TTS duration like i2v, clamped to the model 81-121 range', () => {
    expect(wanFallbackFrames(6.54, 5)).toBe(113); // 7 s
    expect(wanFallbackFrames(3.2, 5)).toBe(81); // 4 s -> 65, clamped up
    expect(wanFallbackFrames(undefined, 9)).toBe(113); // caps at 7 s like i2v
    expect(
      buildReplicateWanInput(ctx({ resolvedDeps: { 0: { url: 'https://r2/f13.png' }, 2: { url: 'https://r2/f13.wav', durationS: 5.8 } } })),
    ).toEqual({
      image: 'https://r2/f13.png',
      prompt: job.motionPrompt,
      resolution: '480p',
      num_frames: 97,
      frames_per_second: 16,
      go_fast: true,
    });
    expect(() => buildReplicateWanInput(ctx())).toThrow(/no resolved image URL/);
  });

  it('normalize: crop the 832x480 Replicate clip to the pod-native 832x464 at 16 fps', () => {
    expect(buildNormalizeInput('https://replicate.delivery/x.mp4', { projectId: 'proj', frameId: 'f13' })).toEqual({
      mode: 'normalize',
      video_url: 'https://replicate.delivery/x.mp4',
      width: 832,
      height: 464,
      fps: 16,
      project_id: 'proj',
      frame_id: 'f13',
    });
  });
});

describe('catalog routing', () => {
  it('routes only jobs whose fallbackRung the step declares', () => {
    const image = catalogEntry(0)!;
    const animation = catalogEntry(3)!;
    expect(fallbackRouteFor(image, job)).toBeUndefined();
    expect(fallbackRouteFor(image, { ...job, fallbackRung: 'flux-4b' })).toMatchObject({ provider: 'runpod', endpointId: 'e165se4r3eo5hp' });
    expect(fallbackRouteFor(animation, { ...job, fallbackRung: 'replicate-wan22-fast' })).toMatchObject({
      provider: 'replicate',
      model: 'wan-video/wan-2.2-i2v-fast',
    });
    expect(fallbackRouteFor(image, { ...job, fallbackRung: 'replicate-wan22-fast' })).toBeUndefined();
  });

  it('auxiliary endpoints: qwen-image-gen for step 0, postprod-lite for step 3, none for step 1 (same endpoint)', () => {
    expect(auxiliaryEndpoints(catalogEntry(0)!)).toEqual([{ endpointId: 'e165se4r3eo5hp', workers: 2 }]);
    expect(auxiliaryEndpoints(catalogEntry(1)!)).toEqual([]);
    expect(auxiliaryEndpoints(catalogEntry(3)!)).toEqual([{ endpointId: POSTPROD_LITE_ENDPOINT_ID, workers: 1 }]);
    expect(auxiliaryEndpoints(catalogEntry(2)!)).toEqual([]);
  });

  it('jobEndpointId follows the route (normalize endpoint for a Replicate fallback)', () => {
    expect(jobEndpointId(catalogEntry(0)!, job)).toBe('oxwx8o879qwtla');
    expect(jobEndpointId(catalogEntry(0)!, { ...job, fallbackRung: 'flux-4b' })).toBe('e165se4r3eo5hp');
    expect(jobEndpointId(catalogEntry(3)!, { ...job, fallbackRung: 'replicate-wan22-fast' })).toBe(POSTPROD_LITE_ENDPOINT_ID);
  });
});

describe('cleanRewrite', () => {
  it('strips quotes and "Prompt:" preambles, collapses whitespace, rejects empty output', () => {
    expect(cleanRewrite('  "Prompt:  a girl,\n exactly one girl"  ', 900)).toBe('a girl, exactly one girl');
    expect(cleanRewrite('Corrected motion prompt: slow push in', 400)).toBe('slow push in');
    expect(cleanRewrite('   ', 900)).toBeUndefined();
    expect(cleanRewrite('x'.repeat(1000), 900)).toHaveLength(900);
  });
});

describe('generator: Replicate fallback hops', () => {
  const CFG = { runpodApiBase: 'https://api.runpod.ai/v2', runpodRestBase: 'https://rest.runpod.io/v1', runpodApiKey: 'k', runpodMaxRetries: 0, runpodTimeoutMs: 1000 };
  const animation = catalogEntry(3)!;
  const fallbackInput = { ...job, fallbackRung: 'replicate-wan22-fast' };

  function pool(queryImpl?: (sql: string) => unknown) {
    const client = {
      query: jest.fn(async (sql: string) =>
        (queryImpl?.(sql) as object | undefined) ??
        (sql.includes('SELECT status FROM jobs') ? { rows: [{ status: 'planned' }] } : sql.includes('SELECT output') ? { rows: [] } : { rows: [] }),
      ),
      release: jest.fn(),
    };
    return { connect: jest.fn(async () => client), query: client.query, client } as unknown as GeneratorDeps['pool'] & { client: typeof client };
  }

  function deps(p: GeneratorDeps['pool'], fetchImpl: jest.Mock): GeneratorDeps {
    return {
      pool: p,
      runpod: new RunpodClient(CFG, { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: jest.fn(async () => {}) }),
      cfg: { workerRateUsdS: 0.0002, reconcileIntervalMs: 10, warmTimeoutMs: 60_000, maxAttempts: 2, lambdaRenderRateUsdS: 0.000127 },
      publicBaseUrl: 'https://vps.example',
      webhookSecret: 'secret',
      replicate: { apiToken: 'r8', apiBase: 'https://api.replicate.com/v1', timeoutMs: 1000 },
    };
  }

  const res = (status: number, body: unknown) =>
    ({ ok: status < 300, status, text: async () => JSON.stringify(body) }) as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
    (jobsRepo.listInFlight as jest.Mock).mockResolvedValue([]);
    (jobsRepo.listStale as jest.Mock).mockResolvedValue([]);
    (stepsRepo.updateStepStatus as jest.Mock).mockResolvedValue(undefined);
    (endpointStateRepo.touchObserved as jest.Mock).mockResolvedValue(undefined);
    (qualityRepo.countUngated as jest.Mock).mockResolvedValue(0);
  });

  it('hop 1: submits the fallback job to Replicate (not RunPod) and records a replicate: handle', async () => {
    (jobsRepo.stepJobCounts as jest.Mock).mockResolvedValueOnce({ total: 1, terminal: 0 }).mockResolvedValue({ total: 1, terminal: 1 });
    (jobsRepo.claimNextBatch as jest.Mock).mockResolvedValueOnce([
      { id: 77, projectId: 'proj', cohortId: 'c', stepSeq: 3, seq: 12, frameId: 'f13', status: 'planned', input: fallbackInput },
    ]);
    (replicate.createPrediction as jest.Mock).mockResolvedValue({ id: 'pred123' });
    const p = pool((sql) => (sql.includes("step_seq = $4 AND status = 'complete'") ? { rows: [{ output: { image_url: 'https://r2/f13.png' } }] } : undefined));
    const fetchImpl = jest.fn(async () => res(200, { workers: { ready: 1, running: 0 } }));

    await runStep(deps(p, fetchImpl), 'c', animation, 5);

    expect(replicate.createPrediction).toHaveBeenCalledWith(
      expect.objectContaining({ apiToken: 'r8' }),
      'wan-video/wan-2.2-i2v-fast',
      expect.objectContaining({ image: 'https://r2/f13.png', resolution: '480p', frames_per_second: 16 }),
    );
    expect(jobsRepo.markSubmitted).toHaveBeenCalledWith(expect.anything(), 77, 'replicate:pred123');
    expect((fetchImpl.mock.calls as unknown as Array<[string]>).some((c) => String(c[0]).endsWith('/run'))).toBe(false);
  });

  it('hop 2: a succeeded prediction is sent to postprod-lite normalize with the job webhook, and the job re-pointed at that RunPod id', async () => {
    (jobsRepo.listStale as jest.Mock).mockResolvedValue([
      { id: 77, projectId: 'proj', cohortId: 'c', stepSeq: 3, seq: 12, frameId: 'f13', status: 'submitted', runpodJobId: 'replicate:pred123', input: fallbackInput },
    ]);
    (replicate.getPrediction as jest.Mock).mockResolvedValue({ status: 'succeeded', output: 'https://replicate.delivery/out.mp4' });
    const fetchImpl = jest.fn(async () => res(200, { id: 'rp-norm-1', status: 'IN_QUEUE' }));
    const p = pool();

    await reconcileTick(deps(p, fetchImpl), 'c', animation, 60);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.runpod.ai/v2/${POSTPROD_LITE_ENDPOINT_ID}/run`);
    const body = JSON.parse(init.body as string);
    expect(body.input).toEqual(expect.objectContaining({ mode: 'normalize', video_url: 'https://replicate.delivery/out.mp4', width: 832, height: 464 }));
    expect(body.webhook).toMatch(/^https:\/\/vps\.example\/v1\/webhooks\/runpod\//);
    expect(jobsRepo.markSubmitted).toHaveBeenCalledWith(expect.anything(), 77, 'rp-norm-1');
    expect(jobsRepo.markTerminal).not.toHaveBeenCalled();
  });

  it('a failed prediction goes through markFailedOrRetry (same retry budget as a RunPod failure)', async () => {
    (jobsRepo.listStale as jest.Mock).mockResolvedValue([
      { id: 77, projectId: 'proj', cohortId: 'c', stepSeq: 3, seq: 12, frameId: 'f13', status: 'submitted', runpodJobId: 'replicate:pred123', input: fallbackInput },
    ]);
    (replicate.getPrediction as jest.Mock).mockResolvedValue({ status: 'failed', error: 'NSFW content detected' });
    (jobsRepo.markFailedOrRetry as jest.Mock).mockResolvedValue(true);
    const fetchImpl = jest.fn();

    await reconcileTick(deps(pool(), fetchImpl), 'c', animation, 60);

    expect(jobsRepo.markFailedOrRetry).toHaveBeenCalledWith(
      expect.anything(),
      77,
      expect.objectContaining({ provider: 'replicate', predictionId: 'pred123', status: 'failed', error: 'NSFW content detected' }),
      2,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stepsRepo.incrementStepCounters).not.toHaveBeenCalled(); // retried, not failed
  });
});
