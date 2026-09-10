/**
 * Read-only admin/observability routes (impl plan §7.3). `GET /v1/fleet` is
 * "the single most useful page during M2" per the doc — registry vs real
 * `workers.ready`, side by side, so a stalled hand-scale test is obvious at
 * a glance instead of requiring a raw RunPod API call.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { RunpodClient } from '../../runpod/client';
import { FLEET } from '../../fleet-registry';
import { cohortSummary } from '../../agents/orchestrator';

export async function adminRoutes(app: FastifyInstance, opts: { pool: Pool; runpod: RunpodClient }): Promise<void> {
  app.get('/v1/fleet', async () => {
    const rows = await Promise.all(
      FLEET.map(async (e) => {
        try {
          const h = await opts.runpod.health(e.endpointId);
          return {
            counterKey: e.counterKey,
            endpointId: e.endpointId,
            registryWorkers: e.workers,
            realReady: h.workers.ready ?? 0,
            realRunning: h.workers.running ?? 0,
          };
        } catch (err) {
          return {
            counterKey: e.counterKey,
            endpointId: e.endpointId,
            registryWorkers: e.workers,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return { fleet: rows };
  });

  app.get<{ Params: { id: string } }>('/v1/cohorts/:id', async (req, reply) => {
    const summary = await cohortSummary(opts.pool, req.params.id);
    if (!summary.cohort) {
      reply.code(404);
      return { error: 'cohort not found' };
    }
    return summary;
  });
}
