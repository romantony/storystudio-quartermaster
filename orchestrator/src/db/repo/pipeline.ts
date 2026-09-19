/**
 * `pipeline_projects` repo (migration 013) — the project compiler's state.
 *
 * The asset tables deliberately know nothing about "is this project
 * finished": that is the one genuinely project-level question in a model
 * that is otherwise entirely per-asset, and it lives here, read by exactly
 * one agent (assets/compiler.ts).
 */
import type { Pool, PoolClient } from 'pg';
import type { AssetPlan } from '../../assets/plan';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export type PipelineStatus = 'generating' | 'assembling' | 'completed' | 'partial' | 'failed';

/** The project-level QA verdict (migration 016). The compiler assembles on
 * `passed` or `bypassed` only; `failed` is terminal. */
export type ProjectQaStatus = 'pending' | 'passed' | 'bypassed' | 'failed';

export interface PipelineProject {
  projectId: string;
  status: PipelineStatus;
  qaStatus: ProjectQaStatus;
  qaDetail: unknown;
  plan: AssetPlan;
  expectedAssets: number;
  manifest: unknown;
  manifestUrl: string | null;
  tailStage: string | null;
  tailJobId: string | null;
  finalUrl: string | null;
  attempts: number;
  lastError: unknown;
  startedAt: Date;
  assemblingAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

const COLUMNS = `project_id, status, qa_status, qa_detail, plan, expected_assets, manifest,
                 manifest_url, tail_stage, tail_job_id, final_url, attempts, last_error,
                 started_at, assembling_at, completed_at, updated_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
function toPipeline(row: any): PipelineProject {
  return {
    projectId: row.project_id,
    status: row.status,
    qaStatus: row.qa_status ?? 'pending',
    qaDetail: row.qa_detail ?? {},
    plan: row.plan,
    expectedAssets: row.expected_assets,
    manifest: row.manifest,
    manifestUrl: row.manifest_url,
    tailStage: row.tail_stage,
    tailJobId: row.tail_job_id,
    finalUrl: row.final_url,
    attempts: row.attempts,
    lastError: row.last_error,
    startedAt: row.started_at,
    assemblingAt: row.assembling_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

/** Idempotent, like the asset rows it accompanies — a replayed submission
 * must not reset a project that is already generating. */
export async function insertPipelineProject(
  db: Queryable,
  input: { projectId: string; plan: AssetPlan; expectedAssets: number },
): Promise<void> {
  await db.query(
    `INSERT INTO pipeline_projects (project_id, status, plan, expected_assets)
     VALUES ($1, 'generating', $2, $3)
     ON CONFLICT (project_id) DO NOTHING`,
    [input.projectId, JSON.stringify(input.plan), input.expectedAssets],
  );
}

export async function getPipelineProject(db: Queryable, projectId: string): Promise<PipelineProject | undefined> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM pipeline_projects WHERE project_id = $1`, [projectId]);
  return rows[0] ? toPipeline(rows[0]) : undefined;
}

/** The compiler's tick query: every project still owed work, oldest first. */
export async function listLivePipelineProjects(db: Queryable, limit = 50): Promise<PipelineProject[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM pipeline_projects
      WHERE status IN ('generating', 'assembling')
      ORDER BY updated_at ASC LIMIT $1`,
    [limit],
  );
  return rows.map(toPipeline);
}

/**
 * Claim a project for assembly. The UPDATE is conditional on it still being
 * `generating`, so two compiler ticks (or two processes) racing on the same
 * finished project cannot both fire the tail — the loser gets no row back.
 */
export async function beginAssembly(
  db: Queryable,
  projectId: string,
  manifest: unknown,
  manifestUrl: string | null,
): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE pipeline_projects
        SET status = 'assembling', manifest = $2, manifest_url = $3,
            assembling_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE project_id = $1 AND status = 'generating'
      RETURNING project_id`,
    [projectId, manifest, manifestUrl],
  );
  return rows.length > 0;
}

export async function setTailProgress(
  db: Queryable,
  projectId: string,
  input: { stage: string | null; jobId: string | null; finalUrl?: string },
): Promise<void> {
  await db.query(
    `UPDATE pipeline_projects
        SET tail_stage = $2, tail_job_id = $3,
            final_url = COALESCE($4, final_url), updated_at = now()
      WHERE project_id = $1`,
    [projectId, input.stage, input.jobId, input.finalUrl ?? null],
  );
}

export async function finishPipelineProject(
  db: Queryable,
  projectId: string,
  input: { status: Exclude<PipelineStatus, 'generating' | 'assembling'>; finalUrl?: string | null; error?: unknown },
): Promise<void> {
  await db.query(
    `UPDATE pipeline_projects
        SET status = $2, final_url = COALESCE($3, final_url), last_error = $4,
            tail_stage = NULL, tail_job_id = NULL, completed_at = now(), updated_at = now()
      WHERE project_id = $1`,
    [projectId, input.status, input.finalUrl ?? null, input.error ?? null],
  );
}

/** Push a project back to `generating` — used when assembly could not finish
 * but the work is recoverable (a tail call failed, a repaired asset needs to
 * regenerate). The attempts counter is what bounds this. */
export async function returnToGenerating(db: Queryable, projectId: string, error: unknown): Promise<void> {
  await db.query(
    `UPDATE pipeline_projects
        SET status = 'generating', tail_stage = NULL, tail_job_id = NULL,
            last_error = $2, updated_at = now()
      WHERE project_id = $1`,
    [projectId, error],
  );
}

/**
 * The QA agent's project-level verdict. Written on every gate decision, so an
 * operator can answer "why has this not assembled" from the table rather than
 * the logs. Only ever moves away from a terminal value to re-open: a rework
 * puts a passed project back to `pending`, which is correct — it has
 * unjudged work again.
 */
export async function setProjectQa(
  db: Queryable,
  projectId: string,
  qaStatus: ProjectQaStatus,
  detail: unknown,
): Promise<void> {
  await db.query(
    `UPDATE pipeline_projects
        SET qa_status = $2, qa_detail = $3, updated_at = now()
      WHERE project_id = $1 AND (qa_status IS DISTINCT FROM $2 OR qa_detail IS DISTINCT FROM $3::jsonb)`,
    [projectId, qaStatus, JSON.stringify(detail ?? {})],
  );
}

/** Keeps the tick ordering fair when nothing changed for this project. */
export async function touchPipelineProject(db: Queryable, projectId: string): Promise<void> {
  await db.query(`UPDATE pipeline_projects SET updated_at = now() WHERE project_id = $1`, [projectId]);
}

/** INVARIANT mirror of migration 013's `pipeline_projects_attempts_cap`. */
export const PIPELINE_ATTEMPTS_HARD_CAP = 5;
