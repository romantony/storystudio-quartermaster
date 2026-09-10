/**
 * The HTTP surface. M0 registered only GET /v1/health; M2 adds §7's ingest,
 * webhook, and admin routes against this same instance.
 *
 * Fastify is handed the process logger (telemetry/log.ts) so request logs and
 * agent-loop logs are one stream in one format.
 */
import Fastify from 'fastify';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import { healthRoutes } from './routes/health';
import { requestsRoutes } from './routes/requests';
import { webhookRoutes } from './routes/webhooks';
import { adminRoutes } from './routes/admin';

/** Return type is inferred so the pino logger's type provider is preserved. */
export async function buildServer(cfg: Config, logger: Logger, deps: { pool: Pool; runpod: RunpodClient }) {
  const app = Fastify({
    loggerInstance: logger,
    // Body limits and timeouts get real values when the ingest route lands.
    disableRequestLogging: cfg.nodeEnv === 'test',
  });

  await app.register(healthRoutes);
  await app.register(requestsRoutes, { pool: deps.pool, cfg, runpod: deps.runpod, publicBaseUrl: cfg.publicBaseUrl });
  await app.register(webhookRoutes, { pool: deps.pool, cfg });
  await app.register(adminRoutes, { pool: deps.pool, runpod: deps.runpod });

  return app;
}
