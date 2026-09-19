/**
 * Admin/observability routes (impl plan §7.3 + the 2026-09-16 dashboard).
 * `GET /v1/fleet` is "the single most useful page during M2" per the doc —
 * registry vs real `workers.ready`, side by side, so a stalled hand-scale
 * test is obvious at a glance instead of requiring a raw RunPod API call.
 *
 * Every route here now requires `Authorization: Bearer <ORCH_ADMIN_TOKEN>`
 * (2026-09-16) — `/v1/fleet` and `/v1/cohorts/:id` had none before this;
 * closed while adding the dashboard/stats/rework surface, which can trigger
 * real paid GPU generation and shouldn't be reachable by anyone who can hit
 * the domain.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config';
import type { RunpodClient } from '../../runpod/client';
import { log } from '../../telemetry/log';
import { FLEET } from '../../fleet-registry';
import { cohortSummary } from '../../agents/orchestrator';
import { assetCounts, projectCounts, costTotal, costByProject, listFailedProjects, listAlerts } from '../../db/repo/admin-stats';
import { validateRework, driveRework, ReworkError } from '../../agents/rework';
import { DASHBOARD_HTML } from './dashboard-html';
import { ASSET_KINDS, ASSET_SPECS } from '../../assets/kinds';
import { queueDepths, listProjectAssets, projectAssetCounts } from '../../db/repo/assets';
import { listLivePipelineProjects, getPipelineProject } from '../../db/repo/pipeline';

export async function adminRoutes(
  app: FastifyInstance,
  opts: { pool: Pool; runpod: RunpodClient; cfg: Config; publicBaseUrl: string },
): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    // GET /v1/admin/dashboard (the HTML page itself) is deliberately
    // excluded — the page prompts for the token client-side and sends it
    // on every subsequent fetch(); the HTML shell itself carries no data.
    if (req.url === '/v1/admin/dashboard') return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${opts.cfg.adminToken}`) {
      reply.code(401);
      return reply.send({ error: 'unauthorized' });
    }
  });

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

  // ── asset pipeline (ORCH_PIPELINE_MODE=assets) ────────────────────────
  // The one number that says whether the model is doing its job: for each
  // asset type, how much is queued versus how much is actually on its
  // endpoint. Queued work sitting behind an endpoint with idle pods is the
  // failure this architecture exists to prevent, and it is invisible without
  // this. Empty in 'cohort' mode, where the asset tables have no rows.
  app.get('/v1/assets', async () => {
    const [depths, live] = await Promise.all([queueDepths(opts.pool), listLivePipelineProjects(opts.pool)]);
    return {
      pipelineMode: opts.cfg.pipelineMode,
      queues: ASSET_KINDS.map((kind) => {
        const spec = ASSET_SPECS[kind];
        const d = depths.find((x) => x.kind === kind);
        return {
          kind,
          table: spec.table,
          endpointId: spec.endpointId,
          pods: spec.maxInFlight,
          pending: d?.pending ?? 0,
          submitted: d?.submitted ?? 0,
        };
      }),
      projects: live.map((p) => ({
        projectId: p.projectId,
        status: p.status,
        expectedAssets: p.expectedAssets,
        tailStage: p.tailStage,
        attempts: p.attempts,
        startedAt: p.startedAt,
        updatedAt: p.updatedAt,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/v1/assets/:id', async (req, reply) => {
    const rows = await listProjectAssets(opts.pool, req.params.id);
    if (rows.length === 0) {
      reply.code(404);
      return { error: 'no assets for that project' };
    }
    const pp = await getPipelineProject(opts.pool, req.params.id);
    return {
      project: pp ?? null,
      counts: await projectAssetCounts(opts.pool, req.params.id),
      assets: rows.map((r) => ({
        kind: r.kind,
        frameId: r.frameId,
        seq: r.seq,
        status: r.status,
        stage: r.stage,
        attempts: r.attempts,
        reworks: r.reworks,
        assetUrl: r.assetUrl,
        // What this row is still waiting on — the first thing you want when
        // a project is stuck.
        waitingOn: r.requiredInputs.filter((k) => !r.sources[k]),
        updatedAt: r.updatedAt,
        error: r.error,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/v1/cohorts/:id', async (req, reply) => {
    const summary = await cohortSummary(opts.pool, req.params.id);
    if (!summary.cohort) {
      reply.code(404);
      return { error: 'cohort not found' };
    }
    return summary;
  });

  app.get('/v1/admin/dashboard/stats', async () => {
    const [assets, projects, total, byProject, failedProjects, alerts] = await Promise.all([
      assetCounts(opts.pool),
      projectCounts(opts.pool),
      costTotal(opts.pool),
      costByProject(opts.pool),
      listFailedProjects(opts.pool),
      listAlerts(opts.pool),
    ]);
    return {
      assets,
      projects,
      cost: {
        totalUsd: total,
        // Real, disclosed limitation — see db/repo/admin-stats.ts's costTotal().
        note: 'GPU execution cost only (job_costs). Does not include RunPod warm-up/allocation overhead (allocation_costs is not written by anything yet) — a real undercount of true spend.',
        byProject,
      },
      failedProjects,
      alerts,
    };
  });

  app.post<{ Params: { id: string } }>('/v1/admin/projects/:id/rework', async (req, reply) => {
    const projectId = req.params.id;
    const deps = { pool: opts.pool, runpod: opts.runpod, cfg: opts.cfg, publicBaseUrl: opts.publicBaseUrl };
    try {
      // validateRework() is awaited synchronously — an invalid projectId or
      // "nothing to rework" surfaces as a real 400 right here. Only the
      // actual generation (driveRework, minutes not milliseconds) is
      // fire-and-forget, mirroring http/routes/requests.ts's plan()-then-
      // driveCohort() split; the caller polls the stats endpoint / GET
      // /v1/cohorts/:id rather than holding this connection open.
      const prepared = await validateRework(deps, projectId);
      void driveRework(deps, prepared).catch((err) => log().error({ err, projectId }, 'admin: rework crashed'));
      reply.code(202);
      return { projectId, repairId: prepared.repairId, accepted: true };
    } catch (err) {
      if (err instanceof ReworkError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.get('/v1/admin/dashboard', async (_req, reply) => {
    reply.type('text/html');
    return DASHBOARD_HTML;
  });
}
