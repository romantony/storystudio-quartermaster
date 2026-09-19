/**
 * Asset-pipeline repo integration tests, against a real Postgres — same
 * convention (and the same DATABASE_URL gate) as repo.integration.test.ts.
 *
 * These exist because the interesting parts of migration 013 are things only
 * a real database can tell you: that ON CONFLICT infers the unique key on a
 * PARTITIONED table, that the handoff's status CASE is evaluated against the
 * merged `sources` rather than the old ones, that two upstreams handing off
 * to the same row do not clobber each other, and that the attempts CHECK and
 * the app-side clamp agree (the exact pairing whose mismatch deadlocked the
 * cohort path on 2026-09-18).
 *
 * Run against a throwaway DB with migrations applied:
 *   DATABASE_URL=postgres://qm:qm@localhost:55432/qm_orchestrator_test \
 *     npx ts-node src/db/migrate.ts up && npx jest asset-repo.integration
 */
import { Pool } from 'pg';
import {
  insertAssets,
  claimPending,
  markSubmitted,
  completeAsset,
  failOrRetryAsset,
  reworkAsset,
  releaseSatisfiedBlocked,
  armProjectAsset,
  gateAssetPass,
  gateAssetRework,
  gateAssetSkipped,
  listUngatedAssets,
  listStaleUngated,
  ASSET_QUALITY_ATTEMPTS_HARD_CAP,
  countInFlightForEndpoint,
  listProjectAssets,
  getAssetByProviderJobId,
  queueDepths,
  ASSET_ATTEMPTS_HARD_CAP,
  ASSET_REWORKS_HARD_CAP,
  type NewAsset,
} from '../src/db/repo/assets';
import { insertPipelineProject, getPipelineProject, beginAssembly, finishPipelineProject } from '../src/db/repo/pipeline';
import { compilePlan, expectedAssetCount } from '../src/assets/plan';
import { buildAssetRows } from '../src/assets/submit';
import { RequestSchema, type OrchestratorRequest } from '../src/agents/planner';

const DB_URL = process.env.DATABASE_URL;
const maybeDescribe = DB_URL ? describe : describe.skip;

function request(projectId: string, overrides: Record<string, unknown> = {}): OrchestratorRequest {
  return RequestSchema.parse({
    requestId: `req_${projectId}`,
    projectId,
    source: 'mcp',
    tier: 'narration-basic',
    product: 'documentary',
    language: 'en',
    aspectRatio: '9:16',
    resolution: '1080x1920',
    callbackUrl: 'https://convex.example/api/qm/result',
    options: {},
    frames: [
      { frameId: 'f1', imagePrompt: 'a lighthouse', narration: 'one', durationS: 5 },
      { frameId: 'f2', imagePrompt: 'a harbour', narration: 'two', durationS: 4 },
    ],
    ...overrides,
  });
}

