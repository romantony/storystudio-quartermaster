/**
 * `assets` repo (migration 013). Every statement the eight generator agents
 * and the project compiler run against the per-asset tables lives here; the
 * loop logic stays in assets/agent.ts and assets/compiler.ts.
 *
 * The one rule this file exists to enforce: **a completion and its handoff
 * are one transaction.** "Write back status + the CDN url, and write the url
 * into the next table" must be atomic, or a crash between the two loses the
 * handoff and the downstream row waits forever on an input that already
 * exists. `completeAsset()` therefore takes the handoff targets and does
 * both, and the compiler's repair pass exists for the cases it still cannot
 * cover (a row that was never created at all).
 */
import type { Pool, PoolClient } from 'pg';
import type { AssetKind } from '../../assets/kinds';

type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * INVARIANT: must stay <= migration 013's `assets_attempts_cap` CHECK.
 * The cohort path deadlocked on 2026-09-18 precisely because an app-side
 * ceiling exceeded the DB constraint and every UPDATE threw. Clamped here so
 * the write can never be the thing that fails.
 */
export const ASSET_ATTEMPTS_HARD_CAP = 10;
export const ASSET_REWORKS_HARD_CAP = 3;
/** INVARIANT: must stay <= migration 014's `quality_attempts` CHECK. */
export const ASSET_QUALITY_ATTEMPTS_HARD_CAP = 4;

/** `frame_id` for an asset that belongs to the project, not to one frame. */
export const PROJECT_SCOPE = '*';

