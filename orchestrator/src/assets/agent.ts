/**
 * The generator agent, instantiated once per asset type (2026-09-19).
 *
 * There is one loop here, not eight: what differs between the qwen-image-gen
 * agent and the mmaudio agent is entirely data (assets/kinds.ts's spec — its
 * table, its endpoint, its pod limit, its payload builder), so the behaviour
 * is written once and parameterised by `AssetKind`.
 *
 * Each tick is the operator's description, literally:
 *
 *   1. poll MY OWN table for rows that are ready ("not started")
 *   2. queue them against MY endpoint's own pod limit — never more in flight
 *      than that endpoint has pods, so eight agents saturating at once still
 *      sum inside the 40-worker account cap
 *   3. on completion, write back status + the CDN url AND write that url into
 *      the next table, in one transaction
 *
 * Two things it deliberately does NOT do:
 *
 *   * It never touches `workersMax`. The fixed-pod policy is absolute (memory
 *     qm-orchestrator-diagnostics-and-fixed-pods-20260917): pod counts are
 *     read from the registry, and an admin maintains them on the dashboard.
 *   * It never looks at another asset kind's queue, another project, or any
 *     notion of order. Whatever is `pending` is fair game, whichever project
 *     it belongs to — that is what keeps every GPU busy while anything at all
 *     is queued.
 */
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import { backoffMs } from '../runpod/client';
import { isTerminal, RunpodError, extractErrorText, isResourceExhaustionError, type RunResponse } from '../runpod/types';
import { runpodOutUrl } from '../runpod/output';
import { log } from '../telemetry/log';
import { assetSpec, builderFor, type AssetKind } from './kinds';
import { handoffTargets, nextStage, toResolvedDeps, type AssetPlan } from './plan';
import { getPipelineProject } from '../db/repo/pipeline';
import {
  claimPending,
  completeAsset,
  countInFlightForEndpoint,
  advanceStage,
  failOrRetryAsset,
  listStaleSubmitted,
  markSubmitted,
  reworkAsset,
  touchAsset,
  PROJECT_SCOPE,
  type AssetRow,
  type HandoffTarget,
} from '../db/repo/assets';
import { recordAssetCost } from '../db/repo/asset-costs';
import type { FrameJobInput } from '../steps/builders/types';
import { invokeRemotionOverlay, type LambdaTransport, type RemotionOverlayInput } from '../lambda/client';
import { persistToR2, type R2Transport } from '../r2/client';

export interface AssetAgentDeps {
  pool: Pool;
  runpod: RunpodClient;
  cfg: Pick<
    Config,
    | 'workerRateUsdS'
    | 'maxAttempts'
    | 'maxResourceAttempts'
    | 'assetReconcileAfterMs'
    | 'assetDispatchBatchSize'
    | 'lambdaRenderRateUsdS'
  >;
  publicBaseUrl: string;
  webhookSecret: string;
  sleepImpl?: (ms: number) => Promise<void>;
  /** AWS Lambda transport for `provider: 'lambda'` kinds (`remotion`).
   * Without it such a row fails at submission with a clear error. */
  lambda?: LambdaTransport;
  /** Where a Lambda's output is re-hosted. Remotion Lambda writes to ITS OWN
   * S3 bucket, which QM does not control the retention of — the same class of
   * problem that cost 103/122 shots to expired replicate.delivery links on
   * 2026-08-17. Required alongside `lambda`. */
  r2?: R2Transport;
}

export interface TickSummary {
  kind: AssetKind;
  submitted: number;
  completed: number;
  failed: number;
  /** Requests cancelled and resubmitted for outrunning `timeoutMs`. */
  timedOut: number;
  inFlight: number;
  skippedNoRoom: boolean;
}

/** Per-asset callback token, same construction and the same reason as the
 * cohort path's (RunPod cannot attach custom auth headers, so the secret
 * rides in the URL). Namespaced with `asset:` so a token minted for a `jobs`
 * row can never validate against an asset row and vice versa. */
