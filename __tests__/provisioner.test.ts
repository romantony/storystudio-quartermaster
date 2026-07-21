import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const sendMock = jest.fn();
const smSendMock = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return { ...actual, DynamoDBClient: jest.fn(() => ({ send: sendMock })) };
});

jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return { ...actual, SecretsManagerClient: jest.fn(() => ({ send: smSendMock })) };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { runProvisioner, prewarmEndpoints } from '../src/handlers/provisioner';

const cmdName = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;
const keyOf = (c: any) => (c.input?.Key ? unmarshall(c.input.Key) : undefined);

interface Scenario {
  inflight?: Record<string, number>;       // counterKey -> inflight
  activeReservations?: unknown[];          // plain ReservationItem-shaped objects
  endpointState?: Record<string, { workersMin: number; workersMax: number }>;
}

function mockScenario(s: Scenario) {
  sendMock.mockImplementation(async (cmd) => {
    const name = cmdName(cmd);

    if (name === 'QueryCommand') {
      if (cmd.input.IndexName === 'queue-index') return { Items: [] }; // no queued jobs
      return { Items: [] };
    }

    if (name === 'ScanCommand') {
      return { Items: (s.activeReservations ?? []).map(r => marshall(r as Record<string, unknown>)) };
    }

    if (name === 'GetItemCommand') {
      const key = keyOf(cmd);
      if (typeof key?.pk === 'string' && key.pk.startsWith('COUNTER#')) {
        const ck = key.pk.slice('COUNTER#'.length);
        return { Item: marshall({ inflight: s.inflight?.[ck] ?? 0 }) };
      }
      if (key?.pk === 'RUNPODENDPOINT') {
        const prior = s.endpointState?.[key.sk];
        if (!prior) return {}; // no prior state — readEndpoint defaults to workersMin:0, workersMax:0
        return { Item: marshall({ pk: 'RUNPODENDPOINT', sk: key.sk, endpointId: key.sk, updatedAt: 0, ...prior }) };
      }
      return {};
    }

    if (name === 'PutItemCommand') return {};
    return {};
  });
}

beforeEach(() => sendMock.mockReset());

describe('runProvisioner — reservation-aware demand (WS-C2)', () => {
  it('pre-warms an endpoint with an active reservation even with zero live inflight/queued', async () => {
    mockScenario({
      inflight: {},
      activeReservations: [{
        pk: 'RESERVATION#qm_adm_x', sk: 'META', admissionId: 'qm_adm_x', requestId: 'r1',
        status: 'active', neededWorkers: { 'runpod:flux-tts-s2t': 4 },
        perEndpointJobs: { 'runpod:flux-tts-s2t': 82 }, drainEstMs: 0,
        createdAt: Date.now(), expiresAt: Date.now() + 600_000,
      }],
    });

    const plans = await runProvisioner();
    const flux = plans.find(p => p.counterKey === 'runpod:flux-tts-s2t')!;
    expect(flux.demand.reserved).toBe(4);
    expect(flux.toMin).toBe(1); // pre-warm, not scaled to zero
    expect(flux.reason).toBe('reservation-prewarm');
    // flux alone wants max(reserved=4, its own baseline=6)=6 — the baseline
    // already covers this reservation, and with every endpoint's real
    // per-endpoint baseline (flux=6, qwen-gen=2, qwen-edit=2, wan2=6) the four
    // IDLE sums to only 6+2+2+6=16 <= ACCOUNT_CAP(20), so rebalanceUnderCap
    // never fires.
    expect(flux.toMax).toBe(6);

    // Untouched endpoints stay at the idle baseline (unaffected by the reservation).
    const wan2 = plans.find(p => p.counterKey === 'runpod:wan2-i2v')!;
    expect(wan2.demand.reserved).toBe(0);
    expect(wan2.reason).toBe('scale-to-zero');
  });

  it('idles to each endpoint\'s real per-endpoint baseline, not a uniform default (2026-07-07 account-confirmed values)', async () => {
    mockScenario({ inflight: {} }); // fully idle fleet, no reservations, no organic demand
    const plans = await runProvisioner();
    const byKey = Object.fromEntries(plans.map(p => [p.counterKey, p]));
    expect(byKey['runpod:flux-tts-s2t'].toMax).toBe(6);
    expect(byKey['runpod:qwen-image-gen'].toMax).toBe(2);
    expect(byKey['runpod:qwen-image-edit'].toMax).toBe(2);
    expect(byKey['runpod:wan2-i2v'].toMax).toBe(6);
    expect(byKey['runpod:bgm-s2t'].toMax).toBe(2);
    // Pooled sum is 18 of the account's 20-worker cap (re-confirmed via the
    // RunPod dashboard 2026-07-21 — wan2 corrected 8→6, a stale count from
    // 2026-07-07 that was never re-checked). The remaining 2 units are
    // deployed outside this pool entirely (long2shorts, a direct RunPod call
    // not routed through QM's catalog/provisioner — see fleet.ts's top
    // comment), not idle headroom in this pool.
    const pooled = ['runpod:flux-tts-s2t', 'runpod:qwen-image-gen', 'runpod:qwen-image-edit', 'runpod:wan2-i2v', 'runpod:bgm-s2t'];
    expect(pooled.reduce((a, ck) => a + byKey[ck].toMax, 0)).toBe(18);
    // STANDALONE_ENDPOINTS is empty since 2026-07-21 (ernie-image, its one
    // entry, was retired when image.explainer.t2i's primary rung moved to
    // qwen-image-gen — a pooled endpoint, already asserted above).
    expect(plans.some(p => p.counterKey === 'runpod:ernie-image')).toBe(false);
  });

  it('does not starve a reservation-only endpoint when heavy organic demand elsewhere exceeds the cap', async () => {
    // qwen-image-gen has heavy live traffic (40 inflight -> 10 workers wanted);
    // flux-tts-s2t has ZERO live traffic but a granted reservation for 4 workers.
    // Combined organic-only sizing (10 + 2 + 2 + 2 = 16) already exceeds the
    // default cap of 10 even before the reservation, so rebalancing must fire —
    // the assertion is that flux's reserved commitment still gets weighted
    // fairly instead of collapsing to 0 for lack of "real" queued/inflight jobs.
    mockScenario({
      inflight: { 'runpod:qwen-image-gen': 40 },
      activeReservations: [{
        pk: 'RESERVATION#qm_adm_y', sk: 'META', admissionId: 'qm_adm_y', requestId: 'r2',
        status: 'active', neededWorkers: { 'runpod:flux-tts-s2t': 4 },
        perEndpointJobs: { 'runpod:flux-tts-s2t': 82 }, drainEstMs: 0,
        createdAt: Date.now(), expiresAt: Date.now() + 600_000,
      }],
    });

    const plans = await runProvisioner();
    // ACCOUNT_CAP is only ever enforced over the pooled group — STANDALONE_ENDPOINTS
    // is empty since 2026-07-21 (see the idle-baseline test above), so every plan
    // here is already in the pooled group; no exclusion needed.
    const pooledTotal = plans.reduce((a, p) => a + p.toMax, 0);
    expect(pooledTotal).toBeLessThanOrEqual(20); // ACCOUNT_CAP respected

    const flux = plans.find(p => p.counterKey === 'runpod:flux-tts-s2t')!;
    const qwenGen = plans.find(p => p.counterKey === 'runpod:qwen-image-gen')!;
    expect(flux.toMax).toBeGreaterThan(0);          // not starved to zero
    expect(flux.toMin).toBe(1);                      // still pre-warmed
    expect(qwenGen.toMax).toBeGreaterThan(flux.toMax); // heavier organic demand still wins more share
  });
});

