import { randomUUID } from 'crypto';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { getInflight } from '../gate/dynamo-gate';
import {
  getReservationByRequestId, listActiveReservations, releaseReservation, saveReservation,
} from '../gate/reservation-gate';
import { projectAssetLoad } from '../shared/assetLoad';
import type { AssetLoad } from '../shared/assetLoad';
import { ENDPOINTS, gatherQueuedByEndpoint, getEndpointWorkersMax } from './provisioner';
import type { BaselineItem, LambdaFunctionUrlEvent, LambdaFunctionUrlResponse, ReservationItem } from '../types';

/**
 * Quartermaster as Gatekeeper — project admission (§D2 of
 * docs/qm-admission-gate-implementation-plan.md).
 *
 * MCP/batch only; no strict TAT (see docs/storystudio-qm-admission-gate.md §1.1) —
 * the whole point is reliability over latency, so this module is deliberately
 * biased toward **defer-and-wait**: it grants only when the fleet can absorb the
 * project's projected load without pushing any touched endpoint's estimated drain
 * past a fleet-protection ceiling, and otherwise returns an honest ETA rather than
 * admitting into an overloaded queue.
 *
 * Reservation persistence lives in ../gate/reservation-gate.ts (shared with the
 * capacity manager — see provisioner.ts's reservation-aware demand, §WS-C2).
 * Live worker provisioning on grant (pre-warm actuation) is a separate step
 * (WS-C3, not yet wired here) — this module only decides + reserves;
 * `warmedEndpoints` in the response names the endpoints a future pre-warm call
 * should target.
 */

const TABLE = process.env.TABLE_NAME ?? 'quartermaster-jobs';
const db = new DynamoDBClient({});

const ACCOUNT_CAP = Number(process.env.RUNPOD_ACCOUNT_CAP ?? 10);
const JOBS_PER_WORKER = Number(process.env.RUNPOD_JOBS_PER_WORKER ?? 4);
// Per-frame Map concurrency in the QM-new / Basic-QM SFNs (pipeline-stack.ts
// GenerateImages / qmFrameAssetsMap both use MaxConcurrency:15). Worker sizing
// must be driven by this — the project's *peak concurrent* load on an endpoint —
// not its lifetime total job count, which a single worker serves over time.
const SFN_MAP_MAX_CONCURRENCY = Number(process.env.ADMISSION_MAP_CONCURRENCY ?? 15);
// Fleet-protection ceiling (not a deadline — see module comment). Defer above this.
const MAX_DRAIN_MS = Number(process.env.ADMISSION_MAX_DRAIN_MS ?? 30 * 60_000);
const BRAIN_WINDOW_MS = Number(process.env.ADMISSION_BRAIN_WINDOW_MS ?? 3 * 60_000);
const RESERVATION_BUFFER_MS = Number(process.env.ADMISSION_RESERVATION_BUFFER_MS ?? 5 * 60_000);
const ESTIMATED_READY_MS = Number(process.env.ADMISSION_ESTIMATED_READY_MS ?? 210_000);
const RETRY_MIN_S = Number(process.env.ADMISSION_RETRY_MIN_SECONDS ?? 60);
const RETRY_MAX_S = Number(process.env.ADMISSION_RETRY_MAX_SECONDS ?? 600);
// 'granted' → always grant (wire-shape integration mode; no real capacity math).
const STUB = process.env.ADMISSION_STUB;

/**
 * Cold-start baseline seeds — sourced from real measured warm-inference figures
 * in /home/roman-antony/runpod/API.md, used only until BASELINE# rows accumulate
 * from live traffic (getBaselineMs prefers real samples once they exist).
 */
const SEED_MS: Record<string, number> = {
  // Blend of image~1s, tts~16s, animate~3s, merge~2s, caption~8s, mix_bgm~45s
  // (API.md "pipeline" mode step timings) — flux-tts-s2t serves all of these.
  'runpod:flux-tts-s2t': 12_500,
  'runpod:qwen-image-gen': 8_000,   // documented warm inference (t2i)
  'runpod:qwen-image-edit': 15_000, // documented warm inference (i2i)
  'runpod:wan2-i2v': 92_000,        // documented 87-97s for an 81-frame (5s) clip
};
const DEFAULT_SEED_MS = 15_000;

