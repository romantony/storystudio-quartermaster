/**
 * `docgen_jobs` / `docgen_events` repo (024_docgen.sql) — documentary-basic on
 * the doc-gen EC2 instance. Phase 1 holds what intake and the webhook receiver
 * need; the dispatcher's claim/transition queries land with the dispatcher.
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
}

const COLS = `request_id, docgen_request_id, job_id, project_id, callback_url, state, stage, seq, progress, message,
  request, status, outputs, error, attempts, queued_at, started_at, finished_at, last_heartbeat_at`;

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
