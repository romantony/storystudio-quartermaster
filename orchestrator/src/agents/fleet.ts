/**
 * Fleet controller (impl plan §6.3). The ONLY module permitted to change an
 * endpoint's worker counts — enforced structurally by
 * __tests__/fleet-import-boundary.test.ts, not just this comment.
 *
 * Shadow mode (`cfg.fleetLive === false`, the default): does everything
 * except the two `patchWorkers` calls, logging what it would have sent.
 * Health verification and cap assertion happen for real regardless — M2's
 * acceptance run hand-scales one endpoint's real worker count so this real
 * verification has something real to observe (see the M2 plan's decision 5).
 *
 * NOT YET WIRED: §6.3's lease-write-first step. Impl plan §13 M0.5 is
 * explicit that "the orchestrator-side lease writer (fleet agent) lands with
 * M3" — the AWS-side lease READER already ships (M0.5, `d138d71`), but
 * nothing on this side writes to it yet. Harmless for M2: shadow mode never
 * actually scales anything the live path could contest.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import type { CatalogEntry } from '../steps/catalog';
import { FLEET } from '../fleet-registry';
import { log } from '../telemetry/log';
import { updateStepStatus } from '../db/repo/steps';

export type StallReason = 'warm_timeout' | 'cap_breach' | 'drain_timeout';

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
  cfg: Pick<Config, 'fleetLive' | 'warmTimeoutMs' | 'drainTimeoutMs' | 'accountCap' | 'liveReserveWorkers'>;
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
 * Reads every other endpoint's currently-configured `workersMax` from
 * RunPod directly — impl plan §6.3 step 4: raising to N while others hold
 * workers does not error, it caps silently. This is the real read that
 * catches that before it happens invisibly.
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

  // workersMin == workersMax == target: ACTIVE workers, not a flex floor
  // (impl plan §6.3). Raising workersMin is what actually commands RunPod to
  // provision workers proactively; raising workersMax alone only lifts a
  // ceiling that RunPod's QUEUE_DELAY scaler won't act on until jobs are
  // already queued — and nothing queues until this function returns and
  // steps.status flips to 'ready'. That gap is exactly the chicken-and-egg
  // stall M2's real acceptance run hit on its first two attempts (a human
  // manually raising workersMax only, with no queued jobs, produced no
  // scale-up). A prior version of this function tried workersMin: 0 based on
  // that manual workaround — reverted: it would reproduce the same stall
  // with nobody there to unstick it once M3 runs unattended.
  if (cfg.fleetLive) {
    await runpod.patchWorkers(step.endpointId, { workersMin: step.workers, workersMax: step.workers });
    log().info({ endpointId: step.endpointId, workers: step.workers }, 'fleet: patched workers (live)');
  } else {
    log().info(
      { endpointId: step.endpointId, workers: step.workers },
      `fleet: SHADOW — would PATCH ${step.endpointId} min/max -> ${step.workers}`,
    );
  }

  const ready = await pollUntil(
    async () => {
      const h = await runpod.health(step.endpointId);
      return (h.workers.ready ?? 0) >= step.workers;
    },
    { everyMs: 5_000, timeoutMs: cfg.warmTimeoutMs },
  );
  if (!ready) {
    await updateStepStatus(pool, cohortId, step.seq, 'stalled');
    throw new FleetStallError('warm_timeout', { endpointId: step.endpointId, target: step.workers });
  }

  const otherEndpointIds = FLEET.map((e) => e.endpointId).filter((id) => id !== step.endpointId);
  const others = await sumWorkersMaxExcept(deps, step.endpointId, otherEndpointIds);
  if (others > cfg.accountCap - step.workers) {
    await updateStepStatus(pool, cohortId, step.seq, 'stalled');
    throw new FleetStallError('cap_breach', { others, accountCap: cfg.accountCap, requested: step.workers });
  }

  await updateStepStatus(pool, cohortId, step.seq, 'ready', { warmAt: new Date() });
  log().info({ endpointId: step.endpointId, seq: step.seq }, 'fleet: step ready');
}

export async function release(deps: FleetDeps, cohortId: string, step: CatalogEntry): Promise<void> {
  const { pool, runpod, cfg } = deps;

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
    // an endpoint billing with nothing in front of it.
    log().error({ endpointId: step.endpointId, cohortId, seq: step.seq }, 'fleet: DRAIN TIMEOUT — endpoint may still be billing active workers');
    throw new FleetStallError('drain_timeout', { endpointId: step.endpointId });
  }

  await updateStepStatus(pool, cohortId, step.seq, 'complete', { finishedAt: new Date() });
  log().info({ endpointId: step.endpointId, seq: step.seq }, 'fleet: step drained and complete');
}
