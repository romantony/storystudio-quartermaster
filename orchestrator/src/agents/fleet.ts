/**
 * Fleet controller (impl plan §6.3, revised 2026-09-17). The ONLY module
 * permitted to change an endpoint's worker counts — enforced structurally by
 * __tests__/fleet-import-boundary.test.ts, not just this comment.
 *
 * FIXED POOLS (2026-09-17): every endpoint's `workersMax` is now a static
 * pod count, matched to the real RunPod dashboard and never PATCHed by this
 * module — src/shared/fleet.ts's FLEET already documented this as the
 * intended model for the AWS live path ("a *static* allocation, never
 * dynamically reshuffled"); this orchestrator's own allocate()/release()
 * had diverged from that, PATCHing workersMax up per step and back to 0
 * between steps. That divergence is what a live capacity incident
 * (2026-09-17) traced back to real problems: the account's real 40-worker
 * quota is shared with a completely different product's endpoints on the
 * same RunPod account, so this orchestrator raising and dropping its own
 * ceilings repeatedly collided with that shared, external demand
 * (`cap_breach`) and, worse, a manual dashboard change made mid-incident
 * left a real orphaned worker pool for hours. None of that is fixable by
 * scaling faster or smarter — the fix is to stop moving the ceiling at all.
 * `steps/catalog.ts`'s `maxWorkers` (sourced from the same FLEET numbers)
 * now caps `agents/planner.ts`'s `workersTarget` at each endpoint's real
 * fixed pod count, so this orchestrator never even TRIES to dispatch more
 * concurrent jobs than the pool can serve — RunPod's own QUEUE_DELAY
 * scaler still grows/shrinks the REAL running worker count within that
 * fixed ceiling based on actual queue depth (workersMin stays 0, so an
 * idle pool still costs nothing — see the 2026-09-10 incident note below).
 *
 * `endpoint_state` bookkeeping (upsertHeld/clearHeld) stays: watchdog.ts
 * still needs to know which step currently considers itself the legitimate
 * user of an endpoint, entirely independent of whether the ceiling itself
 * ever changes.
 *
 * M0.5's original design called for a DynamoDB lease written here, read by
 * the AWS Lambda live-path provisioner. M3 confirmed that's unnecessary:
 * MCP-originated traffic (this orchestrator's entire load) never touches
 * that Lambda, so there's no cross-system datastore to coordinate through.
 * `endpoint_state` (already in `001_init.sql`, unwired until M3) is the
 * Postgres-only stand-in — legible only to this orchestrator's own
 * watchdog (`watchdog.ts`), not to anything on the AWS side.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import type { CatalogEntry } from '../steps/catalog';
import { log } from '../telemetry/log';
import { updateStepStatus } from '../db/repo/steps';
import { upsertHeld, clearHeld } from '../db/repo/endpoint-state';
import { countUngated, countInFlightForGatedStep } from '../db/repo/quality';

export type StallReason = 'unreachable' | 'ungated_on_drain';

export class FleetStallError extends Error {
  constructor(
    readonly reason: StallReason,
    readonly detail?: Record<string, unknown>,
  ) {
    super(`fleet stalled: ${reason}${detail ? ' ' + JSON.stringify(detail) : ''}`);
    this.name = 'FleetStallError';
  }
}

export interface FleetDeps {
  pool: Pool;
  runpod: RunpodClient;
  // warmTimeoutMs moved to generator.ts's GeneratorDeps — allocate() no
  // longer polls for readiness, so it has no use for it here.
  cfg: Pick<Config, 'fleetLive'>;
}

/**
 * Records this step as the endpoint's legitimate current claim — no RunPod
 * call. `step.workers` (planner.ts's workersTarget, already capped by
 * catalog.ts's `maxWorkers` at the endpoint's real fixed pod count) is
 * recorded purely for endpoint_state/watchdog visibility, not sent to
 * RunPod: the pool's actual `workersMax` was fixed ahead of time and this
 * orchestrator never changes it.
 */
