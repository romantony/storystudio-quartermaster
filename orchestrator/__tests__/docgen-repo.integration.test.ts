/**
 * docgen repo integration tests, against a real Postgres — same DATABASE_URL
 * gate and convention as asset-repo.integration.test.ts.
 *
 * These exist because the interesting parts of migration 024 are things only a
 * real database can tell you: that the partial unique index really allows only
 * one active job, that the single-statement status UPDATE enforces the `seq`
 * guard and the terminal-state guard under its own row lock, and that
 * `job_id` survives the race where the instance's first webhook beats our own
 * write of the 202 response.
 *
 *   DATABASE_URL=postgres://qm:qm@localhost:55433/qm_orchestrator_test \
 *     npx ts-node src/db/migrate.ts up && npx jest docgen-repo.integration
 */
import { Pool } from 'pg';
import {
  enqueueDocgenJob,
  getDocgenJob,
  getDocgenJobByDocgenId,
  recordDocgenEvent,
  applyDocgenStatus,
} from '../src/db/repo/docgen';
import { applyDocgenEvent } from '../src/docgen/events';
import type { DocgenStatus } from '../src/docgen/types';

const DB_URL = process.env.DATABASE_URL;
const maybeDescribe = DB_URL ? describe : describe.skip;

const st = (seq: number, over: Partial<DocgenStatus> = {}): DocgenStatus => ({
  job_id: 'dg_x', request_id: 'x', seq, state: 'running', stage: 'script', progress: 0.1, message: `m${seq}`, ...over,
});

