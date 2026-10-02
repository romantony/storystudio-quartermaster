/**
 * fleet-registry.ts is the orchestrator's own hand-maintained fleet (it used to
 * be generated from the AWS live path's src/shared/fleet.ts). These guard its
 * shape: unique endpoints, and room under the account cap for the 3D pipeline's
 * workers, which share the same RunPod account.
 */
import { ACCOUNT_CAP, FLEET, FLEET_TOTAL, pooledWorkers } from '../src/fleet-registry';

describe('fleet-registry', () => {
  it('FLEET_TOTAL is the sum of pooled workers', () => {
    expect(FLEET_TOTAL).toBe(FLEET.reduce((a, e) => a + e.workers, 0));
  });

  it('has unique counter keys and endpoint ids, each with a real pod count', () => {
    expect(new Set(FLEET.map((e) => e.counterKey)).size).toBe(FLEET.length);
    expect(new Set(FLEET.map((e) => e.endpointId)).size).toBe(FLEET.length);
    for (const e of FLEET) expect(e.workers).toBeGreaterThan(0);
  });

  it('pooledWorkers resolves a known key and returns 0 for an unknown one', () => {
    expect(pooledWorkers('runpod:wan2-i2v')).toBe(6);
    expect(pooledWorkers('runpod:does-not-exist')).toBe(0);
  });

  it('leaves room under the account cap for the 3D pipeline (11 workers)', () => {
    expect(FLEET_TOTAL + 11).toBeLessThanOrEqual(ACCOUNT_CAP);
  });
});
