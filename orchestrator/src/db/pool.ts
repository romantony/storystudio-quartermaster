/**
 * One pg Pool per process (impl plan §2: "sharing one pg pool"). Every repo
 * module imports `pool` from here; nothing constructs its own.
 *
 * A statement_timeout is set on every connection so a wedged query cannot hold
 * an agent loop forever — the orchestrator would rather a query fail loudly and
 * be retried than a step hang with no error.
 */
import { Pool, type PoolConfig } from 'pg';
import type { Config } from '../config';
import { log } from '../telemetry/log';

let pool: Pool | undefined;

export function initPool(cfg: Config): Pool {
  if (pool) return pool;
  const opts: PoolConfig = {
    connectionString: cfg.databaseUrl,
    max: cfg.pgPoolMax,
    // Fail a checkout rather than queue forever if the pool is exhausted.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  };
  pool = new Pool(opts);

  pool.on('connect', (client) => {
    // Per-connection, not per-query: applies to everything this client runs.
    void client.query(`SET statement_timeout = ${cfg.pgStatementTimeoutMs}`);
  });
  // An idle-client error (e.g. the server dropped the connection) must not take
  // the process down — pg emits it on the pool, and an unhandled 'error' would.
  pool.on('error', (err) => {
    log().error({ err }, 'idle pg client error');
  });

  return pool;
}

export function getPool(): Pool {
  if (!pool) throw new Error('pg pool not initialised — call initPool(config) first');
  return pool;
}

/** `SELECT 1` with a short deadline. Powers GET /v1/health's `pg` field. */
export async function pingDb(): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const started = Date.now();
  try {
    await getPool().query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}
