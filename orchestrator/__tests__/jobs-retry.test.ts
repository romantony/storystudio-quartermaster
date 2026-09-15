/**
 * markFailedOrRetry() — RunPod job failures are retried up to maxAttempts
 * before a frame is failed for good (2026-09-15: CUDA OOM on one leaky Wan2
 * worker failed f16/f24, which had no retry and would have been dropped).
 */
import type { PoolClient } from 'pg';
import { markFailedOrRetry } from '../src/db/repo/jobs';

function client(retryRowCount: number) {
  const queries: string[] = [];
  const c = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SET status = 'planned', attempts = attempts + 1")) return { rowCount: retryRowCount, rows: [] };
      if (sql.includes("SET status = 'failed'"))
        return {
          rowCount: 1,
          rows: [{ id: 492, project_id: 'p', cohort_id: 'c', step_seq: 3, seq: 23, frame_id: 'f24', status: 'failed', deps_remaining: 0, tried_rungs: [], attempts: 2, quality_status: null, quality_attempts: 0, runpod_job_id: null, submitted_at: null, completed_at: null, input: {}, output: null, error: {} }],
        };
      return { rowCount: 0, rows: [] };
    }),
  };
  return { c: c as unknown as PoolClient, queries };
}

describe('markFailedOrRetry', () => {
  const error = { status: 'FAILED', error: 'CUDA out of memory' };

  it('requeues the job (attempts+1, runpod id cleared) while under maxAttempts, without failing it or touching dependents', async () => {
    const { c, queries } = client(1);
    await expect(markFailedOrRetry(c, 492, error, 2)).resolves.toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/runpod_job_id = NULL/);
    expect(queries[0]).toMatch(/attempts < \$3/);
    expect((c.query as jest.Mock).mock.calls[0][1]).toEqual([492, error, 2]);
  });

  it('fails the job for good via markTerminal once attempts are exhausted', async () => {
    const { c, queries } = client(0);
    await expect(markFailedOrRetry(c, 492, error, 2)).resolves.toBe(false);
    expect(queries.some((q) => q.includes("SET status = 'failed'"))).toBe(true);
  });
});
