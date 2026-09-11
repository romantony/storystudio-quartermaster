/**
 * Fleet controller (impl plan §6.3). The ONLY module permitted to change an
 * endpoint's worker counts — enforced structurally by
 * __tests__/fleet-import-boundary.test.ts, not just this comment.
 *
 * Shadow mode (`cfg.fleetLive === false`, the default): does everything
 * except the two `patchWorkers` calls, logging what it would have sent. A
 * single reachability probe (not a poll-until-ready loop — see allocate())
 * and the cap assertion happen for real regardless — M2's acceptance run
 * hand-scales one endpoint's real worker count so this real verification
 * has something real to observe (see the M2 plan's decision 5).
 *
 * M0.5's original design called for a DynamoDB lease written here, read by
 * the AWS Lambda live-path provisioner. M3 confirmed that's unnecessary:
 * MCP-originated traffic (this orchestrator's entire load) never touches
 * that Lambda, so there's no cross-system datastore to coordinate through.
 * `endpoint_state` (already in `001_init.sql`, unwired until now) is the
 * Postgres-only stand-in — legible only to this orchestrator's own
 * watchdog (`watchdog.ts`), not to anything on the AWS side.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import type { CatalogEntry } from '../steps/catalog';
import { FLEET } from '../fleet-registry';
import { log } from '../telemetry/log';
import { updateStepStatus } from '../db/repo/steps';
import { upsertHeld, clearHeld } from '../db/repo/endpoint-state';
import { countUngated, countInFlightForGatedStep } from '../db/repo/quality';

export type StallReason = 'unreachable' | 'cap_breach' | 'drain_timeout' | 'ungated_on_drain';

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
  cfg: Pick<Config, 'fleetLive' | 'drainTimeoutMs' | 'accountCap' | 'liveReserveWorkers'>;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(
  check: () => Promise<boolean>,
  opts: { everyMs: number; timeoutMs: number },
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(opts.everyMs);
  }
}

/**
 * Reads every other endpoint's real, currently-observed worker draw from
 * RunPod directly (not their configured `workersMax` — see the note on
 * `ready + running` below) — impl plan §6.3 step 4: raising to N while
 * others hold workers does not error, it caps silently. This is the real
 * read that catches that before it happens invisibly.
 */
async function sumWorkersMaxExcept(deps: FleetDeps, endpointId: string, others: string[]): Promise<number> {
  let sum = 0;
  for (const id of others) {
    if (id === endpointId) continue;
    try {
      const h = await deps.runpod.health(id);
      // health() reports live worker counts, not the configured max — used
      // here as the best real signal available without a second REST call
      // per endpoint. workers.ready + workers.running approximates the
      // account-wide draw this assertion cares about.
      sum += (h.workers.ready ?? 0) + (h.workers.running ?? 0);
    } catch (err) {
      log().warn({ endpointId: id, err }, 'fleet: could not read sibling endpoint health for cap assertion');
    }
  }
  return sum;
}

