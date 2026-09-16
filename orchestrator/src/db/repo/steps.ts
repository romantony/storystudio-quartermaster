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

/** Batch insert, within the planner's one transaction (impl plan §6.2 step 7).
 * `ON CONFLICT (cohort_id, seq) DO UPDATE ... job_total = steps.job_total +
 * EXCLUDED.job_total` (2026-09-16, multi-project cohort join fix, refined
 * 2026-09-16 live): a second project joining an already-planned cohort
 * resolves the same seq numbers the first project already inserted —
 * `steps`' PRIMARY KEY (cohort_id, seq) would otherwise raise a
 * duplicate-key error on every shared step. The row itself (endpoint/gate/
 * dependsOn/status) is cohort-wide anyway (steps/catalog.ts is static, not
 * per-project) so nothing there needs merging — but `job_total` DOES: it's
 * this step's job count, and a joining project adds its own frames' worth of
 * jobs to it (confirmed live: a 2nd project's jobs land in `jobs` regardless,
 * so leaving job_total at the 1st project's count alone under-reports the
 * step everywhere that column is read — /v1/cohorts/:id, the admin
 * dashboard — even though runStep()'s own completion check is unaffected,
 * since it live-COUNT(*)s `jobs` rather than reading this column). See
 * stepsJoinable() below — callers must check that BEFORE calling this, since
 * silently no-op'ing (or here, accumulating) says nothing about whether
 * anything will ever poll that row again for the new project's jobs. */
export async function insertSteps(db: Queryable, cohortId: string, steps: NewStep[]): Promise<void> {
  for (const s of steps) {
    await db.query(
      `INSERT INTO steps (cohort_id, seq, name, endpoint_id, workers_target, gate, drain_after,
                           depends_on, status, job_total, job_completed, job_failed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, 0, 0)
       ON CONFLICT (cohort_id, seq) DO UPDATE SET job_total = steps.job_total + EXCLUDED.job_total`,
      [cohortId, s.seq, s.name, s.endpointId, s.workersTarget, s.gate, s.drainAfter, s.dependsOn, s.jobTotal],
    );
  }
}

/** Statuses where a step's `runStep()` claim loop (agents/generator.ts) is
 * still guaranteed to be actively cycling, so a job inserted right now WILL
 * genuinely get claimed:
 *  - `pending`/`scaling`/`ready`: allocate() (agents/fleet.ts) is still
 *    scaling the endpoint up — runStep() hasn't started yet, but it reads
 *    live DB state once it does, so anything inserted before then is picked
 *    up for free.
 *  - `running`: actively claiming.
 *  - `gating`: **not** "already past running," despite the name — real gap
 *    found live 2026-09-16, first real two-project join attempt: gateStep()
 *    (agents/quality.ts) writes this the moment IT starts, concurrently
 *    with runStep() (agents/orchestrator.ts's `Promise.all`), so it appears
 *    within milliseconds and persists for the step's entire active
 *    lifetime, not just its tail. runStep()'s own exit condition for a
 *    gated step is `terminal >= total && countUngated() === 0` — it does
 *    NOT exit just because jobs finished generating; it keeps polling until
 *    every job's quality verdict lands too. So `running`-loop activity and
 *    `gating`-status are concurrent facts about the SAME step, not
 *    sequential ones — treating `gating` as unsafe (the original version of
 *    this function) rejected nearly every real join attempt, since steps 1
 *    and 3 (image/motion) are gated.
 * `generated` (an UNGATED step's runStep() already fully exited) and
 * `draining` (release() draining the endpoint after BOTH runStep() and
 * gateStep() resolved) are the two states where that loop has genuinely
 * stopped — along with the terminal `complete`/`failed`. */
const STEP_STILL_POLLING = new Set(['pending', 'scaling', 'ready', 'running', 'gating']);

/** Real incident risk, 2026-09-16: `QM_ORCH_MODE=live` means a second real
 * project can land in the same 6-hour window while the first is still
 * `running` — `cohorts_one_running` (005_invariants.sql) makes minting it a
 * separate cohort impossible ("at most one running cohort, account-wide"),
 * so joining the existing one is the only option. Joining is only SAFE for
 * a seq the first project already planned (any brand-new seq this project
 * needs was never in `agents/orchestrator.ts`'s `runCohort()` one-time
 * `listSteps()` snapshot, so nothing will ever iterate it) AND only while
 * that step is in `STEP_STILL_POLLING` above. Called by agents/planner.ts's
 * plan() BEFORE insertSteps()/insertJobs() — a `false` here must abort the
 * whole plan attempt (db/repo/cohorts.ts's CohortNotJoinableError), not
 * just skip the unsafe steps, since a partially-planned project is worse
 * than none. */
export async function stepsJoinable(db: Queryable, cohortId: string, seqs: number[]): Promise<boolean> {
  const existing = await listSteps(db, cohortId);
  // Nothing planned into this cohort yet at all — this project is the
  // first, the ordinary single-project case, always safe (matches today's
  // behavior exactly; nothing to conflict with or race against).
  if (existing.length === 0) return true;
  const byS = new Map(existing.map((s) => [s.seq, s.status] as const));
  for (const seq of seqs) {
    const status = byS.get(seq);
    if (status === undefined) return false;
    if (!STEP_STILL_POLLING.has(status)) return false;
  }
  return true;
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
