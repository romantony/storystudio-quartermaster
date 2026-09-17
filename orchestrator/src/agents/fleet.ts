/**
 * Fleet controller (impl plan §6.3, revised 2026-09-17 three times — see
 * git history for the full back-and-forth). The ONLY module permitted to
 * change an endpoint's worker counts — enforced structurally by
 * __tests__/fleet-import-boundary.test.ts, not just this comment.
 *
 * TRUE HANDS-OFF FIXED POOLS (2026-09-17, final): this orchestrator NEVER
 * PATCHes workersMax, under any circumstance — not on allocate, not on
 * release, not on a driver failure. Each endpoint's pod count is set once,
 * externally (the RunPod dashboard, matching src/shared/fleet.ts's FLEET
 * numbers), and stays exactly where a human puts it.
 *
 * This is a deliberate operator decision, made with a known, accepted
 * tradeoff already demonstrated live the same day: these 5 endpoints are
 * also independently managed by the AWS Lambda live path's own provisioner
 * (src/shared/fleet.ts: "Idle floor is 0 (true scale-to-zero)... Pre-warm
 * raises workers only on admission"), which releases them to 0 on its own
 * whenever no live-path project is active. An earlier revision of this file
 * re-PATCHed the fixed number back up right before this orchestrator needed
 * it, specifically to survive that — removing it reopens the exact failure
 * that fix closed: a cohort whose step lands on an endpoint the live path
 * has since idled to 0 will fail that step with nothing to dispatch to
 * (`GeneratorStallError('warm_timeout')` once generator.ts's warm-check
 * times out, or a downstream "no resolved URL" cascade if some jobs still
 * squeak through). The operator has chosen to own keeping pod counts
 * topped up manually (via the dashboard) rather than have this code do it.
 *
 * `steps/catalog.ts`'s `maxWorkers` (sourced from the same FLEET numbers)
 * still caps `agents/planner.ts`'s `workersTarget` at each endpoint's fixed
 * pod count, so this orchestrator never even TRIES to dispatch more
 * concurrent jobs than the pool is meant to serve, independent of whatever
 * the real ceiling happens to be at the moment.
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
 * call, ever (see this file's header comment). `step.workers` (planner.ts's
 * workersTarget, already capped by catalog.ts's `maxWorkers` at the
 * endpoint's fixed pod count) is recorded purely for endpoint_state/
 * watchdog visibility. If the real pod count has drifted from this value
 * (most commonly: the AWS live path released it to 0 since an operator last
 * set it), that's an operator/dashboard concern — this function does not
 * detect or correct it.
 */
export async function allocate(deps: FleetDeps, cohortId: string, step: CatalogEntry & { workers: number }): Promise<void> {
  const { pool, runpod } = deps;

  await updateStepStatus(pool, cohortId, step.seq, 'scaling');

  log().info(
    { endpointId: step.endpointId, workers: step.workers },
    "fleet: using fixed pod pool (no workersMax PATCH, ever — see this file's header comment)",
  );

  // Record the claim before the reachability probe — a real worker could
  // already be serving this endpoint's fixed pool the moment a job lands in
  // its queue; watchdog.ts must never see that without a matching claim on
  // record.
  await upsertHeld(pool, step.endpointId, {
    cohortId,
    stepSeq: step.seq,
    workersMax: step.workers,
    workersMin: 0,
    workersReady: 0,
  });

  // One cheap reachability probe, NOT a poll-until-ready loop — catches a
  // typo'd/deleted endpointId immediately rather than minutes into
  // generation. Must not gate on ready/running counts; the pool's real
  // worker count is entirely outside this orchestrator's control now.
  // generator.ts's cold-start-stall detection (GeneratorStallError) is what
  // notices if the real pod count was left at 0 and nothing ever comes up.
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
 * Clears this step's endpoint_state claim — no RunPod call, ever (see this
 * file's header comment). Kept as a distinct function (rather than inlined
 * at each orchestrator.ts call site) because it's the one thing every
 * driver exit path, including failures, needs to do so watchdog.ts stops
 * treating this step as the endpoint's legitimate current owner. Never
 * throws.
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
 * on wan2-i2v — steps/catalog.ts `auxiliaryEndpoints`). Same true-hands-off
 * policy as allocate() above: no ceiling PATCH, ever — this just records the
 * claim so the watchdog sees fallback usage as owned, and runStep() keeps it
 * fresh.
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
