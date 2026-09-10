/**
 * POST /v1/requests (impl plan §7.1). Bearer auth against
 * `cfg.ingestToken`. Plans synchronously (spec §2.2 — fail fast on a bad
 * request, not six hours later), then kicks off the driver in the
 * background and returns the §9.2 acknowledgement immediately.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config';
import type { RunpodClient } from '../../runpod/client';
import { log } from '../../telemetry/log';
import { plan, PlanValidationError } from '../../agents/planner';
import { driveCohort } from '../../agents/orchestrator';

export async function requestsRoutes(
  app: FastifyInstance,
  opts: { pool: Pool; cfg: Config; runpod: RunpodClient; publicBaseUrl: string },
): Promise<void> {
  app.post('/v1/requests', async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${opts.cfg.ingestToken}`) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    try {
      const ack = await plan(opts.pool, opts.cfg, req.body);

      // Fire-and-forget — the ack does not block on the cohort actually
      // running. Errors inside the driver are logged there, not surfaced
      // here (this response has already been decided).
      void driveCohort(
        { pool: opts.pool, runpod: opts.runpod, cfg: opts.cfg, publicBaseUrl: opts.publicBaseUrl },
        ack.cohortId,
      ).catch((err) => log().error({ err, cohortId: ack.cohortId }, 'requests: driveCohort crashed'));

      reply.code(202);
      return ack;
    } catch (err) {
      if (err instanceof PlanValidationError) {
        reply.code(400);
        return { error: err.message, issues: err.issues };
      }
      log().error({ err }, 'requests: plan() failed');
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}
