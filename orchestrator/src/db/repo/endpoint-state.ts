/**
 * `endpoint_state` repo — what the fleet agent believes it holds on each
 * RunPod endpoint, and when it last verified it. Defined in `001_init.sql`
 * but unwired until M3: this is the Postgres-only stand-in for the spec's
 * DynamoDB `ENDPOINTLEASE` design (§6.9's pseudocode already names both —
 * "lease = read ENDPOINTLEASE / endpoint_state.held_by_step"). MCP-originated
 * traffic never touches the AWS Lambda live-path provisioner or DynamoDB, so
 * there is nothing on the other side that needs to read this from a shared
 * datastore — it only needs to be legible to this orchestrator's own
 * watchdog (`watchdog.ts`), which reads it directly from this same Postgres.
 *
 * Plain column CRUD — the orphan-detection judgment call (`held_by_step`
 * unset, or `observed_at` gone stale) lives in the caller, not here.
 */
import type { Pool, PoolClient } from 'pg';

export interface EndpointStateRow {
  endpointId: string;
  workersMax: number;
  workersMin: number;
  workersReady: number;
  heldByCohort: string | null;
  heldByStep: number | null;
  observedAt: Date;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

function toRow(row: {
  endpoint_id: string;
  workers_max: number;
  workers_min: number;
  workers_ready: number;
  held_by_cohort: string | null;
  held_by_step: number | null;
  observed_at: Date;
}): EndpointStateRow {
  return {
    endpointId: row.endpoint_id,
    workersMax: row.workers_max,
    workersMin: row.workers_min,
    workersReady: row.workers_ready,
    heldByCohort: row.held_by_cohort,
    heldByStep: row.held_by_step,
    observedAt: row.observed_at,
  };
}

const COLUMNS = `endpoint_id, workers_max, workers_min, workers_ready, held_by_cohort, held_by_step, observed_at`;

/** Called by allocate() once workers are verified ready. */
export async function upsertHeld(
  db: Queryable,
  endpointId: string,
  held: { cohortId: string; stepSeq: number; workersMax: number; workersMin: number; workersReady: number },
): Promise<void> {
  await db.query(
    `INSERT INTO endpoint_state (endpoint_id, workers_max, workers_min, workers_ready, held_by_cohort, held_by_step, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (endpoint_id) DO UPDATE SET
       workers_max = EXCLUDED.workers_max,
       workers_min = EXCLUDED.workers_min,
       workers_ready = EXCLUDED.workers_ready,
       held_by_cohort = EXCLUDED.held_by_cohort,
       held_by_step = EXCLUDED.held_by_step,
       observed_at = now()`,
    [endpointId, held.workersMax, held.workersMin, held.workersReady, held.cohortId, held.stepSeq],
  );
}

/** Called periodically by generator.ts's runStep() poll loop while a step is actively generating. */
export async function touchObserved(db: Queryable, endpointId: string): Promise<void> {
  await db.query(`UPDATE endpoint_state SET observed_at = now() WHERE endpoint_id = $1`, [endpointId]);
}

/** Called by release() once drain is verified. */
export async function clearHeld(db: Queryable, endpointId: string): Promise<void> {
  await db.query(
    `INSERT INTO endpoint_state (endpoint_id, workers_max, workers_min, workers_ready, held_by_cohort, held_by_step, observed_at)
     VALUES ($1, 0, 0, 0, NULL, NULL, now())
     ON CONFLICT (endpoint_id) DO UPDATE SET
       workers_max = 0, workers_min = 0, workers_ready = 0,
       held_by_cohort = NULL, held_by_step = NULL, observed_at = now()`,
    [endpointId],
  );
}

export async function getState(db: Queryable, endpointId: string): Promise<EndpointStateRow | undefined> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM endpoint_state WHERE endpoint_id = $1`, [endpointId]);
  return rows[0] ? toRow(rows[0]) : undefined;
}

/** Used by watchdog.ts to sweep every registry endpoint each tick. */
export async function listStates(db: Queryable): Promise<EndpointStateRow[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM endpoint_state`);
  return rows.map(toRow);
}