export async function allocate(deps: FleetDeps, cohortId: string, step: CatalogEntry & { workers: number }): Promise<void> {
  const { pool, runpod, cfg } = deps;

  await updateStepStatus(pool, cohortId, step.seq, 'scaling');

  // Only workersMax ever moves. workersMin stays 0, always, everywhere in
  // this codebase. A real live test (2026-09-10) found the opposite design
  // (workersMin == workersMax == target, "active workers") can get stuck
  // mid-cold-start indefinitely while billing the whole time — 5 real
  // workers ran for the full 8-minute warmTimeoutMs and never reported
  // ready, with zero job throughput. RunPod's own QUEUE_DELAY scaler grows
  // real capacity in response to actually-queued jobs, not to a raised
  // ceiling alone and not reliably to a raised floor either — every manual
  // /run submission this session against a workersMin=0 endpoint (postprod-
  // lite, BGM-S2T) scaled up and completed reliably. So allocate() no longer
  // waits for real readiness before handing off — it raises the ceiling,
  // does a cheap reachability check, and lets the generator start
  // submitting immediately; generator.ts's runStep() owns cold-start-stall
  // detection now, non-blockingly, without the billing cost (see its
  // GeneratorStallError).
  if (cfg.fleetLive) {
    await runpod.patchWorkers(step.endpointId, { workersMax: step.workers });
    log().info({ endpointId: step.endpointId, workers: step.workers }, 'fleet: patched workersMax (live)');
  } else {
    log().info(
      { endpointId: step.endpointId, workers: step.workers },
      `fleet: SHADOW — would PATCH ${step.endpointId} workersMax -> ${step.workers} (workersMin stays 0)`,
    );
  }

  // Record the claim right after the PATCH, before anything else — a real
  // worker could start appearing the moment RunPod sees the raised ceiling
  // and a job lands in its queue; watchdog.ts must never see that without a
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
  // generation. Must not gate on ready/running counts; that's exactly what
  // this function is no longer allowed to wait on.
  try {
    await runpod.health(step.endpointId);
  } catch (err) {
    await updateStepStatus(pool, cohortId, step.seq, 'stalled');
    throw new FleetStallError('unreachable', {
      endpointId: step.endpointId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const otherEndpointIds = FLEET.map((e) => e.endpointId).filter((id) => id !== step.endpointId);
  const others = await sumWorkersMaxExcept(deps, step.endpointId, otherEndpointIds);
  if (others > cfg.accountCap - step.workers) {
    await updateStepStatus(pool, cohortId, step.seq, 'stalled');
    throw new FleetStallError('cap_breach', { others, accountCap: cfg.accountCap, requested: step.workers });
  }

  await updateStepStatus(pool, cohortId, step.seq, 'ready');
  log().info({ endpointId: step.endpointId, seq: step.seq }, 'fleet: step ready (ceiling raised, generator may submit)');
}

/**
 * Best-effort backstop used only by the driver's failure path
 * (orchestrator.ts) — a bare `workersMax:0` PATCH with none of release()'s
 * gating (no ungated-quality check, no poll-until-confirmed-drained wait).
 * Real incident, 2026-09-11: allocate() PATCHed workersMax up, then the
 * very next call (submitOne's /run) failed on a transient RunPod race
 * (see generator.ts's ENDPOINT_PAUSED retry — that closes the race itself;
 * this is what stops the bleed on whatever failure gets through anyway).
 * The driver logged the failure and returned without ever compensating,
 * leaving the just-raised workers to bill unmanaged for 2+ hours until a
 * human found and manually drained them. Never throws — a failure here is
 * logged and swallowed so it cannot mask the original error that triggered
 * it; WATCHDOG_AUTODRAIN is the remaining backstop if this PATCH itself
 * fails or the orchestrator process dies before reaching it.
 */
export async function emergencyDrain(deps: FleetDeps, endpointId: string): Promise<void> {
  if (!deps.cfg.fleetLive) return;
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

export async function release(deps: FleetDeps, cohortId: string, step: CatalogEntry): Promise<void> {
  const { pool, runpod, cfg } = deps;

  // §6.5: "jobs_ungated must return empty before the fleet controller is
  // allowed to drain" — the ONLY coupling between the quality agent and
  // this module. Only meaningful for a gated step (step.gate set) — an
  // ungated step's completed jobs never get a quality_status written at
  // all, so countUngated would find them "ungated" forever; that's correct
  // for gated steps (nothing SHOULD write quality_status until a gate
  // evaluates it) and meaningless noise for ungated ones. In the normal
  // gated path this never fires — the driver already awaits gateStep()
  // before calling release() — this is defense-in-depth against a driver
  // bug, same spirit as the cap assertion below. An ungated drain is worse
  // than the drain-timeout stall already below it: that one is a cost bug
  // ($19/window billing), this one is a correctness bug (a caller receives
  // an unevaluated or mid-rework asset as final).
  if (step.gate === 'image' || step.gate === 'motion') {
    const ungated = await countUngated(pool, cohortId, step.seq);
    const inFlight = await countInFlightForGatedStep(pool, cohortId, step.seq);
    if (ungated > 0 || inFlight > 0) {
      await updateStepStatus(pool, cohortId, step.seq, 'stalled');
      throw new FleetStallError('ungated_on_drain', { endpointId: step.endpointId, cohortId, seq: step.seq, ungated, inFlight });
    }
  }

  await updateStepStatus(pool, cohortId, step.seq, 'draining');

  if (cfg.fleetLive) {
    await runpod.patchWorkers(step.endpointId, { workersMin: 0, workersMax: 0 });
    log().info({ endpointId: step.endpointId }, 'fleet: patched workers to 0 (live)');
  } else {
    log().info({ endpointId: step.endpointId }, `fleet: SHADOW — would PATCH ${step.endpointId} min/max -> 0`);
  }

  const drained = await pollUntil(
    async () => {
      const h = await runpod.health(step.endpointId);
      return (h.workers.running ?? 0) === 0 && (h.workers.ready ?? 0) === 0;
    },
    { everyMs: 5_000, timeoutMs: cfg.drainTimeoutMs },
  );
  if (!drained) {
    await updateStepStatus(pool, cohortId, step.seq, 'stalled');
    // §6.3: "ALERT LOUDLY — this one costs $19/window." A stuck drain leaves
    // an endpoint billing with nothing in front of it. Deliberately NOT
    // clearing endpoint_state here — the claim staying present with a
    // recent observed_at is correct: real workers genuinely are still this
    // step's responsibility, not an orphan of some other cause.
    log().error({ endpointId: step.endpointId, cohortId, seq: step.seq }, 'fleet: DRAIN TIMEOUT — endpoint may still be billing active workers');
    throw new FleetStallError('drain_timeout', { endpointId: step.endpointId });
  }

  await clearHeld(pool, step.endpointId);
  await updateStepStatus(pool, cohortId, step.seq, 'complete', { finishedAt: new Date() });
  log().info({ endpointId: step.endpointId, seq: step.seq }, 'fleet: step drained and complete');
}
