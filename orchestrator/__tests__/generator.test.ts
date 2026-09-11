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

jest.mock('../src/db/repo/jobs');
jest.mock('../src/db/repo/steps');
jest.mock('../src/db/repo/endpoint-state');

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
const FAST_CFG = { workerRateUsdS: 0.0002, reconcileIntervalMs: 10, warmTimeoutMs: 60 };

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
