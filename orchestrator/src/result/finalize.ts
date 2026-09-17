/**
 * Cohort finalization (impl plan §6.7, M5, 2026-09-15). Runs once
 * agents/orchestrator.ts's driver stops, whether every step finished or the
 * cohort stalled:
 *
 *   1. every unfinished project: assemble its §9.6 result, store it, set
 *      projects.status to the result status (completed|partial|failed)
 *   2. close the cohort row (completed, or failed when the driver stopped
 *      early) — replaces the manual `UPDATE cohorts` every test needed
 *   3. deliver every project's callback concurrently, persisting each attempt
 *
 * Deliberate deviation from §6.7's "a cohort is not finished until every
 * callback has succeeded or exhausted": the cohort row closes BEFORE delivery.
 * cohorts_one_running allows one running cohort account-wide, so holding it
 * through ~16 min of retries against a down receiver would reject every new
 * request (CohortBusyError) for that long. The GPU work is done at step 2;
 * delivery state lives per project (callback_status/callback_attempts).
 *
 * Idempotent: only projects with finished_at IS NULL are processed.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import { log } from '../telemetry/log';
import { buildResult, loadResultFacts } from './assemble';
import { deliverCallback, type CallbackAttempt } from './callback';
import { runDiagnostic } from '../diagnostics/diagnose';

export interface FinalizeDeps {
  pool: Pool;
  cfg: Config;
  /** Optional — only used to enrich a diagnostic alert with live endpoint health, never required for finalization itself. */
  runpod?: RunpodClient;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export type DriverOutcome = 'completed' | 'stopped';

/** Best-effort Content-Length of the final asset; null on any failure. */
async function headBytes(fetchImpl: typeof fetch, url: string): Promise<number | null> {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    const len = Number(res.headers.get('content-length'));
    return res.ok && Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

export async function finalizeCohort(deps: FinalizeDeps, cohortId: string, outcome: DriverOutcome): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { rows: projects } = await deps.pool.query(
    `SELECT id, request_id, callback_url FROM projects WHERE cohort_id = $1 AND finished_at IS NULL ORDER BY id`,
    [cohortId],
  );

  const deliveries: Array<{ projectId: string; requestId: string; url: string; body: unknown }> = [];
  for (const p of projects) {
    const facts = await loadResultFacts(deps.pool, p.id);
    if (!facts) continue;
    const result = buildResult(facts);
    if (result.assets.final) result.assets.final.bytes = await headBytes(fetchImpl, result.assets.final.url);

    await deps.pool.query(
      `UPDATE projects SET result = $2, status = $3, finished_at = now(), callback_status = $4 WHERE id = $1`,
      [p.id, result, result.status, p.callback_url ? 'pending' : 'skipped'],
    );
    log().info({ cohortId, projectId: p.id, status: result.status, errors: result.errors.length }, 'finalize: result assembled');
    if (result.status !== 'completed') {
      void runDiagnostic(
        { pool: deps.pool, runpod: deps.runpod, cfg: deps.cfg },
        {
          trigger: result.status === 'failed' ? 'project_failed' : 'project_partial',
          projectId: p.id,
          cohortId,
          facts: { status: result.status, errors: result.errors, errorsTotal: result.errorsTotal },
        },
      );
    }
    if (p.callback_url) deliveries.push({ projectId: p.id, requestId: p.request_id, url: p.callback_url, body: result });
  }

  await deps.pool.query(
    `UPDATE cohorts SET status = $2, current_step = NULL, finished_at = now() WHERE id = $1 AND status = 'running'`,
    [cohortId, outcome === 'completed' ? 'completed' : 'failed'],
  );
  log().info({ cohortId, outcome, projects: projects.length }, 'finalize: cohort closed');

  await Promise.all(
    deliveries.map(async (d) => {
      const { outcome: delivery } = await deliverCallback({
        url: d.url,
        body: d.body,
        requestId: d.requestId,
        secret: deps.cfg.callbackSecret,
        maxAttempts: deps.cfg.callbackMaxAttempts,
        baseDelayMs: deps.cfg.callbackBaseDelayMs,
        maxDelayMs: deps.cfg.callbackMaxDelayMs,
        timeoutMs: deps.cfg.callbackTimeoutMs,
        fetchImpl,
        sleepImpl: deps.sleepImpl,
        onAttempt: async (a: CallbackAttempt) => {
          await deps.pool.query(
            `UPDATE projects SET callback_attempts = callback_attempts || $2::jsonb WHERE id = $1`,
            [d.projectId, JSON.stringify([a])],
          );
        },
      });
      await deps.pool.query(`UPDATE projects SET callback_status = $2 WHERE id = $1`, [d.projectId, delivery]);
      const level = delivery === 'delivered' ? 'info' : 'error';
      log()[level]({ cohortId, projectId: d.projectId, delivery }, 'finalize: callback finished');
    }),
  );
}
