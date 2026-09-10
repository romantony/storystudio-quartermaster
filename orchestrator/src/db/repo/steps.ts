/**
 * `steps` repo. Plain column CRUD — the transition guards from impl plan
 * §8.2's table (e.g. "pending→scaling written by fleet, guarded on lease
 * taken + previous step complete") live in the calling agent (agents/fleet.ts,
 * agents/generator.ts), not here.
 */
import type { Pool, PoolClient } from 'pg';

export interface StepRow {
  cohortId: string;
  seq: number;
  name: string;
  endpointId: string;
  workersTarget: number;
  gate: string | null;
  drainAfter: boolean;
  dependsOn: number[];
  status: string;
  jobTotal: number | null;
  jobCompleted: number | null;
  jobFailed: number | null;
  warmAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface NewStep {
  seq: number;
  name: string;
  endpointId: string;
  workersTarget: number;
  gate: string | null;
  drainAfter: boolean;
  dependsOn: number[];
  jobTotal: number;
}

function toStep(row: {
  cohort_id: string;
  seq: number;
  name: string;
  endpoint_id: string;
  workers_target: number;
  gate: string | null;
  drain_after: boolean;
  depends_on: number[];
  status: string;
  job_total: number | null;
  job_completed: number | null;
  job_failed: number | null;
  warm_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
}): StepRow {
  return {
    cohortId: row.cohort_id,
    seq: row.seq,
    name: row.name,
    endpointId: row.endpoint_id,
    workersTarget: row.workers_target,
    gate: row.gate,
    drainAfter: row.drain_after,
    dependsOn: row.depends_on ?? [],
    status: row.status,
    jobTotal: row.job_total,
    jobCompleted: row.job_completed,
    jobFailed: row.job_failed,
    warmAt: row.warm_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

const STEP_COLUMNS = `cohort_id, seq, name, endpoint_id, workers_target, gate, drain_after,
                       depends_on, status, job_total, job_completed, job_failed,
                       warm_at, started_at, finished_at`;

/** Batch insert, within the planner's one transaction (impl plan §6.2 step 7). */
export async function insertSteps(db: Queryable, cohortId: string, steps: NewStep[]): Promise<void> {
  for (const s of steps) {
    await db.query(
      `INSERT INTO steps (cohort_id, seq, name, endpoint_id, workers_target, gate, drain_after,
                           depends_on, status, job_total, job_completed, job_failed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, 0, 0)`,
      [cohortId, s.seq, s.name, s.endpointId, s.workersTarget, s.gate, s.drainAfter, s.dependsOn, s.jobTotal],
    );
  }
}

export async function getStep(db: Queryable, cohortId: string, seq: number): Promise<StepRow | undefined> {
  const { rows } = await db.query(`SELECT ${STEP_COLUMNS} FROM steps WHERE cohort_id = $1 AND seq = $2`, [
    cohortId,
    seq,
  ]);
  return rows[0] ? toStep(rows[0]) : undefined;
}

export async function listSteps(db: Queryable, cohortId: string): Promise<StepRow[]> {
  const { rows } = await db.query(`SELECT ${STEP_COLUMNS} FROM steps WHERE cohort_id = $1 ORDER BY seq`, [
    cohortId,
  ]);
  return rows.map(toStep);
}

/** Steps whose `depends_on` includes `seq`, for decrementDependents. */
export async function dependentSteps(db: Queryable, cohortId: string, seq: number): Promise<number[]> {
  const { rows } = await db.query<{ seq: number }>(
    'SELECT seq FROM steps WHERE cohort_id = $1 AND $2 = ANY(depends_on)',
    [cohortId, seq],
  );
  return rows.map((r) => r.seq);
}

export async function updateStepStatus(
  db: Queryable,
  cohortId: string,
  seq: number,
  status: string,
  extra: Partial<{ warmAt: Date; startedAt: Date; finishedAt: Date }> = {},
): Promise<void> {
  const sets: string[] = ['status = $3'];
  const values: unknown[] = [cohortId, seq, status];
  if (extra.warmAt !== undefined) {
    sets.push(`warm_at = $${values.length + 1}`);
    values.push(extra.warmAt);
  }
  if (extra.startedAt !== undefined) {
    sets.push(`started_at = $${values.length + 1}`);
    values.push(extra.startedAt);
  }
  if (extra.finishedAt !== undefined) {
    sets.push(`finished_at = $${values.length + 1}`);
    values.push(extra.finishedAt);
  }
  await db.query(`UPDATE steps SET ${sets.join(', ')} WHERE cohort_id = $1 AND seq = $2`, values);
}

export async function incrementStepCounters(
  db: Queryable,
  cohortId: string,
  seq: number,
  field: 'job_completed' | 'job_failed',
): Promise<void> {
  await db.query(`UPDATE steps SET ${field} = ${field} + 1 WHERE cohort_id = $1 AND seq = $2`, [cohortId, seq]);
}
