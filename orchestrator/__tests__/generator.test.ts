/**
 * Unit tests for agents/generator.ts's runStep() — new as of the M3 fix
 * (2026-09-10). allocate() no longer polls for real worker readiness before
 * handing off (see fleet.test.ts), so runStep() now owns cold-start-stall
 * detection itself, non-blockingly. These tests exercise that logic in
 * isolation: the DB repo layer is mocked (jest.mock) rather than hit for
 * real, since runStep()'s stall condition only cares about
 * stepJobCounts()/health() — a real Postgres adds nothing here. Fixture
 * RunpodClient (same mocked-fetch convention as runpod-client.test.ts).
 */
import { RunpodClient } from '../src/runpod/client';
import { runStep, GeneratorStallError, type GeneratorDeps } from '../src/agents/generator';
import type { CatalogEntry } from '../src/steps/catalog';
import * as jobsRepo from '../src/db/repo/jobs';
import * as stepsRepo from '../src/db/repo/steps';
import * as endpointStateRepo from '../src/db/repo/endpoint-state';
import * as qualityRepo from '../src/db/repo/quality';

jest.mock('../src/db/repo/jobs');
jest.mock('../src/db/repo/steps');
jest.mock('../src/db/repo/endpoint-state');
jest.mock('../src/db/repo/quality');

const CFG = {
  runpodApiBase: 'https://api.runpod.ai/v2',
  runpodRestBase: 'https://rest.runpod.io/v1',
  runpodApiKey: 'test-key',
  runpodMaxRetries: 0,
  runpodTimeoutMs: 1000,
};

function fakeRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function fakePool() {
  const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
  return { connect: jest.fn(async () => client) } as unknown as GeneratorDeps['pool'];
}

/** Like fakePool(), but answers submitOne()'s `SELECT status ... FOR UPDATE`
 * re-check with a real 'planned' row so submission actually proceeds
 * instead of being skipped as already-claimed. */
function fakePoolWithPlannedJob() {
  const client = {
    query: jest.fn(async (sql: string) => (sql.includes('SELECT status FROM jobs') ? { rows: [{ status: 'planned' }] } : { rows: [] })),
    release: jest.fn(),
  };
  return { connect: jest.fn(async () => client) } as unknown as GeneratorDeps['pool'];
}

const STEP: CatalogEntry = {
  seq: 1,
  name: 'image',
  endpointId: 'e165se4r3eo5hp',
  gate: null,
  dependsOn: [],
  scope: 'bulk',
  builder: (() => ({})) as CatalogEntry['builder'],
};

// Fast, real-timer-friendly: tiny warmTimeoutMs and reconcileIntervalMs so a
// stall test completes in well under a second of real wall-clock time.
const FAST_CFG = { workerRateUsdS: 0.0002, reconcileIntervalMs: 10, warmTimeoutMs: 60, maxAttempts: 2, lambdaRenderRateUsdS: 0.000127 };

beforeEach(() => {
  jest.clearAllMocks();
  (jobsRepo.claimNextBatch as jest.Mock).mockResolvedValue([]);
  (jobsRepo.listInFlight as jest.Mock).mockResolvedValue([]);
  (jobsRepo.listStale as jest.Mock).mockResolvedValue([]);
  (stepsRepo.updateStepStatus as jest.Mock).mockResolvedValue(undefined);
  (endpointStateRepo.touchObserved as jest.Mock).mockResolvedValue(undefined);
});

