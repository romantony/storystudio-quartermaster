import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { CatalogResolver } from '../catalog/resolver';
import { getInflight } from '../gate/dynamo-gate';
import { getReservedWorkersByEndpoint } from '../gate/reservation-gate';
import { isInternalRung } from './router';
import type { JobItem, ProvisionShadowItem, Queue, RunPodEndpointItem } from '../types';

const TABLE = process.env.TABLE_NAME ?? 'quartermaster-jobs';
// Shared account-wide worker cap. Raised 10→20 (2026-07-07): balance crossed
// $200, confirmed against the RunPod dashboard (20/20 workers deployed).
const ACCOUNT_CAP = Number(process.env.RUNPOD_ACCOUNT_CAP ?? 20);
// Fallback idle floor for any endpoint that doesn't specify its own
// `baselineMax` below. Endpoints listed in ENDPOINTS should each set a real
// value confirmed against the account (never guess — see per-endpoint note).
const DEFAULT_BASELINE_MAX = Number(process.env.RUNPOD_BASELINE_MAX ?? 2);
const JOBS_PER_WORKER = Number(process.env.RUNPOD_JOBS_PER_WORKER ?? 4);
const COOLDOWN_MS = Number(process.env.RUNPOD_SCALEDOWN_COOLDOWN_MS ?? 300_000);
// Shadow mode: log/audit the decision but never PATCH RunPod. Flip to false
// (RUNPOD_PROVISION_LIVE=true) once the shadow log is trusted.
const LIVE = process.env.RUNPOD_PROVISION_LIVE === 'true';

const db = new DynamoDBClient({});
const sm = new SecretsManagerClient({});

// The RunPod serverless endpoints QM provisions. counterKey mirrors the
// per-endpoint semaphore in dynamo-gate; endpointId is the RunPod id from
// /home/roman-antony/runpod/API.md. `baselineMax` is each endpoint's real,
// account-confirmed idle floor — NOT a uniform guess. Using one global
// constant here previously caused the provisioner's shadow model to silently
// diverge from RunPod's actual config, which the periodic scale-to-zero tick
// would have kept re-asserting forever. Raised 2026-07-07 (account balance
// crossed $200, cap doubled 10→20) to match the dashboard: Flux-TTS-ANIM=6,
// qwen-image-edit=2, Wan2-14b-fp8-RTX6000ADA=8 — see fleet.ts for the same
// figures plus bgm-s2t/ernie-image (not in this provisioner-cap-enforcing
// list, see fleet.ts's header for why).
export const ENDPOINTS: Array<{ counterKey: string; endpointId: string; baselineMax: number }> = [
  { counterKey: 'runpod:flux-tts-s2t',    endpointId: 'rnqxi6c0mlq517', baselineMax: 6 },
  { counterKey: 'runpod:qwen-image-gen',  endpointId: 'e165se4r3eo5hp', baselineMax: 2 },
  { counterKey: 'runpod:qwen-image-edit', endpointId: 'oxwx8o879qwtla', baselineMax: 2 },
  { counterKey: 'runpod:wan2-i2v',        endpointId: 'nd7wloyvj09xwy', baselineMax: 8 },
];