export interface AssetRow {
  id: number;
  kind: AssetKind;
  projectId: string;
  frameId: string;
  seq: number;
  status: string;
  endpointId: string;
  provider: string;
  requiredInputs: string[];
  sources: Record<string, { url?: string; durationS?: number }>;
  input: unknown;
  stage: string | null;
  stages: string[];
  output: unknown;
  assetUrl: string | null;
  durationS: number | null;
  error: unknown;
  attempts: number;
  reworks: number;
  qualityStatus: string | null;
  qualityAttempts: number;
  qualityScore: number | null;
  qualityIssues: unknown;
  providerJobId: string | null;
  submittedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `id, asset_kind, project_id, frame_id, seq, status, endpoint_id, provider,
                 required_inputs, sources, input, stage, stages, output, asset_url, duration_s,
                 error, attempts, reworks, quality_status, quality_attempts, quality_score,
                 quality_issues, provider_job_id, submitted_at, completed_at,
                 created_at, updated_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
function toAsset(row: any): AssetRow {
  return {
    id: Number(row.id),
    kind: row.asset_kind,
    projectId: row.project_id,
    frameId: row.frame_id,
    seq: row.seq,
    status: row.status,
    endpointId: row.endpoint_id,
    provider: row.provider,
    requiredInputs: row.required_inputs ?? [],
    sources: row.sources ?? {},
    input: row.input,
    stage: row.stage,
    stages: row.stages ?? [],
    output: row.output,
    assetUrl: row.asset_url,
    durationS: row.duration_s === null || row.duration_s === undefined ? null : Number(row.duration_s),
    error: row.error,
    attempts: row.attempts,
    reworks: row.reworks,
    qualityStatus: row.quality_status ?? null,
    qualityAttempts: row.quality_attempts ?? 0,
    qualityScore: row.quality_score === null || row.quality_score === undefined ? null : Number(row.quality_score),
    qualityIssues: row.quality_issues ?? [],
    providerJobId: row.provider_job_id,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewAsset {
  kind: AssetKind;
  projectId: string;
  frameId: string;
  seq: number;
  endpointId: string;
  requiredInputs: string[];
  input: unknown;
  stage: string | null;
  stages: string[];
  /**
   * Overrides the "no required inputs means runnable" rule below. Needed for
   * `postprod-lite`, whose fan-in is the whole project and therefore cannot be
   * written as `required_inputs` at all: it has none, but it must NOT be
   * runnable until the compiler arms it with a manifest. Without this it would
   * be dispatched the instant the project is submitted, with nothing to do.
   */
  initialStatus?: 'pending' | 'blocked';
}

/**
 * Submission-time write: every asset the project needs, all at once. A row
 * with no required inputs starts `pending` (the agents can pick it up the
 * moment this transaction commits); everything else starts `blocked` and is
 * released by its upstream's handoff.
 *
 * ON CONFLICT DO NOTHING keeps a replayed submission idempotent — the unique
 * (kind, project, frame) key is exactly the identity of an asset.
 */
export async function insertAssets(db: Queryable, rows: NewAsset[]): Promise<number> {
  let inserted = 0;
  for (const r of rows) {
    const status = r.initialStatus ?? (r.requiredInputs.length === 0 ? 'pending' : 'blocked');
    const res = await db.query(
      `INSERT INTO assets (asset_kind, project_id, frame_id, seq, status, endpoint_id,
                           required_inputs, input, stage, stages)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (asset_kind, project_id, frame_id) DO NOTHING`,
      [r.kind, r.projectId, r.frameId, r.seq, status, r.endpointId, r.requiredInputs, r.input, r.stage, r.stages],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/**
 * The agent's work queue. `FOR UPDATE SKIP LOCKED` so several agent processes
 * (or several ticks of one) never claim the same row, and the claim is
 * written in the same transaction — a lock released with nothing to show for
 * it is not a claim.
 *
 * ORDER BY attempts first: a requeued row only comes back round once no fresh
 * attempt is left unclaimed for this kind, so one poisoned asset cannot crowd
 * out first attempts across every other project (the rule the cohort path
 * adopted on 2026-09-16).
 */
export async function claimPending(client: PoolClient, kind: AssetKind, limit: number): Promise<AssetRow[]> {
  if (limit <= 0) return [];
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM assets
      WHERE asset_kind = $1 AND status = 'pending'
      ORDER BY attempts ASC, created_at ASC, seq ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
    [kind, limit],
  );
  return rows.map(toAsset);
}

/** How many jobs this ENDPOINT is holding, across every kind that shares it.
 * `animation` and `postprod-lite` are two agents on one 4-pod endpoint, so a
 * per-kind count would let them put 8 jobs on 4 pods between them. */
export async function countInFlightForEndpoint(db: Queryable, endpointId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM assets WHERE endpoint_id = $1 AND status = 'submitted'`,
    [endpointId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function markSubmitted(db: Queryable, id: number, kind: AssetKind, providerJobId: string): Promise<void> {
  await db.query(
    `UPDATE assets
        SET status = 'submitted', provider_job_id = $3, attempts = attempts + 1,
            submitted_at = now(), claimed_at = now(), updated_at = now()
      WHERE asset_kind = $2 AND id = $1`,
    [id, kind, providerJobId],
  );
}

/** Keeps the compiler's staleness clock honest while a long job is alive. */
export async function touchAsset(db: Queryable, id: number, kind: AssetKind): Promise<void> {
  await db.query(`UPDATE assets SET updated_at = now() WHERE asset_kind = $2 AND id = $1`, [id, kind]);
}

export interface HandoffTarget {
  kind: AssetKind;
  /** Pre-resolved from the plan, so this file never imports the plan module. */
  requiredInputs: string[];
  endpointId: string;
  stage: string | null;
  stages: string[];
  /** Copied onto the new row if the handoff is what creates it. */
  input: unknown;
}

/**
 * Terminal success + handoff, in one transaction.
 *
 * The handoff is an UPSERT, not an UPDATE: the downstream row already exists
 * in the ordinary case (submission wrote every row up front), but an upsert
 * makes the write safe when it does not — after a compiler repair, or if a
 * future plan adds a kind mid-flight. `sources` is merged, never replaced, so
 * two upstreams handing off to the same row cannot clobber each other, and
 * the status flips to `pending` only when EVERY required input is present.
 *
 * The status CASE is deliberately computed in SQL from the row's own
 * `required_inputs` and the merged `sources`: it is then impossible for two
 * concurrent handoffs to both read "not yet satisfied" and leave the row
 * blocked forever.
 */
export async function completeAsset(
  client: PoolClient,
  row: Pick<AssetRow, 'id' | 'kind' | 'projectId' | 'frameId' | 'seq'>,
  result: { output: unknown; assetUrl: string; durationS?: number },
  handoffs: HandoffTarget[],
  /**
   * Whether this kind has a QA gate. It controls ONE thing: whether
   * `quality_status` is left NULL, which is the QA agent's queue
   * (`listUngatedAssets`). It does NOT control the handoff — QA is
   * non-blocking, so downstream generation starts either way.
   *
   * Those two meanings were conflated once and it deadlocked a live project
   * (2026-09-19): making QA non-blocking turned this flag off entirely, so
   * every asset completed as 'ungated', nothing ever entered the QA queue,
   * the project-level verdict never left 'pending', and the compiler waited
   * forever on a gate that could never clear.
   */
  gated = false,
): Promise<void> {
  await client.query(
    `UPDATE assets
        SET status = 'complete', output = $3, asset_url = $4, duration_s = $5,
            error = NULL, quality_status = $6, completed_at = now(), updated_at = now()
      WHERE asset_kind = $2 AND id = $1`,
    [row.id, row.kind, result.output, result.assetUrl, result.durationS ?? null, gated ? null : 'ungated'],
  );
  // Always — a gated kind's verdict gates ASSEMBLY, never the chain.
  await writeHandoffs(client, row, { url: result.assetUrl, durationS: result.durationS }, handoffs);
}

/**
 * The handoff itself: write this asset's url into every downstream row.
 * Extracted so the gated path can perform it later, from `gateAssetPass()`,
 * without duplicating the upsert.
 */
async function writeHandoffs(
  client: PoolClient,
  row: Pick<AssetRow, 'kind' | 'projectId' | 'frameId' | 'seq'>,
  asset: { url: string; durationS?: number },
  handoffs: HandoffTarget[],
): Promise<void> {
  const handoffValue = JSON.stringify({
    [row.kind]: { url: asset.url, ...(asset.durationS !== undefined ? { durationS: asset.durationS } : {}) },
  });

  for (const t of handoffs) {
    await client.query(
      `INSERT INTO assets (asset_kind, project_id, frame_id, seq, status, endpoint_id,
                           required_inputs, sources, input, stage, stages)
       VALUES ($1, $2, $3, $4, 'blocked', $5, $6, $7::jsonb, $8, $9, $10)
       ON CONFLICT (asset_kind, project_id, frame_id) DO UPDATE
          SET sources = assets.sources || EXCLUDED.sources,
              updated_at = now(),
              status = CASE
                WHEN assets.status <> 'blocked' THEN assets.status
                WHEN NOT EXISTS (
                  SELECT 1 FROM unnest(assets.required_inputs) r
                   WHERE NOT ((assets.sources || EXCLUDED.sources) ? r)
                ) THEN 'pending'
                ELSE 'blocked'
              END`,
      [t.kind, row.projectId, row.frameId, row.seq, t.endpointId, t.requiredInputs, handoffValue, t.input, t.stage, t.stages],
    );
  }
}

/**
 * A passing (or exhausted-but-accepted) verdict. Records it and performs the
 * handoff the completion deferred, in one transaction — so a crash between
 * the two is impossible and the downstream row can never see an asset no one
 * judged.
 */
export async function gateAssetPass(
  client: PoolClient,
  row: Pick<AssetRow, 'id' | 'kind' | 'projectId' | 'frameId' | 'seq'>,
  verdict: { status: 'pass' | 'exhausted'; score: number | null; issues: unknown },
  asset: { url: string; durationS?: number },
  handoffs: HandoffTarget[],
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE assets
        SET quality_status = $3, quality_score = $4, quality_issues = $5, updated_at = now()
      WHERE asset_kind = $2 AND id = $1 AND status = 'complete' AND quality_status IS NULL
      RETURNING id`,
    [row.id, row.kind, verdict.status, verdict.score, JSON.stringify(verdict.issues ?? [])],
  );
  // Lost the race with another QA tick — it already handed off.
  if (rows.length === 0) return false;
  await writeHandoffs(client, row, asset, handoffs);
  return true;
}

/**
 * A rejecting verdict. Patches the row's `input` with the correction (a
 * rewritten prompt, or a stepped seed) and puts it back in its own agent's
 * queue. Deliberately the SAME row, not a new one: the frame's identity, its
 * attempt history and its handoff targets all stay put, and the agent picks
 * it up under the same pod limit as any other work.
 *
 * `attempts` is reset to 0 so the retry budget that governs provider failures
 * is not consumed by a quality rework — `quality_attempts` is what bounds
 * this loop, and it is capped separately.
 */
export async function gateAssetRework(
  db: Queryable,
  row: Pick<AssetRow, 'id' | 'kind'>,
  verdict: { score: number | null; issues: unknown },
  patchedInput: unknown,
): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE assets
        SET status = 'pending', quality_status = 'rework', quality_score = $3,
            quality_issues = $4, quality_attempts = quality_attempts + 1,
            input = $5, attempts = 0, provider_job_id = NULL,
            asset_url = NULL, output = NULL, duration_s = NULL, updated_at = now()
      WHERE asset_kind = $2 AND id = $1
        AND status = 'complete' AND quality_status IS NULL
        AND quality_attempts < $6
      RETURNING id`,
    [row.id, row.kind, verdict.score, JSON.stringify(verdict.issues ?? []), patchedInput, ASSET_QUALITY_ATTEMPTS_HARD_CAP],
  );
  return rows.length > 0;
}

/**
 * Reset a frame's downstream rows so they regenerate from a reworked upstream.
 *
 * QA does not gate the handoff any more, so a rejected image may already have
 * produced a clip. Without this the corrected image would be regenerated and
 * then ignored — the manifest would still carry the clip made from the
 * rejected frame, and the gate would be decorative.
 *
 * Each descendant goes back to `blocked` with its own output and verdict
 * cleared, and loses the `sources` entries that came from the reset set, so
 * the chain re-releases it naturally as each upstream completes again. A row
 * still `submitted` is reset too: its in-flight result is about to be stale,
 * and the agent's own status re-check makes the late completion a no-op.
 */
export async function resetDescendants(
  db: Queryable,
  projectId: string,
  frameId: string,
  kinds: AssetKind[],
  from: AssetKind,
): Promise<number> {
  if (kinds.length === 0) return 0;
  const stale = [from, ...kinds];
  const res = await db.query(
    `UPDATE assets
        SET status = 'blocked',
            sources = sources - $4::text[],
            asset_url = NULL, output = NULL, duration_s = NULL, error = NULL,
            provider_job_id = NULL, attempts = 0,
            quality_status = NULL, quality_score = NULL, quality_issues = '[]'::jsonb,
            completed_at = NULL, updated_at = now()
      WHERE project_id = $1 AND frame_id = $2 AND asset_kind = ANY($3::text[])`,
    [projectId, frameId, kinds, stale],
  );
  return res.rowCount ?? 0;
}

/** The QA agent's work queue: completed assets of this kind nobody has
 * judged yet, oldest first. */
export async function listUngatedAssets(db: Queryable, kind: AssetKind, limit: number): Promise<AssetRow[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM assets
      WHERE asset_kind = $1 AND status = 'complete' AND quality_status IS NULL
      ORDER BY completed_at ASC
      LIMIT $2`,
    [kind, limit],
  );
  return rows.map(toAsset);
}

/** Marks an asset ungated without a verdict — what `ORCH_ASSET_QA=off` does,
 * and the escape hatch when scoring is impossible (no transport configured).
 * Performs the deferred handoff, so switching gating off cannot wedge a
 * project that was mid-flight. */
export async function gateAssetSkipped(
  client: PoolClient,
  row: Pick<AssetRow, 'id' | 'kind' | 'projectId' | 'frameId' | 'seq'>,
  asset: { url: string; durationS?: number },
  handoffs: HandoffTarget[],
): Promise<boolean> {
  const { rows } = await client.query(
    `UPDATE assets SET quality_status = 'ungated', updated_at = now()
      WHERE asset_kind = $2 AND id = $1 AND status = 'complete' AND quality_status IS NULL
      RETURNING id`,
    [row.id, row.kind],
  );
  if (rows.length === 0) return false;
  await writeHandoffs(client, row, asset, handoffs);
  return true;
}

/** Multi-stage kinds only: record the stage's output and re-queue the SAME
 * row for its next call. No handoff happens until the last stage finishes. */
export async function advanceStage(
  db: Queryable,
  id: number,
  kind: AssetKind,
  input: { stage: string; output: unknown; assetUrl: string; durationS?: number },
): Promise<void> {
  await db.query(
    `UPDATE assets
        SET status = 'pending', stage = $3, output = $4, asset_url = $5, duration_s = $6,
            provider_job_id = NULL, attempts = 0, updated_at = now()
      WHERE asset_kind = $2 AND id = $1`,
    [id, kind, input.stage, input.output, input.assetUrl, input.durationS ?? null],
  );
}

/**
 * Retry-or-fail, with the attempt clamp on the app side of the DB CHECK.
 * Returns true when the row went back to `pending` for another attempt.
 *
 * A retry deliberately goes back to `pending` rather than to `blocked`: the
 * inputs that made it runnable are still in `sources`, so re-deriving them
 * would only risk losing them.
 */
export async function failOrRetryAsset(
  db: Queryable,
  id: number,
  kind: AssetKind,
  error: unknown,
  ceiling: number,
): Promise<boolean> {
  const budget = Math.min(ceiling, ASSET_ATTEMPTS_HARD_CAP);
  const { rows } = await db.query(
    `UPDATE assets
        SET status = 'pending', provider_job_id = NULL, error = $3, updated_at = now()
      WHERE asset_kind = $2 AND id = $1 AND attempts < $4
      RETURNING id`,
    [id, kind, error, budget],
  );
  if ((rows.length ?? 0) > 0) return true;
  await db.query(
    `UPDATE assets
        SET status = 'failed', error = $3, completed_at = now(), updated_at = now()
      WHERE asset_kind = $2 AND id = $1`,
    [id, kind, error],
  );
  return false;
}

/**
 * Submitted rows the reconcile scan should poll, and the timeout sweep should
 * judge.
 *
 * Ordered and filtered by `submitted_at`, NOT `updated_at`. That distinction
 * is the whole bug this replaced: `reconcile()` touches `updated_at` every
 * time it polls a still-running job, so an `updated_at` clock can never age
 * past one reconcile interval and a timeout measured against it could never
 * fire. `submitted_at` is when the request actually went to the provider and
 * is only rewritten by a resubmission — which is exactly the semantics
 * "how long has this request been outstanding" needs.
 */
export async function listStaleSubmitted(db: Queryable, kind: AssetKind, olderThan: Date): Promise<AssetRow[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM assets
      WHERE asset_kind = $1 AND status = 'submitted' AND submitted_at < $2
      ORDER BY submitted_at ASC`,
    [kind, olderThan],
  );
  return rows.map(toAsset);
}

