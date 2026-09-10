/**
 * Pure unit tests for watchdog.ts's orphan-detection logic (impl plan §6.9 /
 * M3). Fixture RunpodClient (same mocked-fetch convention as
 * runpod-client.test.ts) + a fake pg pool (checkOnce only ever calls
 * `.query`, matching db/repo/endpoint-state.ts's `Queryable` type) — no real
 * Postgres or RunPod needed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunpodClient } from '../src/runpod/client';
import { checkOnce, watchedEndpoints } from '../src/watchdog';
import type { FleetEndpoint } from '../src/fleet-registry';
import { STEP_CATALOG } from '../src/steps/catalog';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'runpod', name), 'utf8'));

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

const ENDPOINT: FleetEndpoint = { counterKey: 'runpod:wan2-i2v', endpointId: 'nd7wloyvj09xwy', workers: 10 };
const WATCHDOG_CFG = { orphanGraceMs: 600_000, watchdogAutodrain: false };

function fakePool(stateRow: Record<string, unknown> | undefined) {
  return { query: jest.fn(async () => ({ rows: stateRow ? [stateRow] : [] })) } as unknown as Parameters<
    typeof checkOnce
  >[1];
}

function stateRow(overrides: Partial<{ held_by_step: number | null; observed_at: Date }> = {}) {
  return {
    endpoint_id: ENDPOINT.endpointId,
    workers_max: 10,
    workers_min: 10,
    workers_ready: 10,
    held_by_cohort: overrides.held_by_step === null ? null : 'win_2026_09_10_18',
    held_by_step: overrides.held_by_step ?? 3,
    observed_at: overrides.observed_at ?? new Date(),
  };
}

describe('watchdog checkOnce', () => {
  it('does not alert when real workers are 0, regardless of claim state', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, { workers: { ready: 0, running: 0 } }));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool(undefined);

    await checkOnce(runpod, pool, WATCHDOG_CFG, [ENDPOINT]);

    // getState should never even be queried once we know realWorkers === 0 —
    // pool.query is only called by getState, so zero calls confirms the
    // short-circuit.
    expect((pool.query as jest.Mock).mock.calls.length).toBe(0);
  });

  it('does NOT flag an orphan when a fresh claim exists', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, fixture('health.json')));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool(stateRow({ observed_at: new Date() }));
    const logger = require('../src/telemetry/log').log();
    const errorSpy = jest.spyOn(logger, 'error');

    await checkOnce(runpod, pool, WATCHDOG_CFG, [ENDPOINT]);

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('flags an orphan when real workers exist but no claim is on record', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, fixture('health.json')));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const pool = fakePool(undefined); // no endpoint_state row at all
    const logger = require('../src/telemetry/log').log();
    const errorSpy = jest.spyOn(logger, 'error');

    await checkOnce(runpod, pool, WATCHDOG_CFG, [ENDPOINT]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: ENDPOINT.endpointId }),
      expect.stringContaining('ORPHANED'),
    );
    errorSpy.mockRestore();
  });

  it('flags an orphan when a claim exists but observed_at is past orphanGraceMs', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, fixture('health.json')));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const staleObservedAt = new Date(Date.now() - WATCHDOG_CFG.orphanGraceMs - 60_000);
    const pool = fakePool(stateRow({ observed_at: staleObservedAt }));
    const logger = require('../src/telemetry/log').log();
    const errorSpy = jest.spyOn(logger, 'error');

    await checkOnce(runpod, pool, WATCHDOG_CFG, [ENDPOINT]);

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('auto-drains only when watchdogAutodrain=true AND the grace period has elapsed', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, fixture('health.json')));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const staleObservedAt = new Date(Date.now() - WATCHDOG_CFG.orphanGraceMs - 60_000);
    const pool = fakePool(stateRow({ observed_at: staleObservedAt }));

    await checkOnce(runpod, pool, { ...WATCHDOG_CFG, watchdogAutodrain: true }, [ENDPOINT]);

    // health() + patchWorkers() both go through fetchImpl — expect a second
    // call whose URL hits the management PATCH endpoint.
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const patchCall = calls.find(([url]) => url.includes('/rest.runpod.io/'));
    expect(patchCall).toBeDefined();
  });

  it('does NOT auto-drain when watchdogAutodrain=false, even with a stale claim', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, fixture('health.json')));
    const runpod = new RunpodClient(CFG, { fetchImpl, sleepImpl: jest.fn(async () => {}) });
    const staleObservedAt = new Date(Date.now() - WATCHDOG_CFG.orphanGraceMs - 60_000);
    const pool = fakePool(stateRow({ observed_at: staleObservedAt }));

    await checkOnce(runpod, pool, WATCHDOG_CFG, [ENDPOINT]);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const patchCall = calls.find(([url]) => url.includes('/rest.runpod.io/'));
    expect(patchCall).toBeUndefined();
  });
});

describe('watchedEndpoints', () => {
  const MULTITALK: FleetEndpoint = { counterKey: 'runpod:multitalk', endpointId: 'mt6vmstwzw0evp', workers: 2 };
  const BGM: FleetEndpoint = { counterKey: 'runpod:bgm-s2t', endpointId: '6apg6j7suzuezw', workers: 4 };

  it('excludes FLEET endpoints no catalogued step uses — a real false-positive found live 2026-09-10', () => {
    const fleet = [ENDPOINT, MULTITALK, BGM];
    const watched = watchedEndpoints(fleet);
    expect(watched.map((e) => e.endpointId)).not.toContain(MULTITALK.endpointId);
    expect(watched.map((e) => e.endpointId)).not.toContain(BGM.endpointId);
  });

  it('includes every FLEET endpoint a catalogued step references', () => {
    const cataloguedIds = new Set(STEP_CATALOG.map((s) => s.endpointId));
    const fleet = [ENDPOINT, MULTITALK, BGM, ...[...cataloguedIds].map((id) => ({ counterKey: id, endpointId: id, workers: 1 }))];
    const watched = watchedEndpoints(fleet);
    for (const id of cataloguedIds) {
      expect(watched.map((e) => e.endpointId)).toContain(id);
    }
  });
});