export function assetWebhookToken(secret: string, assetId: number): string {
  return createHmac('sha256', secret).update(`asset:${assetId}`).digest('hex').slice(0, 32);
}

/** Retry budget for THIS failure — the wider one for a resource-exhaustion
 * error, which is worker-assignment-dependent and genuinely worth retrying
 * (the 2026-09-16 CUDA-OOM incident), the default otherwise. */
export function assetRetryCeiling(errorText: string | undefined, cfg: Pick<Config, 'maxAttempts' | 'maxResourceAttempts'>): number {
  return isResourceExhaustionError(errorText) ? Math.max(cfg.maxAttempts, cfg.maxResourceAttempts) : cfg.maxAttempts;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const ENDPOINT_PAUSED_MAX_ATTEMPTS = 8;

/** How long a synchronous Lambda row may sit `submitted` before it is treated
 * as orphaned by a dead process. Not a timeout — `remotion` has none by
 * design; this only recovers rows nobody is awaiting any more. */
const LAMBDA_ORPHAN_RECOVERY_MS = 600_000;

function isEndpointPausedRace(err: unknown): boolean {
  return (
    err instanceof RunpodError &&
    err.status === 409 &&
    (err.body as { code?: string } | undefined)?.code === 'ENDPOINT_PAUSED'
  );
}

/** A fixed-pod endpoint that drifted to zero workers answers 409
 * ENDPOINT_PAUSED until RunPod brings one back. Cheap to wait out — no
 * worker is billed while it is paused. */
async function runWithPausedRetry(
  deps: AssetAgentDeps,
  assetId: number,
  endpointId: string,
  attempt: () => Promise<RunResponse>,
): Promise<RunResponse> {
  const sleepImpl = deps.sleepImpl ?? defaultSleep;
  for (let tries = 0; ; tries += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!isEndpointPausedRace(err) || tries >= ENDPOINT_PAUSED_MAX_ATTEMPTS) throw err;
      log().warn({ assetId, endpointId, attempt: tries + 1 }, 'asset-agent: endpoint paused, retrying submission');
      await sleepImpl(backoffMs(tries));
    }
  }
}

/** The handoff list for a completed row: every asset kind that declared this
 * one as a required input. Resolved from the project's own persisted plan, so
 * an agent never hard-codes a successor. */
export function resolveHandoffs(plan: AssetPlan, kind: AssetKind, input: unknown): HandoffTarget[] {
  return handoffTargets(plan, kind).map((target) => {
    const spec = assetSpec(target);
    const stages = plan.stages[target] ?? [];
    return {
      kind: target,
      requiredInputs: plan.requires[target] ?? [],
      endpointId: spec.endpointId,
      stage: stages[0] ?? null,
      stages,
      // Only used if the handoff is what CREATES the row (a repair case);
      // the ordinary path found it already written at submission time.
      input,
    };
  });
}

function buildPayload(row: AssetRow): Record<string, unknown> {
  const spec = assetSpec(row.kind);
  const build = builderFor(spec, row.stage);
  const sources = { ...row.sources };
  // A multi-stage row feeds its own previous stage's output forward, read at
  // this kind's own legacySeq. No kind uses stages today; the machinery is
  // kept for the Remotion overlay.
  if (row.stage && row.stages.indexOf(row.stage) > 0 && row.assetUrl) {
    sources[row.kind] = { url: row.assetUrl, durationS: row.durationS ?? undefined };
  }
  return build({
    // A project-scoped row's `input` is not a frame at all — `bgm` carries a
    // prompt and a target length, `postprod-lite` carries the manifest — but
    // every builder reads only the fields it needs off `ctx.job`, so one cast
    // covers both shapes.
    job: row.input as FrameJobInput,
    resolvedDeps: toResolvedDeps(sources),
    projectId: row.projectId,
    frameId: row.frameId === PROJECT_SCOPE ? null : row.frameId,
  });
}

