/**
 * The doc-gen dispatcher: drives one documentary at a time through
 * queued -> starting_instance -> running -> terminal -> result callback.
 *
 * Every tick reads Postgres and acts on what it finds; nothing but retry
 * back-offs is held in memory, so a restart resumes exactly where it stopped.
 * (Webhooks update the same rows concurrently — see events.ts — and this loop
 * is the fallback for when they don't arrive.)
 *
 * Rules the code holds to (ORCHESTRATOR_INTEGRATION.md §3):
 *  - never stop the instance while a job is running: StopInstances is called
 *    only from `stopIfIdle`, after a job has reached a final state and with
 *    nothing queued or active;
 *  - the instance stopping or booting is normal: CloudFront 502/504 mean "not
 *    up yet" (client.health() -> null), never a failure by itself;
 *  - a start that never reached the instance consumes no attempt; only an
 *    accepted job counts (markDocgenAccepted);
 *  - at most one automatic retry per D5, only for failures that mean the
 *    infrastructure lost the job — a retry restarts from nothing and pays for
 *    generation again.
 *
 * Operator alerts are error-level log lines carrying `alert: true`.
 */
import type { Pool } from 'pg';
import { log } from '../telemetry/log';
import { deliverCallback, type CallbackAttempt } from '../result/callback';
import {
  getActiveDocgenJob,
  claimNextQueuedDocgenJob,
  requeueDocgenJob,
  markDocgenAccepted,
  failDocgenJob,
  retryDocgenJob,
  touchDocgenPolled,
  countQueuedDocgenJobs,
  listUnfinalizedDocgenJobs,
  listPendingDocgenCallbacks,
  setDocgenResult,
  appendDocgenCallbackAttempt,
  setDocgenCallbackStatus,
  getDocgenJob,
  applyDocgenStatus,
  type DocgenJobRow,
} from '../db/repo/docgen';
import { DocgenClient, DocgenHttpError, DocgenUnreachableError } from './client';
import { applyDocgenEvent } from './events';
import { startInstance, stopInstance, describeInstance, isCapacityError, isIncorrectStateError, type Ec2Transport } from './ec2';
import { docgenRequestIdFor } from './request';
import { buildDocgenResult, type DocgenResult } from './result';
import type { DocgenStartPayload } from './types';

export interface DispatcherTimings {
  /** The instance must answer /v1/health within this long of StartInstances. */
  bootTimeoutMs: number;
  /** No event or heartbeat for this long while `running` -> poll the API. */
  silenceMs: number;
  /** Minimum gap between polls of one job. */
  pollEveryMs: number;
  /** Silence this long AND the API unreachable -> the job is lost. */
  unreachableFailMs: number;
  capacityBackoffMs: number;
  configBackoffMs: number;
  busyBackoffMs: number;
  stoppingBackoffMs: number;
}

export const DEFAULT_TIMINGS: DispatcherTimings = {
  bootTimeoutMs: 5 * 60_000,
  silenceMs: 5 * 60_000,
  pollEveryMs: 60_000,
  unreachableFailMs: 10 * 60_000,
  capacityBackoffMs: 5 * 60_000,
  configBackoffMs: 30 * 60_000,
  busyBackoffMs: 10 * 60_000,
  stoppingBackoffMs: 30_000,
};

/** Failures that mean the infrastructure lost the job, as opposed to the job being wrong. */
const RETRY_CODES = new Set(['internal', 'llm_error', 'instance_unreachable', 'job_lost']);

