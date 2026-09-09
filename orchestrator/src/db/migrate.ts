/**
 * Minimal forward/back SQL migration runner. No dependency beyond `pg`.
 *
 * Each migration is one file, `NNN_name.sql`, split into an up and a down
 * section by a line that is exactly `-- @DOWN` (case-sensitive). Everything
 * before it runs on `up`; everything after it runs on `down`. Both halves must
 * be present — a migration with no reverse is a migration you cannot test, and
 * M0's exit criterion is "apply and roll back cleanly".
 *
 *   ts-node src/db/migrate.ts up        # apply every pending migration
 *   ts-node src/db/migrate.ts down      # revert the most recently applied one
 *   ts-node src/db/migrate.ts status    # list applied / pending
 *
 * Applied migrations are tracked in `schema_migrations(version, applied_at)`.
 * Each migration + its bookkeeping row commit in one transaction, so a failed
 * migration leaves nothing half-applied.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'migrations');
const DOWN_MARKER = '-- @DOWN';

export interface Migration {
  version: string;      // "001_init"
  up: string;
  down: string;
}

export function loadMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((file) => {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const idx = raw.indexOf(DOWN_MARKER);
    if (idx === -1) {
      throw new Error(`${file}: missing "${DOWN_MARKER}" section — every migration must be reversible`);
    }
    return {
      version: file.replace(/\.sql$/, ''),
      up: raw.slice(0, idx).trim(),
      down: raw.slice(idx + DOWN_MARKER.length).trim(),
    };
  });
}

async function ensureTrackingTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );
  return new Set(rows.map((r) => r.version));
}

async function runUp(client: Client, migrations: Migration[]): Promise<void> {
  const applied = await appliedVersions(client);
  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    console.info('[migrate] nothing pending');
    return;
  }
  for (const m of pending) {
    console.info(`[migrate] up   ${m.version}`);
    await client.query('BEGIN');
    try {
      if (m.up) await client.query(m.up);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`[migrate] ${m.version} failed, rolled back: ${(err as Error).message}`);
    }
  }
  console.info(`[migrate] applied ${pending.length} migration(s)`);
}

async function runDown(client: Client, migrations: Migration[]): Promise<void> {
  const applied = await appliedVersions(client);
  const last = [...migrations].reverse().find((m) => applied.has(m.version));
  if (!last) {
    console.info('[migrate] nothing to revert');
    return;
  }
  console.info(`[migrate] down ${last.version}`);
  await client.query('BEGIN');
  try {
    if (last.down) await client.query(last.down);
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [last.version]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`[migrate] revert of ${last.version} failed, rolled back: ${(err as Error).message}`);
  }
  console.info(`[migrate] reverted ${last.version}`);
}

async function printStatus(client: Client, migrations: Migration[]): Promise<void> {
  const applied = await appliedVersions(client);
  for (const m of migrations) {
    console.info(`  ${applied.has(m.version) ? '[x]' : '[ ]'} ${m.version}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status';
  if (!['up', 'down', 'status'].includes(cmd)) {
    console.error(`usage: migrate <up|down|status>`);
    process.exit(2);
  }

  // Migrations need only the connection string — not the full app config. This
  // keeps `migrate` runnable in a deploy step that has DATABASE_URL and nothing
  // else.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const migrations = loadMigrations();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await ensureTrackingTable(client);
    if (cmd === 'up') await runUp(client, migrations);
    else if (cmd === 'down') await runDown(client, migrations);
    else await printStatus(client, migrations);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