/**
 * A worker that answers `COMPLETED` with `{"error": "..."}` in its output is
 * a real and routine postprod-lite behaviour (containers/media.md: "Errors
 * come back as {error} in output with the job still COMPLETED"). Treating it
 * as success is how a pipeline ends up with rows marked complete and no asset
 * behind them, which is the exact failure the 2026-08-17 incident was.
 */
function outputError(output: unknown): string | undefined {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const e = (output as { error?: unknown }).error;
    if (typeof e === 'string' && e.trim()) return e;
  }
  return undefined;
}

function outputDuration(output: unknown): number | undefined {
  if (output && typeof output === 'object') {
    const d = (output as { duration_s?: unknown }).duration_s;
    if (typeof d === 'number' && Number.isFinite(d)) return d;
  }
  return undefined;
}

/**
 * Apply a provider success to a row: advance its stage, or complete it and
 * hand off. Shared verbatim by the reconcile scan and the webhook receiver so
 * the two can race safely — both re-read the row under lock and the second
 * one finds it no longer `submitted` and does nothing.
 */
export async function applyAssetSuccess(
  deps: AssetAgentDeps,
  assetId: number,
  kind: AssetKind,
  output: unknown,
  billing?: { executionMs: number | null; delayMs: number | null },
): Promise<'completed' | 'advanced' | 'failed' | 'noop'> {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, asset_kind, project_id, frame_id, seq, status, stage, stages, input, sources,
              asset_url, duration_s, provider_job_id, endpoint_id
         FROM assets WHERE asset_kind = $2 AND id = $1 FOR UPDATE`,
      [assetId, kind],
    );
    const row = rows[0];
    if (!row || row.status !== 'submitted') {
      await client.query('ROLLBACK');
      return 'noop';
    }

    const workerError = outputError(output);
    const url = workerError ? undefined : runpodOutUrl(output);
    if (workerError || !url) {
      const reason = workerError ?? 'provider reported COMPLETED with no asset URL in its output';
      const retried = await failOrRetryAsset(client, assetId, kind, { stage: row.stage, error: reason.slice(0, 500) }, assetRetryCeiling(reason, deps.cfg));
      await client.query('COMMIT');
      log().warn({ assetId, kind, reason, retried }, 'asset-agent: completion carried no usable asset');
      return retried ? 'noop' : 'failed';
    }

    const durationS = outputDuration(output);

    if (billing) {
      await recordAssetCost(client, {
        assetId,
        assetKind: kind,
        projectId: row.project_id,
        frameId: row.frame_id,
        endpointId: row.endpoint_id,
        providerJobId: row.provider_job_id,
        executionMs: billing.executionMs,
        delayMs: billing.delayMs,
        workerRateUsdS: deps.cfg.workerRateUsdS,
      });
    }

    const spec = assetSpec(kind);
    const plan = await getPipelineProject(client, row.project_id).then((p) => p?.plan);
    const following = plan ? nextStage(plan, kind, row.stage) : null;
    if (following) {
      await advanceStage(client, assetId, kind, { stage: following, output, assetUrl: url, durationS });
      await client.query('COMMIT');
      log().info({ assetId, kind, stage: row.stage, next: following }, 'asset-agent: stage complete, row re-queued for its next call');
      return 'advanced';
    }

    // QA does NOT gate the handoff (operator's call, 2026-09-19): downstream
    // generation starts immediately and the quality verdict lands in
    // parallel. What the verdict gates is ASSEMBLY — assets/compiler.ts will
    // not compile a project until every gated asset has one.
    //
    // The trade is explicit: a rejected still may already have cost a Wan2
    // job by the time QA rejects it. assets/quality.ts's rework then resets
    // that frame's descendants so the clip is regenerated from the corrected
    // image, rather than shipping a clip made from a rejected frame.
    const handoffs = plan ? resolveHandoffs(plan, kind, row.input) : [];
    await completeAsset(
      client,
      { id: assetId, kind, projectId: row.project_id, frameId: row.frame_id, seq: row.seq },
      { output, assetUrl: url, durationS },
      handoffs,
      // `gated` here means "defer the handoff", which nothing does any more.
      false,
    );
    await client.query('COMMIT');
    log().info(
      { assetId, kind, projectId: row.project_id, frameId: row.frame_id, url, handoff: handoffs.map((h) => h.kind) },
      'asset-agent: complete, handed off',
    );
    return 'completed';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Apply a provider failure. Same race-safety contract as applyAssetSuccess. */
export async function applyAssetFailure(
  deps: AssetAgentDeps,
  assetId: number,
  kind: AssetKind,
  error: Record<string, unknown>,
): Promise<'retried' | 'failed' | 'noop'> {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM assets WHERE asset_kind = $2 AND id = $1 FOR UPDATE`,
      [assetId, kind],
    );
    if (!rows[0] || rows[0].status !== 'submitted') {
      await client.query('ROLLBACK');
      return 'noop';
    }
    const retried = await failOrRetryAsset(client, assetId, kind, error, assetRetryCeiling(extractErrorText(error), deps.cfg));
    await client.query('COMMIT');
    log().warn({ assetId, kind, error, retried }, 'asset-agent: provider job failed');
    return retried ? 'retried' : 'failed';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A `provider: 'lambda'` row. No run/status/webhook cycle: one synchronous
 * invoke that already blocks until the render finishes, then the output is
 * re-hosted into R2 before the row is marked complete. Modelled on
 * agents/generator.ts's identical branch for the cohort path's step 16.
 *
 * "Throw, don't fall back to the ephemeral URL" is deliberate: a persist
 * failure fails the row like an invoke failure rather than completing it with
 * a link that will expire.
 */
