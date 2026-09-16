/**
 * `request_outbox` repo (010_request_outbox.sql) — ORCH_SCHEDULING_MODE=batch
 * only, 2026-09-16.
 */
import type { PoolClient } from 'pg';
import { enqueueRequest, listEligibleOutbox, markOutboxPlanned, markOutboxRejected } from '../src/db/repo/request-outbox';

function fakeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '7',
    request_id: 'req_1',
    project_id: 'proj_1',
    payload: { hello: 'world' },
    status: 'queued',
    cohort_id: null,
    error: null,
    received_at: new Date('2026-09-16T00:00:00Z'),
    planned_at: null,
    ...overrides,
  };
}

describe('enqueueRequest', () => {
  it('inserts, ON CONFLICT (request_id) DO UPDATE so a replayed submission returns the same row instead of erroring', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [fakeRow()] }));
    const c = { query } as unknown as PoolClient;

    const row = await enqueueRequest(c, { requestId: 'req_1', projectId: 'proj_1', payload: { hello: 'world' } });

    expect(row).toEqual({
      id: 7,
      requestId: 'req_1',
      projectId: 'proj_1',
      payload: { hello: 'world' },
      status: 'queued',
      cohortId: null,
      error: null,
      receivedAt: new Date('2026-09-16T00:00:00Z'),
      plannedAt: null,
    });
    expect(query.mock.calls[0][0]).toMatch(/ON CONFLICT \(request_id\) DO UPDATE/);
    expect(query.mock.calls[0][1]).toEqual(['req_1', 'proj_1', { hello: 'world' }]);
  });
});

describe('listEligibleOutbox', () => {
  it('selects only queued rows, passes the cutoff through, and maps every column', async () => {
    const cutoff = new Date('2026-09-16T05:45:00Z');
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [fakeRow(), fakeRow({ id: '8', request_id: 'req_2' })] }));
    const c = { query } as unknown as PoolClient;

    const rows = await listEligibleOutbox(c, cutoff);

    expect(rows).toHaveLength(2);
    expect(rows[1].requestId).toBe('req_2');
    expect(query.mock.calls[0][0]).toMatch(/status = 'queued' AND received_at < \$1/);
    expect(query.mock.calls[0][0]).toMatch(/ORDER BY received_at/);
    expect(query.mock.calls[0][1]).toEqual([cutoff]);
  });
});

describe('markOutboxPlanned / markOutboxRejected', () => {
  it('markOutboxPlanned writes status, cohort_id, and planned_at', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const c = { query } as unknown as PoolClient;

    await markOutboxPlanned(c, 7, 'win_2026_09_16_00');

    expect(query.mock.calls[0][0]).toMatch(/SET status = 'planned', cohort_id = \$2, planned_at = now\(\)/);
    expect(query.mock.calls[0][1]).toEqual([7, 'win_2026_09_16_00']);
  });

  it('markOutboxRejected writes status + error, truncated to 2000 chars', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const c = { query } as unknown as PoolClient;
    const longError = 'x'.repeat(3000);

    await markOutboxRejected(c, 7, longError);

    expect(query.mock.calls[0][0]).toMatch(/SET status = 'rejected', error = \$2/);
    expect((query.mock.calls[0][1]?.[1] as string)).toHaveLength(2000);
  });
});