describe('agents/generator.ts runStep() — cold-start stall detection (M3 fix)', () => {
  it('throws GeneratorStallError("warm_timeout") when health() stays ready:0 past warmTimeoutMs and zero jobs are terminal', async () => {
    (jobsRepo.stepJobCounts as jest.Mock).mockResolvedValue({ total: 3, terminal: 0 });
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 0, running: 5 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: GeneratorDeps = {
      pool: fakePool(),
      runpod,
      cfg: FAST_CFG,
      publicBaseUrl: 'https://vps.example',
      webhookSecret: 'secret',
    };

    const err = await runStep(deps, 'win_test', STEP, 5).catch((e) => e);
    expect(err).toBeInstanceOf(GeneratorStallError);
    expect(err.reason).toBe('warm_timeout');
  });

  it('does NOT stall once health() ever reports ready > 0', async () => {
    (jobsRepo.stepJobCounts as jest.Mock)
      .mockResolvedValueOnce({ total: 3, terminal: 0 })
      .mockResolvedValueOnce({ total: 3, terminal: 0 })
      .mockResolvedValueOnce({ total: 3, terminal: 0 })
      .mockResolvedValue({ total: 3, terminal: 3 }); // finishes shortly after warming
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 2, running: 2 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: GeneratorDeps = {
      pool: fakePool(),
      runpod,
      cfg: FAST_CFG,
      publicBaseUrl: 'https://vps.example',
      webhookSecret: 'secret',
    };

    await expect(runStep(deps, 'win_test', STEP, 5)).resolves.toBeUndefined();
    // Confirms warmAt was actually recorded, not just "didn't throw".
    const warmCall = (stepsRepo.updateStepStatus as jest.Mock).mock.calls.find(
      (c) => c[3] === 'running' && c[4]?.warmAt,
    );
    expect(warmCall).toBeDefined();
  });

  it('does NOT stall once at least one job reaches terminal, even with ready staying 0 (dependency-chain false-positive guard)', async () => {
    // total===terminal never happens (so the loop keeps running past
    // warmTimeoutMs), but terminal is nonzero from the very first tick —
    // this must disarm the stall check per the terminal===0 guard.
    (jobsRepo.stepJobCounts as jest.Mock)
      .mockResolvedValueOnce({ total: 3, terminal: 1 })
      .mockResolvedValueOnce({ total: 3, terminal: 1 })
      .mockResolvedValueOnce({ total: 3, terminal: 1 })
      .mockResolvedValue({ total: 3, terminal: 3 });
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 0, running: 0 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: GeneratorDeps = {
      pool: fakePool(),
      runpod,
      cfg: FAST_CFG,
      publicBaseUrl: 'https://vps.example',
      webhookSecret: 'secret',
    };

    await expect(runStep(deps, 'win_test', STEP, 5)).resolves.toBeUndefined();
  });
});

describe('agents/generator.ts submitOne() — ENDPOINT_PAUSED retry (2026-09-11 incident)', () => {
  it('retries a 409 ENDPOINT_PAUSED /run response and succeeds once RunPod catches up to the PATCH', async () => {
    (jobsRepo.stepJobCounts as jest.Mock)
      .mockResolvedValueOnce({ total: 1, terminal: 0 })
      .mockResolvedValue({ total: 1, terminal: 1 });
    (jobsRepo.claimNextBatch as jest.Mock).mockResolvedValueOnce([
      { id: 1, projectId: 'p1', frameId: 'f1', input: {} },
    ]);

    let runCalls = 0;
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/health')) return fakeRes(200, { workers: { ready: 1, running: 0 } });
      if (url.includes('/run')) {
        runCalls += 1;
        if (runCalls < 3) {
          return fakeRes(409, { status: 409, code: 'ENDPOINT_PAUSED', detail: 'Endpoint is paused' });
        }
        return fakeRes(200, { id: 'job-1', status: 'COMPLETED', output: { url: 'https://x/out.mp4' } });
      }
      return fakeRes(200, {});
    });
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const sleepImpl = jest.fn(async () => {});
    const deps: GeneratorDeps = {
      pool: fakePoolWithPlannedJob(),
      runpod,
      cfg: FAST_CFG,
      publicBaseUrl: 'https://vps.example',
      webhookSecret: 'secret',
      sleepImpl,
    };

    await expect(runStep(deps, 'win_test', STEP, 5)).resolves.toBeUndefined();
    expect(runCalls).toBe(3); // 2 paused rejections + 1 success
    expect(sleepImpl).toHaveBeenCalledTimes(2); // one backoff wait per retried attempt
  });

  it('gives up and throws after exhausting retries on a /run that stays paused', async () => {
    (jobsRepo.stepJobCounts as jest.Mock).mockResolvedValue({ total: 1, terminal: 0 });
    (jobsRepo.claimNextBatch as jest.Mock).mockResolvedValueOnce([
      { id: 1, projectId: 'p1', frameId: 'f1', input: {} },
    ]);

    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/health')) return fakeRes(200, { workers: { ready: 0, running: 0 } });
      if (url.includes('/run')) return fakeRes(409, { status: 409, code: 'ENDPOINT_PAUSED', detail: 'still paused' });
      return fakeRes(200, {});
    });
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: GeneratorDeps = {
      pool: fakePoolWithPlannedJob(),
      runpod,
      cfg: FAST_CFG,
      publicBaseUrl: 'https://vps.example',
      webhookSecret: 'secret',
      sleepImpl: jest.fn(async () => {}),
    };

    const err = await runStep(deps, 'win_test', STEP, 5).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(409);
  });
});

