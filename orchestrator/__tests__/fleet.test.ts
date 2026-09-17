/**
 * Unit tests for agents/fleet.ts's allocate()/release()/emergencyDrain() —
 * rewritten 2026-09-17 (twice) for the fixed-pool model (see fleet.ts's
 * header comment): allocate()/emergencyDrain() still PATCH workersMax (to
 * the fixed pod count / to 0 respectively — never an uncapped demand
 * figure), but release() no longer PATCHes back to 0 between steps, since
 * the AWS live path's own provisioner independently owns scaling these
 * shared endpoints to 0 when idle. Fixture RunpodClient (same mocked-fetch
 * convention as runpod-client.test.ts) + a fake pg pool — no real Postgres
 * or RunPod needed.
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

function quietFetch() {
  return jest.fn(async () => fakeRes(200, { workers: { ready: 0, running: 0 } }));
}

/** Every call this mock's fetch received that hit RunPod's management API
 * (rest.runpod.io) — a PATCH to a fixed pool is exactly the behavior these
 * tests assert never happens from allocate()/release()/emergencyDrain(). */
function patchCalls(fetchImpl: jest.Mock) {
  return (fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter(
    ([url, init]) => url.includes('/rest.runpod.io/') && init?.method === 'PATCH',
  );
}

const STEP: CatalogEntry & { workers: number } = {
  seq: 1,
  name: 'image',
  endpointId: 'e165se4r3eo5hp', // real qwen-image-gen id, matches FLEET
  gate: null,
  dependsOn: [],
  scope: 'bulk',
  builder: (() => ({})) as CatalogEntry['builder'],
  workers: 4, // the fixed pod count, not a scaling target
};

const FLEET_CFG = { fleetLive: true };

describe('agents/fleet.ts allocate() — fixed pool (2026-09-17)', () => {
  it('PATCHes workersMax to the fixed pod count (idempotent, or a real raise if the live path released it to 0)', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await allocate(deps, 'win_test', STEP);

    const calls = patchCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ workersMax: STEP.workers });
    // upsertHeld's INSERT ... ON CONFLICT — asserted loosely on the values,
    // not exact SQL text, so a harmless query-shape refactor doesn't break this.
    const insertCall = (pool.query as jest.Mock).mock.calls.find(([, params]: [string, unknown[]]) =>
      params?.includes(STEP.endpointId),
    );
    expect(insertCall).toBeDefined();
  });

  it('is a no-op in shadow mode (fleetLive: false) — no PATCH sent', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: { fleetLive: false } };

    await allocate(deps, 'win_test', STEP);

    expect(patchCalls(fetchImpl)).toEqual([]);
  });

  it('calls runpod.health() exactly once for the reachability probe — not a poll loop', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await allocate(deps, 'win_test', STEP);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const ownHealthCalls = calls.filter(([url]) => url.includes(`/${STEP.endpointId}/health`));
    expect(ownHealthCalls).toHaveLength(1);
  });

  it('throws FleetStallError("unreachable") when the reachability probe fails, after the PATCH has already gone out', async () => {
    const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') return fakeRes(200, {}); // the PATCH itself must succeed
      return fakeRes(500, 'boom'); // every GET (the reachability probe) fails
    });
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    const err = await allocate(deps, 'win_test', STEP).catch((e) => e);
    expect(err).toBeInstanceOf(FleetStallError);
    expect(err.reason).toBe('unreachable');
    expect(patchCalls(fetchImpl)).toHaveLength(1);
  });
});

describe('agents/fleet.ts release() — fixed pool (2026-09-17)', () => {
  it('never PATCHes workers to 0 — clears the endpoint_state claim only', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await release(deps, 'win_test', STEP);

    expect(patchCalls(fetchImpl)).toEqual([]);
    const clearCall = (pool.query as jest.Mock).mock.calls.find(([, params]: [string, unknown[]]) =>
      params?.includes(STEP.endpointId),
    );
    expect(clearCall).toBeDefined();
  });
});

describe('agents/fleet.ts release() — M4 drain precondition (unchanged by the fixed-pool change)', () => {
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

  it('throws FleetStallError("ungated_on_drain") and never touches endpoint_state when jobs are still ungated', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = poolWithCounts(2, 0);
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await expect(release(deps, 'win_test', GATED_STEP)).rejects.toMatchObject({ reason: 'ungated_on_drain' });
    const clearCall = (pool.query as jest.Mock).mock.calls.find(([, params]: [string, unknown[]]) =>
      params?.includes(GATED_STEP.endpointId),
    );
    expect(clearCall).toBeUndefined();
  });

  it('throws when jobs are still in flight (planned/submitted), even with zero ungated', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const deps: FleetDeps = { pool: poolWithCounts(0, 1), runpod, cfg: FLEET_CFG };

    await expect(release(deps, 'win_test', GATED_STEP)).rejects.toMatchObject({ reason: 'ungated_on_drain' });
  });

  it('proceeds normally (clears the claim) when ungated=0 and inFlight=0 on a gated step', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = poolWithCounts(0, 0);
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await release(deps, 'win_test', GATED_STEP);

    const clearCall = (pool.query as jest.Mock).mock.calls.find(([, params]: [string, unknown[]]) =>
      params?.includes(GATED_STEP.endpointId),
    );
    expect(clearCall).toBeDefined();
  });

  it('never even queries the ungated counts for an ungated step (gate: null)', async () => {
    const fetchImpl = quietFetch();
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = poolWithCounts(99, 99); // would throw if this step's release() checked it
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await release(deps, 'win_test', STEP); // STEP has gate: null
    const clearCall = (pool.query as jest.Mock).mock.calls.find(([, params]: [string, unknown[]]) =>
      params?.includes(STEP.endpointId),
    );
    expect(clearCall).toBeDefined(); // proceeded to clear, ignoring the poisoned counts
  });
});

describe('agents/fleet.ts emergencyDrain() — driver failure-path backstop (2026-09-11 incident, restored 2026-09-17)', () => {
  it('PATCHes workersMax:0 and clears the endpoint_state claim, no gating and no drain-confirmation wait', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, {}));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await emergencyDrain(deps, 'e165se4r3eo5hp');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rest.runpod.io/');
    expect(JSON.parse(init.body as string)).toEqual({ workersMin: 0, workersMax: 0 });
    const clearCall = (pool.query as jest.Mock).mock.calls.find(([, params]: [string, unknown[]]) =>
      params?.includes('e165se4r3eo5hp'),
    );
    expect(clearCall).toBeDefined();
  });

  it('never throws, even when the PATCH itself fails — must not mask the original driver error', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(500, { error: 'boom' }));
    const runpod = new RunpodClient({ ...CFG, runpodMaxRetries: 0 }, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: FLEET_CFG };

    await expect(emergencyDrain(deps, 'e165se4r3eo5hp')).resolves.toBeUndefined();
  });

  it('is a no-op in shadow mode (fleetLive: false) — no PATCH sent, claim still cleared', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, {}));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool();
    const deps: FleetDeps = { pool, runpod, cfg: { fleetLive: false } };

    await emergencyDrain(deps, 'e165se4r3eo5hp');

    expect(fetchImpl).not.toHaveBeenCalled();
    const clearCall = (pool.query as jest.Mock).mock.calls.find(([, params]: [string, unknown[]]) =>
      params?.includes('e165se4r3eo5hp'),
    );
    expect(clearCall).toBeDefined();
  });
});
