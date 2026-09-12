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
import { upsertHeld, touchObserved, clearHeld, getState } from '../src/db/repo/endpoint-state';

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

  it('jobs: a singleJobPerProject consumer (frame_id NULL) fans in on every frame\'s producer completion, including a failed one (2026-09-12, step 8/concat)', async () => {
    const cohort = { id: sharedCohortId };
    const project = (
      await insertProject(pool, {
        id: uniqueId('proj'),
        cohortId: cohort.id,
        requestId: uniqueId('req'),
        tier: 'narration-premium',
        language: 'en',
        request: {},
        callbackUrl: null,
      })
    ).project;

    const base = seqBase();
    const [seqMerge, seqConcat] = [base, base + 2];
    await insertSteps(pool, cohort.id, [
      { seq: seqMerge, name: 'merge', endpointId: 'e6', workersTarget: 2, gate: null, drainAfter: false, dependsOn: [], jobTotal: 3 },
      { seq: seqConcat, name: 'concat', endpointId: 'e6', workersTarget: 2, gate: null, drainAfter: true, dependsOn: [seqMerge], jobTotal: 1 },
    ]);

    const frameIds = [uniqueId('frame'), uniqueId('frame'), uniqueId('frame')];
    await insertJobs(pool, cohort.id, [
      ...frameIds.map((frameId, idx) => ({ projectId: project.id, stepSeq: seqMerge, seq: idx, frameId, depsRemaining: 0, input: {} })),
      // 3-way fan-in: one row, no frame, waiting on all 3 merge jobs above.
      { projectId: project.id, stepSeq: seqConcat, seq: 0, frameId: null, depsRemaining: 3, input: {} },
    ]);

    async function claimAndComplete(frameId: string, outcome: { status: 'complete'; output: unknown } | { status: 'failed'; error: unknown }) {
      const claimed = await withClient(pool, async (client) => {
        await client.query('BEGIN');
        const rows = await claimNextBatch(client, cohort.id, seqMerge, 5, project.id);
        const row = rows.find((r) => r.frameId === frameId)!;
        await markSubmitted(client, row.id, uniqueId('rp-job'));
        await client.query('COMMIT');
        return row;
      });
      await withClient(pool, async (client) => {
        await client.query('BEGIN');
        await markTerminal(client, claimed.id, outcome);
        await client.query('COMMIT');
      });
    }

    // Not claimable yet — still waiting on all 3 frames.
    const before = await withClient(pool, async (client) => {
      await client.query('BEGIN');
      const claimed = await claimNextBatch(client, cohort.id, seqConcat, 5);
      await client.query('ROLLBACK');
      return claimed;
    });
    expect(before).toHaveLength(0);

    await claimAndComplete(frameIds[0], { status: 'complete', output: { video: 'https://pub.example/f0.mp4' } });
    await claimAndComplete(frameIds[1], { status: 'failed', error: { status: 'FAILED' } }); // a hard failure must still count toward fan-in
    await claimAndComplete(frameIds[2], { status: 'complete', output: { video: 'https://pub.example/f2.mp4' } });

    const after = await withClient(pool, async (client) => {
      await client.query('BEGIN');
      const claimed = await claimNextBatch(client, cohort.id, seqConcat, 5);
      await client.query('ROLLBACK');
      return claimed;
    });
    expect(after).toHaveLength(1);
    expect(after[0].frameId).toBeNull();
    expect(after[0].depsRemaining).toBe(0);
  });
});

maybeDescribe('db repo layer — endpoint_state (integration, M3)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DB_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  function uniqueEndpointId(): string {
    return `test-endpoint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  it('upsertHeld -> getState round-trips the claim', async () => {
    const endpointId = uniqueEndpointId();
    await upsertHeld(pool, endpointId, { cohortId: 'win_test', stepSeq: 3, workersMax: 10, workersMin: 10, workersReady: 0 });

    const state = await getState(pool, endpointId);
    expect(state).toBeDefined();
    expect(state?.heldByCohort).toBe('win_test');
    expect(state?.heldByStep).toBe(3);
    expect(state?.workersMax).toBe(10);
    expect(state?.workersReady).toBe(0);
  });

  it('a second upsertHeld call overwrites the row (ON CONFLICT), not a duplicate', async () => {
    const endpointId = uniqueEndpointId();
    await upsertHeld(pool, endpointId, { cohortId: 'win_a', stepSeq: 1, workersMax: 5, workersMin: 5, workersReady: 0 });
    await upsertHeld(pool, endpointId, { cohortId: 'win_a', stepSeq: 1, workersMax: 5, workersMin: 5, workersReady: 5 });

    const state = await getState(pool, endpointId);
    expect(state?.workersReady).toBe(5);
  });

  it('touchObserved bumps observed_at without touching the held fields', async () => {
    const endpointId = uniqueEndpointId();
    await upsertHeld(pool, endpointId, { cohortId: 'win_b', stepSeq: 7, workersMax: 25, workersMin: 25, workersReady: 25 });
    const before = await getState(pool, endpointId);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await touchObserved(pool, endpointId);
    const after = await getState(pool, endpointId);

    expect(after?.observedAt.getTime()).toBeGreaterThan(before!.observedAt.getTime());
    expect(after?.heldByStep).toBe(7);
    expect(after?.heldByCohort).toBe('win_b');
  });

  it('clearHeld nulls the held fields and zeroes worker counts', async () => {
    const endpointId = uniqueEndpointId();
    await upsertHeld(pool, endpointId, { cohortId: 'win_c', stepSeq: 2, workersMax: 8, workersMin: 8, workersReady: 8 });

    await clearHeld(pool, endpointId);
    const state = await getState(pool, endpointId);

    expect(state?.heldByCohort).toBeNull();
    expect(state?.heldByStep).toBeNull();
    expect(state?.workersMax).toBe(0);
    expect(state?.workersMin).toBe(0);
    expect(state?.workersReady).toBe(0);
  });

  it('clearHeld on an endpoint with no prior row still leaves it in a clean, unheld state', async () => {
    const endpointId = uniqueEndpointId();
    await clearHeld(pool, endpointId);
    const state = await getState(pool, endpointId);
    expect(state?.heldByStep).toBeNull();
  });
});
