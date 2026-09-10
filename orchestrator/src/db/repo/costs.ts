/**
 * `job_costs` repo. Written from two call sites that both need the exact
 * same insert: the generator's synchronous-completion path (a warm endpoint
 * returning `status: COMPLETED` inline on `/run`) and the webhook receiver
 * (impl plan §7.2: "Write job_costs from executionTime (billed) and
 * delayTime (queue, not billed)"). `cost_usd` is a generated column
 * (migration `002`) — never written directly.
 */
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function recordJobCost(
  db: Queryable,
  input: {
    jobId: number;
    endpointId: string;
    executionMs: number | null;
    delayMs: number | null;
    workerRateUsdS: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO job_costs (job_id, endpoint_id, execution_ms, delay_ms, worker_rate_usd_s)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (job_id) DO NOTHING`,
    [input.jobId, input.endpointId, input.executionMs, input.delayMs, input.workerRateUsdS],
  );
}