async function invokeLambdaRow(deps: AssetAgentDeps, kind: AssetKind, row: AssetRow, payload: Record<string, unknown>): Promise<void> {
  const spec = assetSpec(kind);

  // steps/builders/remotion-overlay.ts's per-frame escape hatch: a frame with
  // no textManifest completes immediately with its clip unchanged, never
  // invoking Lambda. Without it a mixed project (some frames captioned, some
  // not) would drop the uncaptioned ones out of the chain entirely.
  if ((payload as { __passthrough?: boolean }).__passthrough) {
    const clipUrl = (payload as { clipUrl: string }).clipUrl;
    await markSubmitted(deps.pool, row.id, kind, `lambda:passthrough:${row.id}`);
    await applyAssetSuccess(deps, row.id, kind, { video: clipUrl });
    log().info({ assetId: row.id, kind, frameId: row.frameId }, 'asset-agent: lambda step skipped (no textManifest), clip passed through');
    return;
  }

  if (!deps.lambda) throw new Error(`${kind} is provider:'lambda' but no lambda transport is configured`);
  if (!deps.r2) throw new Error(`${kind} is provider:'lambda' but no r2 transport is configured`);

  await markSubmitted(deps.pool, row.id, kind, `lambda:${row.id}:${row.attempts + 1}`);
  const startedAt = Date.now();
  try {
    const result = await invokeRemotionOverlay(deps.lambda, payload as unknown as RemotionOverlayInput);
    const permanentUrl = await persistToR2(
      deps.r2,
      result.overlayRenderedUrl,
      `remotion-overlay/${row.projectId}/${row.frameId}.mp4`,
    );
    await recordAssetCost(deps.pool, {
      assetId: row.id,
      assetKind: kind,
      projectId: row.projectId,
      frameId: row.frameId,
      endpointId: spec.endpointId,
      providerJobId: `lambda:${row.id}:${row.attempts + 1}`,
      executionMs: Date.now() - startedAt,
      delayMs: null,
      workerRateUsdS: deps.cfg.lambdaRenderRateUsdS,
    });
    // `video`, not `overlayRenderedUrl`, so runpodOutUrl() resolves it
    // downstream exactly like every other video-producing kind's output.
    await applyAssetSuccess(deps, row.id, kind, { video: permanentUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await applyAssetFailure(deps, row.id, kind, { provider: 'lambda', error: message.slice(0, 500) });
  }
}

/** Claim one row and submit it. Claim + submit + id write are one short
 * transaction so a crash can never leave a job running on RunPod with no row
 * pointing at it — the crash-safety boundary the cohort path settled on. */
async function submitOne(deps: AssetAgentDeps, kind: AssetKind, row: AssetRow): Promise<boolean> {
  const spec = assetSpec(kind);
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ status: string }>(
      `SELECT status FROM assets WHERE asset_kind = $2 AND id = $1 FOR UPDATE SKIP LOCKED`,
      [row.id, kind],
    );
    if (!rows[0] || rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return false;
    }

    let payload: Record<string, unknown>;
    try {
      payload = buildPayload(row);
    } catch (err) {
      // A builder refusing THIS row (its upstream frame failed, so there is
      // no image to animate) fails this row only. Never the agent, never
      // another project — the 2026-09-15 incident where one frame's throw
      // aborted all 36 frames' animation and the whole cohort.
      const message = err instanceof Error ? err.message : String(err);
      await client.query(
        `UPDATE assets SET status = 'failed', error = $3, completed_at = now(), updated_at = now()
          WHERE asset_kind = $2 AND id = $1`,
        [row.id, kind, { stage: 'build', error: message }],
      );
      await client.query('COMMIT');
      log().warn({ assetId: row.id, kind, error: message }, 'asset-agent: payload build failed, row failed');
      return false;
    }

    if (spec.provider === 'lambda') {
      // Claim it, then release the lock before a render that blocks for
      // ~11-17s — no row lock is ever held across a network call.
      await client.query(
        `UPDATE assets SET status = 'submitted', claimed_at = now(), updated_at = now()
          WHERE asset_kind = $2 AND id = $1`,
        [row.id, kind],
      );
      await client.query('COMMIT');
      await invokeLambdaRow(deps, kind, row, payload);
      return true;
    }

    const webhookUrl = `${deps.publicBaseUrl}/v1/webhooks/asset/${assetWebhookToken(deps.webhookSecret, row.id)}`;
    const res = await runWithPausedRetry(deps, row.id, spec.endpointId, () =>
      deps.runpod.run(spec.endpointId, payload, webhookUrl),
    );
    await markSubmitted(client, row.id, kind, res.id);
    await client.query('COMMIT');

    // A warm endpoint can return the finished output inline on /run. Applied
    // outside this transaction, through the same path a webhook would use,
    // so there is exactly one completion code path.
    if (res.status === 'COMPLETED') {
      await applyAssetSuccess(deps, row.id, kind, res.output, {
        executionMs: res.executionTime ?? null,
        delayMs: res.delayTime ?? null,
      });
    } else if (isTerminal(res.status)) {
      const errorText = extractErrorText(res.error, res.output);
      await applyAssetFailure(deps, row.id, kind, { status: res.status, error: errorText?.slice(0, 500) });
    }
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log().error({ assetId: row.id, kind, err }, 'asset-agent: submission failed');
    return false;
  } finally {
    client.release();
  }
}

