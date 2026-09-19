/**
 * Process entry. Loads config, opens the pg pool, constructs the RunPod
 * client, starts the HTTP server, installs shutdown hooks. This file is
 * deliberately the only place that composition happens (impl plan §2).
 *
 * M2 wires the planner/fleet/generator/driver behind the HTTP routes
 * (agents/orchestrator.ts's driveCohort, called per-request) — that's still
 * the whole story in the default `ORCH_SCHEDULING_MODE=project` mode.
 * 2026-09-16 adds the `batch` mode's cron trigger (agents/batch-window.ts) —
 * registered unconditionally below (cheap), but a no-op every firing unless
 * schedulingMode is actually 'batch'.
 */
import cron from 'node-cron';
import { loadConfig } from './config';
import { closePool, initPool, getPool } from './db/pool';
import { buildServer } from './http/server';
import { createLogger, setLogger } from './telemetry/log';
import { RunpodClient } from './runpod/client';
import { driveCohort } from './agents/orchestrator';
import { runBatchWindow } from './agents/batch-window';
import { ASSET_KINDS } from './assets/kinds';
import { startAssetAgents } from './assets/agent';
import { startCompiler } from './assets/compiler';
import { startAssetQa } from './assets/quality';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg);
  setLogger(logger);
  logger.info({ nodeEnv: cfg.nodeEnv, port: cfg.port, fleetLive: cfg.fleetLive }, 'orchestrator starting');

  initPool(cfg);
  const runpod = new RunpodClient(cfg);

  const app = await buildServer(cfg, logger, { pool: getPool(), runpod });
  await app.listen({ host: '0.0.0.0', port: cfg.port });
  logger.info(`listening on :${cfg.port}`);

  // Resume cohorts a restart (deploy, crash) left mid-run. driveCohort() is
  // driven entirely by Postgres state: completed steps are skipped, planned
  // jobs are submitted, submitted jobs are reconciled via /status. A minimal
  // slice of M6's boot reconciliation (§10.2), added 2026-09-15 so deploying
  // a fix doesn't strand the running cohort.
  const { rows: running } = await getPool().query<{ id: string }>(`SELECT id FROM cohorts WHERE status = 'running'`);
  for (const { id } of running) {
    logger.warn({ cohortId: id }, 'boot: resuming running cohort');
    void driveCohort({ pool: getPool(), runpod, cfg, publicBaseUrl: cfg.publicBaseUrl }, id).catch((err) =>
      logger.error({ err, cohortId: id }, 'boot: resumed driveCohort crashed'),
    );
  }

  // ORCH_PIPELINE_MODE=assets (2026-09-19): the eight per-asset generator
  // agents plus the project compiler above them. Started only in that mode —
  // in 'cohort' mode their tables are empty and every tick would be pure
  // overhead. Nothing here is a cron: each agent runs its own short interval
  // and picks up whatever is queued, across every project at once.
  let assetAgents: { stop(): void } | undefined;
  let assetQa: { stop(): void } | undefined;
  let compiler: { stop(): void } | undefined;
  if (cfg.pipelineMode === 'assets') {
    const r2 = {
      accountId: cfg.r2AccountId,
      bucket: cfg.r2Bucket,
      publicUrl: cfg.r2PublicUrl,
      accessKeyId: cfg.r2AccessKeyId ?? '',
      secretAccessKey: cfg.r2SecretAccessKey ?? '',
    };
    const assetDeps = {
      pool: getPool(),
      runpod,
      cfg,
      publicBaseUrl: cfg.publicBaseUrl,
      webhookSecret: cfg.webhookSecret,
      // The `remotion` agent's transports — the one non-RunPod kind.
      lambda: { functionName: cfg.remotionLambdaFunctionName, region: cfg.remotionLambdaRegion },
      r2,
    };
    assetAgents = startAssetAgents(assetDeps, ASSET_KINDS, cfg.assetTickMs);
    // Always started, even at ORCH_ASSET_QA=off: a gated kind's completion
    // defers its handoff unconditionally (assets/agent.ts), so something has
    // to release it. With gating off that release is immediate and unjudged.
    assetQa = startAssetQa(
      {
        pool: getPool(),
        cfg,
        replicate: cfg.replicateApiToken
          ? {
              apiToken: cfg.replicateApiToken,
              apiBase: cfg.replicateApiBase,
              visionModel: cfg.replicateVisionModel,
              visionModelFallback: cfg.replicateVisionModelFallback,
              pollIntervalMs: cfg.replicatePollIntervalMs,
              maxPollAttempts: cfg.replicateMaxPollAttempts,
              timeoutMs: cfg.replicateTimeoutMs,
            }
          : undefined,
      },
      ASSET_KINDS,
      cfg.assetQaTickMs,
    );
    compiler = startCompiler(
      {
        pool: getPool(),
        runpod,
        cfg,
        r2,
      },
      cfg.compilerTickMs,
    );
    logger.info({ kinds: ASSET_KINDS.length, qa: cfg.assetQa }, 'asset pipeline active');
  }

  // ORCH_SCHEDULING_MODE=batch's window-close trigger. Fires at every
  // windowCron boundary regardless of mode — runBatchWindow()'s own first
  // line is the real gate, so this stays a harmless no-op while the mode is
  // 'project' (the default).
  const batchWindowTask = cron.schedule(cfg.windowCron, () => {
    void runBatchWindow({ pool: getPool(), runpod, cfg, publicBaseUrl: cfg.publicBaseUrl }, new Date()).catch((err) =>
      logger.error({ err }, 'batch-window: runBatchWindow crashed'),
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      batchWindowTask.stop();
      assetAgents?.stop();
      assetQa?.stop();
      compiler?.stop();
      await app.close();
      await closePool();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // Config/boot failures land here — print the readable message, not a stack.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
