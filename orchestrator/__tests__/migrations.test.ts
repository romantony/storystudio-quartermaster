/**
 * Static well-formedness + reversibility checks for the migration set. The
 * live "apply then roll back on a scratch DB" check is a manual step (README);
 * this is what guards the files in CI where no Postgres is attached.
 */
import { loadMigrations } from '../src/db/migrate';

const migrations = loadMigrations();

describe('migrations', () => {
  it('are the expected ordered set 001..006', () => {
    expect(migrations.map((m) => m.version)).toEqual([
      '001_init',
      '002_measurement',
      '003_webhooks',
      '004_rules',
      '005_invariants',
      '006_step_deps',
    ]);
  });

  it('every migration has a non-empty up and a non-empty down section', () => {
    for (const m of migrations) {
      expect(m.up.length).toBeGreaterThan(0);
      expect(m.down.length).toBeGreaterThan(0);
    }
  });

  it('every CREATE TABLE in an up has a matching DROP TABLE in its down', () => {
    for (const m of migrations) {
      const created = [...m.up.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)].map((x) => x[1]);
      for (const table of created) {
        expect(m.down).toMatch(new RegExp(`DROP TABLE (?:IF EXISTS )?${table}\\b`, 'i'));
      }
    }
  });

  it('every CREATE FUNCTION in an up has a matching DROP FUNCTION in its down', () => {
    for (const m of migrations) {
      const fns = [...m.up.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w+)/gi)].map((x) => x[1]);
      for (const fn of fns) {
        expect(m.down).toMatch(new RegExp(`DROP FUNCTION (?:IF EXISTS )?${fn}\\b`, 'i'));
      }
    }
  });

  it('001_init carries the spec §10 tables and the five partial indexes verbatim', () => {
    const init = migrations.find((m) => m.version === '001_init')!.up;
    for (const t of ['cohorts', 'projects', 'steps', 'endpoint_state', 'jobs', 'quality_verdicts']) {
      expect(init).toMatch(new RegExp(`CREATE TABLE ${t} \\(`));
    }
    for (const idx of [
      'jobs_step_ready',
      'jobs_inflight',
      'jobs_ungated',
      'jobs_runpod_id',
      'jobs_by_project',
    ]) {
      expect(init).toContain(idx);
    }
    // The unique partial index is what makes restart safe (spec §10 prose).
    expect(init).toMatch(/CREATE UNIQUE INDEX jobs_runpod_id ON jobs \(runpod_job_id\)\s*\n\s*WHERE runpod_job_id IS NOT NULL;/);
  });

  it('005_invariants enforces "one live step per cohort" and "one running cohort"', () => {
    const inv = migrations.find((m) => m.version === '005_invariants')!.up;
    expect(inv).toContain('steps_one_live_per_cohort');
    expect(inv).toContain('cohorts_one_running');
    expect(inv).toContain('verify_invariants()');
  });
});
