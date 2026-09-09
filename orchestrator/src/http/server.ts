/**
 * The HTTP surface. M0 registers only GET /v1/health; §7's ingest, webhook and
 * admin routes are added in later milestones against this same instance.
 *
 * Fastify is handed the process logger (telemetry/log.ts) so request logs and
 * agent-loop logs are one stream in one format.
 */
import Fastify from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../config';
import { healthRoutes } from './routes/health';

/** Return type is inferred so the pino logger's type provider is preserved. */
export async function buildServer(cfg: Config, logger: Logger) {
  const app = Fastify({
    loggerInstance: logger,
    // Body limits and timeouts get real values when the ingest route lands.
    disableRequestLogging: cfg.nodeEnv === 'test',
  });

  await app.register(healthRoutes);

  return app;
}
