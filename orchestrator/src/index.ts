/**
 * Process entry. Loads config, opens the pg pool, constructs the RunPod
 * client, starts the HTTP server, installs shutdown hooks. This file is
 * deliberately the only place that composition happens (impl plan §2).
 *
 * M2 wires the planner/fleet/generator/driver behind the HTTP routes
 * (agents/orchestrator.ts's driveCohort, called per-request) rather than as
 * standalone background loops — the tumbling-window scheduler that would
 * run them independently of a request lands in M6.
 */
import { loadConfig } from './config';
import { closePool, initPool, getPool } from './db/pool';
import { buildServer } from './http/server';
import { createLogger, setLogger } from './telemetry/log';
import { RunpodClient } from './runpod/client';
import { driveCohort } from './agents/orchestrator';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg);
  setLogger(logger);
  logger.info({ nodeEnv: cfg.nodeEnv, port: cfg.port, fleetLive: cfg.fleetLive }, 'orchestrator starting');

  initPool(cfg);
  const runpod = new RunpodClient(cfg);

  const app = await buildServer(cfg, logger, { pool: getPool(), runpod });
  await app.listen({ host: '0.0.0.0', port: cfg.port });
  logger.info(`listening on :${cfg.port}`);

  // Resume cohorts a restart (deploy, crash) left mid-run. driveCohort() is
  // driven entirely by Postgres state: completed steps are skipped, planned
  // jobs are submitted, submitted jobs are reconciled via /status. A minimal
  // slice of M6's boot reconciliation (§10.2), added 2026-09-15 so deploying
  // a fix doesn't strand the running cohort.
  const { rows: running } = await getPool().query<{ id: string }>(`SELECT id FROM cohorts WHERE status = 'running'`);
  for (const { id } of running) {
    logger.warn({ cohortId: id }, 'boot: resuming running cohort');
    void driveCohort({ pool: getPool(), runpod, cfg, publicBaseUrl: cfg.publicBaseUrl }, id).catch((err) =>
      logger.error({ err, cohortId: id }, 'boot: resumed driveCohort crashed'),
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closePool();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // Config/boot failures land here — print the readable message, not a stack.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
