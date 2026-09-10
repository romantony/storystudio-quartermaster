/**
 * Watchdog (impl plan §6.9 / M3). Guards the failure mode this design
 * introduces: an endpoint left with active workers because the orchestrator
 * died between the quality gate and the release call — billing silently,
 * with no failed job to point at it.
 *
 * A SEPARATE PROCESS from the orchestrator (own entrypoint, own pg.Pool, own
 * RunpodClient — deliberately not importing anything from index.ts's
 * composition). Surviving the orchestrator process's death is the entire
 * point; sharing its pool or its in-memory state would defeat that. Deployed
 * as a sibling container in the VPS's docker-compose stack, its own restart
 * policy (see the M3 plan's Deploy section for why that's a considered
 * substitute for a literal systemd unit, not an oversight).
 *
 * Reads RunPod (real worker counts) and Postgres (`endpoint_state` — is a
 * live step's claim on this endpoint present and fresh); never writes
 * Postgres. The one exception is the gated auto-drain PATCH itself
 * (WATCHDOG_AUTODRAIN, off by default) — that's a RunPod write, not a DB
 * write, and per spec is the one other place `patchWorkers` may legitimately
 * be called from (see __tests__/fleet-import-boundary.test.ts).
 *
 * No DynamoDB/AWS SDK: MCP-originated traffic never touches the AWS Lambda
 * live-path provisioner, so there's nothing on that side to coordinate with
 * — endpoint_state (Postgres, this orchestrator's own database) is the only
 * source of truth this needs.
 */
import { loadConfig } from './config';
import { closePool, initPool, getPool } from './db/pool';
import { createLogger, setLogger, log } from './telemetry/log';
import { RunpodClient } from './runpod/client';
import { FLEET, type FleetEndpoint } from './fleet-registry';
import { getState } from './db/repo/endpoint-state';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function alert(
  webhookUrl: string | undefined,
  payload: { endpointId: string; realWorkers: number; heldByStep: number | null; orphanForMs: number },
): Promise<void> {
  log().error(payload, 'watchdog: ORPHANED WORKERS — real RunPod workers with no fresh endpoint_state claim');
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `watchdog: orphaned workers on ${payload.endpointId}`, ...payload }),
    });
  } catch (err) {
    log().warn({ err }, 'watchdog: alert webhook delivery failed (logged alert above still stands)');
  }
}

export async function checkOnce(
  runpod: RunpodClient,
  pool: ReturnType<typeof getPool>,
  cfg: { orphanGraceMs: number; watchdogAutodrain: boolean; watchdogAlertWebhookUrl?: string },
  endpoints: readonly FleetEndpoint[] = FLEET,
): Promise<void> {
  for (const endpoint of endpoints) {
    let realWorkers = 0;
    try {
      const h = await runpod.health(endpoint.endpointId);
      realWorkers = (h.workers.ready ?? 0) + (h.workers.running ?? 0);
    } catch (err) {
      log().warn({ endpointId: endpoint.endpointId, err }, 'watchdog: health check failed, will retry next tick');
      continue;
    }
    if (realWorkers === 0) continue;

    const state = await getState(pool, endpoint.endpointId);
    const staleMs = state ? Date.now() - state.observedAt.getTime() : Infinity;
    const orphaned = !state?.heldByStep || staleMs > cfg.orphanGraceMs;
    if (!orphaned) continue;

    await alert(cfg.watchdogAlertWebhookUrl, {
      endpointId: endpoint.endpointId,
      realWorkers,
      heldByStep: state?.heldByStep ?? null,
      orphanForMs: Number.isFinite(staleMs) ? staleMs : -1,
    });

    if (cfg.watchdogAutodrain && staleMs > cfg.orphanGraceMs) {
      log().error({ endpointId: endpoint.endpointId }, 'watchdog: WATCHDOG_AUTODRAIN=true, draining orphaned endpoint');
      await runpod.patchWorkers(endpoint.endpointId, { workersMin: 0, workersMax: 0 });
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg);
  setLogger(logger);
  logger.info(
    { intervalMs: cfg.watchdogIntervalMs, autodrain: cfg.watchdogAutodrain, orphanGraceMs: cfg.orphanGraceMs },
    'watchdog starting',
  );

  initPool(cfg);
  const runpod = new RunpodClient(cfg);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'watchdog shutting down');
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  while (!shuttingDown) {
    try {
      await checkOnce(runpod, getPool(), cfg);
    } catch (err) {
      log().error({ err }, 'watchdog: tick failed, will retry next interval');
    }
    await sleep(cfg.watchdogIntervalMs);
  }
}

// Guarded so watchdog.test.ts can import checkOnce (and any other export)
// without executing main() as an import side effect — the same reason
// index.ts is never imported by a test, made explicit here since this file
// has to be both an entrypoint and importable.
if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