describe('agents/generator.ts runStep() — optional projectId scoping (M5 phase 1, 2026-09-11)', () => {
  it('threads projectId through every claim/read call when provided, for agents/assembler.ts to drive one project at a time', async () => {
    (jobsRepo.stepJobCounts as jest.Mock)
      .mockResolvedValueOnce({ total: 1, terminal: 0 }) // one real loop iteration first...
      .mockResolvedValue({ total: 1, terminal: 1 }); // ...then finishes
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 1, running: 0 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: GeneratorDeps = {
      pool: fakePool(),
      runpod,
      cfg: FAST_CFG,
      publicBaseUrl: 'https://vps.example',
      webhookSecret: 'secret',
    };

    await runStep(deps, 'win_test', STEP, 5, 'proj_abc');

    expect(jobsRepo.stepJobCounts).toHaveBeenCalledWith(expect.anything(), 'win_test', STEP.seq, 'proj_abc');
    expect(jobsRepo.listInFlight).toHaveBeenCalledWith(expect.anything(), 'win_test', STEP.seq, 'proj_abc');
  });

  it('omits projectId entirely (undefined) when not provided — preserves the exact cohort-wide behavior steps 1-5 rely on', async () => {
    (jobsRepo.stepJobCounts as jest.Mock).mockResolvedValue({ total: 1, terminal: 1 });
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 1, running: 0 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: GeneratorDeps = {
      pool: fakePool(),
      runpod,
      cfg: FAST_CFG,
      publicBaseUrl: 'https://vps.example',
      webhookSecret: 'secret',
    };

    await runStep(deps, 'win_test', STEP, 5);

    expect(jobsRepo.stepJobCounts).toHaveBeenCalledWith(expect.anything(), 'win_test', STEP.seq, undefined);
  });
});

describe('agents/generator.ts runStep() — gated steps wait for the gate (deadlock fix, 2026-09-15)', () => {
  const GATED: CatalogEntry = { ...STEP, gate: 'image' };
  const deps = (): GeneratorDeps => ({
    pool: fakePool(),
    runpod: new RunpodClient(CFG, { fetchImpl: jest.fn(async () => fakeRes(200, { workers: { ready: 1, running: 0 } })), sleepImpl: jest.fn(async () => {}) }),
    cfg: FAST_CFG,
    publicBaseUrl: 'https://vps.example',
    webhookSecret: 'secret',
  });

  it('keeps looping while completed jobs are still ungated, then resubmits a job the gate sent back to planned', async () => {
    // tick 1: all terminal but 2 ungated -> keep looping
    // tick 2: gate reworked one -> 1 not terminal -> loop claims it
    // tick 3: all terminal and gated -> exit
    (jobsRepo.stepJobCounts as jest.Mock)
      .mockResolvedValueOnce({ total: 36, terminal: 36 })
      .mockResolvedValueOnce({ total: 36, terminal: 35 })
      .mockResolvedValue({ total: 36, terminal: 36 });
    (qualityRepo.countUngated as jest.Mock).mockResolvedValueOnce(2).mockResolvedValue(0);

    await runStep(deps(), 'win_test', GATED, 5);

    expect(jobsRepo.stepJobCounts).toHaveBeenCalledTimes(3);
    expect(jobsRepo.claimNextBatch).toHaveBeenCalled(); // the reworked job was eligible for resubmission
    const finalStatus = (stepsRepo.updateStepStatus as jest.Mock).mock.calls.at(-1);
    expect(finalStatus?.[3]).toBe('generated');
  });

  it('never consults the gate for an ungated step', async () => {
    (jobsRepo.stepJobCounts as jest.Mock).mockResolvedValue({ total: 3, terminal: 3 });
    await runStep(deps(), 'win_test', STEP, 5);
    expect(qualityRepo.countUngated).not.toHaveBeenCalled();
  });
});

