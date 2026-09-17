/**
 * Fleet controller (impl plan §6.3, revised 2026-09-17 twice). The ONLY
 * module permitted to change an endpoint's worker counts — enforced
 * structurally by __tests__/fleet-import-boundary.test.ts, not just this
 * comment.
 *
 * FIXED POOLS (2026-09-17): each endpoint has one agreed pod count
 * (src/shared/fleet.ts's FLEET, re-synced against the real dashboard) —
 * this orchestrator never asks for more than that number, and never
 * deliberately asks for less. That's the fix for a real capacity incident
 * the same day: allocate() used to PATCH workersMax up to an UNCAPPED
 * per-cohort demand figure (up to cfg.workersHead, 25) and release() PATCHed
 * it back to 0 between every step — colliding with a genuinely shared,
 * hard 40-worker account-wide RunPod quota (also drawn on by a completely
 * different product's endpoints on the same account) and, once, leaving a
 * manually-raised endpoint orphaned for hours mid-incident.
 * `steps/catalog.ts`'s `maxWorkers` (sourced from the same FLEET numbers)
 * now caps `agents/planner.ts`'s `workersTarget` so `step.workers` here IS
 * always exactly that fixed number, never an inflated demand figure — so
 * allocate()'s PATCH is idempotent in the normal case, not a scale-up.
 *
 * release() does NOT PATCH back to 0, and never did as of the first
 * 2026-09-17 revision — corrected same day: these 5 endpoints are also
 * actively managed by the AWS Lambda live path's own provisioner
 * (src/shared/fleet.ts: "Idle floor is 0 (true scale-to-zero)... Pre-warm
 * raises workers only on admission"), which legitimately scales them to 0
 * on its own whenever no live-path project is currently active — entirely
 * independent of this orchestrator. A first cut removed allocate()'s PATCH
 * entirely, assuming the fixed value would just sit there; it doesn't — the
 * live path's own release cycle zeroed all 5 within the hour, and the next
 * cohort's jobs failed instantly (`not_run`, nothing to dispatch to) because
 * this orchestrator had given up its own ability to raise them back. So:
 * allocate() re-PATCHes up to the fixed number every time (harmless no-op
 * if the live path already left it there, a real and necessary raise if the
 * live path had released it to 0) — that IS "never asking for more than the
 * agreed number," not a contradiction of "fixed pools." Only release()
 * dropping it back to 0 between every step was the actual problem this
 * whole revision set out to fix, and that part stays removed.
 *
 * `endpoint_state` bookkeeping (upsertHeld/clearHeld) stays regardless:
 * watchdog.ts still needs to know which step currently considers itself the
 * legitimate user of an endpoint, independent of the ceiling's real value.
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
 * PATCHes workersMax up to `step.workers` — which is always the endpoint's
 * fixed pod count (catalog.ts's `maxWorkers` caps planner.ts's
 * workersTarget at exactly that number, never more), so this is idempotent
 * in the normal case, not a scale-up. It's still necessary, not dead code:
 * the AWS live path's own provisioner independently releases these same
 * endpoints to 0 when idle (see this file's header comment) — without this
 * PATCH, a cohort starting after that release has nothing to dispatch to.
 * workersMin stays 0, always (see the 2026-09-10 incident note in git
 * history) — RunPod's own QUEUE_DELAY scaler grows the REAL running worker
 * count within this ceiling based on actual queue depth, not to a raised
 * ceiling alone.
 */
export async function allocate(deps: FleetDeps, cohortId: string, step: CatalogEntry & { workers: number }): Promise<void> {
  const { pool, runpod, cfg } = deps;

  await updateStepStatus(pool, cohortId, step.seq, 'scaling');

  if (cfg.fleetLive) {
    await runpod.patchWorkers(step.endpointId, { workersMax: step.workers });
    log().info({ endpointId: step.endpointId, workers: step.workers }, 'fleet: patched workersMax to the fixed pod count (live)');
  } else {
    log().info(
      { endpointId: step.endpointId, workers: step.workers },
      `fleet: SHADOW — would PATCH ${step.endpointId} workersMax -> ${step.workers} (the fixed pod count)`,
    );
  }

  // Record the claim right after the PATCH, before anything else — a real
  // worker could start appearing the moment RunPod sees the ceiling and a
  // job lands in its queue; watchdog.ts must never see that without a
  // matching claim on record.
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
 * Best-effort backstop used only by the driver's failure path
 * (orchestrator.ts) — a bare `workersMax:0` PATCH plus a claim clear, none
 * of release()'s gating. Real incident, 2026-09-11: allocate() PATCHed
 * workersMax up, the very next call failed, and the driver returned without
 * ever compensating, leaving the just-raised workers to bill unmanaged for
 * 2+ hours. Restored 2026-09-17 (same day it was briefly removed): allocate()
 * PATCHing up is real again — idempotent in the common case, but a genuine
 * raise whenever the AWS live path had already released the endpoint to 0
 * (see allocate()'s header comment) — so the crash-between-raise-and-release
 * window this exists for is real again too. Never throws — a failure here
 * is logged and swallowed so it cannot mask the original error that
 * triggered it; WATCHDOG_AUTODRAIN is the remaining backstop if this PATCH
 * itself fails or the orchestrator process dies before reaching it.
 */
export async function emergencyDrain(deps: FleetDeps, endpointId: string): Promise<void> {
  if (deps.cfg.fleetLive) {
    try {
      await deps.runpod.patchWorkers(endpointId, { workersMin: 0, workersMax: 0 });
      log().error({ endpointId }, 'fleet: EMERGENCY DRAIN — step failed after allocate(), PATCHing workersMax -> 0 to stop billing');
    } catch (err) {
      log().error(
        { endpointId, err },
        'fleet: emergency drain PATCH itself failed — endpoint may still be billing; WATCHDOG_AUTODRAIN is the remaining backstop',
      );
    }
  }
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
 * on wan2-i2v — steps/catalog.ts `auxiliaryEndpoints`). Same fixed-pool
 * reasoning as allocate() above: the aux endpoint may be one of the shared
 * FLEET endpoints the AWS live path also scales to 0 on its own, so this
 * still PATCHes up to `aux.workers` (idempotent when already there).
 */
export async function allocateAuxiliary(
  deps: FleetDeps,
  cohortId: string,
  stepSeq: number,
  aux: { endpointId: string; workers: number },
): Promise<void> {
  if (deps.cfg.fleetLive) {
    await deps.runpod.patchWorkers(aux.endpointId, { workersMax: aux.workers });
    log().info({ endpointId: aux.endpointId, workers: aux.workers, stepSeq }, 'fleet: auxiliary endpoint patched to its fixed pod count (live)');
  } else {
    log().info({ endpointId: aux.endpointId, workers: aux.workers, stepSeq }, 'fleet: SHADOW — would patch auxiliary endpoint to its fixed pod count');
  }
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
