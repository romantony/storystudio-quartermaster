/**
 * `jobs` repo. The generator's claim loop (impl plan §6.4) and the
 * idempotency rules §10.1 lists for the Submission and Webhook levels live
 * here as narrow, transaction-friendly functions — the loop/backoff logic
 * itself stays in agents/generator.ts.
 */
import type { Pool, PoolClient } from 'pg';
import { dependentSteps } from './steps';

export interface JobRow {
  id: number;
  projectId: string;
  cohortId: string;
  stepSeq: number;
  seq: number;
  frameId: string | null;
  status: string;
  depsRemaining: number;
  triedRungs: string[];
  attempts: number;
  qualityStatus: string | null;
  qualityAttempts: number;
  runpodJobId: string | null;
  submittedAt: Date | null;
  completedAt: Date | null;
  input: unknown;
  output: unknown;
  error: unknown;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface NewJob {
  projectId: string;
  stepSeq: number;
  seq: number;
  frameId: string | null;
  depsRemaining: number;
  input: unknown;
}

const JOB_COLUMNS = `id, project_id, cohort_id, step_seq, seq, frame_id, status, deps_remaining,
                      tried_rungs, attempts, quality_status, quality_attempts, runpod_job_id,
                      submitted_at, completed_at, input, output, error`;

function toJob(row: {
  id: number;
  project_id: string;
  cohort_id: string;
  step_seq: number;
  seq: number;
  frame_id: string | null;
  status: string;
  deps_remaining: number;
  tried_rungs: string[];
  attempts: number;
  quality_status: string | null;
  quality_attempts: number;
  runpod_job_id: string | null;
  submitted_at: Date | null;
  completed_at: Date | null;
  input: unknown;
  output: unknown;
  error: unknown;
}): JobRow {
  return {
    id: row.id,
    projectId: row.project_id,
    cohortId: row.cohort_id,
    stepSeq: row.step_seq,
    seq: row.seq,
    frameId: row.frame_id,
    status: row.status,
    depsRemaining: row.deps_remaining,
    triedRungs: row.tried_rungs ?? [],
    attempts: row.attempts,
    qualityStatus: row.quality_status,
    qualityAttempts: row.quality_attempts,
    runpodJobId: row.runpod_job_id,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    input: row.input,
    output: row.output,
    error: row.error,
  };
}

/** Batch insert, within the planner's one transaction (impl plan §6.2 step 7). */
export async function insertJobs(db: Queryable, cohortId: string, jobs: NewJob[]): Promise<void> {
  for (const j of jobs) {
    await db.query(
      `INSERT INTO jobs (project_id, cohort_id, step_seq, seq, frame_id, status, deps_remaining, input)
       VALUES ($1, $2, $3, $4, $5, 'planned', $6, $7)`,
      [j.projectId, cohortId, j.stepSeq, j.seq, j.frameId, j.depsRemaining, j.input],
    );
  }
}

/**
 * The generator's whole work queue — impl plan §6.4's exact query, `FOR
 * UPDATE SKIP LOCKED` so a future second generator process is safe. Must be
 * called inside a transaction that also writes the claim (see markSubmitted)
 * or the lock is released with nothing to show for it.
 */
export async function claimNextBatch(
  client: PoolClient,
  cohortId: string,
  stepSeq: number,
  limit: number,
  projectId?: string,
): Promise<JobRow[]> {
  if (limit <= 0) return [];
  const { rows } = await client.query(
    `SELECT ${JOB_COLUMNS} FROM jobs
      WHERE cohort_id = $1 AND step_seq = $2 AND status = 'planned' AND deps_remaining = 0
        ${projectId !== undefined ? 'AND project_id = $4' : ''}
      ORDER BY seq
      LIMIT $3
      FOR UPDATE SKIP LOCKED`,
    projectId !== undefined ? [cohortId, stepSeq, limit, projectId] : [cohortId, stepSeq, limit],
  );
  return rows.map(toJob);
}

/**
 * Same-transaction id+status write (impl plan §10.1's Submission
 * idempotency row: `jobs.runpod_job_id` gets id and status together, or
 * neither).
 */
export async function markSubmitted(client: PoolClient, jobId: number, runpodJobId: string): Promise<void> {
  await client.query(
    `UPDATE jobs SET runpod_job_id = $2, status = 'submitted', submitted_at = now() WHERE id = $1`,
    [jobId, runpodJobId],
  );
}

export async function getJobByRunpodId(db: Queryable, runpodJobId: string): Promise<JobRow | undefined> {
  const { rows } = await db.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE runpod_job_id = $1`, [runpodJobId]);
  return rows[0] ? toJob(rows[0]) : undefined;
}

export async function listInFlight(db: Queryable, cohortId: string, stepSeq: number, projectId?: string): Promise<JobRow[]> {
  const { rows } = await db.query(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE cohort_id = $1 AND step_seq = $2 AND status = 'submitted'
       ${projectId !== undefined ? 'AND project_id = $3' : ''}`,
    projectId !== undefined ? [cohortId, stepSeq, projectId] : [cohortId, stepSeq],
  );
  return rows.map(toJob);
}