export async function allocate(deps: FleetDeps, cohortId: string, step: CatalogEntry & { workers: number }): Promise<void> {
  const { pool, runpod } = deps;

  await updateStepStatus(pool, cohortId, step.seq, 'scaling');

  log().info(
    { endpointId: step.endpointId, workers: step.workers },
    'fleet: using fixed pod pool (no workersMax PATCH — see this file\'s header comment)',
  );

  // Record the claim before the reachability probe — a real worker could
  // already be serving this endpoint's fixed, always-present pool the
  // moment a job lands in its queue; watchdog.ts must never see that
  // without a matching claim on record.
  await upsertHeld(pool, step.endpointId, {
    cohortId,
    stepSeq: step.seq,
    workersMax: step.workers,
    workersMin: 0,
    workersReady: 0,
  });

  // One cheap reachability probe, NOT a poll-until-ready loop — catches a
  // typo'd/deleted endpointId immediately rather than minutes into
  // generation. Must not gate on ready/running counts; the fixed pool's
  // real worker count is RunPod's own QUEUE_DELAY scaler's business, and
  // generator.ts's cold-start-stall detection (GeneratorStallError) owns
  // waiting for real readiness, non-blockingly.
  try {
    await runpod.health(step.endpointId);
  } catch (err) {
    await updateStepStatus(pool, cohortId, step.seq, 'stalled');
    throw new FleetStallError('unreachable', {
      endpointId: step.endpointId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  await updateStepStatus(pool, cohortId, step.seq, 'ready');
  log().info({ endpointId: step.endpointId, seq: step.seq }, 'fleet: step ready (fixed pool, generator may submit)');
}

/**
 * Clears this step's endpoint_state claim — no RunPod call. Kept as a
 * distinct function (rather than inlined at each orchestrator.ts call site)
 * because it's the one thing every driver exit path, including failures,
 * needs to do so watchdog.ts stops treating this step as the endpoint's
 * legitimate current owner. Never throws.
 *
 * Named for what it now does, not what it used to (a real
 * `workersMax:0` PATCH, removed 2026-09-17 along with allocate()'s PATCH —
 * see this file's header comment). There is nothing left to "drain": the
 * pool's ceiling was never raised in the first place, so RunPod's own
 * QUEUE_DELAY scaler and idleTimeout already own bringing the real running
 * count back toward 0 once nothing is queued, at no cost (workersMin stays
 * 0 — see the 2026-09-10 incident note in allocate()'s old header, kept in
 * git history).
 */
export async function emergencyDrain(deps: FleetDeps, endpointId: string): Promise<void> {
  try {
    await clearHeld(deps.pool, endpointId);
  } catch (err) {
    log().error({ endpointId, err }, 'fleet: clearing endpoint_state claim failed — watchdog will see a stale claim until it expires');
  }
}

export async function release(deps: FleetDeps, cohortId: string, step: CatalogEntry): Promise<void> {
  const { pool } = deps;

  // §6.5: "jobs_ungated must return empty before the fleet controller is
  // allowed to drain" — the ONLY coupling between the quality agent and
  // this module. Only meaningful for a gated step (step.gate set) — an
  // ungated step's completed jobs never get a quality_status written at
  // all, so countUngated would find them "ungated" forever; that's correct
  // for gated steps (nothing SHOULD write quality_status until a gate
  // evaluates it) and meaningless noise for ungated ones. In the normal
  // gated path this never fires — the driver already awaits gateStep()
  // before calling release() — this is defense-in-depth against a driver
  // bug: releasing this step's claim while an asset is unevaluated or
  // mid-rework would let a caller receive it as final.
  if (step.gate === 'image' || step.gate === 'motion') {
    const ungated = await countUngated(pool, cohortId, step.seq);
    const inFlight = await countInFlightForGatedStep(pool, cohortId, step.seq);
    if (ungated > 0 || inFlight > 0) {
      await updateStepStatus(pool, cohortId, step.seq, 'stalled');
      throw new FleetStallError('ungated_on_drain', { endpointId: step.endpointId, cohortId, seq: step.seq, ungated, inFlight });
    }
  }

  await updateStepStatus(pool, cohortId, step.seq, 'draining');

  await clearHeld(pool, step.endpointId);
  await updateStepStatus(pool, cohortId, step.seq, 'complete', { finishedAt: new Date() });
  log().info({ endpointId: step.endpointId, seq: step.seq }, 'fleet: step complete, claim cleared (fixed pool untouched)');
}

/**
 * Auxiliary endpoints (2026-09-15): a gated step's model-switch fallbacks can
 * submit to endpoints other than the step's own (Flux on qwen-image-gen while
 * step 0 runs on qwen-image-edit; postprod-lite `normalize` while step 3 runs
 * on wan2-i2v — steps/catalog.ts `auxiliaryEndpoints`). Fixed pools
 * (2026-09-17): no ceiling PATCH here either — the aux endpoint's pool is
 * already sized for its own real demand; this just records the claim so the
 * watchdog sees fallback usage as owned, and runStep() keeps it fresh.
 */
export async function allocateAuxiliary(
  deps: FleetDeps,
  cohortId: string,
  stepSeq: number,
  aux: { endpointId: string; workers: number },
): Promise<void> {
  log().info({ endpointId: aux.endpointId, workers: aux.workers, stepSeq }, 'fleet: auxiliary endpoint claim recorded (fixed pool, no PATCH)');
  await upsertHeld(deps.pool, aux.endpointId, { cohortId, stepSeq, workersMax: aux.workers, workersMin: 0, workersReady: 0 });
}

/** Clears an auxiliary endpoint's claim — no RunPod call, see
 * emergencyDrain()'s header comment for why. Never throws — it runs on
 * every driver exit path, including failures. */
export async function releaseAuxiliary(deps: FleetDeps, endpointId: string): Promise<void> {
  try {
    await clearHeld(deps.pool, endpointId);
    log().info({ endpointId }, 'fleet: auxiliary endpoint claim cleared');
  } catch (err) {
    log().error({ endpointId, err }, 'fleet: auxiliary claim clear failed — watchdog will see a stale claim until it expires');
  }
}
