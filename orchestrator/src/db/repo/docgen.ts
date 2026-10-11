/**
 * `docgen_jobs` / `docgen_events` repo (024_docgen.sql) — documentary-basic on
 * the doc-gen EC2 instance. Intake and webhook queries first, then the
 * dispatcher's claim/transition queries (src/docgen/dispatcher.ts).
 */
import type { Pool, PoolClient } from 'pg';
import type { DocgenStatus } from '../../docgen/types';
import { DOCGEN_TERMINAL } from '../../docgen/types';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export type DocgenJobState =
  | 'queued'
  | 'starting_instance'
  | 'running'
  | 'awaiting_input'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface DocgenJobRow {
  requestId: string;
  docgenRequestId: string;
  jobId: string | null;
  projectId: string;
  callbackUrl: string;
  state: DocgenJobState;
  stage: string | null;
  seq: number;
  progress: number | null;
  message: string | null;
  request: unknown;
  status: DocgenStatus | null;
  outputs: unknown;
  error: unknown;
  attempts: number;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastHeartbeatAt: Date | null;
  instanceStartedAt: Date | null;
  lastPolledAt: Date | null;
  updatedAt: Date;
  result: unknown;
  callbackStatus: 'pending' | 'delivered' | 'rejected' | 'exhausted' | 'skipped' | null;
}

const COLS = `request_id, docgen_request_id, job_id, project_id, callback_url, state, stage, seq, progress, message,
  request, status, outputs, error, attempts, queued_at, started_at, finished_at, last_heartbeat_at,
  instance_started_at, last_polled_at, updated_at, result, callback_status`;

function toRow(r: Record<string, any>): DocgenJobRow {
  return {
    requestId: r.request_id,
    docgenRequestId: r.docgen_request_id,
    jobId: r.job_id,
    projectId: r.project_id,
    callbackUrl: r.callback_url,
    state: r.state,
    stage: r.stage,
    seq: Number(r.seq),
    progress: r.progress,
    message: r.message,
    request: r.request,
    status: r.status,
    outputs: r.outputs,
    error: r.error,
    attempts: Number(r.attempts),
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    lastHeartbeatAt: r.last_heartbeat_at,
    instanceStartedAt: r.instance_started_at,
    lastPolledAt: r.last_polled_at,
    updatedAt: r.updated_at,
    result: r.result,
    callbackStatus: r.callback_status,
  };
}

/**
 * Idempotent on `request_id`: a replayed submission returns the existing row
 * unchanged (never re-queues a finished or failed job). `created` tells the
 * caller whether this call inserted it.
 */
export async function enqueueDocgenJob(
  db: Queryable,
  input: { requestId: string; docgenRequestId: string; projectId: string; callbackUrl: string; request: unknown },
): Promise<{ row: DocgenJobRow; created: boolean }> {
  const ins = await db.query(
    `INSERT INTO docgen_jobs (request_id, docgen_request_id, project_id, callback_url, request)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING ${COLS}`,
    [input.requestId, input.docgenRequestId, input.projectId, input.callbackUrl, input.request],
  );
  if (ins.rows[0]) return { row: toRow(ins.rows[0]), created: true };
  const existing = await getDocgenJob(db, input.requestId);
  if (!existing) throw new Error(`docgen_jobs: ${input.requestId} neither inserted nor found`);
  return { row: existing, created: false };
}

