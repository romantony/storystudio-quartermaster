/**
 * POST /v1/documentaries, GET /v1/documentaries/:id, GET /v1/admin/docgen
 * (src/http/routes/docgen.ts).
 */
import Fastify from 'fastify';
import type { Pool } from 'pg';
import pino from 'pino';
import { docgenRoutes } from '../src/http/routes/docgen';
import { setLogger } from '../src/telemetry/log';
import type { Config } from '../src/config';

setLogger(pino({ level: 'silent' }));

const cfg = {
  ingestToken: 'ing', adminToken: 'adm', publicBaseUrl: 'https://orch.example',
  docgenBaseUrl: 'https://doc-gen.example', docgenApiToken: 't', docgenCallbackSecret: 's',
  docgenReviewMode: 'auto', docgenModel: 'claude-sonnet-5-5',
} as unknown as Config;

const body = {
  requestId: 'req_1', projectId: 'p1', source: 'mcp', tier: 'documentary-basic',
  callbackUrl: 'https://x.convex.site/api/qm/result', topic: 'Topic', synopsis: 'Synopsis.',
};
const DB_ROW = (over: Record<string, unknown> = {}) => ({
  request_id: 'req_1', docgen_request_id: 'req_1', job_id: null, project_id: 'p1', callback_url: 'https://x', state: 'queued',
  stage: null, seq: 0, progress: null, message: null, request: {}, status: null, outputs: null, error: null, attempts: 0,
  queued_at: new Date(), started_at: null, finished_at: null, last_heartbeat_at: null, instance_started_at: null,
  last_polled_at: null, updated_at: new Date(), result: null, callback_status: null, ...over,
});

function fakePool(opts: { existing?: Record<string, unknown> | null; ahead?: number } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (/INSERT INTO docgen_jobs/.test(sql)) return opts.existing ? { rows: [], rowCount: 0 } : { rows: [DB_ROW({ request_id: params?.[0], docgen_request_id: params?.[1], request: params?.[4] })], rowCount: 1 };
    if (/AS ahead/.test(sql)) return { rows: [{ ahead: opts.ahead ?? 0 }] };
    if (/FROM docgen_jobs WHERE request_id/.test(sql)) return { rows: opts.existing === null ? [] : [opts.existing ?? DB_ROW()] };
    return { rows: [] };
  });
  return { pool: { query } as unknown as Pool, calls };
}
const mk = async (pool: Pool, c: Config = cfg) => {
  const a = Fastify();
  await a.register(docgenRoutes, { pool, cfg: c });
  return a;
};
const post = (a: Awaited<ReturnType<typeof mk>>, payload: unknown, auth: string | null = 'Bearer ing') =>
  a.inject({ method: 'POST', url: '/v1/documentaries', headers: auth ? { authorization: auth } : {}, payload: payload as object });

describe('POST /v1/documentaries', () => {
  it('401 without the ingest token — and the admin token is not accepted here', async () => {
    const a = await mk(fakePool().pool);
    expect((await post(a, body, null)).statusCode).toBe(401);
    expect((await post(a, body, 'Bearer adm')).statusCode).toBe(401);
  });

  it('503 while the feature is off, rather than accepting work nothing will run', async () => {
    const off = { ...cfg, docgenBaseUrl: '' } as unknown as Config;
    expect((await post(await mk(fakePool().pool, off), body)).statusCode).toBe(503);
    const noSecret = { ...cfg, docgenCallbackSecret: undefined } as unknown as Config;
    expect((await post(await mk(fakePool().pool, noSecret), body)).statusCode).toBe(503);
  });

  it('400 with the zod issues, and nothing is queued', async () => {
    const { pool, calls } = fakePool();
    const r = await post(await mk(pool), { ...body, targetSeconds: 10 });
    expect(r.statusCode).toBe(400);
    expect(r.json().issues[0].path).toEqual(['targetSeconds']);
    expect(calls).toHaveLength(0);
  });

  it('202: queues the instance payload (not the intake) and acknowledges with jobs-ahead and an estimate', async () => {
    const { pool, calls } = fakePool({ ahead: 2 });
    const r = await post(await mk(pool), body);
    expect(r.statusCode).toBe(202);
    const j = r.json();
    expect(j).toMatchObject({ requestId: 'req_1', accepted: true, queued: true, state: 'queued', jobsAhead: 2, estimateBasis: 'default' });
    expect(new Date(j.estimatedResultAt).getTime()).toBeGreaterThan(Date.now() + 2 * 75 * 60_000);
    const insert = calls.find((c) => /INSERT INTO docgen_jobs/.test(c.sql))!;
    expect(insert.params?.[1]).toBe('req_1');
    expect(insert.params?.[3]).toBe(body.callbackUrl);
    expect(insert.params?.[4]).toMatchObject({
      request_id: 'req_1', review_mode: 'auto', model: 'claude-sonnet-5-5', output: { prefix: 'docgen/req_1/' },
      callback: { url: 'https://orch.example/v1/webhooks/docgen' },
    });
  });

  it('a replay is acknowledged from the stored row; a finished job has no estimate', async () => {
    const done = DB_ROW({ state: 'succeeded' });
    const r = await post(await mk(fakePool({ existing: done }).pool), body);
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ requestId: 'req_1', state: 'succeeded', queued: false, estimatedResultAt: null });
  });
});

describe('GET /v1/documentaries/:requestId', () => {
  const get = (a: Awaited<ReturnType<typeof mk>>, auth: string | null = 'Bearer ing') =>
    a.inject({ method: 'GET', url: '/v1/documentaries/req_1', headers: auth ? { authorization: auth } : {} });

  it('401, 404, and the status summary', async () => {
    expect((await get(await mk(fakePool().pool), null)).statusCode).toBe(401);
    expect((await get(await mk(fakePool({ existing: null }).pool))).statusCode).toBe(404);
    const running = DB_ROW({ state: 'running', stage: 'build_long', progress: 0.5, message: 'Assembling', status: { warnings: ['w1'] }, outputs: [{ kind: 'x' }] });
    const r = await get(await mk(fakePool({ existing: running }).pool));
    expect(r.json()).toMatchObject({ requestId: 'req_1', state: 'running', stage: 'build_long', progress: 0.5, warnings: ['w1'], outputs: [{ kind: 'x' }] });
    expect(r.json()).not.toHaveProperty('result');
    expect(r.json()).not.toHaveProperty('request');
  });
});

describe('GET /v1/admin/docgen', () => {
  it('needs the admin token, and the ingest token is not enough', async () => {
    const a = await mk(fakePool().pool);
    expect((await a.inject({ method: 'GET', url: '/v1/admin/docgen' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/v1/admin/docgen', headers: { authorization: 'Bearer ing' } })).statusCode).toBe(401);
    const ok = await a.inject({ method: 'GET', url: '/v1/admin/docgen', headers: { authorization: 'Bearer adm' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ enabled: true, active: null, queued: [], recent: [] });
  });
});
