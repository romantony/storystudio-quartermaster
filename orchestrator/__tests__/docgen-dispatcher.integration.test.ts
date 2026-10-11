/**
 * The doc-gen dispatcher against a real Postgres (src/docgen/dispatcher.ts),
 * with a fake instance (EC2), fake doc-gen API and fake callback sender.
 *
 * Real database because the dispatcher is a state machine over rows: the one-
 * active index, the claim query, the idempotent accept and the retry reset are
 * exactly what a mocked pool cannot check.
 *
 *   DATABASE_URL=postgres://qm:qm@localhost:55433/qm_orchestrator_test \
 *     npx ts-node src/db/migrate.ts up && npx jest docgen-dispatcher.integration
 */
import { Pool } from 'pg';
import pino from 'pino';
import { setLogger } from '../src/telemetry/log';
import { createDocgenDispatcher, type DispatcherTimings } from '../src/docgen/dispatcher';
import { DocgenHttpError, DocgenUnreachableError } from '../src/docgen/client';
import { enqueueDocgenJob, getDocgenJob } from '../src/db/repo/docgen';
import type { deliverCallback } from '../src/result/callback';

setLogger(pino({ level: 'silent' }));

const DB_URL = process.env.DATABASE_URL;
const maybeDescribe = DB_URL ? describe : describe.skip;

const OUT = (id: string) => [
  { kind: 'long_video', path: 'out/a.mp4', bytes: 9, url: `https://cdn/docgen/${id}/out/a.mp4` },
  { kind: 'thumbnail', path: 'thumb/t.jpg', bytes: 1, url: `https://cdn/docgen/${id}/thumb/t.jpg` },
];
const READY = { ready: true, busy: false, current_job_id: null, checks: {} };
const statusOf = (id: string, over: Record<string, unknown> = {}) => ({
  job_id: 'dg_1', request_id: id, seq: 20, state: 'succeeded', stage: 'done', progress: 1, outputs: OUT(id), warnings: [], error: null, ...over,
});

