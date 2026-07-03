import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { CatalogResolver } from '../catalog/resolver';
import { getInflight } from '../gate/dynamo-gate';
import { isInternalRung } from './router';
import type { JobItem, ProvisionShadowItem, Queue, RunPodEndpointItem } from '../types';

const TABLE = process.env.TABLE_NAME ?? 'quartermaster-jobs';
// Shared account-wide worker cap (10; rises to 20 once balance ≥ $200).
const ACCOUNT_CAP = Number(process.env.RUNPOD_ACCOUNT_CAP ?? 10);
const BASELINE_MAX = Number(process.env.RUNPOD_BASELINE_MAX ?? 2);
const JOBS_PER_WORKER = Number(process.env.RUNPOD_JOBS_PER_WORKER ?? 4);
const COOLDOWN_MS = Number(process.env.RUNPOD_SCALEDOWN_COOLDOWN_MS ?? 300_000);
// Shadow mode: log/audit the decision but never PATCH RunPod. Flip to false
// (RUNPOD_PROVISION_LIVE=true) once the shadow log is trusted.
const LIVE = process.env.RUNPOD_PROVISION_LIVE === 'true';

const db = new DynamoDBClient({});

// The RunPod serverless endpoints QM provisions. counterKey mirrors the
// per-endpoint semaphore in dynamo-gate; endpointId is the RunPod id from
// /home/roman-antony/runpod/API.md.
export const ENDPOINTS: Array<{ counterKey: string; endpointId: string }> = [
  { counterKey: 'runpod:flux-tts-s2t',   endpointId: 'rnqxi6c0mlq517' },
  { counterKey: 'runpod:qwen-image-gen', endpointId: 'e165se4r3eo5hp' },
  { counterKey: 'runpod:qwen-image-edit', endpointId: 'oxwx8o879qwtla' },
  { counterKey: 'runpod:wan2-i2v',       endpointId: 'nd7wloyvj09xwy' },
];

interface Demand { inflight: number; queued: number; }
interface Plan {
  counterKey: string;
  endpointId: string;
  demand: Demand;
  fromMin: number; fromMax: number;
  toMin: number; toMax: number;
  reason: string;
}

/**
 * One provisioning tick (called by the sweeper). Reads per-endpoint demand,
 * computes desired worker counts under the shared account cap, and — in shadow
 * mode — records the scale decision it *would* make without touching RunPod.
 */
export async function runProvisioner(): Promise<Plan[]> {
  const queued = await gatherQueuedByEndpoint();
  const now = Date.now();

  // 1. Raw demand + a first-pass desired workersMax per endpoint.
  const plans: Plan[] = [];
  for (const ep of ENDPOINTS) {
    const inflight = await getInflight(ep.counterKey);
    const demand: Demand = { inflight, queued: queued[ep.counterKey] ?? 0 };
    const state = await readEndpoint(ep.counterKey, ep.endpointId);
    const total = demand.inflight + demand.queued;

    let toMax = BASELINE_MAX;
    let toMin = 0;
    let reason = 'idle';
    if (total > 0) {
      toMax = Math.max(1, Math.ceil(total / JOBS_PER_WORKER));
      toMin = 1;                       // pre-warm: keep at least one worker up while there's work
      reason = state.workersMax === 0 || state.workersMin === 0 ? 'prewarm' : 'scale-up';
    } else {
      // Demand is zero — only scale to zero once the cooldown has elapsed.
      const busyRecently = state.lastBusyAt && now - state.lastBusyAt < COOLDOWN_MS;
      if (busyRecently) {
        toMax = Math.max(state.workersMax, BASELINE_MAX);
        toMin = state.workersMin;      // hold warm through the cooldown
        reason = 'cooldown';
      } else {
        toMax = BASELINE_MAX; toMin = 0; reason = 'scale-to-zero';
      }
    }

    plans.push({
      counterKey: ep.counterKey, endpointId: ep.endpointId, demand,
      fromMin: state.workersMin, fromMax: state.workersMax, toMin, toMax, reason,
    });
  }

  // 2. Rebalance to respect the shared account cap (sum of workersMax ≤ cap),
  //    proportional to each endpoint's demand share.
  rebalanceUnderCap(plans);

  // 3. Persist intended state + record the shadow decision. (Live mode would
  //    additionally PATCH rest.runpod.io here.)
  for (const p of plans) {
    const busy = p.demand.inflight + p.demand.queued > 0;
    await writeEndpoint(p, busy ? now : undefined);
    if (p.toMin !== p.fromMin || p.toMax !== p.fromMax) {
      await writeShadow(p, now);
      if (LIVE) await patchRunPod(p);
      console.info('[provisioner]', LIVE ? 'PATCH' : 'SHADOW', p.counterKey,
        `max ${p.fromMax}→${p.toMax} min ${p.fromMin}→${p.toMin}`,
        `(inflight=${p.demand.inflight} queued=${p.demand.queued}) ${p.reason}`);
    }
  }

  return plans;
}