interface AdmissionRequest {
  requestId: string;
  projectType: string;
  tier: string;
  durationSeconds: number;
  userId?: string;
}

type Decision =
  | { kind: 'granted'; neededWorkers: Record<string, number>; drainEstMs: number }
  | { kind: 'deferred'; reason: 'cap_committed' | 'queue_busy' | 'fleet_saturated'; drainMs: number };

// ─── POST /admission ──────────────────────────────────────────────────────────

export async function handleAdmission(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  const body = parseBody<AdmissionRequest>(evt);
  if (!body?.requestId || !body.projectType || !body.tier || !body.durationSeconds) {
    return json(400, { error: 'requestId, projectType, tier, and durationSeconds are required' });
  }

  // Idempotency: an existing active, unexpired reservation for this requestId is
  // returned as-is (retries within the 2-min cron never double-reserve).
  const existing = await getReservationByRequestId(body.requestId);
  if (existing && existing.status === 'active' && existing.expiresAt > Date.now()) {
    return json(200, grantedResponse(existing));
  }

  const load = projectAssetLoad(body.projectType, body.durationSeconds);
  if (!load.supported) {
    return json(400, { error: `unsupported projectType: ${body.projectType}` });
  }

  if (STUB === 'granted') {
    const reservation = await grant(body, load, {}, 0);
    return json(200, grantedResponse(reservation));
  }

  const decision = await decide(load);
  if (decision.kind === 'deferred') {
    return json(200, {
      decision: 'deferred',
      reason: decision.reason,
      estimatedWaitSeconds: Math.round(decision.drainMs / 1000),
      retryAfterSeconds: retryAfterSeconds(decision.drainMs),
    });
  }

  const reservation = await grant(body, load, decision.neededWorkers, decision.drainEstMs);
  return json(200, grantedResponse(reservation));
}

// ─── POST /admission/{admissionId}/release ────────────────────────────────────

export async function handleAdmissionRelease(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  const parts = evt.rawPath.split('/'); // ['', 'admission', admissionId, 'release']
  const admissionId = parts[2];
  if (!admissionId) return json(400, { error: 'admissionId required' });
  const body = parseBody<{ outcome?: string }>(evt) ?? {};

  const result = await releaseReservation(admissionId, body.outcome);
  if (result.notFound) return json(404, { released: false, error: 'not found' });
  // Idempotent: already released/expired still reports released:true.
  return json(200, { released: true });
}

// ─── Decision ──────────────────────────────────────────────────────────────────

/**
 * No-TAT admission decision (see module comment). For each endpoint this project
 * would use, estimates drain time from live inflight/queued state PLUS the
 * projected job/worker load already committed by other active reservations
 * (jobs not yet enqueued but already promised) — this is what lets big loads
 * "serialize per endpoint" instead of piling in. Separately checks whether
 * granting would push the fleet-wide worker total over the account cap.
 */