describe('prewarmEndpoints — immediate pre-warm on grant (WS-C3)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    smSendMock.mockReset();
    delete process.env.RUNPOD_PROVISION_LIVE;
    delete process.env.RUNPOD_API_KEY;
    delete process.env.RUNPOD_API_KEY_ARN;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetModules();
  });

  it('raises workersMin/workersMax for a cold endpoint in shadow mode, without calling fetch', async () => {
    mockScenario({});
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await prewarmEndpoints({ 'runpod:flux-tts-s2t': 4 });

    const putCalls = sendMock.mock.calls.filter(c => cmdName(c[0]) === 'PutItemCommand');
    const endpointWrite = putCalls
      .map(c => unmarshall((c[0] as any).input.Item))
      .find(item => item.pk === 'RUNPODENDPOINT' && item.sk === 'runpod:flux-tts-s2t');
    expect(endpointWrite?.workersMin).toBe(4); // all workers warmed on grant (fleet.ts cost model)
    expect(endpointWrite?.workersMax).toBe(4);
    expect(fetchMock).not.toHaveBeenCalled(); // LIVE unset -> shadow only
  });

  it('skips an endpoint already at or above the target — no redundant write', async () => {
    // Already warm at min 4 (all workers) and max 6 — a prewarm of 4 asks for
    // nothing higher, so no write.
    mockScenario({ endpointState: { 'runpod:flux-tts-s2t': { workersMin: 4, workersMax: 6 } } });

    await prewarmEndpoints({ 'runpod:flux-tts-s2t': 4 }); // min 4 <= 4, max 4 <= 6

    const putCalls = sendMock.mock.calls.filter(c => cmdName(c[0]) === 'PutItemCommand');
    expect(putCalls).toHaveLength(0);
  });

  it('PATCHes RunPod with the raised worker counts when RUNPOD_PROVISION_LIVE=true, hydrating the key from Secrets Manager', async () => {
    // LIVE and the SecretsManagerClient instance are captured at module import
    // time (same convention as ADMISSION_STUB elsewhere), so a fresh module
    // instance is required after setting the env vars.
    process.env.RUNPOD_PROVISION_LIVE = 'true';
    process.env.RUNPOD_API_KEY_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:runpod-key';
    smSendMock.mockResolvedValue({ SecretString: 'test-runpod-key' });
    mockScenario({});
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const live = require('../src/handlers/provisioner') as typeof import('../src/handlers/provisioner');
    await live.prewarmEndpoints({ 'runpod:wan2-i2v': 2 });

    expect(smSendMock).toHaveBeenCalledTimes(1); // key hydrated once (then cached)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('nd7wloyvj09xwy'); // wan2-i2v's endpointId
    expect(opts.method).toBe('PATCH');
    expect(opts.headers.Authorization).toBe('Bearer test-runpod-key');
    expect(JSON.parse(opts.body)).toEqual({ workersMin: 2, workersMax: 2 }); // all requested workers warmed
  });
});
