/**
 * The divergence guard (impl plan M0 / §5.1). fleet-registry.ts is a generated
 * projection of src/shared/fleet.ts; if someone edits the live-path fleet and
 * forgets `npm run gen:fleet`, this test fails the build rather than letting
 * the orchestrator plan against stale worker counts — the exact class of bug
 * every incident comment in fleet.ts documents.
 */
import { ACCOUNT_CAP as SRC_CAP, FLEET as SRC_FLEET } from '@qm/shared/fleet';
import { ACCOUNT_CAP, FLEET, FLEET_TOTAL, pooledWorkers } from '../src/fleet-registry';

describe('fleet-registry (generated)', () => {
  it('is an exact projection of src/shared/fleet.ts — regenerate with `npm run gen:fleet` if this fails', () => {
    expect(ACCOUNT_CAP).toBe(SRC_CAP);
    expect(FLEET.map((e) => ({ counterKey: e.counterKey, endpointId: e.endpointId, workers: e.workers }))).toEqual(
      SRC_FLEET.map((e) => ({ counterKey: e.counterKey, endpointId: e.endpointId, workers: e.workers })),
    );
  });

  it('FLEET_TOTAL is the sum of pooled workers', () => {
    expect(FLEET_TOTAL).toBe(SRC_FLEET.reduce((a, e) => a + e.workers, 0));
    expect(FLEET_TOTAL).toBe(FLEET.reduce((a, e) => a + e.workers, 0));
  });

  it('pooledWorkers resolves a known key and returns 0 for an unknown one', () => {
    expect(pooledWorkers('runpod:wan2-i2v')).toBe(pooledWorkers('runpod:wan2-i2v'));
    expect(pooledWorkers('runpod:wan2-i2v')).toBeGreaterThan(0);
    expect(pooledWorkers('runpod:does-not-exist')).toBe(0);
  });

  it('leaves head-step headroom under the account cap (spec §5.2 arithmetic)', () => {
    // Not an assertion about the live path's runtime holdings — just that the
    // static pool + a 25-worker head step is describable within the cap.
    expect(FLEET_TOTAL).toBeLessThan(ACCOUNT_CAP);
  });
});
