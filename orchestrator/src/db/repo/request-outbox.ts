/**
 * `request_outbox` repo (010_request_outbox.sql) — `ORCH_SCHEDULING_MODE=batch`
 * only. In 'project' mode (the default) this table is never touched.
 */
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface OutboxRow {
  id: number;
  requestId: string;
  projectId: string;
  payload: unknown;
  status: 'queued' | 'planned' | 'rejected';
  cohortId: string | null;
  error: string | null;
  receivedAt: Date;
  plannedAt: Date | null;
}

function toRow(r: {
  id: string;
  request_id: string;
  project_id: string;
  payload: unknown;
  status: string;
  cohort_id: string | null;
  error: string | null;
  received_at: Date;
  planned_at: Date | null;
}): OutboxRow {
  return {
    id: Number(r.id),
    requestId: r.request_id,
    projectId: r.project_id,
    payload: r.payload,
    status: r.status as OutboxRow['status'],
    cohortId: r.cohort_id,
    error: r.error,
    receivedAt: r.received_at,
    plannedAt: r.planned_at,
  };
}

/** `ON CONFLICT (request_id) DO NOTHING` mirrors plan()'s own requestId-replay
 * idempotency (db/repo/projects.ts's insertProject) — a replayed submission
 * while still queued is a no-op, not a duplicate row. Returns the row
 * whether it was just inserted or already existed, so the caller can build
 * the same ack either way. */
export async function enqueueRequest(
  db: Queryable,
  input: { requestId: string; projectId: string; payload: unknown },
): Promise<OutboxRow> {
  const { rows } = await db.query(
    `INSERT INTO request_outbox (request_id, project_id, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (request_id) DO UPDATE SET request_id = request_outbox.request_id
     RETURNING id, request_id, project_id, payload, status, cohort_id, error, received_at, planned_at`,
    [input.requestId, input.projectId, input.payload],
  );
  return toRow(rows[0]);
}

/** agents/batch-window.ts's runBatchWindow() selection query: every `queued`
 * row received before `cutoff`, oldest first — rows received inside the
 * cutoff window stay `queued` for the next firing. */
export async function listEligibleOutbox(db: Queryable, cutoff: Date): Promise<OutboxRow[]> {
  const { rows } = await db.query(
    `SELECT id, request_id, project_id, payload, status, cohort_id, error, received_at, planned_at
       FROM request_outbox
      WHERE status = 'queued' AND received_at < $1
      ORDER BY received_at`,
    [cutoff],
  );
  return rows.map(toRow);
}

export async function markOutboxPlanned(db: Queryable, id: number, cohortId: string): Promise<void> {
  await db.query(`UPDATE request_outbox SET status = 'planned', cohort_id = $2, planned_at = now() WHERE id = $1`, [
    id,
    cohortId,
  ]);
}

/** One bad row must not sink the whole window — see batch-window.ts's
 * per-row try/catch. Truncated the same way other error columns in this
 * codebase are (e.g. webhooks.ts's body.error.slice(0, 500)). */
export async function markOutboxRejected(db: Queryable, id: number, error: string): Promise<void> {
  await db.query(`UPDATE request_outbox SET status = 'rejected', error = $2, planned_at = now() WHERE id = $1`, [
    id,
    error.slice(0, 2000),
  ]);
}