/**
 * Cancel a request that has outrun its kind's `timeoutMs` and put it back in
 * the queue. The operator's numbers (2026-09-19) are tight on purpose — 150s
 * covers a cold qwen pod (~120s) with headroom, 300s covers Wan2 — because a
 * timeout costs one duplicate job while a wedged request costs the project.
 *
 * Cancel first, best-effort: RunPod may have already finished it, lost it, or
 * never started it, and none of those should stop the resubmission. Bounded
 * by the same `reworks` budget as any other requeue, so a request that times
 * out forever eventually fails instead of looping.
 */
async function timeoutAndResubmit(deps: AssetAgentDeps, kind: AssetKind, row: AssetRow): Promise<boolean> {
  const spec = assetSpec(kind);
  const outstandingMs = Date.now() - (row.submittedAt?.getTime() ?? Date.now());

  if (spec.cancelOnTimeout && row.providerJobId && spec.provider === 'runpod') {
    try {
      await deps.runpod.cancel(spec.endpointId, row.providerJobId);
    } catch (err) {
      // Already gone is the common case and exactly what we wanted.
      log().warn({ assetId: row.id, kind, err }, 'asset-agent: cancel of a timed-out request failed, resubmitting anyway');
    }
  }

  const requeued = await reworkAsset(deps.pool, row.id, kind, {
    reason: 'timeout',
    outstandingMs,
    timeoutMs: spec.timeoutMs,
    providerJobId: row.providerJobId,
  });
  log().warn(
    { assetId: row.id, kind, frameId: row.frameId, outstandingMs, timeoutMs: spec.timeoutMs, requeued },
    requeued
      ? 'asset-agent: request timed out, cancelled and resubmitted'
      : 'asset-agent: request timed out and the rework budget is exhausted, failed',
  );
  return requeued;
}

