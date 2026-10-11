/**
 * POST /v1/webhooks/docgen — signature, raw-body parsing, scoping, and event
 * application (src/http/routes/docgen-webhook.ts, src/docgen/events.ts).
 */
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { docgenWebhookRoutes } from '../src/http/routes/docgen-webhook';
import { applyDocgenEvent } from '../src/docgen/events';
import { signDocgenBody } from '../src/docgen/signature';
import { setLogger } from '../src/telemetry/log';
import pino from 'pino';
import type { Config } from '../src/config';
import type { DocgenStatus, DocgenWebhookBody } from '../src/docgen/types';

setLogger(pino({ level: 'silent' }));

const SECRET = 'whsec';
const jobRow = { request_id: 'req_1', docgen_request_id: 'req_1', job_id: null, project_id: 'p', callback_url: 'https://cb', state: 'running', seq: 2, attempts: 1 };

function status(seq: number, over: Partial<DocgenStatus> = {}): DocgenStatus {
  return { job_id: 'dg_1', request_id: 'req_1', seq, state: 'running', stage: 'script', progress: 0.1, ...over };
}
function body(event: string, seq: number, over: Partial<DocgenStatus> = {}): DocgenWebhookBody {
  return { event, job_id: 'dg_1', request_id: 'req_1', seq, status: status(seq, over) };
}

/** Routes SQL by statement shape; records what ran. */
function fakePool(opts: { job?: Record<string, unknown> | null; eventNew?: boolean; applyPrevSeq?: number | null } = {}) {
  const job = opts.job === undefined ? jobRow : opts.job;
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (/FROM docgen_jobs WHERE docgen_request_id/.test(sql)) return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
    if (/INSERT INTO docgen_events/.test(sql)) return { rows: [], rowCount: opts.eventNew === false ? 0 : 1 };
    if (/WITH prev AS/.test(sql)) {
      const p = opts.applyPrevSeq === undefined ? 2 : opts.applyPrevSeq;
      return { rows: p === null ? [] : [{ prev_seq: p }], rowCount: p === null ? 0 : 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  return { pool: { query } as unknown as Pool, calls };
}

async function app(pool: Pool, secret: string | null = SECRET) {
  const a = Fastify();
  // An unrelated JSON route registered beside it: the raw-body parser must not leak onto it.
  a.post('/other', async (req) => ({ got: (req.body as { x: number }).x }));
  await a.register(docgenWebhookRoutes, { pool, cfg: { docgenCallbackSecret: secret ?? undefined } as unknown as Config });
  return a;
}
const post = (a: Awaited<ReturnType<typeof app>>, raw: string, sig?: string) =>
  a.inject({ method: 'POST', url: '/v1/webhooks/docgen', headers: { 'content-type': 'application/json', ...(sig ? { 'x-docgen-signature': sig } : {}) }, payload: raw });

describe('POST /v1/webhooks/docgen', () => {
  it('503s when no callback secret is configured (feature off), never accepting unsigned input', async () => {
    const { pool, calls } = fakePool();
    const r = await post(await app(pool, null), JSON.stringify(body('stage.started', 3)));
    expect(r.statusCode).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('401s a missing or wrong signature and touches nothing', async () => {
    const { pool, calls } = fakePool();
    const a = await app(pool);
    const raw = JSON.stringify(body('stage.started', 3));
    expect((await post(a, raw)).statusCode).toBe(401);
    expect((await post(a, raw, signDocgenBody('wrong', raw))).statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('verifies over the RAW bytes: re-serialised JSON with different whitespace still verifies only against its own bytes', async () => {
    const { pool } = fakePool();
    const a = await app(pool);
    const compact = JSON.stringify(body('stage.started', 3));
    const spaced = JSON.stringify(body('stage.started', 3), null, 2);
    expect((await post(a, spaced, signDocgenBody(SECRET, compact))).statusCode).toBe(401);
    expect((await post(a, spaced, signDocgenBody(SECRET, spaced))).statusCode).toBe(200);
  });

  it('400s a correctly-signed body that is not an event', async () => {
    const { pool } = fakePool();
    const a = await app(pool);
    for (const raw of ['not json', '{"hello":1}']) {
      expect((await post(a, raw, signDocgenBody(SECRET, raw))).statusCode).toBe(400);
    }
  });

  it('200s and applies a signed status event', async () => {
    const { pool, calls } = fakePool();
    const raw = JSON.stringify(body('stage.started', 3, { stage: 'narration' }));
    const r = await post(await app(pool), raw, signDocgenBody(SECRET, raw));
    expect(r.statusCode).toBe(200);
    await new Promise((res) => setImmediate(res)); // work continues after the reply
    expect(calls.some((c) => /INSERT INTO docgen_events/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /WITH prev AS/.test(c.sql))).toBe(true);
  });

  it('still answers 200 when the database fails — the instance would otherwise retry-storm; catch-up recovers it', async () => {
    const pool = { query: jest.fn(async () => { throw new Error('db down'); }) } as unknown as Pool;
    const raw = JSON.stringify(body('stage.started', 3));
    expect((await post(await app(pool), raw, signDocgenBody(SECRET, raw))).statusCode).toBe(200);
  });

  it('keeps the raw-body parser scoped: other routes still get parsed JSON', async () => {
    const { pool } = fakePool();
    const r = await (await app(pool)).inject({ method: 'POST', url: '/other', headers: { 'content-type': 'application/json' }, payload: '{"x":7}' });
    expect(r.json()).toEqual({ got: 7 });
  });
});

describe('applyDocgenEvent', () => {
  it('ignores an event for a request id we never sent', async () => {
    const { pool, calls } = fakePool({ job: null });
    expect(await applyDocgenEvent(pool, body('stage.started', 3))).toEqual({ outcome: 'unknown_job' });
    expect(calls).toHaveLength(1);
  });

  it('a heartbeat only touches last_heartbeat_at — no event row, no status change', async () => {
    const { pool, calls } = fakePool();
    expect(await applyDocgenEvent(pool, { event: 'job.heartbeat', job_id: 'dg_1', request_id: 'req_1', seq: 2 })).toEqual({ outcome: 'heartbeat' });
    expect(calls.map((c) => c.sql).join('\n')).not.toMatch(/docgen_events|WITH prev/);
    expect(calls.some((c) => /last_heartbeat_at = now\(\)/.test(c.sql))).toBe(true);
  });

  it('applies the next event with no gap', async () => {
    const { pool } = fakePool({ applyPrevSeq: 2 });
    expect(await applyDocgenEvent(pool, body('stage.started', 3))).toEqual({ outcome: 'applied', prevSeq: 2, gap: false });
  });

  it('flags a gap when seq jumps by more than one (a webhook was missed)', async () => {
    const { pool } = fakePool({ applyPrevSeq: 2 });
    expect(await applyDocgenEvent(pool, body('stage.started', 6))).toEqual({ outcome: 'applied', prevSeq: 2, gap: true });
  });

  it('an older or equal seq is stale; a repeat of a recorded event is a duplicate', async () => {
    expect(await applyDocgenEvent(fakePool({ applyPrevSeq: null, eventNew: true }).pool, body('stage.started', 1))).toEqual({ outcome: 'stale' });
    expect(await applyDocgenEvent(fakePool({ applyPrevSeq: null, eventNew: false }).pool, body('stage.started', 1))).toEqual({ outcome: 'duplicate' });
  });
});
