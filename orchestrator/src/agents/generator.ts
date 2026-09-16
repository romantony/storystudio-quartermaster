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
import { auxiliaryEndpoints, fallbackRouteFor, type CatalogEntry, type FallbackRoute } from '../steps/catalog';
import type { BuildContext, FrameJobInput, ResolvedDeps } from '../steps/builders/types';
import { log } from '../telemetry/log';
import { claimNextBatch, markSubmitted, markTerminal, markFailedOrRetry, listInFlight, stepJobCounts, listStale, type JobRow } from '../db/repo/jobs';
import { updateStepStatus, incrementStepCounters } from '../db/repo/steps';
import { recordJobCost } from '../db/repo/costs';
import { touchObserved } from '../db/repo/endpoint-state';
import { runpodOutUrl } from '../runpod/output';
import { countUngated } from '../db/repo/quality';
import { createPrediction, getPrediction, type ReplicateTransport } from '../quality/replicate';
import { invokeRemotionOverlay, type LambdaTransport, type RemotionOverlayInput } from '../lambda/client';
import { persistToR2, type R2Transport } from '../r2/client';

export interface GeneratorDeps {
  pool: Pool;
  runpod: RunpodClient;
  // warmTimeoutMs: fleet.ts's allocate() no longer polls for readiness (M3
  // fix, 2026-09-10) — runStep()'s own non-blocking cold-start check owns
  // that timeout now, reusing the same config value.
  cfg: Pick<Config, 'workerRateUsdS' | 'reconcileIntervalMs' | 'warmTimeoutMs' | 'maxAttempts' | 'lambdaRenderRateUsdS'>;
  /** Base URL this process is reachable at (e.g. https://orchestrator.ai-storystudio.com),
   * used to build each job's per-job webhook callback URL. */
  publicBaseUrl: string;
  webhookSecret: string;
  /** Injectable for tests so the ENDPOINT_PAUSED retry backoff does not
   * actually wait. Defaults to a real setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Replicate transport for 'replicate' fallback routes (steps/catalog.ts).
   * Optional: without it such a job fails at submission like any build error. */
  replicate?: ReplicateTransport;
  /** AWS Lambda transport for `source: 'lambda'` steps (steps/catalog.ts's
   * seq 16, Remotion text overlay). Optional: without it such a job fails at
   * submission with a clear error, same as a missing replicate token above. */
  lambda?: LambdaTransport;
  /** R2 transport (src/r2/client.ts) — a lambda-sourced step's real output
   * (currently only step 16) is re-hosted here before being marked
   * complete, since Remotion Lambda's own S3 bucket isn't QM's storage.
   * Optional, same fail-fast-at-submission behavior as `lambda` above. */
  r2?: R2Transport;
}

/** Prefix on jobs.runpod_job_id while a job is a Replicate prediction (the
 * first hop of a 'replicate' fallback route). Webhooks never match it. */
export const REPLICATE_HANDLE_PREFIX = 'replicate:';

/** The RunPod endpoint a job is (or will be) running on. */
export function jobEndpointId(step: CatalogEntry, input: unknown): string {
  const route = fallbackRouteFor(step, input);
  if (route?.provider === 'runpod') return route.endpointId;
  if (route?.provider === 'replicate') return route.normalize.endpointId;
  return step.endpointId;
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
    const output = rows[0]?.output;
    const url = output ? runpodOutUrl(output) : undefined;
    // duration_s: only tts's output shape carries it, but reading it
    // unconditionally off any dependency's raw output is harmless — every
    // other step's output either lacks the key or nothing reads it there.
    const durationS =
      output && typeof output === 'object' && 'duration_s' in output && typeof (output as { duration_s: unknown }).duration_s === 'number'
        ? (output as { duration_s: number }).duration_s
        : undefined;
    resolved[seq] = url || durationS !== undefined ? { url, durationS } : undefined;
  }
  return resolved;
}

