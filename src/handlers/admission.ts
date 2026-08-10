import { randomUUID } from 'crypto';
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  getReservationByRequestId, listActiveReservations, releaseReservation, saveReservation,
} from '../gate/reservation-gate';
import { projectAssetLoad } from '../shared/assetLoad';
import type { AssetLoad, ShotCounts } from '../shared/assetLoad';
import { MAX_ACTIVE_PROJECTS, PROJECT_FLEET, endpointWorkers } from '../shared/fleet';
import { gatherQueuedDetailed, prewarmEndpoints } from './provisioner';
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

// Fleet-protection ceiling — used only as a fallback ETA when active reservations
// carry no drain estimate; the gate itself (fleet.ts) is what paces admission now.
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
  /** Dialogue Premium only — see assetLoad.ts's ShotCounts doc comment. Every
   * other projectType omits this and gets the duration-derived estimate. */
  shotCounts?: ShotCounts;
}

type Decision =
  | { kind: 'granted'; neededWorkers: Record<string, number>; drainEstMs: number }
  | { kind: 'deferred'; reason: 'max_projects' | 'endpoint_busy' | 'unsupported'; drainMs: number };

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

  const load = projectAssetLoad(body.projectType, body.durationSeconds, body.shotCounts);
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
 * Queue-gate admission (simplified model agreed with StoryStudio 2026-07-04, see
 * src/shared/fleet.ts). Two rules, no worker-sizing math:
 *
 *   1. At most MAX_ACTIVE_PROJECTS admitted at once — the shared flux-tts-s2t
 *      endpoint means we don't run more than a couple projects concurrently.
 *   2. Admit only when the project type's *bottleneck* endpoint backlog is at or
 *      under its gate (premium: wan2 <= 6; basic: merge <= 9). Backlog = live
 *      QUEUED jobs on that endpoint (per-op for basic's merge) PLUS the
 *      not-yet-submitted load of freshly-granted reservations (younger than the
 *      brain window — their jobs haven't hit the queue yet, so counting the live
 *      queue alone would let a 2nd project slip in while the gate only *looks*
 *      clear). This self-paces: admit -> the gate endpoint fills -> the next
 *      request defers until it drains back under the gate.
 *
 * On grant, all workers of the touched endpoints are pre-warmed (fleet.ts).
 */
async function decide(load: AssetLoad): Promise<Decision> {
  const plan = PROJECT_FLEET[load.projectType.toLowerCase()];
  if (!plan) return { kind: 'deferred', reason: 'unsupported', drainMs: 0 };

  const now = Date.now();
  const [detailed, activeReservations] = await Promise.all([
    gatherQueuedDetailed(),
    listActiveReservations(),
  ]);

  // Rule 1: cap concurrently-admitted projects.
  if (activeReservations.length >= MAX_ACTIVE_PROJECTS) {
    const soonestFreeMs = Math.min(
      ...activeReservations.map(r => Math.max(0, r.createdAt + r.drainEstMs - now)),
    );
    return { kind: 'deferred', reason: 'max_projects', drainMs: Number.isFinite(soonestFreeMs) ? soonestFreeMs : MAX_DRAIN_MS };
  }

  // Rule 2: gate on the bottleneck endpoint's backlog (live queued + young reservations).
  const liveQueued = plan.gateOperation
    ? (detailed.byEndpointOp[`${plan.gateEndpoint}#${plan.gateOperation}`] ?? 0)
    : (detailed.byEndpoint[plan.gateEndpoint] ?? 0);
  let reservedYoung = 0;
  for (const r of activeReservations) {
    if (now - r.createdAt < BRAIN_WINDOW_MS) reservedYoung += r.perEndpointJobs[plan.gateEndpoint] ?? 0;
  }
  const gateBacklog = liveQueued + reservedYoung;

  const gateEwmaMs = await getBaselineMs(plan.gateEndpoint);
  const gateWorkers = Math.max(1, endpointWorkers(plan.gateEndpoint));

  if (gateBacklog > plan.gateMax) {
    const drainMs = (gateBacklog * gateEwmaMs) / gateWorkers;
    return { kind: 'deferred', reason: 'endpoint_busy', drainMs };
  }

  // Grant: pre-warm every worker of the endpoints this project touches.
  const neededWorkers: Record<string, number> = {};
  for (const ck of plan.endpoints) neededWorkers[ck] = endpointWorkers(ck);
  // ETA (for reservation TTL + estimatedWaitSeconds) = this project's own load
  // draining on its bottleneck endpoint.
  const drainEstMs = ((load.perEndpoint[plan.gateEndpoint] ?? 0) * gateEwmaMs) / gateWorkers;
  return { kind: 'granted', neededWorkers, drainEstMs: Math.round(drainEstMs) };
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
    // Backstop cleanup only (listActiveReservations already filters on status via
    // reservation-status-index) — 7 days past expiresAt is generous vs. any real
    // project lifecycle, just stops released/expired reservations piling up forever.
    ttl: Math.floor((now + BRAIN_WINDOW_MS + drainEstMs + RESERVATION_BUFFER_MS) / 1000) + 7 * 24 * 3600,
  };
  await saveReservation(reservation);
  // Best-effort, synchronous pre-warm (§WS-C3) — the next sweeper tick (≤2 min)
  // would eventually reach the same state via the reservation-aware demand this
  // save just created (§WS-C2), but doing it here lets RunPod's cold start
  // overlap the brain window instead of starting after it. Never blocks or
  // fails the admission response.
  await prewarmEndpoints(neededWorkers).catch(e => console.error('[admission] prewarm failed', e));
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
