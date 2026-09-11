/**
 * `quality_verdicts` repo (impl plan §6.5, M4). Plain CRUD + the two counts
 * `agents/quality.ts`'s loop and `agents/fleet.ts`'s drain precondition
 * need — the rework-vs-pass-vs-exhausted judgment call lives in the caller
 * (`agents/quality.ts`), matching this codebase's existing convention
 * (`db/repo/steps.ts`'s own docstring says the same about its transitions).
 */
import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface UngatedJob {
  id: number;
  projectId: string;
  frameId: string | null;
  qualityAttempts: number;
  input: unknown;
  output: unknown;
}

/** The jobs_ungated partial index's whole reason to exist (001_init.sql) —
 * status='complete' AND quality_status IS NULL. */
export async function listUngated(db: Queryable, cohortId: string, stepSeq: number): Promise<UngatedJob[]> {
  const { rows } = await db.query(
    `SELECT id, project_id, frame_id, quality_attempts, input, output
       FROM jobs
      WHERE cohort_id = $1 AND step_seq = $2 AND status = 'complete' AND quality_status IS NULL
      ORDER BY seq`,
    [cohortId, stepSeq],
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    frameId: r.frame_id,
    qualityAttempts: r.quality_attempts,
    input: r.input,
    output: r.output,
  }));
}

export async function countUngated(db: Queryable, cohortId: string, stepSeq: number): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*) FROM jobs WHERE cohort_id = $1 AND step_seq = $2 AND status = 'complete' AND quality_status IS NULL`,
    [cohortId, stepSeq],
  );
  return Number(rows[0].count);
}

/** Redundant-by-construction with listUngated once runStep() has exited
 * (a rework write always reopens runStep()'s terminal>=total condition, so
 * no planned/submitted row for a gated step should ever coexist with
 * gateStep() having returned) — kept as a real, cheap, separate check
 * rather than an inference fleet.ts's release() silently trusts to hold. */
export async function countInFlightForGatedStep(db: Queryable, cohortId: string, stepSeq: number): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*) FROM jobs WHERE cohort_id = $1 AND step_seq = $2 AND status IN ('planned', 'submitted')`,
    [cohortId, stepSeq],
  );
  return Number(rows[0].count);
}

/** projects.request->options.qualityGates — validated by the planner,
 * never read back until now (M4). Falls back to 'full' if somehow absent
 * (should not happen — OptionsSchema.qualityGates has a zod .default()). */
export async function getQualityGatesOption(db: Queryable, projectId: string): Promise<string> {
  const { rows } = await db.query<{ opt: string | null }>(
    `SELECT request->'options'->>'qualityGates' AS opt FROM projects WHERE id = $1`,
    [projectId],
  );
  return rows[0]?.opt ?? 'full';
}

export interface VerdictWrite {
  jobId: number;
  gate: 'image' | 'motion';
  attempt: number;
  verdict: string;
  issues: unknown;
  action: string;
  ruleCandidate: boolean;
  costUsd: number | null;
  assetUrl: string | null;
  weightedScore: number | null;
}

async function recordVerdict(client: PoolClient, v: VerdictWrite): Promise<void> {
  await client.query(
    `INSERT INTO quality_verdicts (job_id, gate, attempt, verdict, issues, action, rule_candidate, cost_usd, asset_url, weighted_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [v.jobId, v.gate, v.attempt, v.verdict, JSON.stringify(v.issues), v.action, v.ruleCandidate, v.costUsd, v.assetUrl, v.weightedScore],
  );
}

/** The motion gate's image-quality pre-gate needs the IMAGE gate's most
 * recent numeric score for the SAME frame — looked up by frame_id via a
 * join back through jobs, not by job_id (the image job and the motion job
 * for one frame are different rows). Returns null if no image verdict
 * exists yet for this frame (shouldn't happen given steps run sequentially
 * and step 3 depends on step 1, but handled defensively, not assumed).
 * project_id is required alongside frame_id — same 2026-09-11 finding as
 * generator.ts's resolveDeps(): frame_id alone is not globally unique, so
 * without it this could return another project's same-numbered frame's
 * image score into this frame's motion-gate evaluation. */
export async function latestImageScoreForFrame(db: Queryable, cohortId: string, projectId: string, frameId: string): Promise<number | null> {
  const { rows } = await db.query<{ weighted_score: string | null }>(
    `SELECT qv.weighted_score
       FROM quality_verdicts qv
       JOIN jobs j ON j.id = qv.job_id
      WHERE j.cohort_id = $1 AND j.project_id = $2 AND j.frame_id = $3 AND qv.gate = 'image'
      ORDER BY qv.created_at DESC
      LIMIT 1`,
    [cohortId, projectId, frameId],
  );
  return rows[0]?.weighted_score != null ? Number(rows[0].weighted_score) : null;
}

/** PASS — quality_status='pass', jobs.status untouched (stays 'complete'). */
export async function applyPass(client: PoolClient, v: VerdictWrite): Promise<void> {
  await recordVerdict(client, v);
  await client.query(`UPDATE jobs SET quality_status = 'pass' WHERE id = $1`, [v.jobId]);
}

/** REWORK/FAIL with attempts remaining — status back to 'planned' so
 * generator.ts's existing claim loop naturally resubmits it (see
 * agents/quality.ts's header comment for why this needs no generator.ts
 * change), quality_status cleared so it re-enters jobs_ungated next
 * completion, quality_attempts incremented, tried_rungs appended, and the
 * relevant prompt field corrected with the VLM's issue summary. */
export async function applyRework(
  client: PoolClient,
  v: VerdictWrite,
  opts: { promptField: 'imagePrompt' | 'motionPrompt'; correctedPrompt: string; rungLabel: string },
): Promise<void> {
  await recordVerdict(client, v);
  await client.query(
    `UPDATE jobs
        SET status = 'planned',
            quality_status = NULL,
            quality_attempts = quality_attempts + 1,
            tried_rungs = tried_rungs || ARRAY[$3]::text[],
            input = jsonb_set(input, ARRAY[$2]::text[], to_jsonb($4::text))
      WHERE id = $1`,
    [v.jobId, opts.promptField, opts.rungLabel, opts.correctedPrompt],
  );
}

/** Attempts exhausted — quality_status='fail', status stays 'complete' (the
 * asset genuinely generated; it's the content that's rejected — see the
 * M4 plan's note on 005_invariants.sql's completed_project_with_ungated_leaf,
 * which only checks quality_status, not jobs.status, on the leaf step). */
export async function applyExhausted(client: PoolClient, v: VerdictWrite): Promise<void> {
  await recordVerdict(client, v);
  await client.query(`UPDATE jobs SET quality_status = 'fail' WHERE id = $1`, [v.jobId]);
}

/** options.qualityGates='off' (or 'image-only' skipping the motion gate) —
 * nothing was evaluated, so no quality_verdicts row; just mark it passed
 * so the job leaves jobs_ungated and gateStep()'s loop can terminate. */
export async function applySkipped(db: Queryable, jobId: number): Promise<void> {
  await db.query(`UPDATE jobs SET quality_status = 'pass' WHERE id = $1`, [jobId]);
}
