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
import type { RunpodClient } from '../runpod/client';
import { isTerminal } from '../runpod/types';
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
  cfg: Pick<Config, 'workerRateUsdS' | 'reconcileIntervalMs'>;
  /** Base URL this process is reachable at (e.g. https://orchestrator.ai-storystudio.com),
   * used to build each job's per-job webhook callback URL. */
  publicBaseUrl: string;
  webhookSecret: string;
}

/** Resolves a job's step-dependency outputs into the shape steps/builders
 * expect, by reading the completed same-frame job in each dependsOn step. */
async function resolveDeps(client: PoolClient, cohortId: string, frameId: string, dependsOn: number[]): Promise<ResolvedDeps> {
  const resolved: ResolvedDeps = {};
  for (const seq of dependsOn) {
    const { rows } = await client.query<{ output: unknown }>(
      `SELECT output FROM jobs WHERE cohort_id = $1 AND frame_id = $2 AND step_seq = $3 AND status = 'complete'`,
      [cohortId, frameId, seq],
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
    const resolvedDeps = job.frameId ? await resolveDeps(client, cohortId, job.frameId, step.dependsOn) : {};
    const payload = step.builder({
      job: frameInput,
      resolvedDeps,
      projectId: job.projectId,
      frameId: job.frameId,
    });

    const jobToken = webhookToken(deps.webhookSecret, job.id);
    const webhookUrl = `${deps.publicBaseUrl}/v1/webhooks/runpod/${jobToken}`;

    const res = await deps.runpod.run(step.endpointId, payload, webhookUrl);

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

/** §6.4's reconcile tick — the fallback for a missed/delayed webhook. */
export async function reconcileTick(deps: GeneratorDeps, cohortId: string, step: CatalogEntry, baselineSec = 60): Promise<void> {
  const stale = await listStale(deps.pool, cohortId, step.seq, new Date(Date.now() - baselineSec * 1000));
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
 * Runs one step to completion: claims + submits work up to the verified
 * worker count, waits for webhooks/reconcile to bring every job to a
 * terminal state. `verifiedWorkers` comes from the fleet controller's
 * already-verified health check — never a config value (impl plan §6.4).
 */
export async function runStep(deps: GeneratorDeps, cohortId: string, step: CatalogEntry, verifiedWorkers: number): Promise<void> {
  await updateStepStatus(deps.pool, cohortId, step.seq, 'running', { startedAt: new Date() });
  log().info({ stepSeq: step.seq, verifiedWorkers }, 'generator: step running');

  for (;;) {
    const { total, terminal } = await stepJobCounts(deps.pool, cohortId, step.seq);
    if (terminal >= total) break;

    const inFlight = (await listInFlight(deps.pool, cohortId, step.seq)).length;
    const room = Math.max(0, verifiedWorkers - inFlight);
    if (room > 0) {
      const batch = await claimBatchReadOnly(deps.pool, cohortId, step.seq, room);
      for (const job of batch) {
        await submitOne(deps, cohortId, step, job);
      }
    }

    await reconcileTick(deps, cohortId, step);
    // Keep endpoint_state.observed_at fresh for the whole time this step is
    // actively generating, not just at allocation — watchdog.ts's orphan
    // grace window is measured from this timestamp.
    await touchObserved(deps.pool, step.endpointId);
    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, deps.cfg.reconcileIntervalMs)));
  }

  await updateStepStatus(deps.pool, cohortId, step.seq, 'generated');
  log().info({ stepSeq: step.seq }, 'generator: step generated (every job terminal)');
}

/** Unlocked read of candidate jobs — submitOne() does the real FOR UPDATE
 * SKIP LOCKED claim per-job right before submitting, so this is just "what
 * to try next," not the crash-safety boundary. */
async function claimBatchReadOnly(pool: Pool, cohortId: string, stepSeq: number, limit: number): Promise<JobRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await claimNextBatch(client, cohortId, stepSeq, limit);
    await client.query('ROLLBACK'); // release the locks immediately; submitOne reclaims per-job
    return rows;
  } finally {
    client.release();
  }
}
