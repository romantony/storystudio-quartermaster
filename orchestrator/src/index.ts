/**
 * Process entry. M0 scope: load config, open the pg pool, start the HTTP
 * server, install shutdown hooks. The four agent loops (planner, fleet,
 * generator, quality) and the window scheduler are wired in here from M2
 * onward — this file is deliberately the only place that composition happens
 * (impl plan §2).
 */
import { loadConfig } from './config';
import { closePool, initPool } from './db/pool';
import { buildServer } from './http/server';
import { createLogger, setLogger } from './telemetry/log';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg);
  setLogger(logger);
  logger.info({ nodeEnv: cfg.nodeEnv, port: cfg.port, fleetLive: cfg.fleetLive }, 'orchestrator starting');

  initPool(cfg);

  const app = await buildServer(cfg, logger);
  await app.listen({ host: '0.0.0.0', port: cfg.port });
  logger.info(`listening on :${cfg.port}`);

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
