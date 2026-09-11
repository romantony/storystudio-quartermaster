/**
 * Generator agent (impl plan §6.4). One agent for every asset type — the
 * endpoint and the payload come from the plan (steps/catalog.ts), not the
 * code.
 *
 * Adaptation from the spec's pseudocode: §6.4 groups the claim (`FOR UPDATE
 * SKIP LOCKED`) and each submission's id+status write into one description.
 * Read literally that would mean holding row locks on a whole claimed batch
 * open for the duration of several sequential RunPod HTTP calls. Implemented
 * here as claim-then-submit-then-write PER JOB, each in its own short
 * transaction — the crash-safety guarantee §10.1 actually needs ("id and
 * status together, or neither") holds at that granularity, and no lock is
 * held across a network call.
 */
import { createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config';
import { backoffMs, type RunpodClient } from '../runpod/client';
import { isTerminal, RunpodError, type RunResponse } from '../runpod/types';
import type { CatalogEntry } from '../steps/catalog';
import type { FrameJobInput, ResolvedDeps } from '../steps/builders/types';
import { log } from '../telemetry/log';
import { claimNextBatch, markSubmitted, markTerminal, listInFlight, stepJobCounts, listStale, type JobRow } from '../db/repo/jobs';
import { updateStepStatus, incrementStepCounters } from '../db/repo/steps';
import { recordJobCost } from '../db/repo/costs';
import { touchObserved } from '../db/repo/endpoint-state';
import { runpodOutUrl } from '../runpod/output';

export interface GeneratorDeps {
  pool: Pool;
  runpod: RunpodClient;
  // warmTimeoutMs: fleet.ts's allocate() no longer polls for readiness (M3
  // fix, 2026-09-10) — runStep()'s own non-blocking cold-start check owns
  // that timeout now, reusing the same config value.
  cfg: Pick<Config, 'workerRateUsdS' | 'reconcileIntervalMs' | 'warmTimeoutMs'>;
  /** Base URL this process is reachable at (e.g. https://orchestrator.ai-storystudio.com),
   * used to build each job's per-job webhook callback URL. */
  publicBaseUrl: string;
  webhookSecret: string;
  /** Injectable for tests so the ENDPOINT_PAUSED retry backoff does not
   * actually wait. Defaults to a real setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * allocate()'s workersMax PATCH (fleet.ts) and RunPod actually lifting the
 * pause are two different moments — a real incident on 2026-09-11 found a
 * step's very first submitOne() landing in the gap: RunPod returned
 * `409 ENDPOINT_PAUSED` even though the PATCH had already been sent and
 * accepted. The driver treated that single 409 as a fatal step failure and
 * abandoned the cohort, leaving the (by-then-actually-raised) workers
 * orphaned for over two hours with the watchdog only alerting, never
 * draining (WATCHDOG_AUTODRAIN was off — see orchestrator.ts's
 * emergencyDrain() and this repo's docs/qm-orchestrator-session-2026-09-11
 * write-up for the rest of that incident). This retry closes the actual
 * race rather than just containing its blast radius: a few seconds of
 * cheap, no-worker-billed retrying (workersMin stays 0 the whole time) is
 * enough for RunPod to catch up to a PATCH it already accepted.
 *
 * The unpause latency isn't fixed. The first re-verification of this exact
 * fix (same day) found `qwen-image-gen` needed zero retries but
 * `flux-tts-s2t` was still paused after 5 attempts at a flat 3s (~15s
 * total) — different endpoints/node pools evidently settle at different
 * speeds. Reuses runpod/client.ts's own `backoffMs` (full jitter, capped
 * 20s/attempt) instead of a flat delay, and raises the budget to 8
 * attempts — worst case a bit over a minute of cheap polling (no workers
 * billed while waiting), typically much less.
 */
const ENDPOINT_PAUSED_MAX_ATTEMPTS = 8;

function isEndpointPausedRace(err: unknown): boolean {
  return (
    err instanceof RunpodError &&
    err.status === 409 &&
    (err.body as { code?: string } | undefined)?.code === 'ENDPOINT_PAUSED'
  );
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithPausedRetry(
  deps: GeneratorDeps,
  jobId: number,
  endpointId: string,
  attempt: () => Promise<RunResponse>,
): Promise<RunResponse> {
  const sleepImpl = deps.sleepImpl ?? defaultSleep;
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!isEndpointPausedRace(err) || tries >= ENDPOINT_PAUSED_MAX_ATTEMPTS) throw err;
      log().warn(
        { jobId, endpointId, attempt: tries + 1, maxAttempts: ENDPOINT_PAUSED_MAX_ATTEMPTS },
        'generator: endpoint still paused right after workersMax PATCH (fleet.ts allocate() race), retrying submission',
      );
      await sleepImpl(backoffMs(tries));
    }
  }
}

