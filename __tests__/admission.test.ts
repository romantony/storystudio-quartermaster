import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const sendMock = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return { ...actual, DynamoDBClient: jest.fn(() => ({ send: sendMock })) };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { handleAdmission, handleAdmissionRelease } from '../src/handlers/admission';
import { expireStaleReservations } from '../src/gate/reservation-gate';
import type { LambdaFunctionUrlEvent } from '../src/types';

const cmdName = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;
const keyOf = (c: any) => (c.input?.Key ? unmarshall(c.input.Key) : undefined);
const valuesOf = (c: any) => (c.input?.ExpressionAttributeValues ? unmarshall(c.input.ExpressionAttributeValues) : {});

function evt(body: unknown, rawPath = '/admission'): LambdaFunctionUrlEvent {
  return {
    version: '2.0', routeKey: '$default', rawPath, rawQueryString: '',
    headers: {}, isBase64Encoded: false,
    body: JSON.stringify(body),
    requestContext: {
      accountId: '', apiId: '', domainName: '',
      http: { method: 'POST', path: rawPath, protocol: 'HTTP/1.1', sourceIp: '', userAgent: '' },
      requestId: '', routeKey: '$default', stage: '', time: '', timeEpoch: 0,
    },
  };
}

interface Scenario {
  inflight?: Record<string, number>;
  workersMax?: Record<string, number>;
  workersMin?: Record<string, number>;
  baselines?: Record<string, number[]>;   // counterKey -> ewmaMs samples
  activeReservations?: unknown[];         // pre-marshalled-friendly plain objects
  existingByRequestId?: { admissionId: string } | null;
  existingReservation?: unknown | null;
}

function mockScenario(s: Scenario) {
  sendMock.mockImplementation(async (cmd) => {
    const name = cmdName(cmd);

    if (name === 'GetItemCommand') {
      const key = keyOf(cmd);
      if (typeof key?.pk === 'string' && key.pk.startsWith('COUNTER#')) {
        const ck = key.pk.slice('COUNTER#'.length);
        return { Item: marshall({ inflight: s.inflight?.[ck] ?? 0 }) };
      }
      if (key?.pk === 'RUNPODENDPOINT') {
        // Real reads are either ProjectionExpression:workersMax (getEndpointWorkersMax)
        // or the full item (readEndpoint, used by prewarmEndpoints/§WS-C3) — always
        // return the full shape so both call sites get a valid item.
        return {
          Item: marshall({
            pk: 'RUNPODENDPOINT', sk: key.sk, endpointId: key.sk,
            workersMax: s.workersMax?.[key.sk] ?? 0,
            workersMin: s.workersMin?.[key.sk] ?? 0,
            updatedAt: 0,
          }),
        };
      }
      if (typeof key?.pk === 'string' && key.pk.startsWith('RESERVATIONREQ#')) {
        return s.existingByRequestId ? { Item: marshall(s.existingByRequestId) } : {};
      }
      if (typeof key?.pk === 'string' && key.pk.startsWith('RESERVATION#')) {
        return s.existingReservation ? { Item: marshall(s.existingReservation) } : {};
      }
      return {};
    }

    if (name === 'QueryCommand') {
      if (cmd.input.IndexName === 'queue-index') return { Items: [] }; // queued=0 everywhere by default
      const vals = valuesOf(cmd);
      if (typeof vals[':pk'] === 'string' && vals[':pk'].startsWith('BASELINE#')) {
        const ck = vals[':pk'].slice('BASELINE#'.length);
        const samples = s.baselines?.[ck] ?? [];
        return { Items: samples.map(ewmaMs => marshall({ ewmaMs })) };
      }
      return { Items: [] };
    }

    if (name === 'ScanCommand') {
      return { Items: (s.activeReservations ?? []).map(r => marshall(r as Record<string, unknown>)) };
    }

    if (name === 'PutItemCommand' || name === 'UpdateItemCommand') return {};
    return {};
  });
}

beforeEach(() => {
  sendMock.mockReset();
  delete process.env.ADMISSION_STUB;
});

describe('handleAdmission — validation', () => {
  it('400s when required fields are missing', async () => {
    mockScenario({});
    const res = await handleAdmission(evt({ requestId: 'r1' }));
    expect(res.statusCode).toBe(400);
  });

  it('400s on an unsupported projectType', async () => {
    mockScenario({});
    const res = await handleAdmission(evt({
      requestId: 'r1', projectType: 'movie-epic', tier: 'basic', durationSeconds: 90,
    }));
    expect(res.statusCode).toBe(400);
  });
});