describe('agents/generator.ts submitOne() — a builder error fails one job, not the step (2026-09-15)', () => {
  it('marks the job failed with stage "build" and lets runStep() finish', async () => {
    const THROWING: CatalogEntry = {
      ...STEP,
      builder: (() => {
        throw new Error('i2v builder: no resolved image URL for frame f12');
      }) as CatalogEntry['builder'],
    };
    (jobsRepo.stepJobCounts as jest.Mock).mockResolvedValueOnce({ total: 2, terminal: 1 }).mockResolvedValue({ total: 2, terminal: 2 });
    (jobsRepo.claimNextBatch as jest.Mock).mockResolvedValueOnce([
      { id: 480, projectId: 'p', cohortId: 'win_test', stepSeq: 1, seq: 11, frameId: 'f12', status: 'planned', input: {} },
    ]);
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 1, running: 0 } }));
    const deps: GeneratorDeps = {
      pool: fakePoolWithPlannedJob(),
      runpod: new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) }),
      cfg: FAST_CFG,
      publicBaseUrl: 'https://vps.example',
      webhookSecret: 'secret',
    };

    await expect(runStep(deps, 'win_test', THROWING, 5)).resolves.toBeUndefined();
    expect(jobsRepo.markTerminal).toHaveBeenCalledWith(expect.anything(), 480, {
      status: 'failed',
      error: { stage: 'build', error: 'i2v builder: no resolved image URL for frame f12' },
    });
    expect(stepsRepo.incrementStepCounters).toHaveBeenCalledWith(expect.anything(), 'win_test', 1, 'job_failed');
    // no /run was ever attempted for the unbuildable job
    expect((fetchImpl.mock.calls as unknown as Array<[string]>).some((c) => String(c[0]).endsWith("/run"))).toBe(false);
  });
});