export async function getAssetById(db: Queryable, id: number): Promise<AssetRow | undefined> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM assets WHERE id = $1`, [id]);
  return rows[0] ? toAsset(rows[0]) : undefined;
}

export async function getAssetByProviderJobId(db: Queryable, providerJobId: string): Promise<AssetRow | undefined> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM assets WHERE provider_job_id = $1`, [providerJobId]);
  return rows[0] ? toAsset(rows[0]) : undefined;
}

/** Every asset row of one project — the compiler's fan-in read. */
export async function listProjectAssets(db: Queryable, projectId: string): Promise<AssetRow[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM assets WHERE project_id = $1 ORDER BY seq ASC, asset_kind ASC`,
    [projectId],
  );
  return rows.map(toAsset);
}

/**
 * Compiler repair: a row whose inputs are all present but which is still
 * `blocked` lost its handoff's status flip (or was created by a repair pass
 * that could not know). Releasing it is always safe — the condition is
 * exactly the one `completeAsset()` would have applied. Returns how many.
 */
export async function releaseSatisfiedBlocked(db: Queryable, projectId: string): Promise<number> {
  const res = await db.query(
    `UPDATE assets
        SET status = 'pending', updated_at = now()
      WHERE project_id = $1 AND status = 'blocked' AND frame_id <> '${PROJECT_SCOPE}'
        AND NOT EXISTS (SELECT 1 FROM unnest(required_inputs) r WHERE NOT (sources ? r))`,
    [projectId],
  );
  return res.rowCount ?? 0;
}

/**
 * Arm a PROJECT-scoped row (`frame_id = '*'`). These sit outside the per-frame
 * handoff entirely: their fan-in spans every frame, which a `sources` map
 * keyed by asset kind cannot express, so the project compiler releases them
 * explicitly once it has decided the project is whole — and hands them their
 * payload (`postprod-lite`'s manifest) at the same moment.
 *
 * Conditional on the row not already being live, so two compiler ticks racing
 * on the same finished project cannot arm the same tail twice. Returns whether
 * this call was the one that armed it.
 */
export async function armProjectAsset(
  db: Queryable,
  projectId: string,
  kind: AssetKind,
  input: unknown,
): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE assets
        SET status = 'pending', input = $3, error = NULL, provider_job_id = NULL, updated_at = now()
      WHERE asset_kind = $2 AND project_id = $1 AND frame_id = '${PROJECT_SCOPE}'
        AND status IN ('blocked', 'cancelled', 'failed')
      RETURNING id`,
    [projectId, kind, input],
  );
  return rows.length > 0;
}

