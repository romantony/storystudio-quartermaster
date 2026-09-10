/**
 * Unit tests for agents/fleet.ts's allocate()/release() — new as of the M3
 * fix (2026-09-10), which turned a real production incident (5 workers
 * billed for 8+ minutes with zero throughput under the old
 * workersMin==workersMax design) into permanent coverage. Fixture
 * RunpodClient (same mocked-fetch convention as runpod-client.test.ts) + a
 * fake pg pool (allocate()/release() only ever call `.query` through the
 * repo-layer functions, matching their `Queryable` types) — no real
 * Postgres or RunPod needed.
 */
import { RunpodClient } from '../src/runpod/client';
import { allocate, release, FleetStallError, type FleetDeps } from '../src/agents/fleet';
import type { CatalogEntry } from '../src/steps/catalog';

const CFG = {
  runpodApiBase: 'https://api.runpod.ai/v2',
  runpodRestBase: 'https://rest.runpod.io/v1',
  runpodApiKey: 'test-key',
  runpodMaxRetries: 2,
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
  return { query: jest.fn(async () => ({ rows: [] })) } as unknown as FleetDeps['pool'];
}

/** PATCH always succeeds; every health() (this endpoint's own + every
 * sibling sumWorkersMaxExcept reads) reports zero — keeps the cap assertion
 * trivially satisfied so tests not focused on cap_breach don't trip it via
 * FLEET's real sibling list. */
function quietFetch() {
  return jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PATCH') return fakeRes(200, {});
    return fakeRes(200, { workers: { ready: 0, running: 0 } });
  });
}

const STEP: CatalogEntry & { workers: number } = {
  seq: 1,
  name: 'image',
  endpointId: 'e165se4r3eo5hp', // real qwen-image-gen id, matches FLEET
  gate: null,
  dependsOn: [],
  builder: (() => ({})) as CatalogEntry['builder'],
  workers: 5,
};

const FLEET_CFG = { fleetLive: true, drainTimeoutMs: 300_000, accountCap: 40, liveReserveWorkers: 8 };

describe('agents/fleet.ts allocate() — M3 fix', () => {
  it('PATCHes workersMax only — workersMin is never sent as part of allocate()', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await allocate(deps, 'win_test', STEP);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const patchCall = calls.find(([url]) => url.includes('/rest.runpod.io/'));
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall![1].body as string);
    expect(body).toEqual({ workersMax: 5 });
    expect(body.workersMin).toBeUndefined();
  });

  it('calls runpod.health() exactly once for the sanity check — not a poll loop', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await allocate(deps, 'win_test', STEP);

    // sumWorkersMaxExcept also calls health() on real sibling ids from
    // FLEET (unmocked) — assert the endpoint's OWN health() call count is
    // 1, not the total across all endpoints.
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const ownHealthCalls = calls.filter(([url]) => url.includes(`/${STEP.endpointId}/health`));
    expect(ownHealthCalls).toHaveLength(1);
  });

  it('throws FleetStallError("unreachable") when the sanity health() call fails, does not retry', async () => {
    const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') return fakeRes(200, {}); // the PATCH itself must succeed
      return fakeRes(500, 'boom'); // every GET (the sanity health() call) fails
    });
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    const err = await allocate(deps, 'win_test', STEP).catch((e) => e);
    expect(err).toBeInstanceOf(FleetStallError);
    expect(err.reason).toBe('unreachable');
  });

  it('throws FleetStallError("cap_breach") when siblings already hold too much of the account cap', async () => {
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(`/${STEP.endpointId}/health`)) return fakeRes(200, { workers: { ready: 0, running: 0 } });
      // every sibling endpoint reports a big real draw
      return fakeRes(200, { workers: { ready: 20, running: 20 } });
    });
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: { ...FLEET_CFG, accountCap: 10 } };

    await expect(allocate(deps, 'win_test', STEP)).rejects.toMatchObject({ reason: 'cap_breach' });
  });

  it('never sends a nonzero workersMin anywhere during a successful allocate()', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await allocate(deps, 'win_test', STEP);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const patchCalls = calls.filter(([url]) => url.includes('/rest.runpod.io/'));
    for (const [, opts] of patchCalls) {
      const body = JSON.parse(opts.body as string);
      expect(body.workersMin ?? 0).toBe(0);
    }
  });
});

describe('agents/fleet.ts release() — unchanged behavior', () => {
  it('still PATCHes both workersMin:0 and workersMax:0 on drain', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 0, running: 0 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await release(deps, 'win_test', STEP);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const patchCall = calls.find(([url]) => url.includes('/rest.runpod.io/'));
    expect(JSON.parse(patchCall![1].body as string)).toEqual({ workersMin: 0, workersMax: 0 });
  });
});
