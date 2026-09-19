/**
 * `asset_costs` repo (migration 013). The asset pipeline's counterpart to
 * `job_costs`: same columns, same generated `cost_usd`, keyed on an asset row
 * instead of a `jobs` row — `job_costs.job_id` has a hard FK to `jobs(id)`
 * and cannot hold one of these.
 *
 * `cost_usd` is a generated column; never written directly. The unique index
 * on `provider_job_id` is what makes a webhook and a reconcile tick racing on
 * the same completion cost the ledger one line, not two.
 */
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function recordAssetCost(
  db: Queryable,
  input: {
    assetId: number | null;
    assetKind: string | null;
    projectId: string;
    frameId: string | null;
    endpointId: string;
    providerJobId: string | null;
    executionMs: number | null;
    delayMs: number | null;
    workerRateUsdS: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO asset_costs (asset_id, asset_kind, project_id, frame_id, endpoint_id,
                              provider_job_id, execution_ms, delay_ms, worker_rate_usd_s)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (provider_job_id) WHERE provider_job_id IS NOT NULL DO NOTHING`,
    [
      input.assetId,
      input.assetKind,
      input.projectId,
      input.frameId,
      input.endpointId,
      input.providerJobId,
      input.executionMs,
      input.delayMs,
      input.workerRateUsdS,
    ],
  );
}

/** Total GPU spend for one project — every asset plus the compiler's own tail
 * calls. Feeds the §9.6 result's `metrics.gpuCostUsd`. */
export async function projectAssetCost(db: Queryable, projectId: string): Promise<number | null> {
  const { rows } = await db.query<{ total: string | null }>(
    `SELECT sum(cost_usd)::text AS total FROM asset_costs WHERE project_id = $1`,
    [projectId],
  );
  const total = rows[0]?.total;
  return total === null || total === undefined ? null : Number(total);
}
