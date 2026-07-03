import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const sendMock = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return { ...actual, DynamoDBClient: jest.fn(() => ({ send: sendMock })) };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { runProvisioner } from '../src/handlers/provisioner';

const cmdName = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;
const keyOf = (c: any) => (c.input?.Key ? unmarshall(c.input.Key) : undefined);

interface Scenario {
  inflight?: Record<string, number>;       // counterKey -> inflight
  activeReservations?: unknown[];          // plain ReservationItem-shaped objects
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
        return {}; // no prior state — readEndpoint defaults to workersMin:0, workersMax:0
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
    expect(flux.toMax).toBe(4);
    expect(flux.toMin).toBe(1); // pre-warm, not scaled to zero
    expect(flux.reason).toBe('reservation-prewarm');

    // Untouched endpoints stay at the idle baseline (unaffected by the reservation).
    const wan2 = plans.find(p => p.counterKey === 'runpod:wan2-i2v')!;
    expect(wan2.demand.reserved).toBe(0);
    expect(wan2.reason).toBe('scale-to-zero');
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
    const total = plans.reduce((a, p) => a + p.toMax, 0);
    expect(total).toBeLessThanOrEqual(10); // ACCOUNT_CAP respected

    const flux = plans.find(p => p.counterKey === 'runpod:flux-tts-s2t')!;
    const qwenGen = plans.find(p => p.counterKey === 'runpod:qwen-image-gen')!;
    expect(flux.toMax).toBeGreaterThan(0);          // not starved to zero
    expect(flux.toMin).toBe(1);                      // still pre-warmed
    expect(qwenGen.toMax).toBeGreaterThan(flux.toMax); // heavier organic demand still wins more share
  });
});