maybeDescribe('docgen dispatcher (integration)', () => {
  let pool: Pool;
  let n = 0;

  const ec2impl = { start: jest.fn(), stop: jest.fn(), describe: jest.fn() };
  const client = { health: jest.fn(), start: jest.fn(), status: jest.fn(), events: jest.fn() };
  const deliver = jest.fn();

  function dispatcher(timings: Partial<DispatcherTimings> = {}, maxAttempts = 2) {
    return createDocgenDispatcher({
      pool,
      client: client as never,
      ec2: { instanceId: 'i-test', region: 'us-east-1', impl: ec2impl },
      maxAttempts,
      callback: { secret: 'cbsecret', maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 1000 },
      timings: { capacityBackoffMs: 0, configBackoffMs: 0, busyBackoffMs: 0, stoppingBackoffMs: 0, ...timings },
      deliver: deliver as unknown as typeof deliverCallback,
    });
  }

  /** A job row, optionally patched straight into any state the dispatcher can meet it in. */
  async function job(patch: Record<string, unknown> = {}, ageMin = 0) {
    const id = `dgtest_${Date.now()}_${++n}`;
    await enqueueDocgenJob(pool, {
      requestId: id, docgenRequestId: id, projectId: 'proj', callbackUrl: 'https://cb.example/result',
      request: { request_id: id, topic: 't', synopsis: 's', review_mode: 'auto', output: { prefix: `docgen/${id}/` }, callback: { url: 'https://o/w' } },
    });
    const JSONB = new Set(['status', 'outputs', 'error', 'result']);
    const sets = ['queued_at = now() - ($1 || \' minutes\')::interval'];
    const params: unknown[] = [String(ageMin)];
    for (const [k, v] of Object.entries(patch)) {
      params.push(JSONB.has(k) && v !== null ? JSON.stringify(v) : v);
      sets.push(`${k} = $${params.length}${JSONB.has(k) ? '::jsonb' : ''}`);
    }
    params.push(id);
    await pool.query(`UPDATE docgen_jobs SET ${sets.join(', ')} WHERE request_id = $${params.length}`, params);
    return id;
  }
  const ago = (min: number) => `now() - interval '${min} minutes'`;
  const age = (id: string, col: string, min: number) => pool.query(`UPDATE docgen_jobs SET ${col} = ${ago(min)} WHERE request_id = $1`, [id]);
  const row = (id: string) => getDocgenJob(pool, id) as Promise<NonNullable<Awaited<ReturnType<typeof getDocgenJob>>>>;
  const running = (extra: Record<string, unknown> = {}) =>
    job({ state: 'running', job_id: 'dg_1', attempts: 1, started_at: new Date(), ...extra });

  beforeAll(() => { pool = new Pool({ connectionString: DB_URL }); });
  afterAll(async () => {
    await clean();
    await pool.end();
  });
  async function clean() {
    await pool.query(`DELETE FROM docgen_events WHERE request_id LIKE 'dgtest_%'`);
    await pool.query(`DELETE FROM docgen_jobs WHERE request_id LIKE 'dgtest_%'`);
  }
  beforeEach(async () => {
    await clean();
    jest.resetAllMocks();
    ec2impl.start.mockResolvedValue('pending');
    ec2impl.stop.mockResolvedValue('stopping');
    ec2impl.describe.mockResolvedValue('running');
    client.events.mockResolvedValue([]);
    deliver.mockImplementation(async (o: { onAttempt?: (a: unknown) => Promise<void> | void }) => {
      await o.onAttempt?.({ attempt: 1, at: new Date().toISOString(), durationMs: 5, httpStatus: 200 });
      return { outcome: 'delivered', attempts: [] };
    });
  });

  // ── starting ──────────────────────────────────────────────────────────────

  it('claims the oldest queued job, starts the instance, and leaves the rest queued', async () => {
    const newer = await job({}, 1);
    const older = await job({}, 30);
    await dispatcher().tick();
    expect(ec2impl.start).toHaveBeenCalledTimes(1);
    expect(ec2impl.start).toHaveBeenCalledWith('i-test');
    expect((await row(older)).state).toBe('starting_instance');
    expect((await row(older)).instanceStartedAt).toBeInstanceOf(Date);
    expect((await row(newer)).state).toBe('queued');
  });

  it('does nothing with an empty queue — in particular it does not touch the instance', async () => {
    await dispatcher().tick();
    expect(ec2impl.start).not.toHaveBeenCalled();
    expect(ec2impl.stop).not.toHaveBeenCalled();
  });

  it('waits while the instance boots (health = null is "not up yet"), then gives up after the boot timeout without consuming an attempt', async () => {
    const id = await job();
    const d = dispatcher({ bootTimeoutMs: 5 * 60_000, capacityBackoffMs: 60_000 });
    client.health.mockResolvedValue(null);
    await d.tick();                        // claim
    await d.tick();                        // booting
    expect((await row(id)).state).toBe('starting_instance');
    expect(client.start).not.toHaveBeenCalled();
    await age(id, 'instance_started_at', 10);
    await d.tick();
    const r = await row(id);
    expect(r).toMatchObject({ state: 'queued', attempts: 0 });
    expect(r.message).toMatch(/not healthy/);
    await d.tick();                        // held: must not immediately re-claim and re-start
    expect(ec2impl.start).toHaveBeenCalledTimes(1);
  });

  it('posts the job once the instance is up, and counts the attempt only then', async () => {
    const id = await job();
    const d = dispatcher();
    client.health.mockResolvedValue(READY);
    client.start.mockResolvedValue({ created: true, jobId: 'dg_77', state: 'running' });
    await d.tick();
    await d.tick();
    expect(client.start).toHaveBeenCalledTimes(1);
    expect((client.start.mock.calls[0][0] as { request_id: string }).request_id).toBe(id);
    expect(await row(id)).toMatchObject({ state: 'running', jobId: 'dg_77', attempts: 1 });
  });

  it('a replay after a crash (200, job already known) is adopted, not duplicated', async () => {
    const id = await job();
    const d = dispatcher();
    client.health.mockResolvedValue({ ...READY, busy: true, current_job_id: 'dg_77' });
    client.start.mockResolvedValue({ created: false, jobId: 'dg_77', state: 'running' });
    await d.tick(); await d.tick();
    expect(await row(id)).toMatchObject({ state: 'running', jobId: 'dg_77', attempts: 1 });
  });

  it('the instance\'s first webhook beating our own write does not break the accept', async () => {
    const id = await job({ state: 'running', job_id: 'dg_77', seq: 3, stage: 'script' }); // webhook already applied
    await pool.query(`UPDATE docgen_jobs SET started_at = now() WHERE request_id = $1`, [id]);
    const { markDocgenAccepted } = await import('../src/db/repo/docgen');
    await markDocgenAccepted(pool, id, 'dg_77', 1);
    await markDocgenAccepted(pool, id, 'dg_77', 1);   // and a repeat
    expect(await row(id)).toMatchObject({ state: 'running', attempts: 1, stage: 'script', seq: 3 });
  });

  it.each([
    ['an instance busy with an unknown job', new DocgenHttpError(409, 'busy', { error: { code: 'busy', current_job_id: 'dg_x' } }), false],
    ['an instance that is not ready (Storyblocks / keys)', new DocgenHttpError(503, 'not_ready', { error: { checks: {} } }), true],
    ['a refused credential', new DocgenHttpError(401, 'unauthorized', {}), true],
    ['a CloudFront 403 (wrong caller address)', new DocgenHttpError(403, 'cloudfront_forbidden', ''), true],
  ])('%s: requeues the job, holds the queue, and does not burn an attempt', async (_label, err, stops) => {
    const id = await job();
    const d = dispatcher({ busyBackoffMs: 60_000, configBackoffMs: 60_000 });
    client.health.mockResolvedValue(READY);
    client.start.mockRejectedValue(err);
    await d.tick(); await d.tick();
    expect(await row(id)).toMatchObject({ state: 'queued', attempts: 0 });
    expect(ec2impl.stop).toHaveBeenCalledTimes(stops ? 1 : 0);   // a misconfigured instance is stopped; a busy one is NOT (it is running something)
    await d.tick();
    expect(ec2impl.start).toHaveBeenCalledTimes(1);               // held
  });

  it('a 400 from the instance fails the request for good (our mapping is wrong; retrying cannot help) and reports it', async () => {
    const id = await job();
    const d = dispatcher();
    client.health.mockResolvedValue(READY);
    client.start.mockRejectedValue(new DocgenHttpError(400, 'invalid_field', { error: { code: 'invalid_field', field: 'topic' } }));
    await d.tick(); await d.tick();
    expect(await row(id)).toMatchObject({ state: 'failed', error: expect.objectContaining({ code: 'invalid_request', retryable: false }) });
    await d.tick(); await d.drain();
    const r = await row(id);
    expect(r.callbackStatus).toBe('delivered');
    expect((r.result as { status: string }).status).toBe('failed');
    expect(client.start).toHaveBeenCalledTimes(1);   // not retried
  });

  it('no capacity for the instance type: requeued with backoff. Still-stopping: requeued, retried promptly. Neither is mistaken for a config error', async () => {
    const id = await job();
    const held = dispatcher({ capacityBackoffMs: 60_000 });
    ec2impl.start.mockRejectedValueOnce(Object.assign(new Error('no cap'), { name: 'InsufficientInstanceCapacity' }));
    await held.tick();
    expect(await row(id)).toMatchObject({ state: 'queued', attempts: 0 });
    await held.tick();
    expect(ec2impl.start).toHaveBeenCalledTimes(1);

    const id2 = await job({}, 60);
    const prompt = dispatcher({ stoppingBackoffMs: 0 });
    ec2impl.start.mockReset();
    ec2impl.start.mockRejectedValueOnce(Object.assign(new Error('stopping'), { name: 'IncorrectInstanceState' })).mockResolvedValue('pending');
    await prompt.tick();
    expect((await row(id2)).state).toBe('queued');
    await prompt.tick();
    expect((await row(id2)).state).toBe('starting_instance');
  });

  // ── following ─────────────────────────────────────────────────────────────

  it('leaves a job that is talking alone, and polls a silent one no more than once a minute', async () => {
    const id = await running();
    const d = dispatcher({ silenceMs: 5 * 60_000, pollEveryMs: 60_000 });
    await d.tick();
    expect(client.status).not.toHaveBeenCalled();                      // fresh updated_at
    await age(id, 'updated_at', 10);
    client.status.mockResolvedValue(statusOf(id, { state: 'running', stage: 'build_long', seq: 5, outputs: [] }));
    await d.tick();
    expect(client.status).toHaveBeenCalledTimes(1);
    expect(client.events).toHaveBeenCalledWith('dg_1', 0);
    await age(id, 'updated_at', 10);                                   // still silent...
    await d.tick();
    expect(client.status).toHaveBeenCalledTimes(1);                    // ...but polled a moment ago
  });

  it('follows a silent job to success: polls, builds the result, stops the instance, delivers the signed callback', async () => {
    const id = await running();
    await age(id, 'updated_at', 10);
    const d = dispatcher();
    client.status.mockResolvedValue(statusOf(id, { warnings: ['No audio has been listened to'] }));
    await d.tick();                         // poll -> terminal
    expect(await row(id)).toMatchObject({ state: 'succeeded' });
    await d.tick(); await d.drain();        // finalize
    const r = await row(id);
    expect(r.callbackStatus).toBe('delivered');
    expect(r.result).toMatchObject({ requestId: id, projectId: 'proj', kind: 'documentary', status: 'completed', warnings: ['No audio has been listened to'] });
    expect(ec2impl.stop).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({ url: 'https://cb.example/result', requestId: id, secret: 'cbsecret' });
    const { rows } = await pool.query('SELECT jsonb_array_length(callback_attempts) AS n FROM docgen_jobs WHERE request_id = $1', [id]);
    expect(rows[0].n).toBe(1);
  });

  it('never stops the instance while another job is running or waiting — it hands over instead', async () => {
    const finished = await job({ state: 'succeeded', status: statusOf('x'), outputs: OUT('x'), started_at: new Date(), finished_at: new Date(), attempts: 1 });
    const next = await job({}, 0);
    const d = dispatcher();
    client.health.mockResolvedValue(READY);
    await d.tick(); await d.drain();
    expect((await row(finished)).callbackStatus).toBe('delivered');
    expect(ec2impl.stop).not.toHaveBeenCalled();
    expect(ec2impl.start).toHaveBeenCalledTimes(1);                    // start on a running instance is a no-op; same path
    expect((await row(next)).state).toBe('starting_instance');
  });

  it('never stops while a job is active, even when a different one has just finished', async () => {
    await running();
    await job({ state: 'failed', error: { code: 'timeout', retryable: true }, finished_at: new Date(), attempts: 1 });
    await dispatcher().tick();
    expect(ec2impl.stop).not.toHaveBeenCalled();
  });

  it('an output that failed to upload keeps the instance up, so the file can still be fetched', async () => {
    const outputs = [OUT('x')[0], { kind: 'thumbnail', path: 'thumb/t.jpg', bytes: 1 }];
    const id = await job({ state: 'succeeded', status: statusOf('x', { outputs }), outputs, started_at: new Date(), finished_at: new Date(), attempts: 1 });
    await dispatcher().tick(); await dispatcher().drain();
    expect(ec2impl.stop).not.toHaveBeenCalled();
    expect((await row(id)).result).toMatchObject({ status: 'partial' });
  });

  it('a failure to stop is reported, not fatal — the result is still delivered', async () => {
    const id = await job({ state: 'succeeded', status: statusOf('x'), outputs: OUT('x'), started_at: new Date(), finished_at: new Date(), attempts: 1 });
    ec2impl.stop.mockRejectedValue(new Error('UnauthorizedOperation'));
    const d = dispatcher();
    await d.tick(); await d.drain();
    expect((await row(id)).callbackStatus).toBe('delivered');
  });

  // ── retry ─────────────────────────────────────────────────────────────────

  it('retries a lost job once under a new instance-side id, ahead of newer requests, with no callback yet', async () => {
    const id = await job({ state: 'failed', attempts: 1, error: { code: 'internal', retryable: true }, finished_at: new Date(), started_at: new Date(), job_id: 'dg_1', seq: 9 }, 30);
    await dispatcher({ capacityBackoffMs: 60_000, configBackoffMs: 60_000 }).tick();
    const r = await row(id);
    expect(r).toMatchObject({ docgenRequestId: `${id}-r2`, jobId: null, seq: 0, result: null, callbackStatus: null });
    const sent = r.request as { request_id: string; output: { prefix: string } };
    expect(sent.request_id).toBe(`${id}-r2`);
    expect(sent.output.prefix).toBe(`docgen/${id}-r2/`);
    expect(deliver).not.toHaveBeenCalled();
    expect(r.state === 'queued' || r.state === 'starting_instance').toBe(true);   // the same tick may already claim it
  });

  it('gives up after the attempt cap and reports the failure', async () => {
    const id = await job({ state: 'failed', attempts: 2, error: { code: 'internal', retryable: true }, finished_at: new Date(), started_at: new Date() });
    const d = dispatcher();
    await d.tick(); await d.drain();
    const r = await row(id);
    expect(r.docgenRequestId).toBe(id);
    expect(r.callbackStatus).toBe('delivered');
    expect(r.result).toMatchObject({ status: 'failed', errors: [expect.objectContaining({ code: 'internal' })] });
  });

  it.each([
    ['a timeout (it would only burn the same hours again)', { code: 'timeout', retryable: true }],
    ['a failure the instance marks not retryable', { code: 'internal', retryable: false }],
    ['a Storyblocks sign-in problem (a person must fix it)', { code: 'storyblocks_auth', retryable: false }],
    ['a failed generation step', { code: 'generation_failed', retryable: true }],
  ])('does not retry %s', async (_l, error) => {
    const id = await job({ state: 'failed', attempts: 1, error, finished_at: new Date(), started_at: new Date() });
    const d = dispatcher();
    await d.tick(); await d.drain();
    expect((await row(id)).callbackStatus).toBe('delivered');
    expect((await row(id)).docgenRequestId).toBe(id);
  });

  // ── lost instance / job ───────────────────────────────────────────────────

  it('silence plus an unreachable API for 10+ minutes with the instance running: the job is declared lost, then retried', async () => {
    const id = await running();
    await age(id, 'updated_at', 15);
    client.events.mockRejectedValue(new DocgenUnreachableError('timeout'));
    ec2impl.describe.mockResolvedValue('running');
    const d = dispatcher({ capacityBackoffMs: 60_000, configBackoffMs: 60_000 });
    await d.tick();
    expect(await row(id)).toMatchObject({ state: 'failed', error: expect.objectContaining({ code: 'instance_unreachable', retryable: true }) });
    await d.tick();
    expect((await row(id)).docgenRequestId).toBe(`${id}-r2`);
  });

  it('a shorter silence with the API down is tolerated — a slow poll is not a lost job', async () => {
    const id = await running();
    await age(id, 'updated_at', 7);
    client.events.mockRejectedValue(new DocgenUnreachableError('timeout'));
    await dispatcher().tick();
    expect((await row(id)).state).toBe('running');
  });

  it('an instance stopped under a running job is started again so the job can be reported (it then fails `internal`)', async () => {
    const id = await running();
    await age(id, 'updated_at', 15);
    client.events.mockRejectedValue(new DocgenUnreachableError('down'));
    ec2impl.describe.mockResolvedValue('stopped');
    await dispatcher().tick();
    expect(ec2impl.start).toHaveBeenCalledTimes(1);
    expect((await row(id)).state).toBe('running');
  });

  it('a job the instance has never heard of is lost at once', async () => {
    const id = await running();
    await age(id, 'updated_at', 10);
    client.events.mockRejectedValue(new DocgenHttpError(404, 'not_found', {}));
    await dispatcher({ capacityBackoffMs: 60_000, configBackoffMs: 60_000 }).tick();
    expect(await row(id)).toMatchObject({ state: 'failed', error: expect.objectContaining({ code: 'job_lost' }) });
  });

  // ── restart ───────────────────────────────────────────────────────────────

  it('a restart resumes a half-delivered callback instead of dropping it', async () => {
    const id = await job({
      state: 'succeeded', status: statusOf('x'), outputs: OUT('x'), started_at: new Date(), finished_at: new Date(), attempts: 1,
      result: { requestId: 'x', status: 'completed' }, callback_status: 'pending',
    });
    const d = dispatcher();   // a brand new dispatcher: no memory of the earlier one
    await d.tick(); await d.drain();
    expect((await row(id)).callbackStatus).toBe('delivered');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a rejected or exhausted callback is recorded and not re-sent forever', async () => {
    const id = await job({ state: 'succeeded', status: statusOf('x'), outputs: OUT('x'), started_at: new Date(), finished_at: new Date(), attempts: 1 });
    deliver.mockResolvedValue({ outcome: 'exhausted', attempts: [] });
    const d = dispatcher();
    await d.tick(); await d.drain();
    await d.tick(); await d.drain();
    expect((await row(id)).callbackStatus).toBe('exhausted');
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('resumes a job that was mid-boot when the process restarted', async () => {
    const id = await job({ state: 'starting_instance', instance_started_at: new Date() });
    client.health.mockResolvedValue(READY);
    client.start.mockResolvedValue({ created: true, jobId: 'dg_5', state: 'running' });
    await dispatcher().tick();
    expect(await row(id)).toMatchObject({ state: 'running', jobId: 'dg_5' });
    expect(ec2impl.start).not.toHaveBeenCalled();   // it did not start the instance a second time
  });
});