maybeDescribe('asset pipeline repo (integration)', () => {
  let pool: Pool;
  let n = 0;

  beforeAll(() => {
    pool = new Pool({ connectionString: DB_URL });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM projects WHERE id LIKE 'assetpx_%'`);
    await pool.end();
  });

  /** A project row for the asset tables to hang off. No cohort — which is
   * itself part of what these tests assert is possible. */
  async function seedProject(overrides: Record<string, unknown> = {}): Promise<{ projectId: string; req: OrchestratorRequest }> {
    const projectId = `assetpx_${Date.now()}_${n++}`;
    const req = request(projectId, overrides);
    await pool.query(
      `INSERT INTO projects (id, cohort_id, request_id, tier, language, status, request, callback_url)
       VALUES ($1, NULL, $2, $3, $4, 'generating', $5, $6)`,
      [projectId, req.requestId, req.tier, req.language, req, req.callbackUrl],
    );
    return { projectId, req };
  }

  async function seedAssets(overrides: Record<string, unknown> = {}): Promise<{ projectId: string; req: OrchestratorRequest; plan: ReturnType<typeof compilePlan> }> {
    const { projectId, req } = await seedProject(overrides);
    const plan = compilePlan(req);
    await insertAssets(pool, buildAssetRows(req, plan));
    await insertPipelineProject(pool, { projectId, plan, expectedAssets: expectedAssetCount(plan) });
    return { projectId, req, plan };
  }

  it('writes every asset into its own partition, chain heads runnable and the rest blocked', async () => {
    const { projectId, plan } = await seedAssets();
    const rows = await listProjectAssets(pool, projectId);
    // 3 frame kinds x 2 frames, plus the project-scoped tail row.
    expect(rows).toHaveLength(plan.frameKinds.length * 2 + 1);

    const byStatus = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    // qwen-image-gen and tts (2 frames each) start runnable.
    expect(byStatus.pending).toBe(4);
    // wan2-i2v x2 waiting on their inputs, plus the tail waiting on the compiler.
    expect(byStatus.blocked).toBe(3);

    // Each row really is in the partition its agent polls.
    const { rows: tts } = await pool.query('SELECT count(*) AS n FROM asset_tts WHERE project_id = $1', [projectId]);
    expect(Number(tts[0].n)).toBe(2);
    const { rows: tail } = await pool.query('SELECT frame_id FROM asset_postprod_lite WHERE project_id = $1', [projectId]);
    expect(tail).toEqual([{ frame_id: '*' }]);
  });

  it('starts the project bgm track runnable, with no per-frame input to wait for', async () => {
    const { projectId } = await seedAssets({ options: { bgm: true }, bgmPrompt: 'soft piano' });
    const bgm = (await listProjectAssets(pool, projectId)).filter((r) => r.kind === 'bgm');
    expect(bgm).toHaveLength(1);
    expect(bgm[0].frameId).toBe('*');
    expect(bgm[0].status).toBe('pending');
    expect((bgm[0].input as { bgmPrompt?: string }).bgmPrompt).toBe('soft piano');
  });

  it('is idempotent on replay — a second submission adds nothing', async () => {
    const { projectId, req, plan } = await seedAssets();
    const again = await insertAssets(pool, buildAssetRows(req, plan));
    expect(again).toBe(0);
    expect(await listProjectAssets(pool, projectId)).toHaveLength(plan.frameKinds.length * 2 + 1);
  });

  it('hands off by writing the next table, and releases the row only when every input is present', async () => {
    const { projectId, plan } = await seedAssets();

    const image = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'qwen-image-gen' && r.frameId === 'f1')!;
    const tts = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'tts' && r.frameId === 'f1')!;

    const client = await pool.connect();
    try {
      // First upstream: wan2-i2v now has the image but not the narration.
      await client.query('BEGIN');
      await completeAsset(
        client,
        { id: image.id, kind: image.kind, projectId, frameId: 'f1', seq: 0 },
        { output: { image: 'https://cdn/f1.png' }, assetUrl: 'https://cdn/f1.png' },
        [{ kind: 'wan2-i2v', requiredInputs: plan.requires['wan2-i2v'], endpointId: 'x', stage: null, stages: [], input: {} }],
      );
      await client.query('COMMIT');

      let motion = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'wan2-i2v' && r.frameId === 'f1')!;
      expect(motion.status).toBe('blocked');
      expect(motion.sources['qwen-image-gen'].url).toBe('https://cdn/f1.png');

      // Second upstream: both inputs present, so the row goes runnable — and
      // the first upstream's source survives the merge.
      await client.query('BEGIN');
      await completeAsset(
        client,
        { id: tts.id, kind: tts.kind, projectId, frameId: 'f1', seq: 0 },
        { output: { audio: 'https://cdn/f1.mp3', duration_s: 5.4 }, assetUrl: 'https://cdn/f1.mp3', durationS: 5.4 },
        [{ kind: 'wan2-i2v', requiredInputs: plan.requires['wan2-i2v'], endpointId: 'x', stage: null, stages: [], input: {} }],
      );
      await client.query('COMMIT');

      motion = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'wan2-i2v' && r.frameId === 'f1')!;
      expect(motion.status).toBe('pending');
      expect(motion.sources['qwen-image-gen'].url).toBe('https://cdn/f1.png');
      expect(motion.sources.tts).toEqual({ url: 'https://cdn/f1.mp3', durationS: 5.4 });

      // The project-scoped tail is untouched by per-frame handoff — only the
      // compiler arms it.
      const tail = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'postprod-lite')!;
      expect(tail.status).toBe('blocked');
    } finally {
      client.release();
    }
  });

  it('never hands off to a row that already moved past blocked', async () => {
    const { projectId, plan } = await seedAssets();
    const rows = await listProjectAssets(pool, projectId);
    const tts = rows.find((r) => r.kind === 'tts' && r.frameId === 'f1')!;
    const motion = rows.find((r) => r.kind === 'wan2-i2v' && r.frameId === 'f1')!;

    // Pretend this frame's motion job already failed.
    await pool.query(`UPDATE assets SET status = 'failed' WHERE asset_kind = 'wan2-i2v' AND id = $1`, [motion.id]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await completeAsset(
        client,
        { id: tts.id, kind: 'tts', projectId, frameId: 'f1', seq: 0 },
        { output: {}, assetUrl: 'https://cdn/f1.mp3' },
        [{ kind: 'wan2-i2v', requiredInputs: plan.requires['wan2-i2v'], endpointId: 'x', stage: null, stages: [], input: {} }],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const after = (await listProjectAssets(pool, projectId)).find((r) => r.id === motion.id)!;
    expect(after.status).toBe('failed');
    // The url was still recorded, so a later rework has it.
    expect(after.sources.tts.url).toBe('https://cdn/f1.mp3');
  });

  it('arms the project-scoped tail exactly once, and only the compiler can', async () => {
    const { projectId } = await seedAssets();
    const before = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'postprod-lite')!;
    expect(before.status).toBe('blocked');

    // The per-frame repair pass must never release it, even though it has no
    // outstanding required inputs — its fan-in is the whole project.
    expect(await releaseSatisfiedBlocked(pool, projectId)).toBe(0);
    expect((await listProjectAssets(pool, projectId)).find((r) => r.kind === 'postprod-lite')!.status).toBe('blocked');

    expect(await armProjectAsset(pool, projectId, 'postprod-lite', { manifestUrl: 'https://cdn/m.json' })).toBe(true);
    const armed = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'postprod-lite')!;
    expect(armed.status).toBe('pending');
    expect((armed.input as { manifestUrl?: string }).manifestUrl).toBe('https://cdn/m.json');

    // A second compiler tick racing the first cannot re-arm a live row.
    expect(await armProjectAsset(pool, projectId, 'postprod-lite', { manifestUrl: 'https://cdn/other.json' })).toBe(false);
    expect(((await listProjectAssets(pool, projectId)).find((r) => r.kind === 'postprod-lite')!.input as { manifestUrl?: string }).manifestUrl)
      .toBe('https://cdn/m.json');
  });

  it('re-arms a tail that failed, so the compiler can recompile and retry', async () => {
    const { projectId } = await seedAssets();
    const tail = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'postprod-lite')!;
    await pool.query(`UPDATE assets SET status = 'failed' WHERE asset_kind = 'postprod-lite' AND id = $1`, [tail.id]);
    expect(await armProjectAsset(pool, projectId, 'postprod-lite', { manifestUrl: 'https://cdn/retry.json' })).toBe(true);
    expect((await listProjectAssets(pool, projectId)).find((r) => r.kind === 'postprod-lite')!.status).toBe('pending');
  });

  it('claims only its own kind, oldest first, and skips locked rows', async () => {
    const { projectId } = await seedAssets();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await claimPending(client, 'tts', 10);
      expect(batch.length).toBeGreaterThanOrEqual(2);
      expect(batch.every((r) => r.kind === 'tts')).toBe(true);

      // A concurrent claim must not see the rows this one holds. Asserted on
      // ids rather than on project scope: an agent claims across EVERY
      // project at once (that is the point of the model), so the second call
      // legitimately returns other projects' work.
      const other = await pool.connect();
      try {
        await other.query('BEGIN');
        const second = await claimPending(other, 'tts', 50);
        const held = new Set(batch.map((r) => r.id));
        expect(second.filter((r) => held.has(r.id))).toHaveLength(0);
        await other.query('ROLLBACK');
      } finally {
        other.release();
      }
      expect(projectId).toBeTruthy();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('counts in-flight per endpoint, which is how one pod ends up per project', async () => {
    const a = await seedAssets();
    const b = await seedAssets();
    const tailA = (await listProjectAssets(pool, a.projectId)).find((r) => r.kind === 'postprod-lite')!;
    const tailB = (await listProjectAssets(pool, b.projectId)).find((r) => r.kind === 'postprod-lite')!;
    expect(tailA.endpointId).toBe(tailB.endpointId);

    const before = await countInFlightForEndpoint(pool, tailA.endpointId);
    await markSubmitted(pool, tailA.id, 'postprod-lite', `rp_${a.projectId}_tail`);
    await markSubmitted(pool, tailB.id, 'postprod-lite', `rp_${b.projectId}_tail`);
    // Two projects assembling = two of that endpoint's pods in use.
    expect(await countInFlightForEndpoint(pool, tailA.endpointId)).toBe(before + 2);
  });

  it('resolves a row by its provider job id, for the webhook receiver', async () => {
    const { projectId } = await seedAssets();
    const tts = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'tts')!;
    await markSubmitted(pool, tts.id, 'tts', `rp_hook_${projectId}`);
    const found = await getAssetByProviderJobId(pool, `rp_hook_${projectId}`);
    expect(found?.id).toBe(tts.id);
    expect(found?.kind).toBe('tts');
  });

  it('records the one-shot tail\u2019s final url on its own row', async () => {
    const { projectId } = await seedAssets({ options: { removeSilence: true } });
    const tail = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'postprod-lite')!;
    // A single call, no stages — the worker does merge/trim/concat internally.
    expect(tail.stages).toEqual([]);

    await armProjectAsset(pool, projectId, 'postprod-lite', { manifestUrl: 'https://cdn/m.json' });
    await markSubmitted(pool, tail.id, 'postprod-lite', `rp_tail_${projectId}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await completeAsset(
        client,
        { id: tail.id, kind: 'postprod-lite', projectId, frameId: '*', seq: 0 },
        { output: { video: 'https://cdn/final.mp4', duration_s: 44.2 }, assetUrl: 'https://cdn/final.mp4', durationS: 44.2 },
        [],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const after = (await listProjectAssets(pool, projectId)).find((r) => r.id === tail.id)!;
    expect(after.status).toBe('complete');
    expect(after.assetUrl).toBe('https://cdn/final.mp4');
    expect(after.durationS).toBe(44.2);
  });

  it('retries within the budget, then fails terminally — and never exceeds the DB CHECK', async () => {
    const { projectId } = await seedAssets();
    const row = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'tts')!;

    await markSubmitted(pool, row.id, 'tts', `rp_retry_${projectId}_1`);
    expect(await failOrRetryAsset(pool, row.id, 'tts', { error: 'boom' }, 2)).toBe(true);
    await markSubmitted(pool, row.id, 'tts', `rp_retry_${projectId}_2`);
    expect(await failOrRetryAsset(pool, row.id, 'tts', { error: 'boom' }, 2)).toBe(false);

    const after = (await listProjectAssets(pool, projectId)).find((r) => r.id === row.id)!;
    expect(after.status).toBe('failed');
    expect(after.attempts).toBeLessThanOrEqual(ASSET_ATTEMPTS_HARD_CAP);
  });

  it('clamps a caller-supplied ceiling to the hard cap rather than letting the UPDATE throw', async () => {
    const { projectId } = await seedAssets();
    const row = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'tts')!;
    // A ceiling far above the CHECK is exactly the 2026-09-18 deadlock shape:
    // it must clamp, not raise.
    for (let i = 0; i < ASSET_ATTEMPTS_HARD_CAP + 2; i += 1) {
      await markSubmitted(pool, row.id, 'tts', `rp_clamp_${projectId}_${i}`).catch(() => undefined);
      await failOrRetryAsset(pool, row.id, 'tts', { error: 'boom' }, 9999);
    }
    const after = (await listProjectAssets(pool, projectId)).find((r) => r.id === row.id)!;
    expect(after.attempts).toBeLessThanOrEqual(ASSET_ATTEMPTS_HARD_CAP);
    expect(after.status).toBe('failed');
  });

  it('reworks a stuck row on its own bounded budget, continuing the attempt count', async () => {
    const { projectId } = await seedAssets();
    const row = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'tts')!;
    await markSubmitted(pool, row.id, 'tts', `rp_rework_${projectId}`);

    for (let i = 0; i < ASSET_REWORKS_HARD_CAP; i += 1) {
      expect(await reworkAsset(pool, row.id, 'tts', { reason: 'stuck' })).toBe(true);
    }
    expect(await reworkAsset(pool, row.id, 'tts', { reason: 'stuck' })).toBe(false);

    const after = (await listProjectAssets(pool, projectId)).find((r) => r.id === row.id)!;
    expect(after.status).toBe('failed');
    expect(after.reworks).toBe(ASSET_REWORKS_HARD_CAP);
    // Continued, not reset: the one submission it had still counts.
    expect(after.attempts).toBe(1);
  });

  it('releases a row stranded by a lost handoff, and only that row', async () => {
    const { projectId, plan } = await seedAssets();
    const rows = await listProjectAssets(pool, projectId);
    const stranded = rows.find((r) => r.kind === 'wan2-i2v' && r.frameId === 'f1')!;
    const honest = rows.find((r) => r.kind === 'wan2-i2v' && r.frameId === 'f2')!;

    // f1 has both inputs but never flipped; f2 has only one.
    await pool.query(`UPDATE assets SET sources = $2::jsonb WHERE asset_kind = 'wan2-i2v' AND id = $1`, [
      stranded.id,
      JSON.stringify({ 'qwen-image-gen': { url: 'a' }, tts: { url: 'b' } }),
    ]);
    await pool.query(`UPDATE assets SET sources = $2::jsonb WHERE asset_kind = 'wan2-i2v' AND id = $1`, [
      honest.id,
      JSON.stringify({ tts: { url: 'b' } }),
    ]);
    expect(plan.requires['wan2-i2v']).toHaveLength(2);

    expect(await releaseSatisfiedBlocked(pool, projectId)).toBe(1);
    const after = await listProjectAssets(pool, projectId);
    expect(after.find((r) => r.id === stranded.id)!.status).toBe('pending');
    expect(after.find((r) => r.id === honest.id)!.status).toBe('blocked');
  });

  it('rejects a complete row with no asset url — the silent-degradation guard', async () => {
    const { projectId } = await seedAssets();
    const row = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'tts')!;
    await expect(
      pool.query(`UPDATE assets SET status = 'complete' WHERE asset_kind = 'tts' AND id = $1`, [row.id]),
    ).rejects.toThrow(/assets_complete_has_url/);
  });

  it('lets exactly one caller claim a project for assembly', async () => {
    const { projectId } = await seedAssets();
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      expect(await beginAssembly(a, projectId, { version: 1 }, null)).toBe(true);
      expect(await beginAssembly(b, projectId, { version: 1 }, null)).toBe(false);
    } finally {
      a.release();
      b.release();
    }
    const pp = await getPipelineProject(pool, projectId);
    expect(pp?.status).toBe('assembling');
    expect(pp?.attempts).toBe(1);
    // The plan round-trips through jsonb intact — it is what every handoff
    // and the compiler's completeness check are read from.
    expect(pp?.plan.requires['wan2-i2v']).toEqual(['qwen-image-gen', 'tts']);

    await finishPipelineProject(pool, projectId, { status: 'completed', finalUrl: 'https://cdn/final.mp4' });
    expect((await getPipelineProject(pool, projectId))?.finalUrl).toBe('https://cdn/final.mp4');
    // This fixture is deliberately inconsistent (completed with assets that
    // never generated), which is exactly what verify_asset_invariants()
    // reports — drop it so the invariant tests below see a clean database.
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });

  describe('the quality gate', () => {
    /** Complete a gated asset the way assets/agent.ts does: no handoff. */
    async function completeGated(projectId: string, kind: 'qwen-image-gen' | 'wan2-i2v', frameId: string, url: string) {
      const rows = await listProjectAssets(pool, projectId);
      const r = rows.find((x) => x.kind === kind && x.frameId === frameId)!;
      await markSubmitted(pool, r.id, kind, `rp_gate_${projectId}_${kind}_${frameId}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await completeAsset(client, { id: r.id, kind, projectId, frameId, seq: r.seq }, { output: {}, assetUrl: url }, [], true);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      return (await listProjectAssets(pool, projectId)).find((x) => x.id === r.id)!;
    }

    it('completes a gated asset without handing off, and queues it for the gate', async () => {
      const { projectId } = await seedAssets();
      const image = await completeGated(projectId, 'qwen-image-gen', 'f1', 'https://cdn/f1.png');
      expect(image.status).toBe('complete');
      expect(image.qualityStatus).toBeNull();

      // The downstream row has NOT been released.
      const motion = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'wan2-i2v' && r.frameId === 'f1')!;
      expect(motion.status).toBe('blocked');
      expect(motion.sources['qwen-image-gen']).toBeUndefined();

      const queue = await listUngatedAssets(pool, 'qwen-image-gen', 10);
      expect(queue.map((q) => q.id)).toContain(image.id);
    });

    it('marks an ungated kind gated at completion, so it never enters the queue', async () => {
      const { projectId } = await seedAssets();
      const tts = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'tts' && r.frameId === 'f1')!;
      await markSubmitted(pool, tts.id, 'tts', `rp_ungated_${projectId}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await completeAsset(client, { id: tts.id, kind: 'tts', projectId, frameId: 'f1', seq: 0 }, { output: {}, assetUrl: 'https://cdn/f1.mp3' }, [], false);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const after = (await listProjectAssets(pool, projectId)).find((r) => r.id === tts.id)!;
      expect(after.qualityStatus).toBe('ungated');
      expect((await listUngatedAssets(pool, 'tts', 10)).map((q) => q.id)).not.toContain(tts.id);
    });

    it('a passing verdict records the score AND performs the deferred handoff', async () => {
      const { projectId, plan } = await seedAssets();
      const image = await completeGated(projectId, 'qwen-image-gen', 'f1', 'https://cdn/f1.png');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const applied = await gateAssetPass(
          client,
          { id: image.id, kind: 'qwen-image-gen', projectId, frameId: 'f1', seq: 0 },
          { status: 'pass', score: 9.1, issues: [] },
          { url: 'https://cdn/f1.png' },
          [{ kind: 'wan2-i2v', requiredInputs: plan.requires['wan2-i2v'], endpointId: 'x', stage: null, stages: [], input: {} }],
        );
        expect(applied).toBe(true);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const after = await listProjectAssets(pool, projectId);
      expect(after.find((r) => r.id === image.id)!.qualityStatus).toBe('pass');
      expect(after.find((r) => r.id === image.id)!.qualityScore).toBe(9.1);
      // The handoff the completion deferred has now happened.
      expect(after.find((r) => r.kind === 'wan2-i2v' && r.frameId === 'f1')!.sources['qwen-image-gen'].url).toBe('https://cdn/f1.png');
    });

    it('a second verdict on the same asset cannot double-hand-off', async () => {
      const { projectId } = await seedAssets();
      const image = await completeGated(projectId, 'qwen-image-gen', 'f1', 'https://cdn/f1.png');
      const ref = { id: image.id, kind: 'qwen-image-gen' as const, projectId, frameId: 'f1', seq: 0 };
      const client = await pool.connect();
      try {
        expect(await gateAssetPass(client, ref, { status: 'pass', score: 9, issues: [] }, { url: 'https://cdn/f1.png' }, [])).toBe(true);
        expect(await gateAssetPass(client, ref, { status: 'pass', score: 9, issues: [] }, { url: 'https://cdn/f1.png' }, [])).toBe(false);
      } finally {
        client.release();
      }
    });

    it('a rejecting verdict re-queues the SAME row with the corrected input', async () => {
      const { projectId } = await seedAssets();
      const image = await completeGated(projectId, 'qwen-image-gen', 'f1', 'https://cdn/f1.png');

      const requeued = await gateAssetRework(
        pool,
        { id: image.id, kind: 'qwen-image-gen' },
        { score: 0, issues: [{ category: 'DEGENERATE', priority: 'P0', description: 'blank' }] },
        { frameId: 'f1', imagePrompt: 'a lighthouse at dusk', seed: 101 },
      );
      expect(requeued).toBe(true);

      const after = (await listProjectAssets(pool, projectId)).find((r) => r.id === image.id)!;
      expect(after.status).toBe('pending');
      expect(after.qualityStatus).toBe('rework');
      expect(after.qualityAttempts).toBe(1);
      expect((after.input as { seed?: number }).seed).toBe(101);
      // The rejected asset is cleared — nothing downstream can pick it up.
      expect(after.assetUrl).toBeNull();
      // The provider-failure budget is NOT consumed by a quality rework.
      expect(after.attempts).toBe(0);
    });

    it('stops reworking at the quality cap, and the DB CHECK agrees', async () => {
      const { projectId } = await seedAssets();
      for (let i = 0; i <= ASSET_QUALITY_ATTEMPTS_HARD_CAP; i += 1) {
        const image = await completeGated(projectId, 'qwen-image-gen', 'f1', `https://cdn/f1-${i}.png`);
        const ok = await gateAssetRework(pool, { id: image.id, kind: 'qwen-image-gen' }, { score: 0, issues: [] }, image.input);
        if (i < ASSET_QUALITY_ATTEMPTS_HARD_CAP) expect(ok).toBe(true);
        else expect(ok).toBe(false);
      }
      const after = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'qwen-image-gen' && r.frameId === 'f1')!;
      expect(after.qualityAttempts).toBe(ASSET_QUALITY_ATTEMPTS_HARD_CAP);
    });

    it('surfaces an asset left unjudged past the grace window', async () => {
      const { projectId } = await seedAssets();
      const image = await completeGated(projectId, 'qwen-image-gen', 'f1', 'https://cdn/f1.png');
      expect(await listStaleUngated(pool, projectId, new Date(Date.now() - 60_000))).toHaveLength(0);

      await pool.query(`UPDATE assets SET completed_at = now() - interval '1 hour' WHERE asset_kind = 'qwen-image-gen' AND id = $1`, [image.id]);
      const stale = await listStaleUngated(pool, projectId, new Date(Date.now() - 60_000));
      expect(stale.map((r) => r.id)).toEqual([image.id]);

      // Releasing it unjudged still writes the handoff it was holding.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        expect(
          await gateAssetSkipped(
            client,
            { id: image.id, kind: 'qwen-image-gen', projectId, frameId: 'f1', seq: 0 },
            { url: 'https://cdn/f1.png' },
            [{ kind: 'wan2-i2v', requiredInputs: ['qwen-image-gen', 'tts'], endpointId: 'x', stage: null, stages: [], input: {} }],
          ),
        ).toBe(true);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const motion = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'wan2-i2v' && r.frameId === 'f1')!;
      expect(motion.sources['qwen-image-gen'].url).toBe('https://cdn/f1.png');
    });

    it('verify_asset_quality_invariants() catches a handoff that escaped the gate', async () => {
      const { projectId } = await seedAssets();
      const image = await completeGated(projectId, 'qwen-image-gen', 'f1', 'https://cdn/f1.png');
      // Simulate the bug: the downstream row got the url without a verdict.
      await pool.query(
        `UPDATE assets SET sources = '{"qwen-image-gen": {"url": "https://cdn/f1.png"}}'::jsonb
          WHERE asset_kind = 'wan2-i2v' AND project_id = $1 AND frame_id = 'f1'`,
        [projectId],
      );
      const { rows } = await pool.query('SELECT * FROM verify_asset_quality_invariants()');
      expect(rows.some((r: { invariant: string }) => r.invariant === 'asset_handed_off_before_gating')).toBe(true);
      expect(image.qualityStatus).toBeNull();
      await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    });
  });

  it('reports queue depth per kind — the "is any GPU idle while work is queued" number', async () => {
    await seedAssets();
    const depths = await queueDepths(pool);
    const tts = depths.find((d) => d.kind === 'tts');
    expect(tts).toBeDefined();
    expect(tts!.pending + tts!.submitted).toBeGreaterThan(0);
  });

  it('cascades every asset away when its project is deleted', async () => {
    const { projectId } = await seedAssets();
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    expect(await listProjectAssets(pool, projectId)).toHaveLength(0);
    expect(await getPipelineProject(pool, projectId)).toBeUndefined();
  });

  it('verify_asset_invariants() is empty on a healthy database', async () => {
    const { rows } = await pool.query('SELECT * FROM verify_asset_invariants()');
    expect(rows).toEqual([]);
  });

  it('verify_asset_invariants() catches a row blocked with its inputs satisfied', async () => {
    const { projectId } = await seedAssets();
    const stranded = (await listProjectAssets(pool, projectId)).find((r) => r.kind === 'wan2-i2v')!;
    await pool.query(`UPDATE assets SET sources = $2::jsonb WHERE asset_kind = 'wan2-i2v' AND id = $1`, [
      stranded.id,
      JSON.stringify({ 'qwen-image-gen': { url: 'a' }, tts: { url: 'b' } }),
    ]);
    const { rows } = await pool.query('SELECT * FROM verify_asset_invariants()');
    expect(rows.some((r: { invariant: string }) => r.invariant === 'asset_blocked_with_inputs_satisfied')).toBe(true);
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });

  it('accepts an asset row set for a project with no cohort at all', async () => {
    const { projectId } = await seedAssets();
    const { rows } = await pool.query('SELECT cohort_id FROM projects WHERE id = $1', [projectId]);
    expect(rows[0].cohort_id).toBeNull();
    expect((await listProjectAssets(pool, projectId)).length).toBeGreaterThan(0);
  });

  it('keeps one asset per (kind, project, frame) even under a concurrent double insert', async () => {
    const { projectId, req, plan } = await seedAssets();
    const rows: NewAsset[] = buildAssetRows(req, plan);
    await Promise.all([insertAssets(pool, rows), insertAssets(pool, rows)]);
    const all = await listProjectAssets(pool, projectId);
    const keys = new Set(all.map((r) => `${r.kind}:${r.frameId}`));
    expect(keys.size).toBe(all.length);
  });
});
