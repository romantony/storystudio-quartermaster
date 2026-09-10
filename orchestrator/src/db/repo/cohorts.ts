/**
 * `cohorts` repo. Narrow CRUD only — the state-machine guards (who may write
 * which transition) live in the calling agent, not here, matching this
 * codebase's convention in src/gate/dynamo-gate.ts.
 *
 * M2 does not yet have the tumbling-window scheduler (impl plan §6.1, lands
 * M6) — `ensureCohort` is called inline from POST /v1/requests with the
 * current window's id, computed the same way §6.1 specifies.
 */
import type { Pool, PoolClient } from 'pg';

export interface Cohort {
  id: string;
  opensAt: Date;
  closesAt: Date;
  status: string;
  currentStep: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

function toCohort(row: {
  id: string;
  opens_at: Date;
  closes_at: Date;
  status: string;
  current_step: number | null;
  started_at: Date | null;
  finished_at: Date | null;
}): Cohort {
  return {
    id: row.id,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    status: row.status,
    currentStep: row.current_step,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** [opensAt, closesAt) for the 6-hourly tumbling window (00/06/12/18 UTC)
 * containing `at`. */
export function windowBounds(at: Date = new Date()): { opensAt: Date; closesAt: Date } {
  const opensAt = new Date(at);
  opensAt.setUTCMinutes(0, 0, 0);
  opensAt.setUTCHours(Math.floor(opensAt.getUTCHours() / 6) * 6);
  const closesAt = new Date(opensAt.getTime() + 6 * 60 * 60 * 1000);
  return { opensAt, closesAt };
}

/** Window id `win_YYYY_MM_DD_HH`, impl plan §6.1 — `HH` is the window's
 * OPENING hour (00/06/12/18), not the current hour, so every timestamp in
 * the same 6-hour window resolves to the same deterministic cohort id
 * (a restart mid-window rejoins it rather than opening a second one). */
export function windowId(at: Date = new Date()): string {
  const { opensAt } = windowBounds(at);
  const y = opensAt.getUTCFullYear();
  const m = String(opensAt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(opensAt.getUTCDate()).padStart(2, '0');
  const h = String(opensAt.getUTCHours()).padStart(2, '0');
  return `win_${y}_${m}_${d}_${h}`;
}

/**
 * Raised when `005_invariants`'s `cohorts_one_running` unique index rejects
 * a new cohort because a DIFFERENT one is still 'running'. This is exactly
 * the case M6's real queue-behind logic (§6.1: "if already running, mark
 * the closing cohort queued") is meant to handle; M2 doesn't implement that
 * yet, so this surfaces as a clear, named error instead of raising a raw
 * Postgres constraint violation up through POST /v1/requests.
 */
export class CohortBusyError extends Error {
  constructor(readonly attemptedId: string) {
    super(`cohort ${attemptedId} cannot start — a different cohort is still 'running' (queue-behind lands in M6)`);
    this.name = 'CohortBusyError';
  }
}

/**
 * Idempotent insert-or-fetch for the current window's cohort, marked
 * 'running' immediately (M6's queue-behind-if-already-running rule is not
 * implemented yet — every M2 cohort assumes it may run right away, and
 * throws CohortBusyError in the one case that assumption doesn't hold).
 */
export async function ensureCohort(db: Queryable, at: Date = new Date()): Promise<Cohort> {
  const id = windowId(at);
  const { opensAt, closesAt } = windowBounds(at);
  try {
    const { rows } = await db.query(
      `INSERT INTO cohorts (id, opens_at, closes_at, status, started_at)
       VALUES ($1, $2, $3, 'running', now())
       ON CONFLICT (id) DO UPDATE SET id = cohorts.id
       RETURNING id, opens_at, closes_at, status, current_step, started_at, finished_at`,
      [id, opensAt, closesAt],
    );
    return toCohort(rows[0]);
  } catch (err) {
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'cohorts_one_running') {
      throw new CohortBusyError(id);
    }
    throw err;
  }
}

export async function getCohort(db: Queryable, id: string): Promise<Cohort | undefined> {
  const { rows } = await db.query(
    `SELECT id, opens_at, closes_at, status, current_step, started_at, finished_at
       FROM cohorts WHERE id = $1`,
    [id],
  );
  return rows[0] ? toCohort(rows[0]) : undefined;
}

export async function setCurrentStep(db: Queryable, cohortId: string, seq: number | null): Promise<void> {
  await db.query('UPDATE cohorts SET current_step = $2 WHERE id = $1', [cohortId, seq]);
}