/**
 * Compiler rework: the provider job is gone or wedged. Mark it `cancelled`
 * and immediately re-queue it as a fresh attempt, bounded by `reworks` — a
 * separate budget from `attempts`, which is deliberately NOT reset. A rework
 * continues the attempt count rather than restarting it, so an asset that is
 * genuinely unrunnable cannot resubmit forever. Returns true if it requeued.
 */
export async function reworkAsset(db: Queryable, id: number, kind: AssetKind, reason: unknown): Promise<boolean> {
  const { rows } = await db.query(
    `UPDATE assets
        SET status = 'pending', provider_job_id = NULL, reworks = reworks + 1,
            error = $3, updated_at = now()
      WHERE asset_kind = $2 AND id = $1
        AND reworks < $4 AND attempts < $5
      RETURNING id`,
    [id, kind, reason, ASSET_REWORKS_HARD_CAP, ASSET_ATTEMPTS_HARD_CAP],
  );
  if (rows.length > 0) return true;
  await db.query(
    `UPDATE assets
        SET status = 'failed', error = $3, completed_at = now(), updated_at = now()
      WHERE asset_kind = $2 AND id = $1`,
    [id, kind, reason],
  );
  return false;
}

/**
 * Deadlock breaker: a gated asset nobody judged. If the QA agent is not
 * running (or is wedged), a `complete` row with no verdict never hands off
 * and its whole project waits forever — strictly worse than shipping an
 * unjudged asset. After `olderThan` the compiler releases it ungated, loudly.
 * Returns the rows it released so the caller can write their handoffs.
 */