export async function getDocgenJob(db: Queryable, requestId: string): Promise<DocgenJobRow | null> {
  const { rows } = await db.query(`SELECT ${COLS} FROM docgen_jobs WHERE request_id = $1`, [requestId]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** Webhooks carry the id we SENT the instance, which differs from `request_id` on a retry. */
export async function getDocgenJobByDocgenId(db: Queryable, docgenRequestId: string): Promise<DocgenJobRow | null> {
  const { rows } = await db.query(`SELECT ${COLS} FROM docgen_jobs WHERE docgen_request_id = $1`, [docgenRequestId]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** Returns true when the event was new (the unique key absorbs at-least-once repeats). */
export async function recordDocgenEvent(
  db: Queryable,
  e: { requestId: string; seq: number; event: string; body: unknown },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO docgen_events (request_id, seq, event, body) VALUES ($1, $2, $3, $4)
     ON CONFLICT (request_id, seq, event) DO NOTHING`,
    [e.requestId, e.seq, e.event, e.body],
  );
  return (rowCount ?? 0) > 0;
}

export async function touchDocgenHeartbeat(db: Queryable, docgenRequestId: string): Promise<void> {
  await db.query(`UPDATE docgen_jobs SET last_heartbeat_at = now(), updated_at = now() WHERE docgen_request_id = $1`, [
    docgenRequestId,
  ]);
}

/**
 * Apply a status snapshot iff its `seq` is newer than the stored one, and the
 * row is not already final. The snapshot is complete, so the newest alone is
 * enough — no merging with older events. Single statement: `prev` is read under
 * the same row lock the UPDATE takes, so `prevSeq` is the value actually
 * replaced and the caller can tell a gap (`status.seq > prevSeq + 1`).
 *
 * `job_id` is COALESCEd: the instance's first webhook can beat our own write of
 * the 202 response, and must not be lost to that race.
 */
export async function applyDocgenStatus(
  db: Queryable,
  docgenRequestId: string,
  s: DocgenStatus,
): Promise<{ applied: boolean; prevSeq: number | null }> {
  const terminal = DOCGEN_TERMINAL.has(s.state);
  const { rows } = await db.query(
    `WITH prev AS (
       SELECT request_id, seq FROM docgen_jobs
        WHERE docgen_request_id = $1 AND seq < $2 AND state NOT IN ('succeeded', 'failed', 'cancelled')
        FOR UPDATE
     )
     UPDATE docgen_jobs j SET
       job_id     = COALESCE(j.job_id, $3),
       state      = $4,
       stage      = $5,
       seq        = $2,
       progress   = $6,
       message    = $7,
       status     = $8::jsonb,
       outputs    = $9::jsonb,
       error      = $10::jsonb,
       started_at = COALESCE(j.started_at, now()),
       finished_at = CASE WHEN $11::boolean THEN now() ELSE j.finished_at END,
       last_heartbeat_at = now(),
       updated_at = now()
     FROM prev
     WHERE j.request_id = prev.request_id
     RETURNING prev.seq AS prev_seq`,
    [
      docgenRequestId,
      s.seq,
      s.job_id,
      s.state,
      s.stage,
      s.progress,
      s.message ?? null,
      // Stringified on purpose: node-postgres turns a JS array (`outputs`) into a
      // Postgres array literal, which jsonb rejects. Objects would survive, but
      // one rule for all three is harder to get wrong.
      JSON.stringify(s),
      s.outputs ? JSON.stringify(s.outputs) : null,
      s.error ? JSON.stringify(s.error) : null,
      terminal,
    ],
  );
  return rows[0] ? { applied: true, prevSeq: Number(rows[0].prev_seq) } : { applied: false, prevSeq: null };
}

// ── dispatcher queries ──────────────────────────────────────────────────────

const ACTIVE_STATES = `('starting_instance', 'running', 'awaiting_input')`;
const FINAL_STATES = `('succeeded', 'failed', 'cancelled')`;

/** The one job holding the instance, if any (the unique index guarantees at most one). */
export async function getActiveDocgenJob(db: Queryable): Promise<DocgenJobRow | null> {
  const { rows } = await db.query(`SELECT ${COLS} FROM docgen_jobs WHERE state IN ${ACTIVE_STATES} LIMIT 1`);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Take the oldest queued job and mark it `starting_instance`. SKIP LOCKED plus
 * the one-active unique index make a racing second claimer come away with null
 * (23505 is swallowed) rather than a second active job.
 */
export async function claimNextQueuedDocgenJob(db: Queryable): Promise<DocgenJobRow | null> {
  try {
    const { rows } = await db.query(
      `UPDATE docgen_jobs SET state = 'starting_instance', instance_started_at = now(), updated_at = now()
        WHERE request_id = (
          SELECT request_id FROM docgen_jobs WHERE state = 'queued'
           ORDER BY queued_at, request_id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING ${COLS}`,
    );
    return rows[0] ? toRow(rows[0]) : null;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

/** Back to the queue — the instance never accepted the job, so it consumes no attempt. */
export async function requeueDocgenJob(db: Queryable, requestId: string, note: string): Promise<void> {
  await db.query(
    `UPDATE docgen_jobs SET state = 'queued', instance_started_at = NULL, message = $2, updated_at = now()
      WHERE request_id = $1 AND state = 'starting_instance'`,
    [requestId, note],
  );
}

/**
 * The instance accepted the job (202, or 200 on a replay). Idempotent against
 * the instance's own first webhook, which may already have moved the row to
 * `running` or beyond: the state only advances from `starting_instance`, and
 * `attempts` is set to the attempt number rather than incremented, so applying
 * this twice (or after a crash and replay) cannot double-count.
 */
export async function markDocgenAccepted(db: Queryable, requestId: string, jobId: string, attempt: number): Promise<void> {
  await db.query(
    `UPDATE docgen_jobs SET
       job_id = COALESCE(job_id, $2),
       attempts = GREATEST(attempts, $3),
       started_at = COALESCE(started_at, now()),
       state = CASE WHEN state = 'starting_instance' THEN 'running' ELSE state END,
       updated_at = now()
     WHERE request_id = $1`,
    [requestId, jobId, attempt],
  );
}

/** A failure the orchestrator itself decided (bad mapping, unreachable instance). Never overwrites a final state. */
export async function failDocgenJob(db: Queryable, requestId: string, error: Record<string, unknown>): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE docgen_jobs SET state = 'failed', error = $2::jsonb, message = $3, finished_at = now(), updated_at = now()
      WHERE request_id = $1 AND state NOT IN ${FINAL_STATES}`,
    [requestId, JSON.stringify(error), String(error.message ?? error.code ?? 'failed')],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Re-queue a failed job under a new instance-side id (`<id>-rN`): a failed id is
 * never reused. Clears the previous run's progress; keeps `queued_at` so the
 * retry goes ahead of newer requests. Earlier events stay under this
 * request_id; their (seq, event) keys can collide with the new run's, which only
 * affects the history, never the status (status applies on `seq` alone).
 */
export async function retryDocgenJob(db: Queryable, requestId: string, newDocgenRequestId: string, payload: unknown, note: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE docgen_jobs SET
       state = 'queued', docgen_request_id = $2, request = $3::jsonb, job_id = NULL, seq = 0, stage = NULL,
       progress = NULL, message = $4, status = NULL, outputs = NULL, error = NULL, started_at = NULL,
       finished_at = NULL, instance_started_at = NULL, last_heartbeat_at = NULL, last_polled_at = NULL,
       updated_at = now()
     WHERE request_id = $1 AND state = 'failed' AND result IS NULL`,
    [requestId, newDocgenRequestId, JSON.stringify(payload), note],
  );
  return (rowCount ?? 0) > 0;
}

export async function touchDocgenPolled(db: Queryable, requestId: string): Promise<void> {
  await db.query(`UPDATE docgen_jobs SET last_polled_at = now() WHERE request_id = $1`, [requestId]);
}

export async function countQueuedDocgenJobs(db: Queryable): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM docgen_jobs WHERE state = 'queued'`);
  return rows[0].n;
}

/** Finished on the instance (or by us) but no result built yet. */
export async function listUnfinalizedDocgenJobs(db: Queryable): Promise<DocgenJobRow[]> {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM docgen_jobs WHERE state IN ${FINAL_STATES} AND result IS NULL ORDER BY finished_at NULLS LAST, queued_at`,
  );
  return rows.map(toRow);
}

/** Result built, not yet delivered — also what a restart mid-delivery picks back up. */
export async function listPendingDocgenCallbacks(db: Queryable): Promise<DocgenJobRow[]> {
  const { rows } = await db.query(
    `SELECT ${COLS} FROM docgen_jobs WHERE result IS NOT NULL AND callback_status = 'pending' ORDER BY finished_at`,
  );
  return rows.map(toRow);
}

export async function setDocgenResult(db: Queryable, requestId: string, result: unknown): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE docgen_jobs SET result = $2::jsonb, callback_status = 'pending', updated_at = now()
      WHERE request_id = $1 AND result IS NULL AND state IN ${FINAL_STATES}`,
    [requestId, JSON.stringify(result)],
  );
  return (rowCount ?? 0) > 0;
}

export async function appendDocgenCallbackAttempt(db: Queryable, requestId: string, attempt: unknown): Promise<void> {
  await db.query(`UPDATE docgen_jobs SET callback_attempts = callback_attempts || $2::jsonb WHERE request_id = $1`, [
    requestId,
    JSON.stringify([attempt]),
  ]);
}

export async function setDocgenCallbackStatus(db: Queryable, requestId: string, status: string): Promise<void> {
  await db.query(`UPDATE docgen_jobs SET callback_status = $2, updated_at = now() WHERE request_id = $1`, [requestId, status]);
}

/**
 * How many jobs are ahead of this one: the active job (if any) plus queued jobs
 * that arrived earlier. 0 for a job that is itself active or finished.
 */
export async function docgenJobsAhead(db: Queryable, requestId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT CASE WHEN me.state = 'queued' THEN
              (SELECT count(*) FROM docgen_jobs WHERE state IN ${ACTIVE_STATES})
            + (SELECT count(*) FROM docgen_jobs o WHERE o.state = 'queued' AND (o.queued_at, o.request_id) < (me.queued_at, me.request_id))
            ELSE 0 END::int AS ahead
       FROM docgen_jobs me WHERE me.request_id = $1`,
    [requestId],
  );
  return rows[0]?.ahead ?? 0;
}

export async function listRecentFinishedDocgenJobs(db: Queryable, limit: number): Promise<DocgenJobRow[]> {
  const { rows } = await db.query(`SELECT ${COLS} FROM docgen_jobs WHERE state IN ${FINAL_STATES} ORDER BY finished_at DESC NULLS LAST LIMIT $1`, [limit]);
  return rows.map(toRow);
}

export async function listQueuedDocgenJobs(db: Queryable): Promise<DocgenJobRow[]> {
  const { rows } = await db.query(`SELECT ${COLS} FROM docgen_jobs WHERE state = 'queued' ORDER BY queued_at, request_id`);
  return rows.map(toRow);
}