describe('handleAdmission — grant on an empty fleet', () => {
  it('grants a narration-basic project with sane worker sizing (concurrency-capped, not total-jobs)', async () => {
    mockScenario({ inflight: {}, workersMax: {}, baselines: {} });
    const res = await handleAdmission(evt({
      requestId: 'r-basic', projectType: 'narration-basic', tier: 'basic', durationSeconds: 100, // -> 20 frames
    }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.decision).toBe('granted');
    expect(body.admissionId).toMatch(/^qm_adm_/);
    expect(body.warmedEndpoints).toEqual(['runpod:flux-tts-s2t']);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('synchronously pre-warms the touched endpoint on grant (§WS-C3), not just on the next sweeper tick', async () => {
    mockScenario({ inflight: {}, workersMax: {}, workersMin: {}, baselines: {} });
    await handleAdmission(evt({
      requestId: 'r-prewarm', projectType: 'narration-basic', tier: 'basic', durationSeconds: 100,
    }));

    const putCalls = sendMock.mock.calls.filter(c => cmdName(c[0]) === 'PutItemCommand');
    const endpointWrite = putCalls
      .map(c => unmarshall((c[0] as any).input.Item))
      .find(item => item.pk === 'RUNPODENDPOINT' && item.sk === 'runpod:flux-tts-s2t');
    expect(endpointWrite).toBeDefined();
    expect(endpointWrite!.workersMin).toBeGreaterThanOrEqual(1); // pre-warmed, not left cold
    expect(endpointWrite!.workersMax).toBeGreaterThanOrEqual(4); // concurrency-sized (§D2 correction)
  });
});

describe('handleAdmission — defer on cap contention', () => {
  it('grants a solo narration-premium project against an idle fleet (regression: premium has its own, lower Map concurrency)', async () => {
    // Before the 2026-07-04 fix, premium shared the basic Map's concurrency (15):
    // ceil(min(20,15)/4)=4 workers * 3 endpoints = 12 > cap(10) — a solo premium
    // project deferred `cap_committed` forever, even on a fully idle fleet (confirmed
    // against real StoryStudio traffic: one request retried identically for 40+ min).
    // Premium now uses PREMIUM_MAP_CONCURRENCY (8): ceil(min(20,8)/4)=2 * 3 = 6 <= 10.
    mockScenario({ inflight: {}, workersMax: {}, baselines: {} });
    const res = await handleAdmission(evt({
      requestId: 'r-premium', projectType: 'narration-premium', tier: 'premium', durationSeconds: 100,
    }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.decision).toBe('granted');
    expect([...body.warmedEndpoints].sort()).toEqual([
      'runpod:flux-tts-s2t', 'runpod:qwen-image-edit', 'runpod:wan2-i2v',
    ]);

    const putCalls = sendMock.mock.calls.filter(c => cmdName(c[0]) === 'PutItemCommand');
    const reservationWrite = putCalls
      .map(c => unmarshall((c[0] as any).input.Item))
      .find(item => typeof item.pk === 'string' && item.pk.startsWith('RESERVATION#'));
    expect(reservationWrite).toBeDefined();
    const totalWorkers = Object.values(reservationWrite!.neededWorkers as Record<string, number>)
      .reduce((a, b) => a + b, 0);
    expect(totalWorkers).toBe(6); // ceil(min(20,8)/4)=2 per endpoint * 3 endpoints
  });

  it('still defers a narration-premium project when real fleet contention pushes the total over the cap', async () => {
    // cap_committed must still be reachable for premium — just from real organic
    // demand elsewhere, not structurally from a solo project's own footprint.
    // 20 inflight jobs on qwen-image-gen (unrelated to this i2i-only premium
    // project) => ceil(20/4)=5 organic workers already committed; + this
    // project's 6 (see the grant test above) = 11 > cap(10).
    mockScenario({ inflight: { 'runpod:qwen-image-gen': 20 }, workersMax: {}, baselines: {} });
    const res = await handleAdmission(evt({
      requestId: 'r-premium-contended', projectType: 'narration-premium', tier: 'premium', durationSeconds: 100,
    }));
    const body = JSON.parse(res.body!);
    expect(body.decision).toBe('deferred');
    expect(body.reason).toBe('cap_committed');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.estimatedWaitSeconds).toBeGreaterThan(0);
  });
});

describe('handleAdmission — defer on queue-depth ceiling', () => {
  it('defers when the endpoint baseline makes drain exceed the fleet-protection ceiling, even with cap headroom', async () => {
    // Cap is fine (basic needs ~4 workers), but an absurdly high baseline blows the 30-min drain ceiling.
    mockScenario({
      inflight: {}, workersMax: {},
      baselines: { 'runpod:flux-tts-s2t': [10_000_000] }, // 10,000s per job
    });
    const res = await handleAdmission(evt({
      requestId: 'r-slow', projectType: 'narration-basic', tier: 'basic', durationSeconds: 100,
    }));
    const body = JSON.parse(res.body!);
    expect(body.decision).toBe('deferred');
    expect(body.reason).toBe('queue_busy');
  });
});

describe('handleAdmission — idempotency', () => {
  it('returns the same admissionId on a retry without re-deciding capacity', async () => {
    const existing = {
      pk: 'RESERVATION#qm_adm_existing', sk: 'META', admissionId: 'qm_adm_existing',
      requestId: 'r-dup', projectType: 'narration-basic', tier: 'basic', durationSeconds: 90,
      neededWorkers: { 'runpod:flux-tts-s2t': 4 }, perEndpointJobs: { 'runpod:flux-tts-s2t': 74 },
      status: 'active', drainEstMs: 60000, createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    };
    mockScenario({ existingByRequestId: { admissionId: 'qm_adm_existing' }, existingReservation: existing });

    const res = await handleAdmission(evt({
      requestId: 'r-dup', projectType: 'narration-basic', tier: 'basic', durationSeconds: 90,
    }));
    const body = JSON.parse(res.body!);
    expect(body.decision).toBe('granted');
    expect(body.admissionId).toBe('qm_adm_existing');

    // Only the two GetItem lookups should have fired — no capacity-decision queries.
    const names = sendMock.mock.calls.map(c => cmdName(c[0]));
    expect(names.every(n => n === 'GetItemCommand')).toBe(true);
  });
});

describe('handleAdmission — ADMISSION_STUB', () => {
  it('always grants, skipping capacity math, when ADMISSION_STUB=granted', async () => {
    // ADMISSION_STUB is read into a module-level const at import time (same
    // convention as ACCOUNT_CAP/SAFE_LIMIT elsewhere), so a fresh module
    // instance is required after setting the env var.
    process.env.ADMISSION_STUB = 'granted';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stub = require('../src/handlers/admission') as typeof import('../src/handlers/admission');
    mockScenario({});
    const res = await stub.handleAdmission(evt({
      requestId: 'r-stub', projectType: 'narration-premium', tier: 'premium', durationSeconds: 600,
    }));
    const body = JSON.parse(res.body!);
    expect(body.decision).toBe('granted');
    delete process.env.ADMISSION_STUB;
    jest.resetModules();
  });
});

describe('handleAdmissionRelease', () => {
  it('releases an active reservation', async () => {
    const reservation = {
      pk: 'RESERVATION#qm_adm_abc', sk: 'META', admissionId: 'qm_adm_abc',
      requestId: 'r-rel', status: 'active', neededWorkers: {}, perEndpointJobs: {},
      drainEstMs: 0, createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    };
    mockScenario({ existingReservation: reservation });

    const res = await handleAdmissionRelease(evt({ outcome: 'completed' }, '/admission/qm_adm_abc/release'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).released).toBe(true);
    expect(sendMock.mock.calls.some(c => cmdName(c[0]) === 'UpdateItemCommand')).toBe(true);
  });

  it('404s for an unknown admissionId', async () => {
    mockScenario({ existingReservation: null });
    const res = await handleAdmissionRelease(evt({}, '/admission/qm_adm_missing/release'));
    expect(res.statusCode).toBe(404);
  });

  it('is idempotent on a second release of an already-released reservation', async () => {
    const reservation = {
      pk: 'RESERVATION#qm_adm_abc', sk: 'META', admissionId: 'qm_adm_abc',
      requestId: 'r-rel', status: 'released', neededWorkers: {}, perEndpointJobs: {},
      drainEstMs: 0, createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    };
    mockScenario({ existingReservation: reservation });
    const res = await handleAdmissionRelease(evt({}, '/admission/qm_adm_abc/release'));
    expect(JSON.parse(res.body!).released).toBe(true);
  });
});

describe('expireStaleReservations', () => {
  it('expires active reservations past expiresAt and leaves fresh ones', async () => {
    const stale = {
      pk: 'RESERVATION#qm_adm_stale', sk: 'META', admissionId: 'qm_adm_stale',
      status: 'active', expiresAt: Date.now() - 1000, neededWorkers: {}, perEndpointJobs: {},
    };
    const fresh = {
      pk: 'RESERVATION#qm_adm_fresh', sk: 'META', admissionId: 'qm_adm_fresh',
      status: 'active', expiresAt: Date.now() + 600_000, neededWorkers: {}, perEndpointJobs: {},
    };
    mockScenario({ activeReservations: [stale, fresh] });

    const result = await expireStaleReservations();
    expect(result.expired).toBe(1);
    const updateCalls = sendMock.mock.calls.filter(c => cmdName(c[0]) === 'UpdateItemCommand');
    expect(updateCalls).toHaveLength(1);
    expect(unmarshall((updateCalls[0][0] as any).input.Key).pk).toBe('RESERVATION#qm_adm_stale');
  });
});
