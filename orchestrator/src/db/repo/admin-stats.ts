/**
 * Admin dashboard stats (http/routes/admin.ts, 2026-09-16) — small,
 * individually-testable pure query functions over tables that already
 * exist. No new tables for stats themselves.
 */
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface StatusCounts {
  [status: string]: number;
}

async function statusCounts(db: Queryable, table: 'jobs' | 'projects'): Promise<StatusCounts> {
  const { rows } = await db.query<{ status: string; count: string }>(`SELECT status, count(*) AS count FROM ${table} GROUP BY status`);
  const out: StatusCounts = {};
  for (const r of rows) out[r.status] = Number(r.count);
  return out;
}

/** jobs.status breakdown — generated=complete, queued=planned+submitted,
 * failed=failed, matches the dashboard's own vocabulary (not jobs' raw
 * status enum, which also has regated/requeued). */
export async function assetCounts(db: Queryable): Promise<{ generated: number; queued: number; failed: number; byRawStatus: StatusCounts }> {
  const byRawStatus = await statusCounts(db, 'jobs');
  return {
    generated: byRawStatus.complete ?? 0,
    queued: (byRawStatus.planned ?? 0) + (byRawStatus.submitted ?? 0),
    failed: byRawStatus.failed ?? 0,
    byRawStatus,
  };
}

/** projects.status breakdown, plus (batch mode only, count is 0 otherwise)
 * requests still sitting in request_outbox — genuinely different from an
 * in-progress *planned* project, so kept as its own figure rather than
 * folded in. */
export async function projectCounts(db: Queryable): Promise<{ byStatus: StatusCounts; outboxQueued: number }> {
  const byStatus = await statusCounts(db, 'projects');
  const { rows } = await db.query<{ count: string }>(`SELECT count(*) AS count FROM request_outbox WHERE status = 'queued'`);
  return { byStatus, outboxQueued: Number(rows[0]?.count ?? 0) };
}

/** Real GPU-execution cost only — job_costs.cost_usd, a DB-generated column
 * (execution_ms * worker_rate_usd_s). Does NOT include allocation_costs
 * (warm-up/scaling overhead, ~25% of a real cohort's bill per the window-
 * architecture design doc) — that table is never written by anything today,
 * so this is a real, known undercount of true spend. Surfaced as-is; the
 * caller (the dashboard route/page) is responsible for labeling it honestly. */
export async function costTotal(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ sum: string | null }>(`SELECT sum(cost_usd) AS sum FROM job_costs`);
  return Number(rows[0]?.sum ?? 0);
}

export interface ProjectCost {
  projectId: string;
  costUsd: number;
}

export async function costByProject(db: Queryable, limit = 100): Promise<ProjectCost[]> {
  const { rows } = await db.query<{ project_id: string; sum: string }>(
    `SELECT j.project_id, sum(jc.cost_usd) AS sum
       FROM jobs j JOIN job_costs jc ON jc.job_id = j.id
      GROUP BY j.project_id
      ORDER BY sum DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ projectId: r.project_id, costUsd: Number(r.sum) }));
}

export interface FailedProjectRow {
  id: string;
  status: string;
  tier: string;
  finishedAt: Date | null;
  failedJobs: number;
}

/** The rework UI's own source list — every project a rework button could
 * apply to. Ordered most-recently-finished first, so the freshest failures
 * surface at the top. */
export async function listFailedProjects(db: Queryable, limit = 50): Promise<FailedProjectRow[]> {
  const { rows } = await db.query<{ id: string; status: string; tier: string; finished_at: Date | null; failed_jobs: string }>(
    `SELECT p.id, p.status, p.tier, p.finished_at,
            (SELECT count(*) FROM jobs WHERE project_id = p.id AND status = 'failed') AS failed_jobs
       FROM projects p
      WHERE p.status IN ('partial', 'failed')
      ORDER BY p.finished_at DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    tier: r.tier,
    finishedAt: r.finished_at,
    failedJobs: Number(r.failed_jobs),
  }));
}
