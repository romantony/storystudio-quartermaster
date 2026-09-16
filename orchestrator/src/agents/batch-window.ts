/**
 * `ORCH_SCHEDULING_MODE=batch`'s window-close trigger (2026-09-16). Cron-fired
 * (index.ts, `cfg.windowCron`) at every window boundary — plans the full set
 * of requests queued before this window's cutoff together, into one cohort,
 * then drives it once. A no-op in `project` mode (the default): the cron is
 * registered unconditionally, but this function's own mode check is what
 * actually gates the behavior, so flipping back to `project` makes it inert
 * without touching the schedule.
 *
 * Deliberately does NOT duplicate any cohort/plan/drive logic — every row is
 * just replayed through the exact same `plan()` `project` mode already uses
 * (so it gets the same `stepsJoinable()` join-safety backstop for free, and
 * the exact same `driveCohort()` at the end), just called once per queued
 * row instead of once per HTTP request, and with `at` pinned to a single
 * timestamp so every row resolves the same window deterministically.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import { log } from '../telemetry/log';
import { listEligibleOutbox, markOutboxPlanned, markOutboxRejected } from '../db/repo/request-outbox';
import { plan } from './planner';
import { driveCohort } from './orchestrator';

export interface BatchWindowDeps {
  pool: Pool;
  runpod: RunpodClient;
  cfg: Config;
  publicBaseUrl: string;
}

export async function runBatchWindow(deps: BatchWindowDeps, at: Date = new Date()): Promise<void> {
  if (deps.cfg.schedulingMode !== 'batch') return;

  const cutoff = new Date(at.getTime() - deps.cfg.windowCutoffMinutes * 60_000);
  const rows = await listEligibleOutbox(deps.pool, cutoff);
  if (rows.length === 0) {
    log().info({ at: at.toISOString(), cutoff: cutoff.toISOString() }, 'batch-window: nothing queued before cutoff');
    return;
  }

  log().info({ at: at.toISOString(), cutoff: cutoff.toISOString(), count: rows.length }, 'batch-window: planning queued requests');

  // Sequential, not concurrent — avoids any race in stepsJoinable()'s
  // read-then-decide check across simultaneous plan() calls all targeting
  // the same freshly-created cohort.
  let cohortId: string | undefined;
  for (const row of rows) {
    try {
      // `at`, not `new Date()` per row — every row in this run must resolve
      // the identical window (db/repo/cohorts.ts's windowId()), even if
      // processing a large batch takes long enough to otherwise cross a
      // boundary mid-run. 1ms before the firing boundary so windowBounds()'s
      // hour-floor lands in the window that's CLOSING, not the next one
      // that's only just opening at exactly `at`.
      const ack = await plan(deps.pool, deps.cfg, row.payload, new Date(at.getTime() - 1));
      cohortId = ack.cohortId;
      await markOutboxPlanned(deps.pool, row.id, ack.cohortId);
      log().info({ requestId: row.requestId, cohortId: ack.cohortId }, 'batch-window: row planned');
    } catch (err) {
      // One bad row must not sink the whole window — same isolation
      // principle used everywhere else in this codebase (one frame's
      // failure doesn't fail the step; one project's failure doesn't fail
      // the cohort). Should be rare: validateRequest() already ran at
      // enqueue time, so a rejection here is a genuine runtime edge case
      // (e.g. schedulingMode flipped mid-window with a project-mode cohort
      // still occupying cohorts_one_running).
      const message = err instanceof Error ? err.message : String(err);
      await markOutboxRejected(deps.pool, row.id, message);
      log().error({ requestId: row.requestId, err }, 'batch-window: row rejected, continuing with the rest');
    }
  }

  if (!cohortId) {
    log().warn({ at: at.toISOString() }, 'batch-window: every queued row was rejected, nothing to drive');
    return;
  }

  await driveCohort({ pool: deps.pool, runpod: deps.runpod, cfg: deps.cfg, publicBaseUrl: deps.publicBaseUrl }, cohortId);
}
