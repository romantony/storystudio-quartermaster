/**
 * POST /v1/requests (impl plan §7.1). Bearer auth against
 * `cfg.ingestToken`. Plans synchronously (spec §2.2 — fail fast on a bad
 * request, not six hours later), then kicks off the driver in the
 * background and returns the §9.2 acknowledgement immediately.
 *
 * Forks first on `cfg.pipelineMode` (2026-09-19, default 'cohort'):
 * 'assets' hands the request to assets/submit.ts instead, which writes one
 * row per asset and returns — see src/assets/README.md.
 *
 * Then forks on `cfg.schedulingMode` (2026-09-16, default 'project' — today's
 * exact behavior, unchanged): 'batch' mode still validates synchronously
 * (same fail-fast guarantee — validateRequest() covers both zod shape and
 * the business-rule checks) but queues instead of planning+driving —
 * agents/batch-window.ts's cron-fired runBatchWindow() plans the whole
 * window's queue together, once, later.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config';
import type { RunpodClient } from '../../runpod/client';
import { log } from '../../telemetry/log';
import { plan, validateRequest, PlanValidationError } from '../../agents/planner';
import { driveCohort } from '../../agents/orchestrator';
import { enqueueRequest } from '../../db/repo/request-outbox';
import { windowBounds } from '../../db/repo/cohorts';
import { submitToAssetPipeline } from '../../assets/submit';

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
      if (opts.cfg.pipelineMode === 'assets') {
        // The per-asset generator model (2026-09-19). No cohort, no window,
        // no driver kicked off here: submission writes every asset the
        // project needs into that asset's own table, and the eight agents
        // already polling those tables pick them up on their next tick.
        // Checked before schedulingMode because that switch is about WHEN a
        // cohort is planned, which this model has no equivalent of.
        const ack = await submitToAssetPipeline(opts.pool, opts.cfg, req.body);
        reply.code(202);
        return ack;
      }

      if (opts.cfg.schedulingMode === 'batch') {
        // Same fail-fast guarantee as 'project' mode — a malformed request
        // is rejected here, at submission time, never left to fail hours
        // later at the window boundary.
        const { req: validated } = validateRequest(req.body);
        const row = await enqueueRequest(opts.pool, {
          requestId: validated.requestId,
          projectId: validated.projectId,
          payload: validated,
        });
        reply.code(202);
        return {
          requestId: row.requestId,
          accepted: true,
          queued: true,
          windowClosesAt: windowBounds().closesAt.toISOString(),
        };
      }

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