/** Clamp total workersMax across endpoints to ACCOUNT_CAP, demand-weighted. */
function rebalanceUnderCap(plans: Plan[]): void {
  const sum = plans.reduce((a, p) => a + p.toMax, 0);
  if (sum <= ACCOUNT_CAP) return;

  const totalDemand = plans.reduce((a, p) => a + p.demand.inflight + p.demand.queued, 0);
  let allocated = 0;
  for (const p of plans) {
    const d = p.demand.inflight + p.demand.queued;
    // At least 1 for any endpoint with demand; otherwise proportional share.
    const share = totalDemand > 0
      ? Math.max(d > 0 ? 1 : 0, Math.floor((d / totalDemand) * ACCOUNT_CAP))
      : Math.floor(ACCOUNT_CAP / plans.length);
    p.toMax = Math.min(p.toMax, Math.max(share, d > 0 ? 1 : 0));
    allocated += p.toMax;
    if (p.toMax < p.toMin) p.toMin = p.toMax; // keep min ≤ max
  }
  // Hand any leftover headroom to the hungriest endpoint.
  let leftover = ACCOUNT_CAP - allocated;
  if (leftover > 0) {
    const sorted = [...plans].sort(
      (a, b) => (b.demand.inflight + b.demand.queued) - (a.demand.inflight + a.demand.queued));
    for (const p of sorted) {
      if (leftover <= 0) break;
      p.toMax += 1; leftover -= 1;
    }
  }
}

// ─── Demand gathering ─────────────────────────────────────────────────────────

/**
 * Count QUEUED jobs per RunPod endpoint by resolving each job's internal rung.
 * Exported for the admission gate's queue-depth/drain estimate (§D2).
 */
export async function gatherQueuedByEndpoint(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const lane of ['rest', 'video']) {
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await db.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'queue-index',
        KeyConditionExpression: '#lane = :lane',
        FilterExpression: '#status = :q',
        ExpressionAttributeNames: { '#lane': 'lane', '#status': 'status' },
        ExpressionAttributeValues: marshall({ ':lane': lane, ':q': 'QUEUED' }),
        ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
      }));
      for (const raw of res.Items ?? []) {
        const job = unmarshall(raw) as JobItem;
        const ck = jobCounterKey(job);
        if (ck) counts[ck] = (counts[ck] ?? 0) + 1;
      }
      lastKey = res.LastEvaluatedKey ? unmarshall(res.LastEvaluatedKey) : undefined;
    } while (lastKey);
  }
  return counts;
}

function jobCounterKey(job: JobItem): string | undefined {
  if (!job.assetType) return undefined;
  const resolver = CatalogResolver.forQueue((job.queue ?? 'background') as Queue);
  const ladder = resolver.getLadder(job.assetType, job.tier, job.operation);
  return ladder.find(isInternalRung)?.counterKey;
}

// ─── Endpoint state + shadow audit ───────────────────────────────────────────

/**
 * Read the currently-provisioned workersMax for one endpoint (0 if unseen).
 * Exported for the admission gate's fleet-cap check (§D2) — organic demand-driven
 * provisioning already reflected here is the floor the gate must respect.
 */
export async function getEndpointWorkersMax(counterKey: string): Promise<number> {
  const r = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: 'RUNPODENDPOINT', sk: counterKey }),
    ProjectionExpression: 'workersMax',
  }));
  if (!r.Item) return 0;
  const { workersMax } = unmarshall(r.Item) as { workersMax?: number };
  return workersMax ?? 0;
}

async function readEndpoint(counterKey: string, endpointId: string): Promise<RunPodEndpointItem> {
  const r = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: 'RUNPODENDPOINT', sk: counterKey }),
  }));
  if (r.Item) return unmarshall(r.Item) as RunPodEndpointItem;
  return { pk: 'RUNPODENDPOINT', sk: counterKey, endpointId, workersMin: 0, workersMax: 0, updatedAt: 0 };
}

async function writeEndpoint(p: Plan, busyAt?: number): Promise<void> {
  const prev = await readEndpoint(p.counterKey, p.endpointId);
  const item: RunPodEndpointItem = {
    pk: 'RUNPODENDPOINT', sk: p.counterKey, endpointId: p.endpointId,
    workersMin: p.toMin, workersMax: p.toMax,
    lastBusyAt: busyAt ?? prev.lastBusyAt,
    updatedAt: Date.now(),
  };
  await db.send(new PutItemCommand({ TableName: TABLE, Item: marshall(item, { removeUndefinedValues: true }) }));
}

async function writeShadow(p: Plan, now: number): Promise<void> {
  const item: ProvisionShadowItem = {
    pk: 'PROVISION_SHADOW', sk: `${now}#${p.counterKey}`,
    counterKey: p.counterKey, endpointId: p.endpointId, reason: p.reason,
    fromWorkersMax: p.fromMax, toWorkersMax: p.toMax,
    fromWorkersMin: p.fromMin, toWorkersMin: p.toMin,
    queued: p.demand.queued, inflight: p.demand.inflight, timestamp: now,
  };
  await db.send(new PutItemCommand({ TableName: TABLE, Item: marshall(item) }));
}

/** Live-mode RunPod management PATCH. Only called when RUNPOD_PROVISION_LIVE=true. */
async function patchRunPod(p: Plan): Promise<void> {
  const key = process.env.RUNPOD_API_KEY;
  if (!key) { console.warn('[provisioner] RUNPOD_API_KEY unset — cannot PATCH'); return; }
  await fetch(`https://rest.runpod.io/v1/endpoints/${p.endpointId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workersMin: p.toMin, workersMax: p.toMax }),
  }).catch(e => console.error('[provisioner] PATCH failed', p.endpointId, e));
}