// `reserved` = worker-units committed by active admission-gate reservations for
// this endpoint (§WS-C2) — a project the gatekeeper has granted but that hasn't
// submitted any real jobs yet still needs its pool held warm.
interface Demand { inflight: number; queued: number; reserved: number; }
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
  const [queued, reservedWorkers] = await Promise.all([
    gatherQueuedByEndpoint(),
    getReservedWorkersByEndpoint(),
  ]);
  const now = Date.now();

  // 1. Raw demand + a first-pass desired workersMax per endpoint.
  const plans: Plan[] = [];
  for (const ep of ENDPOINTS) {
    const inflight = await getInflight(ep.counterKey);
    const reserved = reservedWorkers[ep.counterKey] ?? 0;
    const demand: Demand = { inflight, queued: queued[ep.counterKey] ?? 0, reserved };
    const state = await readEndpoint(ep.counterKey, ep.endpointId);
    const total = demand.inflight + demand.queued;

    // Combine organic (live job) sizing with the admission gate's reservation
    // commitment via max, not sum — a reservation's promised workers and the
    // jobs it eventually submits describe the SAME demand, so summing them
    // would double-count once its SFN starts running. Whichever signal is
    // larger — real traffic or a still-unrealized reservation — wins.
    const organicWorkers = total > 0 ? Math.max(1, Math.ceil(total / JOBS_PER_WORKER)) : 0;
    const effectiveWorkers = Math.max(organicWorkers, reserved);
    const baselineMax = ep.baselineMax ?? DEFAULT_BASELINE_MAX;

    let toMax = baselineMax;
    let toMin = 0;
    let reason = 'idle';
    if (effectiveWorkers > 0) {
      toMax = Math.max(effectiveWorkers, baselineMax);
      toMin = 1;                       // pre-warm: keep at least one worker up while there's work
      reason = reserved > organicWorkers
        ? (state.workersMax === 0 ? 'reservation-prewarm' : 'reservation-hold')
        : (state.workersMax === 0 || state.workersMin === 0 ? 'prewarm' : 'scale-up');
    } else {
      // No organic demand AND no active reservation — only scale to zero once
      // the cooldown has elapsed.
      const busyRecently = state.lastBusyAt && now - state.lastBusyAt < COOLDOWN_MS;
      if (busyRecently) {
        toMax = Math.max(state.workersMax, baselineMax);
        toMin = state.workersMin;      // hold warm through the cooldown
        reason = 'cooldown';
      } else {
        toMax = baselineMax; toMin = 0; reason = 'scale-to-zero';
      }
    }

    plans.push({
      counterKey: ep.counterKey, endpointId: ep.endpointId, demand,
      fromMin: state.workersMin, fromMax: state.workersMax, toMin, toMax, reason,
    });
  }

  // 2. Rebalance to respect the shared account cap (sum of workersMax ≤ cap),
  //    proportional to each endpoint's demand share (organic + reserved).
  rebalanceUnderCap(plans);

  // 3. Persist intended state + record the shadow decision. (Live mode would
  //    additionally PATCH rest.runpod.io here.)
  for (const p of plans) {
    const busy = p.demand.inflight + p.demand.queued + p.demand.reserved > 0;
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

/**
 * Immediately raise capacity for a just-granted reservation's touched endpoints
 * (§WS-C3), rather than waiting for the next 2-min sweeper tick — RunPod's cold
 * start (2.5–4 min, see runpod/API.md) should overlap Convex's brain window, not
 * start after it. Monotonic: only raises workersMin/workersMax for the given
 * endpoints, never lowers anything, and never touches endpoints outside
 * `neededWorkers`. Skips endpoints already at or above the target (no redundant
 * PATCH when multiple reservations land on an already-warm pool).
 *
 * Deliberately does NOT re-run the account-cap rebalance across all endpoints —
 * admission.ts's decide() already validated the fleet-wide cap before granting.
 * The next full sweeper tick (§WS-C2's reservation-aware demand) reconciles any
 * transient over-commitment from concurrent grants, the same eventually-
 * consistent convergence the rest of this module already relies on.
 */
export async function prewarmEndpoints(neededWorkers: Record<string, number>): Promise<void> {
  const now = Date.now();
  for (const [counterKey, workers] of Object.entries(neededWorkers)) {
    const ep = ENDPOINTS.find(e => e.counterKey === counterKey);
    if (!ep || workers <= 0) continue;

    const state = await readEndpoint(counterKey, ep.endpointId);
    // Warm ALL the endpoint's workers on grant (not just 1) — the project's Map
    // wave hits every worker at once, so a single warm worker + N cold ones would
    // still pay N cold starts as jobs land. Scale-to-zero when the pipeline empties
    // is what keeps this from wasting GPU (fleet.ts cost principle).
    const toMin = Math.max(state.workersMin, workers);
    const toMax = Math.max(state.workersMax, workers);
    if (toMin === state.workersMin && toMax === state.workersMax) continue; // already sufficient

    const plan: Plan = {
      counterKey, endpointId: ep.endpointId,
      demand: { inflight: 0, queued: 0, reserved: workers },
      fromMin: state.workersMin, fromMax: state.workersMax,
      toMin, toMax, reason: 'reservation-prewarm-immediate',
    };
    await writeEndpoint(plan, now);
    await writeShadow(plan, now);
    if (LIVE) await patchRunPod(plan);
    console.info('[provisioner]', LIVE ? 'PATCH' : 'SHADOW', counterKey,
      `max ${plan.fromMax}→${plan.toMax} min ${plan.fromMin}→${plan.toMin}`,
      `(immediate pre-warm on grant, reserved=${workers})`);
  }
}

/**
 * Weight for proportional cap allocation, in job-count units. `reserved` is
 * worker-units, so it's converted through JOBS_PER_WORKER to stay comparable
 * with inflight+queued — otherwise a reservation-only endpoint (organic demand
 * still zero) would weigh ~1-10 against others' tens of queued jobs and get
 * starved down by rebalancing, defeating the pre-warm it's owed.
 */
function demandWeight(p: Plan): number {
  return p.demand.inflight + p.demand.queued + p.demand.reserved * JOBS_PER_WORKER;
}

/** Clamp total workersMax across endpoints to ACCOUNT_CAP, demand-weighted. */
function rebalanceUnderCap(plans: Plan[]): void {
  const sum = plans.reduce((a, p) => a + p.toMax, 0);
  if (sum <= ACCOUNT_CAP) return;

  const totalDemand = plans.reduce((a, p) => a + demandWeight(p), 0);
  let allocated = 0;
  for (const p of plans) {
    const d = demandWeight(p);
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
    const sorted = [...plans].sort((a, b) => demandWeight(b) - demandWeight(a));
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
  return (await gatherQueuedDetailed()).byEndpoint;
}

/**
 * Scan QUEUED canonical jobs once, bucketing by resolved internal endpoint AND
 * by `${endpoint}#${operation}`. The admission gate needs per-operation depth
 * (basic watches merge-only backlog on flux) as well as per-endpoint depth
 * (premium watches all of wan2). One scan feeds both.
 */
export async function gatherQueuedDetailed(): Promise<{
  byEndpoint: Record<string, number>;
  byEndpointOp: Record<string, number>;
}> {
  const byEndpoint: Record<string, number> = {};
  const byEndpointOp: Record<string, number> = {};
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
        if (!ck) continue;
        byEndpoint[ck] = (byEndpoint[ck] ?? 0) + 1;
        if (job.operation) {
          const opKey = `${ck}#${job.operation}`;
          byEndpointOp[opKey] = (byEndpointOp[opKey] ?? 0) + 1;
        }
      }
      lastKey = res.LastEvaluatedKey ? unmarshall(res.LastEvaluatedKey) : undefined;
    } while (lastKey);
  }
  return { byEndpoint, byEndpointOp };
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
    queued: p.demand.queued, inflight: p.demand.inflight, reserved: p.demand.reserved, timestamp: now,
  };
  await db.send(new PutItemCommand({ TableName: TABLE, Item: marshall(item) }));
}

