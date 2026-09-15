/**
 * `harness_findings` / `harness_corrections` / `harness_guardrails` repo
 * (prompt harness plan §9.1, migration 009). Plain CRUD — the
 * signature-classification and promotion judgment calls live in
 * harness/learn/*.ts, matching this codebase's existing convention
 * (db/repo/quality.ts's own docstring says the same about its transitions).
 */
import type { Pool, PoolClient } from 'pg';
import type { Domain, Guardrail } from '../../harness/guardrails/types';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface NewFinding {
  cohortId?: string;
  projectId?: string;
  frameId?: string;
  jobId?: number;
  domain: Domain;
  profile: string;
  source: 'lint' | 'tool' | 'image_gate' | 'motion_gate' | 'probe' | 'calibration';
  signature: string;
  guardrailId?: string;
  confidence?: 'high' | 'low';
  prompt?: string;
  contract?: unknown;
  evidence?: Record<string, unknown>;
  assetUrl?: string;
  guardrailSet?: string;
}

export async function insertFinding(db: Queryable, f: NewFinding): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO harness_findings
       (cohort_id, project_id, frame_id, job_id, domain, profile, source, signature, guardrail_id, confidence, prompt, contract, evidence, asset_url, guardrail_set)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      f.cohortId ?? null,
      f.projectId ?? null,
      f.frameId ?? null,
      f.jobId ?? null,
      f.domain,
      f.profile,
      f.source,
      f.signature,
      f.guardrailId ?? null,
      f.confidence ?? 'high',
      f.prompt ?? null,
      f.contract ? JSON.stringify(f.contract) : null,
      JSON.stringify(f.evidence ?? {}),
      f.assetUrl ?? null,
      f.guardrailSet ?? '',
    ],
  );
  return rows[0].id;
}

export interface NewCorrection {
  findingId: number;
  measure: Record<string, unknown>;
  promptBefore?: string;
  promptAfter?: string;
  contractBefore?: unknown;
  contractAfter?: unknown;
}

export async function insertCorrection(db: Queryable, c: NewCorrection): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO harness_corrections (finding_id, measure, prompt_before, prompt_after, contract_before, contract_after)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id`,
    [
      c.findingId,
      JSON.stringify(c.measure),
      c.promptBefore ?? null,
      c.promptAfter ?? null,
      c.contractBefore ? JSON.stringify(c.contractBefore) : null,
      c.contractAfter ? JSON.stringify(c.contractAfter) : null,
    ],
  );
  return rows[0].id;
}

export async function resolveCorrection(
  db: Queryable,
  correctionId: number,
  outcome: 'passed' | 'failed' | 'accepted_flagged',
  opts: { attempt?: number; score?: number } = {},
): Promise<void> {
  await db.query(
    `UPDATE harness_corrections
        SET outcome = $2, outcome_job_attempt = $3, outcome_score = $4, resolved_at = now()
      WHERE id = $1`,
    [correctionId, outcome, opts.attempt ?? null, opts.score ?? null],
  );
}

/** The most recent pending correction for a finding on this job — used to
 * resolve outcome on the NEXT verdict for the same job (plan §9.2). */
export async function latestPendingCorrectionForJob(db: Queryable, jobId: number): Promise<{ id: number } | undefined> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT c.id
       FROM harness_corrections c
       JOIN harness_findings f ON f.id = c.finding_id
      WHERE f.job_id = $1 AND c.outcome = 'pending'
      ORDER BY c.created_at DESC
      LIMIT 1`,
    [jobId],
  );
  return rows[0];
}

export interface SignatureCount {
  signature: string;
  domain: Domain;
  count: number;
  projects: number;
}

/** Findings with no covering guardrail, recurring across projects — the
 * raw material for promotion (plan §9.3). */
export async function uncoveredSignatures(db: Queryable, sinceDays = 14, minCount = 3): Promise<SignatureCount[]> {
  const { rows } = await db.query<{ signature: string; domain: Domain; count: string; projects: string }>(
    `SELECT signature, domain, count(*) AS count, count(DISTINCT project_id) AS projects
       FROM harness_findings
      WHERE guardrail_id IS NULL AND created_at > now() - ($1 || ' days')::interval
      GROUP BY signature, domain
     HAVING count(*) >= $2 AND count(DISTINCT project_id) >= 2
      ORDER BY count(*) DESC`,
    [sinceDays, minCount],
  );
  return rows.map((r) => ({ signature: r.signature, domain: r.domain, count: Number(r.count), projects: Number(r.projects) }));
}

export interface CorrectionOutcomeStats {
  measureType: string;
  guardrailId: string | null;
  total: number;
  passed: number;
}

/** Pass-rate per (guardrail, corrective measure) — promotion reorders a
 * guardrail's corrective list toward whichever measure actually works
 * (plan §9.3 point 2), and demotes one whose applications keep failing. */
export async function correctionOutcomeStats(db: Queryable, sinceDays = 30): Promise<CorrectionOutcomeStats[]> {
  const { rows } = await db.query<{ measure_type: string; guardrail_id: string | null; total: string; passed: string }>(
    `SELECT c.measure->>'type' AS measure_type, f.guardrail_id, count(*) AS total,
            count(*) FILTER (WHERE c.outcome = 'passed') AS passed
       FROM harness_corrections c
       JOIN harness_findings f ON f.id = c.finding_id
      WHERE c.outcome IN ('passed','failed') AND c.created_at > now() - ($1 || ' days')::interval
      GROUP BY c.measure->>'type', f.guardrail_id`,
    [sinceDays],
  );
  return rows.map((r) => ({ measureType: r.measure_type, guardrailId: r.guardrail_id, total: Number(r.total), passed: Number(r.passed) }));
}

export async function upsertGuardrail(db: Queryable, g: Guardrail): Promise<void> {
  await db.query(
    `INSERT INTO harness_guardrails (id, version, domain, profile, status, severity, title, detector, fix_target, corrective, instruction, evidence, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id, version) DO UPDATE SET status = EXCLUDED.status, corrective = EXCLUDED.corrective, evidence = EXCLUDED.evidence`,
    [
      g.id,
      g.version,
      g.domain,
      g.profile,
      g.status,
      g.severity,
      g.title,
      JSON.stringify(g.detector),
      g.fixTarget,
      JSON.stringify(g.corrective),
      g.instruction,
      JSON.stringify(g.evidence),
      'promotion',
    ],
  );
}

/** Approved (before/after) pairs for a signature — the few-shot examples
 * the regenerate tool gets (plan §9.3 point 5, §8.1's `examples`). */
export async function approvedExamplesForSignature(db: Queryable, signature: string, limit = 3): Promise<Array<{ before: string; after: string }>> {
  const { rows } = await db.query<{ prompt_before: string; prompt_after: string }>(
    `SELECT c.prompt_before, c.prompt_after
       FROM harness_corrections c
       JOIN harness_findings f ON f.id = c.finding_id
      WHERE f.signature = $1 AND c.approved_example = true AND c.prompt_before IS NOT NULL AND c.prompt_after IS NOT NULL
      ORDER BY c.resolved_at DESC
      LIMIT $2`,
    [signature, limit],
  );
  return rows.map((r) => ({ before: r.prompt_before, after: r.prompt_after }));
}