export async function stepJobCounts(
  db: Queryable,
  cohortId: string,
  stepSeq: number,
  projectId?: string,
): Promise<{ total: number; terminal: number }> {
  const { rows } = await db.query<{ total: string; terminal: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE status IN ('complete', 'failed')) AS terminal
       FROM jobs WHERE cohort_id = $1 AND step_seq = $2
         ${projectId !== undefined ? 'AND project_id = $3' : ''}`,
    projectId !== undefined ? [cohortId, stepSeq, projectId] : [cohortId, stepSeq],
  );
  return { total: Number(rows[0].total), terminal: Number(rows[0].terminal) };
}

/**
 * Marks a job complete or failed and, on completion, decrements
 * `deps_remaining` on every dependent job for the SAME frame (impl plan
 * §6.4/§8.3 — never on a job about to be reworked, but M2 has no rework path
 * yet, so every completion here is unconditional). One transaction so a
 * job's terminal write and its dependents' decrements are atomic.
 */
export async function markTerminal(
  client: PoolClient,
  jobId: number,
  outcome: { status: 'complete'; output: unknown } | { status: 'failed'; error: unknown },
): Promise<JobRow> {
  const { rows } = await client.query(
    outcome.status === 'complete'
      ? `UPDATE jobs SET status = 'complete', output = $2, completed_at = now() WHERE id = $1
         RETURNING ${JOB_COLUMNS}`
      : `UPDATE jobs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1
         RETURNING ${JOB_COLUMNS}`,
    [jobId, outcome.status === 'complete' ? outcome.output : outcome.error],
  );
  const job = toJob(rows[0]);

  if (outcome.status === 'complete' && job.frameId) {
    const dependents = await dependentSteps(client, job.cohortId, job.stepSeq);
    if (dependents.length > 0) {
      // project_id required, not just cohort_id + frame_id — frame_id alone
      // is not globally unique (see generator.ts's resolveDeps() comment,
      // same 2026-09-11 finding). Without it, completing project A's frame
      // "f1" step would also decrement project B's same-numbered frame's
      // deps_remaining, letting a job go 'ready' with a dependency that
      // never actually ran in its own project.
      await client.query(
        `UPDATE jobs SET deps_remaining = GREATEST(deps_remaining - 1, 0)
           WHERE cohort_id = $1 AND project_id = $2 AND frame_id = $3 AND step_seq = ANY($4)`,
        [job.cohortId, job.projectId, job.frameId, dependents],
      );
    }
  }

  return job;
}

export async function listStale(
  db: Queryable,
  cohortId: string,
  stepSeq: number,
  olderThan: Date,
  projectId?: string,
): Promise<JobRow[]> {
  const { rows } = await db.query(
    `SELECT ${JOB_COLUMNS} FROM jobs
      WHERE cohort_id = $1 AND step_seq = $2 AND status = 'submitted' AND submitted_at < $3
        AND runpod_job_id IS NOT NULL
        ${projectId !== undefined ? 'AND project_id = $4' : ''}`,
    projectId !== undefined ? [cohortId, stepSeq, olderThan, projectId] : [cohortId, stepSeq, olderThan],
  );
  return rows.map(toJob);
}

/** Which projects actually have work planned for this step, in project
 * insertion order — agents/assembler.ts's per-project loop (M5 phase 1)
 * uses this instead of "every project in the cohort" so a project that
 * somehow has no tail work planned is silently skipped, not stalled on. */
export async function listProjectIdsForStep(db: Queryable, cohortId: string, stepSeq: number): Promise<string[]> {
  const { rows } = await db.query<{ project_id: string }>(
    `SELECT DISTINCT project_id FROM jobs WHERE cohort_id = $1 AND step_seq = $2 ORDER BY project_id`,
    [cohortId, stepSeq],
  );
  return rows.map((r) => r.project_id);
}