describe('agents/generator.ts submitOne() — source: "lambda" dispatch (2026-09-16, Remotion text overlay)', () => {
  const LAMBDA_STEP: CatalogEntry = {
    ...STEP,
    seq: 16,
    name: 'remotion-overlay',
    source: 'lambda',
    endpointId: 'lambda:qm-remotion-overlay',
  };

  function stepWithBuilder(builder: CatalogEntry['builder']): CatalogEntry {
    (jobsRepo.stepJobCounts as jest.Mock).mockResolvedValueOnce({ total: 1, terminal: 0 }).mockResolvedValue({ total: 1, terminal: 1 });
    (jobsRepo.claimNextBatch as jest.Mock).mockResolvedValueOnce([
      { id: 900, projectId: 'p', cohortId: 'win_test', stepSeq: 16, seq: 0, frameId: 'f1', status: 'planned', input: {} },
    ]);
    return { ...LAMBDA_STEP, builder };
  }

  function lambdaDeps(
    invokeImpl: jest.Mock,
    fetchImpl: jest.Mock = jest.fn(),
    r2: { fetchImpl?: jest.Mock; putImpl?: jest.Mock } = {},
  ): GeneratorDeps {
    return {
      pool: fakePoolWithPlannedJob(),
      runpod: new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) }),
      cfg: FAST_CFG,
      publicBaseUrl: 'https://vps.example',
      webhookSecret: 'secret',
      lambda: { functionName: 'QM-remotion-overlay', region: 'us-east-1', invokeImpl },
      r2: {
        accountId: 'acct',
        bucket: 'e2e-storystudio',
        publicUrl: 'https://pub-bce4924e66d944668be30268ccf4492c.r2.dev',
        accessKeyId: 'r2key',
        secretAccessKey: 'r2secret',
        fetchImpl: r2.fetchImpl ?? jest.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => 'video/mp4' } })),
        putImpl: r2.putImpl ?? jest.fn(async () => {}),
      },
    };
  }

  it('invokes the lambda transport (not deps.runpod), re-hosts the output into R2, marks the job complete with {video: <r2 url>}, and records a cost row', async () => {
    const invokeImpl = jest.fn(async () => ({ overlayRenderedUrl: 'https://s3.us-east-1.amazonaws.com/remotionlambda-useast1-55dp29f3ln/renders/abc123/out.mp4' }));
    const fetchImpl = jest.fn(async () => fakeRes(200, {}));
    const r2FetchImpl = jest.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => 'video/mp4' } }));
    const r2PutImpl = jest.fn(async () => {});
    const step = stepWithBuilder((() => ({ clipUrl: 'https://pub.example/f1_merge.mp4', textManifest: '{}' })) as CatalogEntry['builder']);

    await expect(runStep(lambdaDeps(invokeImpl, fetchImpl, { fetchImpl: r2FetchImpl, putImpl: r2PutImpl }), 'win_test', step, 5)).resolves.toBeUndefined();
    expect(invokeImpl).toHaveBeenCalledWith('QM-remotion-overlay', 'us-east-1', {
      clipUrl: 'https://pub.example/f1_merge.mp4',
      textManifest: '{}',
    });
    // downloaded from Remotion's own S3 URL, re-uploaded to R2 under a
    // project/frame-scoped key — never left pointing at Remotion's bucket.
    expect(r2FetchImpl).toHaveBeenCalledWith('https://s3.us-east-1.amazonaws.com/remotionlambda-useast1-55dp29f3ln/renders/abc123/out.mp4');
    expect(r2PutImpl).toHaveBeenCalledWith(expect.anything(), 'remotion-overlay/p/f1.mp4', expect.any(Buffer), 'video/mp4');
    // `video`, not `overlayRenderedUrl` — matches runpodOutUrl()'s key list (runpod/output.ts).
    expect(jobsRepo.markTerminal).toHaveBeenCalledWith(expect.anything(), 900, {
      status: 'complete',
      output: { video: 'https://pub-bce4924e66d944668be30268ccf4492c.r2.dev/remotion-overlay/p/f1.mp4' },
    });
    expect(stepsRepo.incrementStepCounters).toHaveBeenCalledWith(expect.anything(), 'win_test', 16, 'job_completed');
    // no RunPod /run or /health call for a lambda-sourced step
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails (or retries) the job when the lambda invoke throws, without ever calling deps.runpod', async () => {
    const invokeImpl = jest.fn(async () => {
      throw new Error("Lambda QM-remotion-overlay returned Unhandled: Remotion render failed");
    });
    const fetchImpl = jest.fn(async () => fakeRes(200, {}));
    const step = stepWithBuilder((() => ({ clipUrl: 'https://pub.example/f1_merge.mp4', textManifest: '{}' })) as CatalogEntry['builder']);

    await expect(runStep(lambdaDeps(invokeImpl, fetchImpl), 'win_test', step, 5)).resolves.toBeUndefined();
    expect(jobsRepo.markFailedOrRetry).toHaveBeenCalledWith(
      expect.anything(),
      900,
      { error: 'Lambda QM-remotion-overlay returned Unhandled: Remotion render failed' },
      FAST_CFG.maxAttempts,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails (or retries) the job when persisting the lambda output to R2 fails, without completing on Remotion\'s ephemeral URL', async () => {
    const invokeImpl = jest.fn(async () => ({ overlayRenderedUrl: 'https://s3.us-east-1.amazonaws.com/remotionlambda-useast1-55dp29f3ln/renders/abc123/out.mp4' }));
    const r2PutImpl = jest.fn(async () => {
      throw new Error('R2 AccessDenied');
    });
    const step = stepWithBuilder((() => ({ clipUrl: 'https://pub.example/f1_merge.mp4', textManifest: '{}' })) as CatalogEntry['builder']);

    await expect(runStep(lambdaDeps(invokeImpl, jest.fn(), { putImpl: r2PutImpl }), 'win_test', step, 5)).resolves.toBeUndefined();
    expect(jobsRepo.markFailedOrRetry).toHaveBeenCalledWith(expect.anything(), 900, { error: 'R2 AccessDenied' }, FAST_CFG.maxAttempts);
    // never marked complete with the ephemeral Remotion URL
    expect(jobsRepo.markTerminal).not.toHaveBeenCalledWith(expect.anything(), 900, expect.objectContaining({ status: 'complete' }));
  });

  it('a frame with no textManifest (builder returns __passthrough) completes immediately with the original clip, never invoking lambda or r2', async () => {
    const invokeImpl = jest.fn();
    const r2PutImpl = jest.fn();
    const step = stepWithBuilder((() => ({ __passthrough: true, clipUrl: 'https://pub.example/f1_merge.mp4' })) as CatalogEntry['builder']);

    await expect(runStep(lambdaDeps(invokeImpl, jest.fn(), { putImpl: r2PutImpl }), 'win_test', step, 5)).resolves.toBeUndefined();
    expect(r2PutImpl).not.toHaveBeenCalled();
    expect(invokeImpl).not.toHaveBeenCalled();
    expect(jobsRepo.markTerminal).toHaveBeenCalledWith(expect.anything(), 900, {
      status: 'complete',
      output: { video: 'https://pub.example/f1_merge.mp4' },
    });
    expect(stepsRepo.incrementStepCounters).toHaveBeenCalledWith(expect.anything(), 'win_test', 16, 'job_completed');
  });
});
