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
import { allocate, release, emergencyDrain, FleetStallError, type FleetDeps } from '../src/agents/fleet';
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
  scope: 'bulk',
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

describe('agents/fleet.ts release() — M4 drain precondition', () => {
  const GATED_STEP: CatalogEntry & { workers: number } = { ...STEP, seq: 1, gate: 'image' };

  function poolWithCounts(ungated: number, inFlight: number) {
    return {
      query: jest.fn(async (sql: string) => {
        if (sql.includes("status = 'complete' AND quality_status IS NULL")) return { rows: [{ count: String(ungated) }] };
        if (sql.includes("status IN ('planned', 'submitted')")) return { rows: [{ count: String(inFlight) }] };
        return { rows: [] };
      }),
    } as unknown as FleetDeps['pool'];
  }

  it('throws FleetStallError("ungated_on_drain") and never PATCHes when jobs are still ungated', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 0, running: 0 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: FleetDeps = { pool: poolWithCounts(2, 0), runpod, cfg: FLEET_CFG };

    await expect(release(deps, 'win_test', GATED_STEP)).rejects.toMatchObject({ reason: 'ungated_on_drain' });
    const patchCall = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).find(([url]) => url.includes('/rest.runpod.io/'));
    expect(patchCall).toBeUndefined();
  });

  it('throws when jobs are still in flight (planned/submitted), even with zero ungated', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 0, running: 0 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: FleetDeps = { pool: poolWithCounts(0, 1), runpod, cfg: FLEET_CFG };

    await expect(release(deps, 'win_test', GATED_STEP)).rejects.toMatchObject({ reason: 'ungated_on_drain' });
  });

  it('proceeds normally (PATCHes to drain) when ungated=0 and inFlight=0 on a gated step', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 0, running: 0 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: FleetDeps = { pool: poolWithCounts(0, 0), runpod, cfg: FLEET_CFG };

    await release(deps, 'win_test', GATED_STEP);

    const patchCall = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).find(([url]) => url.includes('/rest.runpod.io/'));
    expect(patchCall).toBeDefined();
  });

  it('never even queries the ungated counts for an ungated step (gate: null)', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 0, running: 0 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = poolWithCounts(99, 99); // would throw if this step's release() checked it
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await release(deps, 'win_test', STEP); // STEP has gate: null
    const patchCall = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).find(([url]) => url.includes('/rest.runpod.io/'));
    expect(patchCall).toBeDefined(); // proceeded to drain, ignoring the poisoned counts
  });
});

describe('agents/fleet.ts emergencyDrain() — driver failure-path backstop (2026-09-11 incident)', () => {
  it('PATCHes workersMax:0 with no gating and no drain-confirmation wait', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, {}));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: FleetDeps = { pool: fakePool(), runpod, cfg: FLEET_CFG };

    await emergencyDrain(deps, 'e165se4r3eo5hp');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rest.runpod.io/');
    expect(JSON.parse(init.body as string)).toEqual({ workersMin: 0, workersMax: 0 });
  });

  it('never throws, even when the PATCH itself fails — must not mask the original driver error', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(500, { error: 'boom' }));
    const runpod = new RunpodClient({ ...CFG, runpodMaxRetries: 0 }, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: FleetDeps = { pool: fakePool(), runpod, cfg: FLEET_CFG };

    await expect(emergencyDrain(deps, 'e165se4r3eo5hp')).resolves.toBeUndefined();
  });

  it('is a no-op in shadow mode (fleetLive: false) — no PATCH sent', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, {}));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: FleetDeps = { pool: fakePool(), runpod, cfg: { ...FLEET_CFG, fleetLive: false } };

    await emergencyDrain(deps, 'e165se4r3eo5hp');

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