export interface DispatcherDeps {
  pool: Pool;
  client: Pick<DocgenClient, 'health' | 'start' | 'status' | 'events'>;
  ec2: Ec2Transport;
  /** Total attempts per request, first included (DOCGEN_MAX_ATTEMPTS). */
  maxAttempts: number;
  callback: { secret?: string; maxAttempts: number; baseDelayMs: number; maxDelayMs: number; timeoutMs: number };
  timings?: Partial<DispatcherTimings>;
  deliver?: typeof deliverCallback;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const alert = (msg: string, ctx: Record<string, unknown>) => log().error({ alert: true, ...ctx }, msg);
const errText = (e: unknown) => String((e as Error)?.message ?? e);

export function createDocgenDispatcher(deps: DispatcherDeps) {
  const T: DispatcherTimings = { ...DEFAULT_TIMINGS, ...deps.timings };
  const deliver = deps.deliver ?? deliverCallback;
  const inflight = new Map<string, Promise<void>>();
  let holdUntil = 0;
  let ticking = false;
  let timer: NodeJS.Timeout | undefined;

  const hold = (ms: number) => {
    holdUntil = Math.max(holdUntil, Date.now() + ms);
  };

  // ── delivery ──────────────────────────────────────────────────────────────

  function startDelivery(requestId: string): void {
    if (inflight.has(requestId)) return;
    const p = (async () => {
      const row = await getDocgenJob(deps.pool, requestId);
      if (!row?.result || row.callbackStatus !== 'pending') return;
      const { outcome } = await deliver({
        url: row.callbackUrl,
        body: row.result,
        requestId: row.requestId,
        secret: deps.callback.secret,
        maxAttempts: deps.callback.maxAttempts,
        baseDelayMs: deps.callback.baseDelayMs,
        maxDelayMs: deps.callback.maxDelayMs,
        timeoutMs: deps.callback.timeoutMs,
        fetchImpl: deps.fetchImpl,
        sleepImpl: deps.sleepImpl,
        onAttempt: (a: CallbackAttempt) => appendDocgenCallbackAttempt(deps.pool, requestId, a),
      });
      await setDocgenCallbackStatus(deps.pool, requestId, outcome);
      const level = outcome === 'delivered' ? 'info' : 'error';
      log()[level]({ requestId, outcome, ...(outcome === 'delivered' ? {} : { alert: true }) }, 'docgen: result callback finished');
    })()
      .catch((err) => log().error({ err, requestId }, 'docgen: callback delivery crashed (stays pending, retried next tick)'))
      .finally(() => inflight.delete(requestId));
    inflight.set(requestId, p);
  }

  // ── finishing ─────────────────────────────────────────────────────────────

  async function stopIfIdle(row: DocgenJobRow, result: DocgenResult): Promise<void> {
    if ((await countQueuedDocgenJobs(deps.pool)) > 0 || (await getActiveDocgenJob(deps.pool))) return;
    // An output without a url failed to upload; the file still exists only on the
    // instance. Leave it up (its own 20-minute idle stop is the backstop) so the
    // file can be fetched, rather than destroying the only copy.
    if (result.warnings.some((w) => w.startsWith('Output not uploaded'))) {
      alert('docgen: an output has no url — leaving the instance up so it can be fetched', { requestId: row.requestId });
      return;
    }
    try {
      const state = await stopInstance(deps.ec2);
      log().info({ requestId: row.requestId, state }, 'docgen: queue empty, instance stopping');
    } catch (err) {
      alert('docgen: StopInstances failed — the instance idle timer will stop it', { requestId: row.requestId, err: errText(err) });
    }
  }

  function shouldRetry(row: DocgenJobRow): boolean {
    const e = row.error as { code?: string; retryable?: boolean } | null;
    return row.state === 'failed' && row.attempts < deps.maxAttempts && e?.retryable !== false && RETRY_CODES.has(e?.code ?? '');
  }

  async function finalizeFinished(): Promise<void> {
    for (const row of await listUnfinalizedDocgenJobs(deps.pool)) {
      if (shouldRetry(row)) {
        const id = docgenRequestIdFor(row.requestId, row.attempts + 1);
        const payload = { ...(row.request as DocgenStartPayload), request_id: id, output: { prefix: `docgen/${id}/` } };
        const code = (row.error as { code?: string }).code;
        if (await retryDocgenJob(deps.pool, row.requestId, id, payload, `retrying after ${code}`)) {
          log().warn({ requestId: row.requestId, docgenRequestId: id, attempts: row.attempts, code }, 'docgen: failed job re-queued for another attempt');
          continue;
        }
      }
      const result = buildDocgenResult(row);
      if (!(await setDocgenResult(deps.pool, row.requestId, result))) continue;
      log().info({ requestId: row.requestId, state: row.state, status: result.status, warnings: result.warnings.length }, 'docgen: result built');
      if (result.status === 'failed') {
        alert('docgen: documentary failed', { requestId: row.requestId, errors: result.errors });
      }
      await stopIfIdle(row, result);
      startDelivery(row.requestId);
    }
    for (const row of await listPendingDocgenCallbacks(deps.pool)) startDelivery(row.requestId);
  }

  // ── starting ──────────────────────────────────────────────────────────────

  async function claimAndStart(): Promise<void> {
    if (Date.now() < holdUntil) return;
    const row = await claimNextQueuedDocgenJob(deps.pool);
    if (!row) return;
    try {
      const state = await startInstance(deps.ec2);
      log().info({ requestId: row.requestId, instance: deps.ec2.instanceId, state }, 'docgen: instance starting');
    } catch (err) {
      await requeueDocgenJob(deps.pool, row.requestId, `instance start failed: ${errText(err)}`);
      if (isIncorrectStateError(err)) {
        hold(T.stoppingBackoffMs);
        log().info({ requestId: row.requestId }, 'docgen: instance still stopping, will retry shortly');
      } else if (isCapacityError(err)) {
        hold(T.capacityBackoffMs);
        alert('docgen: no capacity to start the instance — retrying with backoff', { requestId: row.requestId, err: errText(err) });
      } else {
        hold(T.configBackoffMs);
        alert('docgen: StartInstances failed (credentials/permissions?)', { requestId: row.requestId, err: errText(err) });
      }
    }
  }

  async function requeueAndHold(row: DocgenJobRow, ms: number, note: string, stop: boolean): Promise<void> {
    await requeueDocgenJob(deps.pool, row.requestId, note);
    hold(ms);
    if (stop) {
      try {
        await stopInstance(deps.ec2);
      } catch (err) {
        log().warn({ err: errText(err) }, 'docgen: stop after a refused start failed');
      }
    }
  }

  async function advanceStarting(row: DocgenJobRow): Promise<void> {
    const health = await deps.client.health();
    if (!health) {
      const age = Date.now() - (row.instanceStartedAt?.getTime() ?? Date.now());
      if (age > T.bootTimeoutMs) {
        const state = await describeInstance(deps.ec2).catch(() => 'unknown');
        alert('docgen: the instance did not become healthy in time', { requestId: row.requestId, ageMs: age, instanceState: state });
        await requeueAndHold(row, T.capacityBackoffMs, `instance not healthy after ${Math.round(age / 1000)}s (state ${state})`, false);
      }
      return;
    }

    const payload = row.request as DocgenStartPayload;
    try {
      const r = await deps.client.start(payload);
      await markDocgenAccepted(deps.pool, row.requestId, r.jobId, row.attempts + 1);
      log().info({ requestId: row.requestId, jobId: r.jobId, created: r.created, attempt: row.attempts + 1 }, 'docgen: job accepted by the instance');
    } catch (err) {
      if (err instanceof DocgenUnreachableError) return; // went away between health and start; next tick
      if (!(err instanceof DocgenHttpError)) throw err;
      const ctx = { requestId: row.requestId, httpStatus: err.httpStatus, code: err.code, body: err.body };
      if (err.httpStatus === 400) {
        // Our own mapping produced something the instance refuses — retrying cannot help.
        await failDocgenJob(deps.pool, row.requestId, { code: 'invalid_request', stage: 'start', message: `doc-gen rejected the request: ${JSON.stringify(err.body).slice(0, 400)}`, retryable: false });
        alert('docgen: the instance rejected the request payload', ctx);
      } else if (err.code === 'busy') {
        alert('docgen: the instance is busy with a job this orchestrator is not tracking', ctx);
        await requeueAndHold(row, T.busyBackoffMs, 'instance busy with an unknown job', false);
      } else if (err.code === 'not_ready') {
        alert('docgen: the instance is not ready (a key is missing or Storyblocks needs a sign-in) — queue held', ctx);
        await requeueAndHold(row, T.configBackoffMs, 'instance not ready', true);
      } else if (err.httpStatus === 401 || err.httpStatus === 403) {
        alert('docgen: the instance refused our credentials or address — queue held', ctx);
        await requeueAndHold(row, T.configBackoffMs, `instance refused the request (${err.httpStatus})`, true);
      } else {
        alert('docgen: unexpected answer starting the job', ctx);
        await requeueAndHold(row, T.busyBackoffMs, `unexpected ${err.httpStatus} ${err.code}`, false);
      }
    }
  }

  // ── following ─────────────────────────────────────────────────────────────

  async function watchRunning(row: DocgenJobRow): Promise<void> {
    if (row.state === 'awaiting_input') {
      log().warn({ requestId: row.requestId }, 'docgen: job is awaiting input but review_mode is auto — operator action needed');
    }
    const last = Math.max(row.lastHeartbeatAt?.getTime() ?? 0, row.updatedAt.getTime());
    const silence = Date.now() - last;
    if (silence < T.silenceMs) return;
    if (row.lastPolledAt && Date.now() - row.lastPolledAt.getTime() < T.pollEveryMs) return;
    await touchDocgenPolled(deps.pool, row.requestId);

    if (!row.jobId) {
      // Cannot happen after markDocgenAccepted; guard anyway rather than poll a null id.
      await failDocgenJob(deps.pool, row.requestId, { code: 'job_lost', stage: 'start', message: 'running without a job id', retryable: true });
      return;
    }
    try {
      // Events first (history + gap recovery), then the snapshot itself.
      for (const e of await deps.client.events(row.jobId, row.seq)) await applyDocgenEvent(deps.pool, e);
      const s = await deps.client.status(row.jobId);
      const r = await applyDocgenStatus(deps.pool, row.docgenRequestId, s);
      log().info({ requestId: row.requestId, silenceMs: silence, applied: r.applied, state: s.state, stage: s.stage }, 'docgen: polled a silent job');
    } catch (err) {
      if (err instanceof DocgenHttpError && err.httpStatus === 404) {
        await failDocgenJob(deps.pool, row.requestId, { code: 'job_lost', stage: row.stage ?? 'unknown', message: 'the instance no longer knows this job', retryable: true });
        alert('docgen: the instance does not know the job', { requestId: row.requestId, jobId: row.jobId });
        return;
      }
      if (!(err instanceof DocgenUnreachableError)) throw err;
      if (silence < T.unreachableFailMs) return;
      const state = await describeInstance(deps.ec2).catch(() => 'unknown');
      if (state === 'stopped' || state === 'stopping') {
        // Someone (or the idle timer) stopped it under a running job. On the next boot the
        // instance reports the job failed `internal`, which the retry path handles.
        alert('docgen: the instance was stopped under a running job — starting it so the job can be reported', { requestId: row.requestId, instanceState: state });
        await startInstance(deps.ec2).catch((e) => log().warn({ err: errText(e) }, 'docgen: restart of a stopped instance failed'));
        return;
      }
      await failDocgenJob(deps.pool, row.requestId, {
        code: 'instance_unreachable',
        stage: row.stage ?? 'unknown',
        message: `no event or answer from the instance for ${Math.round(silence / 60_000)} minutes (instance state ${state})`,
        retryable: true,
      });
      alert('docgen: the instance is unreachable — job marked failed', { requestId: row.requestId, instanceState: state });
    }
  }

  // ── loop ──────────────────────────────────────────────────────────────────

  async function step(): Promise<void> {
    await finalizeFinished();
    const active = await getActiveDocgenJob(deps.pool);
    if (!active) return claimAndStart();
    if (active.state === 'starting_instance') return advanceStarting(active);
    return watchRunning(active);
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      await step();
    } catch (err) {
      log().error({ err }, 'docgen: dispatcher tick failed');
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    /** Resolves when every callback delivery started so far has finished (tests, shutdown). */
    async drain(): Promise<void> {
      await Promise.allSettled([...inflight.values()]);
    },
    start(intervalMs: number): void {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      void tick();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
