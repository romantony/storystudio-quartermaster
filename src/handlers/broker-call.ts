import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});
let cachedKey: string | undefined;

async function getKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.GATEWAY_STATIC_KEY_ARN! }));
  cachedKey = r.SecretString!;
  return cachedKey;
}

interface BrokerEvent {
  action: 'acquire' | 'release' | 'heartbeat';
  lane?: 'video' | 'rest' | 'none';
  leaseId?: string;
  tenant?: string;
  priority?: 'P0' | 'P1' | 'P2';
  estDurationMs?: number;
  outcome?: 'success' | 'fail';
}

export const handler = async (event: BrokerEvent): Promise<Record<string, unknown>> => {
  const key = await getKey();
  const base = process.env.QM_BASE_URL!;
  const headers = { 'Content-Type': 'application/json', 'x-gateway-key': key };

  if (event.action === 'acquire') {
    // Poll until a slot is granted or Lambda nears timeout (~115 s budget).
    const deadline = Date.now() + 110_000;
    let attempt = 0;
    while (Date.now() < deadline) {
      const r = await fetch(`${base}/acquire`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          lane: event.lane ?? 'rest',
          tenant: event.tenant ?? 'sfn:unknown',
          priority: event.priority ?? 'P1',
          estDurationMs: event.estDurationMs ?? 60_000,
        }),
      });
      const data = (await r.json()) as { granted: boolean; leaseId?: string };
      if (data.granted) return data as Record<string, unknown>;
      const delay = Math.min(2_000 * Math.pow(1.3, attempt), 8_000);
      await new Promise(res => setTimeout(res, delay));
      attempt++;
    }
    throw new Error('acquire: timed out waiting for an available slot');
  }

  if (event.action === 'release') {
    const r = await fetch(`${base}/release`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        lane: event.lane ?? 'rest',
        leaseId: event.leaseId!,
        outcome: event.outcome ?? 'success',
      }),
    });
    return r.json() as Promise<Record<string, unknown>>;
  }

  if (event.action === 'heartbeat') {
    const r = await fetch(`${base}/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ leaseId: event.leaseId!, lane: event.lane ?? 'rest' }),
    });
    return r.json() as Promise<Record<string, unknown>>;
  }

  throw new Error(`Unknown action: ${event.action}`);
};
