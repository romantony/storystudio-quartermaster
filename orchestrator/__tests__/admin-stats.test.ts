/**
 * db/repo/admin-stats.ts — small pure query functions behind the admin
 * dashboard (2026-09-16). Mocked Queryable, mirrors jobs-retry.test.ts's
 * style: assert the SQL shape and that rows get reduced/mapped correctly.
 */
import type { Pool } from 'pg';
import { assetCounts, projectCounts, costTotal, costByProject, listFailedProjects } from '../src/db/repo/admin-stats';

function mockPool(handler: (sql: string, params?: unknown[]) => { rows: unknown[] }) {
  const queries: string[] = [];
  const pool = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      return handler(sql, params);
    }),
  };
  return { pool: pool as unknown as Pool, queries };
}

describe('assetCounts', () => {
  it('maps jobs.status groups to generated/queued/failed vocabulary', async () => {
    const { pool } = mockPool((sql) => {
      expect(sql).toMatch(/FROM jobs GROUP BY status/);
      return {
        rows: [
          { status: 'complete', count: '12' },
          { status: 'planned', count: '3' },
          { status: 'submitted', count: '2' },
          { status: 'failed', count: '1' },
          { status: 'regated', count: '4' },
        ],
      };
    });
    const out = await assetCounts(pool);
    expect(out.generated).toBe(12);
    expect(out.queued).toBe(5);
    expect(out.failed).toBe(1);
    expect(out.byRawStatus.regated).toBe(4);
  });

  it('defaults every bucket to 0 when a status is absent', async () => {
    const { pool } = mockPool(() => ({ rows: [] }));
    const out = await assetCounts(pool);
    expect(out).toMatchObject({ generated: 0, queued: 0, failed: 0 });
  });
});

describe('projectCounts', () => {
  it('combines projects.status groups with request_outbox queued count', async () => {
    const { pool, queries } = mockPool((sql) => {
      if (sql.includes('FROM projects')) return { rows: [{ status: 'completed', count: '7' }, { status: 'failed', count: '2' }] };
      if (sql.includes('FROM request_outbox')) return { rows: [{ count: '5' }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const out = await projectCounts(pool);
    expect(out.byStatus).toEqual({ completed: 7, failed: 2 });
    expect(out.outboxQueued).toBe(5);
    expect(queries.some((q) => q.includes("status = 'queued'"))).toBe(true);
  });
});

describe('costTotal', () => {
  it('sums job_costs.cost_usd', async () => {
    const { pool } = mockPool((sql) => {
      expect(sql).toMatch(/sum\(cost_usd\)/);
      return { rows: [{ sum: '12.3456' }] };
    });
    await expect(costTotal(pool)).resolves.toBeCloseTo(12.3456);
  });

  it('returns 0 when there are no cost rows at all', async () => {
    const { pool } = mockPool(() => ({ rows: [{ sum: null }] }));
    await expect(costTotal(pool)).resolves.toBe(0);
  });
});

describe('costByProject', () => {
  it('joins jobs to job_costs, grouped and ordered by spend descending', async () => {
    const { pool, queries } = mockPool((sql) => {
      expect(sql).toMatch(/JOIN job_costs/);
      expect(sql).toMatch(/GROUP BY j.project_id/);
      expect(sql).toMatch(/ORDER BY sum DESC/);
      return {
        rows: [
          { project_id: 'p1', sum: '4.5' },
          { project_id: 'p2', sum: '1.1' },
        ],
      };
    });
    const out = await costByProject(pool);
    expect(out).toEqual([
      { projectId: 'p1', costUsd: 4.5 },
      { projectId: 'p2', costUsd: 1.1 },
    ]);
    expect(queries[0]).toMatch(/LIMIT \$1/);
  });
});

describe('listFailedProjects', () => {
  it('selects only partial/failed projects with their failed-job count', async () => {
    const { pool } = mockPool((sql) => {
      expect(sql).toMatch(/status IN \('partial', 'failed'\)/);
      return {
        rows: [
          { id: 'p1', status: 'failed', tier: 'basic', finished_at: new Date('2026-09-16T00:00:00Z'), failed_jobs: '2' },
          { id: 'p2', status: 'partial', tier: 'premium', finished_at: null, failed_jobs: '1' },
        ],
      };
    });
    const out = await listFailedProjects(pool);
    expect(out).toEqual([
      { id: 'p1', status: 'failed', tier: 'basic', finishedAt: new Date('2026-09-16T00:00:00Z'), failedJobs: 2 },
      { id: 'p2', status: 'partial', tier: 'premium', finishedAt: null, failedJobs: 1 },
    ]);
  });
});