maybeDescribe('docgen repo (integration)', () => {
  let pool: Pool;
  let n = 0;
  const mk = async (over: Record<string, unknown> = {}) => {
    const id = `dgtest_${Date.now()}_${++n}`;
    const r = await enqueueDocgenJob(pool, { requestId: id, docgenRequestId: id, projectId: 'p1', callbackUrl: 'https://cb.example/x', request: { a: 1 }, ...over });
    return { id, ...r };
  };
  const setState = (id: string, state: string) => pool.query('UPDATE docgen_jobs SET state = $2 WHERE request_id = $1', [id, state]);

  beforeAll(() => { pool = new Pool({ connectionString: DB_URL }); });
  afterAll(async () => {
    await pool.query(`DELETE FROM docgen_events WHERE request_id LIKE 'dgtest_%'`);
    await pool.query(`DELETE FROM docgen_jobs WHERE request_id LIKE 'dgtest_%'`);
    await pool.end();
  });
  beforeEach(async () => {
    // The one-active index is global, so a leftover active row from a failed run would poison the next.
    await pool.query(`DELETE FROM docgen_events WHERE request_id LIKE 'dgtest_%'`);
    await pool.query(`DELETE FROM docgen_jobs WHERE request_id LIKE 'dgtest_%'`);
  });

  it('enqueue inserts a queued row; a replay returns the same row and never re-queues a finished job', async () => {
    const a = await mk();
    expect(a.created).toBe(true);
    expect(a.row).toMatchObject({ state: 'queued', seq: 0, attempts: 0, projectId: 'p1' });
    await setState(a.id, 'failed');
    const again = await enqueueDocgenJob(pool, { requestId: a.id, docgenRequestId: a.id, projectId: 'other', callbackUrl: 'https://cb2', request: {} });
    expect(again.created).toBe(false);
    expect(again.row.state).toBe('failed');
    expect(again.row.projectId).toBe('p1');
  });

  it('looks a job up by the id we sent the instance, which differs from request_id on a retry', async () => {
    const sent = `dgtest_retry_${Date.now()}-r2`;
    const a = await mk({ docgenRequestId: sent });
    expect((await getDocgenJobByDocgenId(pool, sent))?.requestId).toBe(a.id);
  });

  it('the partial unique index allows exactly one active job — the database enforces one-at-a-time', async () => {
    const a = await mk(); const b = await mk(); const c = await mk();
    await setState(a.id, 'starting_instance');
    await expect(setState(b.id, 'running')).rejects.toThrow(/docgen_jobs_one_active/);
    await expect(setState(b.id, 'awaiting_input')).rejects.toThrow(/docgen_jobs_one_active/);
    await setState(a.id, 'succeeded');      // finishing frees the slot
    await setState(b.id, 'running');
    await setState(c.id, 'queued');          // any number may wait
    await setState(c.id, 'failed');          // and any number may be final
  });

  it('applies a newer seq and returns the one it replaced; older, equal and repeated seqs are no-ops', async () => {
    const a = await mk();
    await setState(a.id, 'running');
    expect(await applyDocgenStatus(pool, a.id, st(2, { job_id: 'dg_1', request_id: a.id }))).toEqual({ applied: true, prevSeq: 0 });
    expect(await applyDocgenStatus(pool, a.id, st(5, { job_id: 'dg_1', request_id: a.id, stage: 'build_long', progress: 0.5 }))).toEqual({ applied: true, prevSeq: 2 });
    expect(await applyDocgenStatus(pool, a.id, st(4))).toEqual({ applied: false, prevSeq: null });
    expect(await applyDocgenStatus(pool, a.id, st(5))).toEqual({ applied: false, prevSeq: null });
    const row = await getDocgenJob(pool, a.id);
    expect(row).toMatchObject({ seq: 5, stage: 'build_long', progress: 0.5, jobId: 'dg_1' });
    expect(row?.status?.seq).toBe(5);
  });

  it('a final state is sticky and sets finished_at; a late non-final event cannot resurrect the job', async () => {
    const a = await mk();
    await setState(a.id, 'running');
    await applyDocgenStatus(pool, a.id, st(9, { job_id: 'dg_1', state: 'succeeded', stage: 'done', progress: 1, outputs: [{ kind: 'long_video', path: 'out/a.mp4', url: 'https://cdn/a.mp4' }] }));
    const done = await getDocgenJob(pool, a.id);
    expect(done).toMatchObject({ state: 'succeeded', progress: 1 });
    expect(done?.finishedAt).toBeInstanceOf(Date);
    expect(done?.outputs).toEqual([{ kind: 'long_video', path: 'out/a.mp4', url: 'https://cdn/a.mp4' }]);
    expect(await applyDocgenStatus(pool, a.id, st(12, { stage: 'build_long' }))).toEqual({ applied: false, prevSeq: null });
    expect((await getDocgenJob(pool, a.id))?.state).toBe('succeeded');
  });

  it('keeps an already-known job_id, and fills it in when the first webhook beat our write of the 202', async () => {
    const a = await mk(); await setState(a.id, 'running');
    await applyDocgenStatus(pool, a.id, st(1, { job_id: 'dg_first' }));
    expect((await getDocgenJob(pool, a.id))?.jobId).toBe('dg_first');
    await applyDocgenStatus(pool, a.id, st(2, { job_id: 'dg_second' }));
    expect((await getDocgenJob(pool, a.id))?.jobId).toBe('dg_first');
  });

  it('events are de-duplicated on (request, seq, event) — at-least-once delivery is safe', async () => {
    const a = await mk();
    const e = { requestId: a.id, seq: 3, event: 'stage.started', body: { x: 1 } };
    expect(await recordDocgenEvent(pool, e)).toBe(true);
    expect(await recordDocgenEvent(pool, e)).toBe(false);
    expect(await recordDocgenEvent(pool, { ...e, event: 'stage.completed' })).toBe(true);
  });

  it('applyDocgenEvent end to end: in order, a gap, a repeat, then a stale replay', async () => {
    const a = await mk(); await setState(a.id, 'running');
    const ev = (seq: number, event = 'stage.started', over: Partial<DocgenStatus> = {}) =>
      ({ event, job_id: 'dg_1', request_id: a.id, seq, status: st(seq, { job_id: 'dg_1', request_id: a.id, ...over }) });
    expect(await applyDocgenEvent(pool, ev(1, 'job.accepted'))).toEqual({ outcome: 'applied', prevSeq: 0, gap: false });
    expect(await applyDocgenEvent(pool, ev(2))).toEqual({ outcome: 'applied', prevSeq: 1, gap: false });
    expect(await applyDocgenEvent(pool, ev(6))).toEqual({ outcome: 'applied', prevSeq: 2, gap: true });
    expect(await applyDocgenEvent(pool, ev(6))).toEqual({ outcome: 'duplicate' });
    expect(await applyDocgenEvent(pool, ev(4))).toEqual({ outcome: 'stale' });
    expect((await getDocgenJob(pool, a.id))?.seq).toBe(6);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM docgen_events WHERE request_id = $1', [a.id]);
    expect(rows[0].n).toBe(4); // seq 1, 2, 6 and the stale 4 are recorded; the repeated 6 is not
  });

  it('a heartbeat stamps last_heartbeat_at without touching seq or state', async () => {
    const a = await mk(); await setState(a.id, 'running');
    expect(await applyDocgenEvent(pool, { event: 'job.heartbeat', job_id: 'dg_1', request_id: a.id, seq: 0 })).toEqual({ outcome: 'heartbeat' });
    const row = await getDocgenJob(pool, a.id);
    expect(row?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(row).toMatchObject({ seq: 0, state: 'running' });
  });
});