/** The reconcile scan — the fallback for a webhook that never arrived, and
 * where each kind's request timeout is enforced. */
async function reconcile(deps: AssetAgentDeps, kind: AssetKind): Promise<{ completed: number; failed: number; timedOut: number }> {
  const spec = assetSpec(kind);
  const stale = await listStaleSubmitted(deps.pool, kind, new Date(Date.now() - deps.cfg.assetReconcileAfterMs));
  let completed = 0;
  let failed = 0;
  let timedOut = 0;
  for (const row of stale) {
    // Timeout first: if the request has outrun its budget there is nothing to
    // learn from polling it again. `timeoutMs: null` (remotion) opts out.
    if (spec.timeoutMs !== null && row.submittedAt && Date.now() - row.submittedAt.getTime() > spec.timeoutMs) {
      timedOut += 1;
      if (!(await timeoutAndResubmit(deps, kind, row))) failed += 1;
      continue;
    }
    if (spec.provider === 'lambda') {
      // ORPHAN RECOVERY, not a timeout. A Lambda invoke is synchronous, so a
      // row still `submitted` long after it started means the invoking
      // process died mid-render — there is no job id to ask anyone about and
      // nothing to cancel. Requeue it; the render is deterministic, so a
      // second one produces the same frame.
      //
      // The window is generous on purpose: reconcile's own 60s would requeue
      // a render that is merely slow (measured ~11-17s/frame, but a heavy
      // frame could exceed it) and pay for it twice.
      const startedAt = row.submittedAt?.getTime() ?? 0;
      if (Date.now() - startedAt < LAMBDA_ORPHAN_RECOVERY_MS) continue;
      const outcome = await applyAssetFailure(deps, row.id, kind, {
        provider: 'lambda',
        error: 'no completion recorded — the invoking process probably died mid-render',
      });
      if (outcome === 'failed') failed += 1;
      continue;
    }
    if (!row.providerJobId) continue;
    try {
      const res = await deps.runpod.status(spec.endpointId, row.providerJobId);
      if (res.status === 'COMPLETED') {
        const outcome = await applyAssetSuccess(deps, row.id, kind, res.output, {
          executionMs: res.executionTime ?? null,
          delayMs: res.delayTime ?? null,
        });
        if (outcome === 'completed' || outcome === 'advanced') completed += 1;
        if (outcome === 'failed') failed += 1;
      } else if (isTerminal(res.status)) {
        const errorText = extractErrorText(res.error, res.output);
        const outcome = await applyAssetFailure(deps, row.id, kind, { status: res.status, error: errorText?.slice(0, 500) });
        if (outcome === 'failed') failed += 1;
      } else {
        // Still running. Touch it so the compiler's staleness clock measures
        // "no news from RunPod", not "nobody looked".
        await touchAsset(deps.pool, row.id, kind);
      }
    } catch (err) {
      // A non-Transient RunpodError means RunPod is telling us definitively
      // that this job id will never resolve (404 "job not found" — a real
      // 2026-09-16 incident where three such rows wedged a whole step
      // forever). Requeue for a fresh submission instead of polling a dead id.
      if (err instanceof RunpodError && err.klass !== 'Transient') {
        const outcome = await applyAssetFailure(deps, row.id, kind, { error: `status check: ${err.message}`.slice(0, 500) });
        if (outcome === 'failed') failed += 1;
      } else {
        log().warn({ assetId: row.id, kind, err }, 'asset-agent: status check failed, will retry next tick');
      }
    }
  }
  return { completed, failed, timedOut };
}