export type GeneratorStallReason = 'warm_timeout';

/** Mirrors FleetStallError's shape — runStep()'s own stall, now that
 * allocate() no longer blocks on real worker readiness. */
export class GeneratorStallError extends Error {
  constructor(
    readonly reason: GeneratorStallReason,
    readonly detail?: Record<string, unknown>,
  ) {
    super(`generator stalled: ${reason}${detail ? ' ' + JSON.stringify(detail) : ''}`);
    this.name = 'GeneratorStallError';
  }
}

/** Resolves a job's step-dependency outputs into the shape steps/builders
 * expect, by reading the completed same-frame job in each dependsOn step. */
/**
 * project_id is required, not just cohort_id — frame_id is caller-assigned
 * (Story Studio's own per-project scene numbering, e.g. "f1", "f2", ...) and
 * has no global-uniqueness guarantee. A real cross-project cohort would
 * otherwise let this resolve to a DIFFERENT project's same-numbered frame's
 * output — silently wrong, not an error. Found 2026-09-11 while designing
 * the M5 assembler agent's per-project scoping (docs/
 * qm-orchestrator-implementation-plan.md §6.10, §16 q12); dormant until now
 * only because M2 has no real multi-project cohorts yet.
 */
async function resolveDeps(client: PoolClient, cohortId: string, projectId: string, frameId: string, dependsOn: number[]): Promise<ResolvedDeps> {
  const resolved: ResolvedDeps = {};
  for (const seq of dependsOn) {
    const { rows } = await client.query<{ output: unknown }>(
      `SELECT output FROM jobs WHERE cohort_id = $1 AND project_id = $2 AND frame_id = $3 AND step_seq = $4 AND status = 'complete'`,
      [cohortId, projectId, frameId, seq],
    );
    const url = rows[0] ? runpodOutUrl(rows[0].output) : undefined;
    resolved[seq] = url ? { url } : undefined;
  }
  return resolved;
}

