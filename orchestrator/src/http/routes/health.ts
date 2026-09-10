/**
 * GET /v1/health — liveness + Postgres reachability + last RunPod contact.
 *
 * M0's exit criterion is that this endpoint reports pg reachable. `runpod` is a
 * stub until the RunPod agent exists (M2/M3); its shape is fixed now so callers
 * and dashboards do not have to change when it starts carrying a real value.
 *
 * 200 when Postgres answers, 503 when it does not — so a load balancer or the
 * watchdog can treat the process as unhealthy without parsing the body.
 */
import type { FastifyInstance } from 'fastify';
import { pingDb } from '../../db/pool';

const STARTED_AT = Date.now();
const VERSION = process.env.npm_package_version ?? '0.1.0';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/health', async (_req, reply) => {
    const pg = await pingDb();
    const body = {
      status: pg.ok ? ('ok' as const) : ('degraded' as const),
      version: VERSION,
      uptimeS: Math.round((Date.now() - STARTED_AT) / 1000),
      pg,
      runpod: { lastContactAt: null as string | null }, // populated from M2
    };
    reply.code(pg.ok ? 200 : 503);
    return body;
  });
}
