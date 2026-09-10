/**
 * DB repo-layer integration tests, against a real Postgres — same
 * convention `migrations.test.ts`'s own docstring points at for the "live
 * apply/roll back" check. Skips (not fails) when DATABASE_URL isn't set, so
 * `npm test` stays green in an environment with no Postgres attached.
 *
 * Run against a throwaway DB with migrations already applied:
 *   DATABASE_URL=postgres://qm:qm@localhost:55432/qm_orchestrator_test \
 *     npx ts-node src/db/migrate.ts up && npx jest repo.integration
 */
import { Pool, type PoolClient } from 'pg';
import { ensureCohort, windowBounds } from '../src/db/repo/cohorts';
import { insertProject, getProject } from '../src/db/repo/projects';
import { insertSteps, listSteps, dependentSteps } from '../src/db/repo/steps';
import { insertJobs, claimNextBatch, markSubmitted, markTerminal, stepJobCounts } from '../src/db/repo/jobs';

const DB_URL = process.env.DATABASE_URL;
const maybeDescribe = DB_URL ? describe : describe.skip;

maybeDescribe('db repo layer (integration)', () => {
  let pool: Pool;
  // One shared cohort for every test below (except the dedicated
  // ensureCohort test, which uses its own fixed past date so it doesn't
  // collide with `cohorts_one_running` against whatever's live right now).
  // Sharing avoids each `it()` opening its own 'running' cohort and tripping
  // that same invariant against the others.
  let sharedCohortId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    const cohort = await ensureCohort(pool, new Date('2020-01-01T00:00:00Z'));
    sharedCohortId = cohort.id;
    // Immediately downgrade out of 'running' — cohorts_one_running (005)
    // allows only one 'running' row account-wide, and the tests below only
    // need a valid cohort_id to hang steps/jobs off, not a real "running"
    // cohort. Downgrading here (rather than in the ensureCohort test) is
    // what lets the two coexist regardless of jest's execution order.
    await pool.query(`UPDATE cohorts SET status = 'open' WHERE id = $1`, [sharedCohortId]);
  });

  afterAll(async () => {
    await pool.query(`UPDATE cohorts SET status = 'completed' WHERE id = $1`, [sharedCohortId]);
    await pool.end();
  });

  function uniqueId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Random high seq base per call — steps.PRIMARY KEY is (cohort_id, seq),
   * and the shared cohort persists across local reruns of this suite
   * against the same throwaway DB, so a fixed seq would collide on rerun. */
  function seqBase(): number {
    return 1000 + Math.floor(Math.random() * 1_000_000);
  }

  /** Always releases the client, even if `fn` throws — a leaked checkout is
   * exactly what made afterAll's pool.end() hang before this existed. */
  async function withClient<T>(p: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await p.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  it('ensureCohort is idempotent — same window resolves to the same cohort row', async () => {
    // Uses its own fixed date, distinct from beforeAll's shared cohort, and
    // marks it complete immediately after so it doesn't linger as 'running'
    // and block the shared-cohort tests below.
    const at = new Date('2026-09-01T14:00:00Z');
    const a = await ensureCohort(pool, at);
    const b = await ensureCohort(pool, new Date('2026-09-01T16:00:00Z')); // same window
    expect(a.id).toBe(b.id);
    expect(a.id).toBe('win_2026_09_01_12');
    const { opensAt, closesAt } = windowBounds(at);
    expect(a.opensAt.toISOString()).toBe(opensAt.toISOString());
    expect(a.closesAt.toISOString()).toBe(closesAt.toISOString());
    await pool.query(`UPDATE cohorts SET status = 'completed' WHERE id = $1`, [a.id]);
  });

  it('insertProject is idempotent on request_id — a replay returns the same project, wasNew=false', async () => {
    const cohort = { id: sharedCohortId };
    const projectId = uniqueId('proj');
    const requestId = uniqueId('req');

    const first = await insertProject(pool, {
      id: projectId,
      cohortId: cohort.id,
      requestId,
      tier: 'narration-basic',
      language: 'en',
      request: { hello: 'world' },
      callbackUrl: 'https://convex.example/cb',
    });
    expect(first.wasNew).toBe(true);

    const second = await insertProject(pool, {
      id: projectId,
      cohortId: cohort.id,
      requestId,
      tier: 'narration-basic',
      language: 'en',
      request: { hello: 'world' },
      callbackUrl: 'https://convex.example/cb',
    });
    expect(second.wasNew).toBe(false);
    expect(second.project.id).toBe(first.project.id);

    const fetched = await getProject(pool, projectId);
    expect(fetched?.requestId).toBe(requestId);
  });

  it('steps: insertSteps + listSteps round-trip depends_on', async () => {
    const cohort = { id: sharedCohortId };
    const base = seqBase();
    const [seqImage, seqAnim] = [base, base + 2];
    await insertSteps(pool, cohort.id, [
      { seq: seqImage, name: 'image', endpointId: 'e1', workersTarget: 2, gate: null, drainAfter: true, dependsOn: [], jobTotal: 3 },
      { seq: seqAnim, name: 'animation', endpointId: 'e3', workersTarget: 2, gate: null, drainAfter: true, dependsOn: [seqImage], jobTotal: 3 },
    ]);
    const steps = (await listSteps(pool, cohort.id)).filter((s) => [seqImage, seqAnim].includes(s.seq));
    expect(steps.map((s) => s.seq)).toEqual([seqImage, seqAnim]);
    expect(steps.find((s) => s.seq === seqAnim)?.dependsOn).toEqual([seqImage]);

    const dependents = await dependentSteps(pool, cohort.id, seqImage);
    expect(dependents).toContain(seqAnim);
  });

  it('jobs: claim -> submit -> complete decrements the dependent job in the same frame', async () => {
    const cohort = { id: sharedCohortId };
    const project = (
      await insertProject(pool, {
        id: uniqueId('proj'),
        cohortId: cohort.id,
        requestId: uniqueId('req'),
        tier: 'narration-basic',
        language: 'en',
        request: {},
        callbackUrl: null,
      })
    ).project;

    const base = seqBase();
    const [seqImage, seqAnim] = [base, base + 2];
    await insertSteps(pool, cohort.id, [
      { seq: seqImage, name: 'image', endpointId: 'e1', workersTarget: 2, gate: null, drainAfter: true, dependsOn: [], jobTotal: 1 },
      { seq: seqAnim, name: 'animation', endpointId: 'e3', workersTarget: 2, gate: null, drainAfter: true, dependsOn: [seqImage], jobTotal: 1 },
    ]);

    const frameId = uniqueId('frame');
    await insertJobs(pool, cohort.id, [
      { projectId: project.id, stepSeq: seqImage, seq: 0, frameId, depsRemaining: 0, input: { imagePrompt: 'p' } },
      { projectId: project.id, stepSeq: seqAnim, seq: 0, frameId, depsRemaining: 1, input: { motionPrompt: 'm' } },
    ]);

    // try/finally on every checkout below: a mid-test assertion failure must
    // still release the client, or afterAll's pool.end() hangs waiting for
    // it (exactly what happened here before this was added).

    // The animation job isn't claimable yet — deps_remaining is still 1.
    const claimBefore = await withClient(pool, async (client1) => {
      await client1.query('BEGIN');
      const claimed = await claimNextBatch(client1, cohort.id, seqAnim, 5);
      await client1.query('ROLLBACK');
      return claimed;
    });
    expect(claimBefore).toHaveLength(0);

    // Claim and submit the image job.
    const claimed81 = await withClient(pool, async (client2) => {
      await client2.query('BEGIN');
      const claimed = await claimNextBatch(client2, cohort.id, seqImage, 5);
      expect(claimed).toHaveLength(1);
      await markSubmitted(client2, claimed[0].id, uniqueId('rp-job'));
      await client2.query('COMMIT');
      return claimed;
    });

    // Complete it — this must decrement the animation job's deps_remaining.
    await withClient(pool, async (client3) => {
      await client3.query('BEGIN');
      await markTerminal(client3, claimed81[0].id, { status: 'complete', output: { image: 'https://pub.example/x.png' } });
      await client3.query('COMMIT');
    });

    // Now the animation job should be claimable.
    const claimed83 = await withClient(pool, async (client4) => {
      await client4.query('BEGIN');
      const claimed = await claimNextBatch(client4, cohort.id, seqAnim, 5);
      await client4.query('ROLLBACK');
      return claimed;
    });
    expect(claimed83).toHaveLength(1);
    expect(claimed83[0].depsRemaining).toBe(0);

    const counts81 = await stepJobCounts(pool, cohort.id, seqImage);
    expect(counts81).toEqual({ total: 1, terminal: 1 });
  });
});