let cachedRunpodKey: string | undefined;

/**
 * Resolve the RunPod API key. `executor.ts` hydrates RUNPOD_API_KEY from
 * RUNPOD_API_KEY_ARN into its own process env, but the API Lambda (where the
 * sweeper — and thus this function — runs) never does; only the ARN is set
 * there. Without this, `RUNPOD_PROVISION_LIVE=true` would silently no-op every
 * PATCH. IAM grant for the secret already exists on the API Lambda's role
 * (infra/lib/api-stack.ts) since it's shared with the other provider secrets.
 */
async function getRunpodKey(): Promise<string | undefined> {
  if (cachedRunpodKey) return cachedRunpodKey;
  if (process.env.RUNPOD_API_KEY) return (cachedRunpodKey = process.env.RUNPOD_API_KEY);
  const arn = process.env.RUNPOD_API_KEY_ARN;
  if (!arn) return undefined;
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
    cachedRunpodKey = res.SecretString;
    return cachedRunpodKey;
  } catch (e) {
    console.error('[provisioner] failed to hydrate RUNPOD_API_KEY', e);
    return undefined;
  }
}

/** Live-mode RunPod management PATCH. Only called when RUNPOD_PROVISION_LIVE=true. */
async function patchRunPod(p: Plan): Promise<void> {
  const key = await getRunpodKey();
  if (!key) { console.warn('[provisioner] RUNPOD_API_KEY unavailable — cannot PATCH'); return; }
  await fetch(`https://rest.runpod.io/v1/endpoints/${p.endpointId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workersMin: p.toMin, workersMax: p.toMax }),
  }).catch(e => console.error('[provisioner] PATCH failed', p.endpointId, e));
}