async function submitOne(deps: GeneratorDeps, cohortId: string, step: CatalogEntry, job: JobRow): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    // Re-check under lock — another generator process (a future concern,
    // not M2's single-process reality) could have claimed it first.
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = $1 FOR UPDATE SKIP LOCKED`,
      [job.id],
    );
    if (!rows[0] || rows[0].status !== 'planned') {
      await client.query('ROLLBACK');
      return;
    }

    const frameInput = job.input as FrameJobInput;
    const resolvedDeps = job.frameId ? await resolveDeps(client, cohortId, job.projectId, job.frameId, step.dependsOn) : {};
    const payload = step.builder({
      job: frameInput,
      resolvedDeps,
      projectId: job.projectId,
      frameId: job.frameId,
    });

    const jobToken = webhookToken(deps.webhookSecret, job.id);
    const webhookUrl = `${deps.publicBaseUrl}/v1/webhooks/runpod/${jobToken}`;

    const res = await runWithPausedRetry(deps, job.id, step.endpointId, () =>
      deps.runpod.run(step.endpointId, payload, webhookUrl),
    );

    if (res.status === 'COMPLETED') {
      // Synchronous completion — a warm, fast endpoint can return the
      // finished output inline on /run (impl plan §6.4).
      await markSubmitted(client, job.id, res.id);
      await markTerminal(client, job.id, { status: 'complete', output: res.output });
      await recordJobCost(client, {
        jobId: job.id,
        endpointId: step.endpointId,
        executionMs: res.executionTime ?? null,
        delayMs: res.delayTime ?? null,
        workerRateUsdS: deps.cfg.workerRateUsdS,
      });
      await client.query('COMMIT');
      await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_completed');
      log().info({ jobId: job.id, stepSeq: step.seq }, 'generator: synchronous completion');
    } else if (isTerminal(res.status)) {
      await markSubmitted(client, job.id, res.id);
      await markTerminal(client, job.id, { status: 'failed', error: { status: res.status } });
      await client.query('COMMIT');
      await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_failed');
      log().warn({ jobId: job.id, stepSeq: step.seq, status: res.status }, 'generator: submission returned terminal failure');
    } else {
      await markSubmitted(client, job.id, res.id);
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log().error({ jobId: job.id, err }, 'generator: submission failed');
    throw err;
  } finally {
    client.release();
  }
}

/** HMAC-ish per-job token embedded in the callback URL — RunPod cannot
 * attach custom auth headers (impl plan §7.2, same constraint
 * src/handlers/webhook.ts already solved with a `?key=` param). */
export function webhookToken(secret: string, jobId: number): string {
  return createHmac('sha256', secret).update(String(jobId)).digest('hex').slice(0, 32);
}

/** §6.4's reconcile tick — the fallback for a missed/delayed webhook.
 * Optional projectId scopes this to one project's rows only — see
 * runStep()'s doc comment for why. */
export async function reconcileTick(
  deps: GeneratorDeps,
  cohortId: string,
  step: CatalogEntry,
  baselineSec = 60,
  projectId?: string,
): Promise<void> {
  const stale = await listStale(deps.pool, cohortId, step.seq, new Date(Date.now() - baselineSec * 1000), projectId);
  for (const job of stale) {
    if (!job.runpodJobId) continue;
    try {
      const res = await deps.runpod.status(step.endpointId, job.runpodJobId);
      if (res.status === 'COMPLETED' || isTerminal(res.status)) {
        const client = await deps.pool.connect();
        try {
          await client.query('BEGIN');
          if (res.status === 'COMPLETED') {
            await markTerminal(client, job.id, { status: 'complete', output: res.output });
            await recordJobCost(client, {
              jobId: job.id,
              endpointId: step.endpointId,
              executionMs: res.executionTime ?? null,
              delayMs: res.delayTime ?? null,
              workerRateUsdS: deps.cfg.workerRateUsdS,
            });
          } else {
            await markTerminal(client, job.id, { status: 'failed', error: { status: res.status } });
          }
          await client.query('COMMIT');
          await incrementStepCounters(deps.pool, cohortId, step.seq, res.status === 'COMPLETED' ? 'job_completed' : 'job_failed');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      }
    } catch (err) {
      log().warn({ jobId: job.id, err }, 'generator: reconcile status check failed, will retry next tick');
    }
  }
}

/**
 * Runs one step to completion: claims + submits work up to the target
 * worker count, waits for webhooks/reconcile to bring every job to a
 * terminal state. `targetWorkers` is the planned/configured worker count
 * for this step (`steps.workers_target`) — as of the M3 fix (2026-09-10)
 * this is no longer a fleet-verified real count (allocate() doesn't poll
 * for readiness anymore); it's the ceiling RunPod's own QUEUE_DELAY
 * autoscaler is expected to grow real capacity into as jobs actually land
 * against it. submitOne() just POSTs /run, which RunPod queues regardless
 * of current real worker count — that's the whole mechanism this relies on.
 *
 * `projectId` (M5 phase 1, 2026-09-11): when provided, every claim/read
 * this loop does is additionally scoped to that one project's jobs for this
 * step — the reuse point that lets agents/assembler.ts drive an
 * assembly step one project at a time without duplicating this whole
 * crash-safe claim/submit/reconcile loop. Undefined (the default) preserves
 * the exact cohort-wide behavior steps 1-5 already rely on.
 */
export async function runStep(
  deps: GeneratorDeps,
  cohortId: string,
  step: CatalogEntry,
  targetWorkers: number,
  projectId?: string,
): Promise<void> {
  await updateStepStatus(deps.pool, cohortId, step.seq, 'running', { startedAt: new Date() });
  log().info({ stepSeq: step.seq, targetWorkers, projectId }, 'generator: step running');

  const loopStartedAt = Date.now();
  let warmedAt: Date | null = null;

  for (;;) {
    const { total, terminal } = await stepJobCounts(deps.pool, cohortId, step.seq, projectId);
    if (terminal >= total) break;

    const inFlight = (await listInFlight(deps.pool, cohortId, step.seq, projectId)).length;
    const room = Math.max(0, targetWorkers - inFlight);
    if (room > 0) {
      const batch = await claimBatchReadOnly(deps.pool, cohortId, step.seq, room, projectId);
      for (const job of batch) {
        await submitOne(deps, cohortId, step, job);
      }
    }

    await reconcileTick(deps, cohortId, step, 60, projectId);
    // Keep endpoint_state.observed_at fresh for the whole time this step is
    // actively generating, not just at allocation — watchdog.ts's orphan
    // grace window is measured from this timestamp.
    await touchObserved(deps.pool, step.endpointId);

    // Non-blocking cold-start check — only probes until this step has
    // observed a real ready worker; a no-op for the rest of the step once
    // warm. Restores the protection allocate()'s removed blocking poll used
    // to provide, without its billing cost: workersMin stays 0 throughout,
    // so a stuck cold start here costs nothing while waiting, unlike the
    // 2026-09-10 incident where 5 active workers billed for the full
    // warmTimeoutMs with zero job throughput.
    if (!warmedAt) {
      try {
        const h = await deps.runpod.health(step.endpointId);
        const ready = h.workers.ready ?? 0;
        if (ready > 0) {
          warmedAt = new Date();
          await updateStepStatus(deps.pool, cohortId, step.seq, 'running', { warmAt: warmedAt });
          log().info({ stepSeq: step.seq, endpointId: step.endpointId }, 'generator: endpoint observed warm');
        } else if (Date.now() - loopStartedAt > deps.cfg.warmTimeoutMs && terminal === 0) {
          // terminal===0, not a fraction/total check: the moment ANY job in
          // this step reaches complete/failed, forward progress happened,
          // so "the endpoint never came up" stops being the right diagnosis
          // even if ready is still reading 0 for some unrelated reason.
          // This also sidesteps a real, pre-existing, separate bug rather
          // than masking it: a job whose upstream dependency FAILED (not
          // completed) never decrements deps_remaining (db/repo/jobs.ts —
          // no rework path until M4), so it can sit stuck forever. Don't
          // "fix" this condition into checking total/terminal ratios; that
          // would reintroduce a false stall on a healthy endpoint whenever
          // any single frame's dependency chain is broken.
          await updateStepStatus(deps.pool, cohortId, step.seq, 'stalled');
          throw new GeneratorStallError('warm_timeout', {
            endpointId: step.endpointId,
            stepSeq: step.seq,
            elapsedMs: Date.now() - loopStartedAt,
            total,
            terminal,
          });
        }
      } catch (err) {
        if (err instanceof GeneratorStallError) throw err;
        log().warn({ stepSeq: step.seq, err }, 'generator: warm-check health probe failed, will retry next tick');
      }
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, deps.cfg.reconcileIntervalMs)));
  }

  await updateStepStatus(deps.pool, cohortId, step.seq, 'generated');
  log().info({ stepSeq: step.seq }, 'generator: step generated (every job terminal)');
}

/** Unlocked read of candidate jobs — submitOne() does the real FOR UPDATE
 * SKIP LOCKED claim per-job right before submitting, so this is just "what
 * to try next," not the crash-safety boundary. */
async function claimBatchReadOnly(pool: Pool, cohortId: string, stepSeq: number, limit: number, projectId?: string): Promise<JobRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await claimNextBatch(client, cohortId, stepSeq, limit, projectId);
    await client.query('ROLLBACK'); // release the locks immediately; submitOne reclaims per-job
    return rows;
  } finally {
    client.release();
  }
}