export async function listStaleUngated(db: Queryable, projectId: string, olderThan: Date): Promise<AssetRow[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM assets
      WHERE project_id = $1 AND status = 'complete' AND quality_status IS NULL
        AND completed_at < $2`,
    [projectId, olderThan],
  );
  return rows.map(toAsset);
}

/**
 * The gate state of every gated asset in one project — what the project-level
 * QA verdict is computed from (migration 016).
 */
export async function projectGateState(
  db: Queryable,
  projectId: string,
  gatedKinds: string[],
): Promise<{ total: number; judged: number; exhausted: number; pendingKinds: string[] }> {
  if (gatedKinds.length === 0) return { total: 0, judged: 0, exhausted: 0, pendingKinds: [] };
  const { rows } = await db.query<{ asset_kind: string; status: string; quality_status: string | null; n: string }>(
    `SELECT asset_kind, status, quality_status, count(*) AS n
       FROM assets
      WHERE project_id = $1 AND asset_kind = ANY($2::text[])
      GROUP BY 1,2,3`,
    [projectId, gatedKinds],
  );
  let total = 0;
  let judged = 0;
  let exhausted = 0;
  const pending = new Set<string>();
  for (const r of rows) {
    const n = Number(r.n);
    // A row that failed generation outright is not the gate's problem — it
    // drops out of the project the same way it always did.
    if (r.status === 'failed') continue;
    total += n;
    if (r.status === 'complete' && r.quality_status !== null) {
      judged += n;
      if (r.quality_status === 'exhausted') exhausted += n;
    } else {
      pending.add(r.asset_kind);
    }
  }
  return { total, judged, exhausted, pendingKinds: [...pending] };
}

/** Per-kind counts for one project — what the compiler reports and the admin
 * dashboard reads. */
export async function projectAssetCounts(
  db: Queryable,
  projectId: string,
): Promise<Array<{ kind: string; status: string; n: number }>> {
  const { rows } = await db.query<{ asset_kind: string; status: string; n: string }>(
    `SELECT asset_kind, status, count(*) AS n FROM assets
      WHERE project_id = $1 GROUP BY asset_kind, status ORDER BY asset_kind, status`,
    [projectId],
  );
  return rows.map((r) => ({ kind: r.asset_kind, status: r.status, n: Number(r.n) }));
}

/** Fleet-wide queue depth per kind — the number that answers "is any GPU
 * idle while work is queued", which is the whole point of this model. */
export async function queueDepths(db: Queryable): Promise<Array<{ kind: string; pending: number; submitted: number }>> {
  const { rows } = await db.query<{ asset_kind: string; pending: string; submitted: string }>(
    `SELECT asset_kind,
            count(*) FILTER (WHERE status = 'pending')   AS pending,
            count(*) FILTER (WHERE status = 'submitted') AS submitted
       FROM assets
      WHERE status IN ('pending', 'submitted')
      GROUP BY asset_kind ORDER BY asset_kind`,
  );
  return rows.map((r) => ({ kind: r.asset_kind, pending: Number(r.pending), submitted: Number(r.submitted) }));
}
