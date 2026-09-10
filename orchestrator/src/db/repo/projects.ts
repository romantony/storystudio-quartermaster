/**
 * `projects` repo. `request_id UNIQUE` is the idempotency key spec §7.1 and
 * impl plan §10.1 require — a replayed request must return the SAME project
 * row (and therefore the same acknowledgement/cohortId), never plan twice.
 */
import type { Pool, PoolClient } from 'pg';

export interface Project {
  id: string;
  cohortId: string | null;
  requestId: string;
  tier: string;
  language: string;
  status: string;
  request: unknown;
  result: unknown;
  callbackUrl: string | null;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

function toProject(row: {
  id: string;
  cohort_id: string | null;
  request_id: string;
  tier: string;
  language: string;
  status: string;
  request: unknown;
  result: unknown;
  callback_url: string | null;
}): Project {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    requestId: row.request_id,
    tier: row.tier,
    language: row.language,
    status: row.status,
    request: row.request,
    result: row.result,
    callbackUrl: row.callback_url,
  };
}

/**
 * Insert a new project, or return the existing one if `requestId` was already
 * seen (§10.1's Request-level idempotency). `wasNew` tells the caller whether
 * to actually run the planner or just re-return the prior acknowledgement.
 */
export async function insertProject(
  db: Queryable,
  input: {
    id: string;
    cohortId: string;
    requestId: string;
    tier: string;
    language: string;
    request: unknown;
    callbackUrl: string | null;
  },
): Promise<{ project: Project; wasNew: boolean }> {
  const { rows } = await db.query(
    `INSERT INTO projects (id, cohort_id, request_id, tier, language, status, request, callback_url)
     VALUES ($1, $2, $3, $4, $5, 'planning', $6, $7)
     ON CONFLICT (request_id) DO UPDATE SET request_id = projects.request_id
     RETURNING id, cohort_id, request_id, tier, language, status, request, result, callback_url,
               (xmax = 0) AS inserted`,
    [input.id, input.cohortId, input.requestId, input.tier, input.language, input.request, input.callbackUrl],
  );
  const row = rows[0];
  return { project: toProject(row), wasNew: row.inserted === true };
}

export async function getProject(db: Queryable, id: string): Promise<Project | undefined> {
  const { rows } = await db.query(
    `SELECT id, cohort_id, request_id, tier, language, status, request, result, callback_url
       FROM projects WHERE id = $1`,
    [id],
  );
  return rows[0] ? toProject(rows[0]) : undefined;
}

export async function getProjectByRequestId(db: Queryable, requestId: string): Promise<Project | undefined> {
  const { rows } = await db.query(
    `SELECT id, cohort_id, request_id, tier, language, status, request, result, callback_url
       FROM projects WHERE request_id = $1`,
    [requestId],
  );
  return rows[0] ? toProject(rows[0]) : undefined;
}

export async function setProjectStatus(db: Queryable, id: string, status: string): Promise<void> {
  await db.query('UPDATE projects SET status = $2 WHERE id = $1', [id, status]);
}