/**
 * One tick of one agent. Safe to call concurrently with itself — every claim
 * is `FOR UPDATE SKIP LOCKED` and every transition re-checks status under
 * lock — and safe to call when there is nothing to do (it is two indexed
 * queries and a return).
 */
export async function runAssetAgentTick(deps: AssetAgentDeps, kind: AssetKind): Promise<TickSummary> {
  const spec = assetSpec(kind);
  const { completed, failed, timedOut } = await reconcile(deps, kind);

  // The pod limit is per ENDPOINT, not per kind: `animation` and
  // `postprod-lite` are two agents sharing one 4-pod endpoint, and a per-kind
  // budget would let them put 8 jobs on 4 pods between them.
  const inFlight = await countInFlightForEndpoint(deps.pool, spec.endpointId);
  const room = Math.min(spec.maxInFlight - inFlight, deps.cfg.assetDispatchBatchSize);
  if (room <= 0) {
    return { kind, submitted: 0, completed, failed, timedOut, inFlight, skippedNoRoom: true };
  }

  const client = await deps.pool.connect();
  let batch: AssetRow[];
  try {
    await client.query('BEGIN');
    batch = await claimPending(client, kind, room);
    // The locks are released here on purpose: submitOne() re-claims each row
    // under its own short transaction, so no row lock is ever held across a
    // network call to RunPod.
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  let submitted = 0;
  if (spec.provider === 'lambda') {
    // Each Lambda render blocks for ~11-17s, so a serial loop would turn a
    // 36-frame project into ten minutes of ticking. RunPod submissions are a
    // fast POST and stay serial.
    const results = await Promise.all(batch.map((row) => submitOne(deps, kind, row)));
    submitted = results.filter(Boolean).length;
  } else {
    for (const row of batch) {
      if (await submitOne(deps, kind, row)) submitted += 1;
    }
  }

  if (submitted > 0 || completed > 0 || failed > 0 || timedOut > 0) {
    log().info({ kind, submitted, completed, failed, timedOut, inFlight, room }, 'asset-agent: tick');
  }
  return { kind, submitted, completed, failed, timedOut, inFlight, skippedNoRoom: false };
}

export interface RunningAgents {
  stop(): void;
}

/**
 * Start all eight agents. Each runs on its own interval and never waits on
 * another — an agent whose endpoint is saturated simply returns, it does not
 * hold anything up. A tick that throws is logged and the interval continues:
 * one agent crashing must not take the other seven with it.
 */
export function startAssetAgents(deps: AssetAgentDeps, kinds: readonly AssetKind[], intervalMs: number): RunningAgents {
  const timers = kinds.map((kind) => {
    let running = false;
    return setInterval(() => {
      if (running) return; // never overlap a kind with itself
      running = true;
      void runAssetAgentTick(deps, kind)
        .catch((err) => log().error({ kind, err }, 'asset-agent: tick crashed'))
        .finally(() => {
          running = false;
        });
    }, intervalMs);
  });
  log().info({ kinds, intervalMs }, 'asset-agent: agents started');
  return {
    stop(): void {
      for (const t of timers) clearInterval(t);
    },
  };
}
