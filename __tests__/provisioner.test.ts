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
  leases?: Array<Record<string, unknown>>; // EndpointLeaseItem-shaped objects (pk='ENDPOINTLEASE')
}

function mockScenario(s: Scenario) {
  sendMock.mockImplementation(async (cmd) => {
    const name = cmdName(cmd);

    if (name === 'QueryCommand') {
      if (cmd.input.IndexName === 'queue-index') return { Items: [] }; // no queued jobs
      if (cmd.input.IndexName === 'reservation-status-index') {
        return { Items: (s.activeReservations ?? []).map(r => marshall(r as Record<string, unknown>)) };
      }
      // readEndpointLeases(): main-table Query on pk='ENDPOINTLEASE'
      if (!cmd.input.IndexName && cmd.input.KeyConditionExpression === 'pk = :pk') {
        const vals = unmarshall(cmd.input.ExpressionAttributeValues);
        if (vals[':pk'] === 'ENDPOINTLEASE') {
          return { Items: (s.leases ?? []).map(l => marshall(l)) };
        }
      }
      return { Items: [] };
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
    // flux alone wants max(reserved=4, its own baseline=8)=8 — the baseline
    // already covers this reservation, and with every endpoint's real
    // per-endpoint baseline (flux=8, qwen-gen=6, qwen-edit=4, wan2=10) the
    // four IDLE sums to only 8+6+4+10=28 <= ACCOUNT_CAP(40), so
    // rebalanceUnderCap never fires.
    expect(flux.toMax).toBe(8);

    // Untouched endpoints stay at the idle baseline (unaffected by the reservation).
    const wan2 = plans.find(p => p.counterKey === 'runpod:wan2-i2v')!;
    expect(wan2.demand.reserved).toBe(0);
    expect(wan2.reason).toBe('scale-to-zero');
  });

  it('idles to each endpoint\'s real per-endpoint baseline, not a uniform default (2026-08-11 account-confirmed values)', async () => {
    mockScenario({ inflight: {} }); // fully idle fleet, no reservations, no organic demand
    const plans = await runProvisioner();
    const byKey = Object.fromEntries(plans.map(p => [p.counterKey, p]));
    expect(byKey['runpod:flux-tts-s2t'].toMax).toBe(8);
    expect(byKey['runpod:qwen-image-gen'].toMax).toBe(6);
    expect(byKey['runpod:qwen-image-edit'].toMax).toBe(4);
    expect(byKey['runpod:wan2-i2v'].toMax).toBe(10);
    expect(byKey['runpod:bgm-s2t'].toMax).toBe(4);
    // Pooled sum is 32 of the account's 40-worker cap (re-confirmed via the
    // RunPod dashboard 2026-08-11 — "39/40 Workers deployed"). The remaining
    // 7 units are deployed outside this pool entirely (long2shorts=4, a direct
    // RunPod call not routed through QM's catalog/provisioner — see
    // fleet.ts's top comment; LTX-DUB=1 and multitalk=2, neither routed
    // through QM either), not idle headroom in this pool.
    const pooled = ['runpod:flux-tts-s2t', 'runpod:qwen-image-gen', 'runpod:qwen-image-edit', 'runpod:wan2-i2v', 'runpod:bgm-s2t'];
    expect(pooled.reduce((a, ck) => a + byKey[ck].toMax, 0)).toBe(32);
    // STANDALONE_ENDPOINTS is empty since 2026-07-21 (ernie-image, its one
    // entry, was retired when image.explainer.t2i's primary rung moved to
    // qwen-image-gen — a pooled endpoint, already asserted above).
    expect(plans.some(p => p.counterKey === 'runpod:ernie-image')).toBe(false);
  });

  it('does not starve a reservation-only endpoint when heavy organic demand elsewhere exceeds the cap', async () => {
    // qwen-image-gen has heavy live traffic (200 inflight -> 50 workers wanted,
    // dwarfing its own baseline and everyone else's baselineMax); flux-tts-s2t
    // has ZERO live traffic but a granted reservation for 4 workers. Pooled
    // baseline-only sizing (12+3+4+12+4=35) is already close to ACCOUNT_CAP(40),
    // and qwen-image-gen's organic pull alone (50) pushes the pooled total well
    // past it, so rebalancing must fire — the assertion is that flux's reserved
    // commitment still gets weighted fairly instead of collapsing to 0 for lack
    // of "real" queued/inflight jobs, while qwen-image-gen's much larger organic
    // demand still wins the bigger share.
    mockScenario({
      inflight: { 'runpod:qwen-image-gen': 200 },
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
    expect(pooledTotal).toBeLessThanOrEqual(40); // ACCOUNT_CAP respected

    const flux = plans.find(p => p.counterKey === 'runpod:flux-tts-s2t')!;
    const qwenGen = plans.find(p => p.counterKey === 'runpod:qwen-image-gen')!;
    expect(flux.toMax).toBeGreaterThan(0);          // not starved to zero
    expect(flux.toMin).toBe(1);                      // still pre-warmed
    expect(qwenGen.toMax).toBeGreaterThan(flux.toMax); // heavier organic demand still wins more share
  });
});

describe('runProvisioner — background orchestrator endpoint leases (impl plan §5.3)', () => {
  const lease = (counterKey: string, workers: number, expiresAt: number) => ({
    pk: 'ENDPOINTLEASE', sk: counterKey, holder: 'orchestrator',
    cohortId: 'win_2026_09_01_18', stepSeq: 3, workers, expiresAt, updatedAt: Date.now(),
  });

  it('skips a live-leased endpoint entirely — no plan, no PATCH, no cap-count', async () => {
    // Heavy organic demand on wan2-i2v that would normally pull it to 25 — but
    // the background orchestrator holds it, so the provisioner must not touch it.
    mockScenario({
      inflight: { 'runpod:wan2-i2v': 200 },
      leases: [lease('runpod:wan2-i2v', 25, Date.now() + 30 * 60_000)],
    });

    const plans = await runProvisioner();

    expect(plans.some(p => p.counterKey === 'runpod:wan2-i2v')).toBe(false);
    // the rest of the pool is still planned normally
    expect(plans.some(p => p.counterKey === 'runpod:flux-tts-s2t')).toBe(true);
    // nothing was written or PATCHed for the leased endpoint
    const wroteWan2 = sendMock.mock.calls
      .filter(c => (c[0] as any).constructor.name === 'PutItemCommand')
      .some(c => {
        const item = unmarshall((c[0] as any).input.Item);
        return item.sk === 'runpod:wan2-i2v' || item.counterKey === 'runpod:wan2-i2v';
      });
    expect(wroteWan2).toBe(false);
  });

  it('ignores an expired lease — the endpoint is sized from demand as usual', async () => {
    mockScenario({ inflight: {}, leases: [lease('runpod:wan2-i2v', 25, Date.now() - 60_000)] });

    const plans = await runProvisioner();

    const wan2 = plans.find(p => p.counterKey === 'runpod:wan2-i2v');
    expect(wan2).toBeDefined();
    expect(wan2!.toMax).toBe(10); // its normal idle baseline, untouched by the stale lease
  });

  it('rebalances the live path under a cap reduced by the leased workers', async () => {
    // wan2-i2v leased at 25 → the four remaining pooled endpoints must fit in
    // 40 − 25 = 15. Heavy organic demand on all four so rebalanceUnderCap fires.
    mockScenario({
      inflight: {
        'runpod:flux-tts-s2t': 200, 'runpod:qwen-image-gen': 200,
        'runpod:qwen-image-edit': 200, 'runpod:bgm-s2t': 200,
      },
      leases: [lease('runpod:wan2-i2v', 25, Date.now() + 30 * 60_000)],
    });

    const plans = await runProvisioner();

    expect(plans.some(p => p.counterKey === 'runpod:wan2-i2v')).toBe(false);
    const pooledTotal = plans.reduce((a, p) => a + p.toMax, 0);
    expect(pooledTotal).toBeLessThanOrEqual(15); // ACCOUNT_CAP(40) − leased(25)
    expect(pooledTotal).toBeGreaterThan(0);
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
