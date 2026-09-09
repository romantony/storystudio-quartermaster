import { loadConfig } from '../src/config';

const MINIMAL = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/qm_orch',
  ORCH_INGEST_TOKEN: 'ingest-tok',
  ORCH_WEBHOOK_SECRET: 'wh-secret',
};

describe('loadConfig', () => {
  it('parses a minimal env and fills every operational default from impl plan §17', () => {
    const cfg = loadConfig(MINIMAL as NodeJS.ProcessEnv);
    expect(cfg.databaseUrl).toBe(MINIMAL.DATABASE_URL);
    expect(cfg.port).toBe(8080);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.windowCron).toBe('0 0,6,12,18 * * *');
    expect(cfg.workersHead).toBe(25);
    expect(cfg.workersTail).toBe(10);
    expect(cfg.liveReserveWorkers).toBe(8);
    expect(cfg.accountCap).toBe(40);
    expect(cfg.fleetLive).toBe(false);
    expect(cfg.qualityGates).toBe('full');
    expect(cfg.workerRateUsdS).toBeCloseTo(0.00021);
    // RunPod key is optional in M0.
    expect(cfg.runpodApiKey).toBeUndefined();
  });

  it('is frozen — callers cannot mutate shared config', () => {
    const cfg = loadConfig(MINIMAL as NodeJS.ProcessEnv);
    expect(() => {
      (cfg as { port: number }).port = 1;
    }).toThrow();
  });

  it('coerces numeric and boolean env strings', () => {
    const cfg = loadConfig({
      ...MINIMAL,
      ORCH_PORT: '9000',
      ORCH_FLEET_LIVE: 'true',
      QM_LIVE_RESERVE_WORKERS: '5',
      PG_POOL_MAX: '30',
    } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(9000);
    expect(cfg.fleetLive).toBe(true);
    expect(cfg.liveReserveWorkers).toBe(5);
    expect(cfg.pgPoolMax).toBe(30);
  });

  it('throws with every missing secret listed at once, by env var name', () => {
    let err: Error | undefined;
    try {
      loadConfig({} as NodeJS.ProcessEnv);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('DATABASE_URL');
    expect(err!.message).toContain('ORCH_INGEST_TOKEN');
    expect(err!.message).toContain('ORCH_WEBHOOK_SECRET');
  });

  it('rejects an out-of-enum qualityGates value', () => {
    expect(() =>
      loadConfig({ ...MINIMAL, ORCH_QUALITY_GATES: 'sometimes' } as NodeJS.ProcessEnv),
    ).toThrow(/ORCH_QUALITY_GATES/);
  });

  it('rejects a non-numeric port rather than silently defaulting', () => {
    expect(() =>
      loadConfig({ ...MINIMAL, ORCH_PORT: 'eighty' } as NodeJS.ProcessEnv),
    ).toThrow(/ORCH_PORT/);
  });
});