/** Resolves a `singleJobPerProject` step's fan-in dependencies (e.g. step 8's
 * concat needs every frame's step-6 output, not one frame's) — the
 * project-scoped counterpart to resolveDeps() above. `ORDER BY seq` recovers
 * each frame's original narrative order for free: planner.ts already assigns
 * a per-frame job's `seq` from its index in the request's frames[] array, so
 * no separate ordering field is needed. `status IN ('complete','failed')`
 * matches markTerminal()'s widened fan-in decrement (db/repo/jobs.ts) — a
 * hard-failed frame still counts toward this job becoming claimable, but its
 * output naturally has no resolvable URL and is filtered out below rather
 * than blocking the whole project's concat on one bad frame. */
async function resolveProjectDeps(
  client: PoolClient,
  cohortId: string,
  projectId: string,
  dependsOn: number[],
): Promise<{ urls: Record<number, string[]>; details: NonNullable<BuildContext['perFrameDetails']> }> {
  const urls: Record<number, string[]> = {};
  const details: NonNullable<BuildContext['perFrameDetails']> = {};
  for (const seq of dependsOn) {
    const { rows } = await client.query<{ output: unknown; frame_id: string | null }>(
      `SELECT output, frame_id FROM jobs WHERE cohort_id = $1 AND project_id = $2 AND step_seq = $3 AND status IN ('complete', 'failed') ORDER BY seq ASC`,
      [cohortId, projectId, seq],
    );
    details[seq] = rows.map((r) => {
      const d = (r.output as { duration_s?: unknown } | null)?.duration_s;
      return { frameId: r.frame_id, url: runpodOutUrl(r.output), durationS: typeof d === 'number' ? d : undefined };
    });
    urls[seq] = details[seq].map((x) => x.url).filter((url): url is string => !!url);
  }
  return { urls, details };
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
    const projectDeps = job.frameId ? undefined : await resolveProjectDeps(client, cohortId, job.projectId, step.dependsOn);
    const route: FallbackRoute | undefined = fallbackRouteFor(step, frameInput);
    let payload: Record<string, unknown>;
    try {
      if (route?.provider === 'replicate' && !deps.replicate?.apiToken) {
        throw new Error(`fallback ${frameInput.fallbackRung}: no Replicate API token configured`);
      }
      payload = (route?.builder ?? step.builder)({
        job: frameInput,
        resolvedDeps,
        perFrameOutputs: projectDeps?.urls,
        perFrameDetails: projectDeps?.details,
        projectId: job.projectId,
        frameId: job.frameId,
      });
    } catch (err) {
      // A builder refusing THIS job (e.g. its upstream frame failed, so there
      // is no image to animate) fails this job only — never the whole step.
      // Real incident 2026-09-15 (win_2026_09_15_06): f12's image failed on
      // RunPod, its i2v builder threw, and the throw aborted all 36 frames'
      // animation and the cohort. markTerminal() still decrements dependents,
      // so the frame drops out downstream exactly like a RunPod failure.
      const message = err instanceof Error ? err.message : String(err);
      await markTerminal(client, job.id, { status: 'failed', error: { stage: 'build', error: message } });
      await client.query('COMMIT');
      await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_failed');
      log().warn({ jobId: job.id, stepSeq: step.seq, frameId: job.frameId, error: message }, 'generator: payload build failed, job marked failed');
      return;
    }

    if (route?.provider === 'replicate') {
      // Hop 1 of the model-switch video fallback: a Replicate prediction,
      // polled by reconcileTick(), which then submits hop 2 (normalize).
      const prediction = await createPrediction(deps.replicate!, route.model, payload);
      await markSubmitted(client, job.id, `${REPLICATE_HANDLE_PREFIX}${prediction.id}`);
      await client.query('COMMIT');
      log().info({ jobId: job.id, stepSeq: step.seq, model: route.model, predictionId: prediction.id }, 'generator: fallback submitted to Replicate');
      return;
    }

    if (step.source === 'lambda') {
      // No fallback routing, no run/status/webhook cycle — a single
      // synchronous invoke that already blocks until Remotion's render
      // finishes (src/lambda/client.ts). Modeled on the RunPod
      // synchronous-COMPLETED branch below: mark submitted + terminal in
      // one step, since there's nothing to reconcile later.
      if (!deps.lambda) throw new Error(`step ${step.seq} (${step.name}) is source:'lambda' but no lambda transport is configured`);

      // steps/builders/remotion-overlay.ts's per-frame-optional escape hatch:
      // a frame with no textManifest returns this marker instead of a real
      // Lambda payload — complete immediately with the clip unchanged,
      // never invoke Lambda at all (no cost, no risk of concat's fan-in
      // silently dropping this frame — see that builder's header comment).
      if ((payload as { __passthrough?: boolean }).__passthrough) {
        const clipUrl = (payload as { clipUrl: string }).clipUrl;
        await markSubmitted(client, job.id, `lambda:${job.id}`);
        await markTerminal(client, job.id, { status: 'complete', output: { video: clipUrl } });
        await client.query('COMMIT');
        await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_completed');
        log().info({ jobId: job.id, stepSeq: step.seq }, 'generator: lambda step skipped (no textManifest), clip passed through unchanged');
        return;
      }

      const startedAt = Date.now();
      let result: { overlayRenderedUrl: string };
      try {
        result = await invokeRemotionOverlay(deps.lambda, payload as unknown as RemotionOverlayInput);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retried = await markFailedOrRetry(client, job.id, { error: message }, deps.cfg.maxAttempts);
        await client.query('COMMIT');
        if (!retried) await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_failed');
        log().warn({ jobId: job.id, stepSeq: step.seq, error: message, retried }, 'generator: lambda invoke failed');
        return;
      }

      // Remotion Lambda's output lives on ITS OWN S3 bucket, not QM's —
      // re-host into R2 (src/r2/client.ts) before marking complete, same
      // "throw, don't fall back to the ephemeral URL" philosophy as the
      // top-level repo's persistExternalAsset.ts (real incident precedent:
      // 103/122 shots lost to dead replicate.delivery links because that
      // persistence didn't exist yet for that provider). A persist failure
      // is treated exactly like an invoke failure — retry/fail the job,
      // never complete with a link QM doesn't control the retention of.
      if (!deps.r2) throw new Error(`step ${step.seq} (${step.name}) is source:'lambda' but no r2 transport is configured`);
      const r2Key = `remotion-overlay/${job.projectId}/${job.frameId ?? job.id}.mp4`;
      let permanentUrl: string;
      try {
        permanentUrl = await persistToR2(deps.r2, result.overlayRenderedUrl, r2Key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retried = await markFailedOrRetry(client, job.id, { error: message }, deps.cfg.maxAttempts);
        await client.query('COMMIT');
        if (!retried) await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_failed');
        log().warn({ jobId: job.id, stepSeq: step.seq, error: message, retried }, 'generator: r2 persist of lambda output failed');
        return;
      }

      // `video`, not `overlayRenderedUrl`, so runpodOutUrl() (runpod/output.ts)
      // resolves it downstream the same way every other video-producing
      // step's output already does — no change needed to its key list.
      const output = { video: permanentUrl };
      const executionMs = Date.now() - startedAt;
      await markSubmitted(client, job.id, `lambda:${job.id}`);
      await markTerminal(client, job.id, { status: 'complete', output });
      await recordJobCost(client, {
        jobId: job.id,
        endpointId: step.endpointId,
        executionMs,
        delayMs: null,
        workerRateUsdS: deps.cfg.lambdaRenderRateUsdS,
      });
      await client.query('COMMIT');
      await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_completed');
      log().info({ jobId: job.id, stepSeq: step.seq, executionMs }, 'generator: lambda synchronous completion');
      return;
    }

    const endpointId = route?.provider === 'runpod' ? route.endpointId : step.endpointId;
    const jobToken = webhookToken(deps.webhookSecret, job.id);
    const webhookUrl = `${deps.publicBaseUrl}/v1/webhooks/runpod/${jobToken}`;

    const res = await runWithPausedRetry(deps, job.id, endpointId, () =>
      deps.runpod.run(endpointId, payload, webhookUrl),
    );

    if (res.status === 'COMPLETED') {
      // Synchronous completion — a warm, fast endpoint can return the
      // finished output inline on /run (impl plan §6.4).
      await markSubmitted(client, job.id, res.id);
      await markTerminal(client, job.id, { status: 'complete', output: res.output });
      await recordJobCost(client, {
        jobId: job.id,
        endpointId,
        executionMs: res.executionTime ?? null,
        delayMs: res.delayTime ?? null,
        workerRateUsdS: deps.cfg.workerRateUsdS,
      });
      await client.query('COMMIT');
      await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_completed');
      log().info({ jobId: job.id, stepSeq: step.seq }, 'generator: synchronous completion');
    } else if (isTerminal(res.status)) {
      await markSubmitted(client, job.id, res.id);
      const retried = await markFailedOrRetry(client, job.id, { status: res.status }, deps.cfg.maxAttempts);
      await client.query('COMMIT');
      if (!retried) await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_failed');
      log().warn({ jobId: job.id, stepSeq: step.seq, status: res.status, retried }, 'generator: submission returned terminal failure');
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
    if (job.runpodJobId.startsWith(REPLICATE_HANDLE_PREFIX)) {
      try {
        await advanceReplicateJob(deps, cohortId, step, job);
      } catch (err) {
        log().warn({ jobId: job.id, err }, 'generator: replicate fallback check failed, will retry next tick');
      }
      continue;
    }
    const endpointId = jobEndpointId(step, job.input);
    try {
      const res = await deps.runpod.status(endpointId, job.runpodJobId);
      if (res.status === 'COMPLETED' || isTerminal(res.status)) {
        const client = await deps.pool.connect();
        let retried = false;
        try {
          await client.query('BEGIN');
          if (res.status === 'COMPLETED') {
            await markTerminal(client, job.id, { status: 'complete', output: res.output });
            await recordJobCost(client, {
              jobId: job.id,
              endpointId,
              executionMs: res.executionTime ?? null,
              delayMs: res.delayTime ?? null,
              workerRateUsdS: deps.cfg.workerRateUsdS,
            });
          } else {
            retried = await markFailedOrRetry(client, job.id, { status: res.status }, deps.cfg.maxAttempts);
          }
          await client.query('COMMIT');
          if (!retried) {
            await incrementStepCounters(deps.pool, cohortId, step.seq, res.status === 'COMPLETED' ? 'job_completed' : 'job_failed');
          }
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
    // A gated step isn't done when every job is terminal — the quality gate
    // may still send one back to 'planned' (rework), and nothing else ever
    // resubmits it once this loop has returned. Real deadlock, 2026-09-15
    // (cohort win_2026_09_15_06): step 0 exited, then f12/f13's second image
    // rework landed 30 s later and gateStep() waited forever on 2 planned
    // jobs. Race-free: a verdict atomically either marks a job gated or
    // un-terminals it, so this check always sees one or the other.
    if (terminal >= total && (!step.gate || (await countUngated(deps.pool, cohortId, step.seq)) === 0)) break;

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
    for (const aux of auxiliaryEndpoints(step)) await touchObserved(deps.pool, aux.endpointId);

    // Non-blocking cold-start check — only probes until this step has
    // observed a real ready worker; a no-op for the rest of the step once
    // warm. Restores the protection allocate()'s removed blocking poll used
    // to provide, without its billing cost: workersMin stays 0 throughout,
    // so a stuck cold start here costs nothing while waiting, unlike the
    // 2026-09-10 incident where 5 active workers billed for the full
    // warmTimeoutMs with zero job throughput.
    // Doesn't apply to a `source: 'lambda'` step at all — there's no RunPod
    // worker pool to warm-check, and step.endpointId is a sentinel, not a
    // real RunPod endpoint (deps.runpod.health() would just 404/error on
    // it every tick for no benefit — jobs complete synchronously in
    // submitOne(), so `terminal` reaches `total` almost immediately anyway).
    if (!warmedAt && step.source !== 'lambda') {
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

/**
 * Hop 1 -> hop 2 of a 'replicate' fallback (steps/catalog.ts): once the
 * Replicate prediction succeeds, send its (expiring, 832x480) clip to the
 * route's normalize step on RunPod with the job's normal webhook, and re-point
 * the job at that RunPod id — the webhook/reconcile path then completes the
 * row exactly like any other RunPod job. A failed prediction goes through
 * markFailedOrRetry(), so it gets the same retry budget as a RunPod failure.
 */
async function advanceReplicateJob(deps: GeneratorDeps, cohortId: string, step: CatalogEntry, job: JobRow): Promise<void> {
  const route = fallbackRouteFor(step, job.input);
  if (route?.provider !== 'replicate' || !deps.replicate) return;
  const predictionId = job.runpodJobId!.slice(REPLICATE_HANDLE_PREFIX.length);
  const prediction = await getPrediction(deps.replicate, predictionId);

  if (prediction.status === 'succeeded') {
    const out = prediction.output;
    const videoUrl = typeof out === 'string' ? out : Array.isArray(out) ? String(out[0] ?? '') : runpodOutUrl(out);
    if (!videoUrl || !videoUrl.startsWith('http')) {
      await failOrRetry(deps, cohortId, step, job, { provider: 'replicate', predictionId, error: 'prediction succeeded without a video URL' });
      return;
    }
    const payload = route.normalize.builder(videoUrl, { projectId: job.projectId, frameId: job.frameId });
    const webhookUrl = `${deps.publicBaseUrl}/v1/webhooks/runpod/${webhookToken(deps.webhookSecret, job.id)}`;
    const res = await runWithPausedRetry(deps, job.id, route.normalize.endpointId, () =>
      deps.runpod.run(route.normalize.endpointId, payload, webhookUrl),
    );
    const client = await deps.pool.connect();
    let outcome: 'submitted' | 'complete' | 'failed' | 'retried' = 'submitted';
    try {
      await client.query('BEGIN');
      await markSubmitted(client, job.id, res.id);
      if (res.status === 'COMPLETED') {
        await markTerminal(client, job.id, { status: 'complete', output: res.output });
        await recordJobCost(client, {
          jobId: job.id,
          endpointId: route.normalize.endpointId,
          executionMs: res.executionTime ?? null,
          delayMs: res.delayTime ?? null,
          workerRateUsdS: deps.cfg.workerRateUsdS,
        });
        outcome = 'complete';
      } else if (isTerminal(res.status)) {
        outcome = (await markFailedOrRetry(client, job.id, { status: res.status, stage: 'normalize' }, deps.cfg.maxAttempts)) ? 'retried' : 'failed';
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (outcome === 'complete') await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_completed');
    if (outcome === 'failed') await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_failed');
    log().info({ jobId: job.id, predictionId, runpodJobId: res.id, outcome }, 'generator: replicate fallback output sent to normalize');
    return;
  }

  if (prediction.status === 'failed' || prediction.status === 'canceled') {
    const error = typeof prediction.error === 'string' ? prediction.error.slice(0, 500) : JSON.stringify(prediction.error ?? null).slice(0, 500);
    await failOrRetry(deps, cohortId, step, job, { provider: 'replicate', predictionId, status: prediction.status, error });
  }
}

async function failOrRetry(deps: GeneratorDeps, cohortId: string, step: CatalogEntry, job: JobRow, error: Record<string, unknown>): Promise<void> {
  const client = await deps.pool.connect();
  let retried = false;
  try {
    await client.query('BEGIN');
    retried = await markFailedOrRetry(client, job.id, error, deps.cfg.maxAttempts);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  if (!retried) await incrementStepCounters(deps.pool, cohortId, step.seq, 'job_failed');
  log().warn({ jobId: job.id, error, retried }, 'generator: fallback job failed');
}