async function decide(load: AssetLoad): Promise<Decision> {
  const counterKeys = Object.keys(load.perEndpoint);
  const [queuedByEndpoint, activeReservations] = await Promise.all([
    gatherQueuedByEndpoint(),
    listActiveReservations(),
  ]);

  const otherReservationsTotalWorkers = activeReservations.reduce(
    (sum, r) => sum + Object.values(r.neededWorkers).reduce((a, b) => a + b, 0), 0);

  let worstDrainMs = 0;
  const neededWorkers: Record<string, number> = {};

  for (const ck of counterKeys) {
    const [inflight, workersMax, ewmaMs] = await Promise.all([
      getInflight(ck), getEndpointWorkersMax(ck), getBaselineMs(ck),
    ]);
    const queued = queuedByEndpoint[ck] ?? 0;
    const reservedJobs = activeReservations.reduce((sum, r) => sum + (r.perEndpointJobs[ck] ?? 0), 0);
    const reservedWorkers = activeReservations.reduce((sum, r) => sum + (r.neededWorkers[ck] ?? 0), 0);

    const projectedJobs = load.perEndpoint[ck];
    // Worker sizing uses peak concurrency (bounded by the Map's MaxConcurrency),
    // not total job count — a worker processes many jobs sequentially over the
    // project's lifetime, so total-jobs/JOBS_PER_WORKER would wildly overstate
    // the workers a single project needs (e.g. 82 jobs/4 ≈ 21, which alone would
    // blow the whole account cap). Concurrency is per-endpoint since only one
    // stage of a given frame is active at a time, but a slow stage can
    // accumulate up to the full Map concurrency waiting on it — conservative by
    // design.
    const concurrentJobs = Math.min(load.frameCount, SFN_MAP_MAX_CONCURRENCY);
    const thisNeeded = Math.max(1, Math.ceil(concurrentJobs / JOBS_PER_WORKER));
    neededWorkers[ck] = thisNeeded;

    // Optimistic if-granted worker count (capped elsewhere by the fleet check).
    const workersAvailable = Math.max(1, workersMax, reservedWorkers + thisNeeded);
    const totalJobs = inflight + queued + reservedJobs + projectedJobs;
    const drainMs = (totalJobs * ewmaMs) / workersAvailable;
    worstDrainMs = Math.max(worstDrainMs, drainMs);
  }

  const currentTotalWorkersMax = await sumAllEndpointsWorkersMax();
  const thisProjectWorkers = Object.values(neededWorkers).reduce((a, b) => a + b, 0);
  const projectedFleetTotal = Math.max(currentTotalWorkersMax, otherReservationsTotalWorkers) + thisProjectWorkers;

  const capExceeded = projectedFleetTotal > ACCOUNT_CAP;
  const drainExceeded = worstDrainMs > MAX_DRAIN_MS;

  if (capExceeded || drainExceeded) {
    const reason = capExceeded && drainExceeded ? 'fleet_saturated' : capExceeded ? 'cap_committed' : 'queue_busy';
    return { kind: 'deferred', reason, drainMs: worstDrainMs };
  }

  return { kind: 'granted', neededWorkers, drainEstMs: Math.round(worstDrainMs) };
}

async function sumAllEndpointsWorkersMax(): Promise<number> {
  const sums = await Promise.all(ENDPOINTS.map(e => getEndpointWorkersMax(e.counterKey)));
  return sums.reduce((a, b) => a + b, 0);
}

/** Average ewmaMs across an endpoint's known baseline ops; seed default if none yet. */
async function getBaselineMs(counterKey: string): Promise<number> {
  const r = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: marshall({ ':pk': `BASELINE#${counterKey}` }),
  }));
  const items = (r.Items ?? []).map(i => unmarshall(i) as BaselineItem);
  if (!items.length) return SEED_MS[counterKey] ?? DEFAULT_SEED_MS;
  return items.reduce((a, b) => a + b.ewmaMs, 0) / items.length;
}

function retryAfterSeconds(drainMs: number): number {
  return Math.min(RETRY_MAX_S, Math.max(RETRY_MIN_S, Math.round(drainMs / 1000 / 3)));
}

// ─── Grant ─────────────────────────────────────────────────────────────────────

async function grant(
  body: AdmissionRequest, load: AssetLoad, neededWorkers: Record<string, number>, drainEstMs: number,
): Promise<ReservationItem> {
  const admissionId = `qm_adm_${randomUUID()}`;
  const now = Date.now();
  const reservation: ReservationItem = {
    pk: `RESERVATION#${admissionId}`, sk: 'META',
    admissionId, requestId: body.requestId,
    projectType: body.projectType, tier: body.tier, durationSeconds: body.durationSeconds,
    userId: body.userId,
    neededWorkers, perEndpointJobs: load.perEndpoint,
    status: 'active', drainEstMs,
    createdAt: now, expiresAt: now + BRAIN_WINDOW_MS + drainEstMs + RESERVATION_BUFFER_MS,
  };
  await saveReservation(reservation);
  return reservation;
}

function grantedResponse(r: ReservationItem) {
  return {
    decision: 'granted',
    admissionId: r.admissionId,
    expiresAt: r.expiresAt,
    warmedEndpoints: Object.keys(r.neededWorkers),
    estimatedReadySeconds: Math.round(ESTIMATED_READY_MS / 1000),
  };
}

// ─── Local helpers (duplicated from api.ts to avoid a circular import) ────────

function json(statusCode: number, body: unknown): LambdaFunctionUrlResponse {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function parseBody<T>(evt: LambdaFunctionUrlEvent): T | null {
  try {
    return evt.body ? JSON.parse(evt.body) as T : null;
  } catch {
    return null;
  }
}
