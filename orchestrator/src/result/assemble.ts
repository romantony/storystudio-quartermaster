/**
 * Result assembler (impl plan §6.7, M5, 2026-09-15). Builds the spec §9.6
 * result document for one project from what's already in Postgres — it
 * checks completion and reports; it never runs work. `buildResult()` is
 * pure (unit-tested); `loadResultFacts()` is the only DB access.
 *
 * Completion rule — deliberately NOT the plan doc's `max(steps.seq)` query:
 * seq no longer equals execution order. Steps 14/15 (per-frame DreamX /
 * MMAudio, bulk) run BEFORE merge (6) despite their numbers, and every
 * project-scope step runs after every bulk step (agents/orchestrator.ts).
 * So the leaf is the highest-seq project-scope step when the project has a
 * tail, else the highest-seq bulk step. Then:
 *   completed — every leaf job complete with an output URL, not quality-failed,
 *               and no job anywhere in the project failed or never ran
 *   partial   — the leaf delivered, but something upstream failed
 *               (e.g. a frame dropped from the concat)
 *   failed    — the leaf did not deliver
 */
import type { Pool, PoolClient } from 'pg';
import { runpodOutUrl } from '../runpod/output';
import { catalogEntry } from '../steps/catalog';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export type ResultStatus = 'completed' | 'partial' | 'failed';

export interface ResultError {
  frameId: string | null;
  step: number;
  agent: 'generator' | 'quality' | 'orchestrator';
  reason: string;
  triedRungs: string[];
}

/** Request metadata echoed back so the receiver doesn't need its own copy
 * of the submitted request to act on the result (added 2026-09-15). */
export interface ResultProjectMeta {
  tier: string;
  product: string;
  language: string;
  aspectRatio: string;
  resolution: string;
  frameCount: number;
  options: Record<string, unknown>;
}

/** One entry per requested frame, in request order (added 2026-09-15).
 * Every URL is null when the step that produces it didn't run or failed. */
export interface ResultFrame {
  index: number;
  frameId: string;
  status: 'completed' | 'failed';
  /** Quality gate accepted the asset only after exhausting its reworks. */
  qualityFlagged: boolean;
  /** Generated still (step 0 reference-image edit, or step 1 text-to-image). */
  imageUrl: string | null;
  /** Narration audio (step 2). */
  narrationAudioUrl: string | null;
  narrationDurationS: number | null;
  /** Animated clip without narration: DreamX-upscaled (step 14) when upscale ran, else the raw i2v clip (step 3). */
  clipUrl: string | null;
  /** Clip with narration (and SFX when requested) mixed in: silence-trimmed (step 7) when that ran, else merge (step 6). */
  mergedClipUrl: string | null;
}

export interface QmResult {
  requestId: string;
  projectId: string;
  cohortId: string;
  status: ResultStatus;
  createdAt: string;
  finishedAt: string;
  project: ResultProjectMeta | null;
  assets: {
    final: { url: string; durationS: number | null; bytes: number | null; resolution: string | null } | null;
    frames: ResultFrame[];
    subtitles?: { url: string; burnedIn: boolean };
    bgm?: { url: string };
    shorts: Array<{ index: number; url: string; srtUrl?: string; startS?: number; endS?: number }>;
  };
  steps: Array<{
    seq: number;
    name: string;
    total: number;
    completed: number;
    failed: number;
    warmMs: number | null;
    runMs: number | null;
  }>;
  quality: {
    gated: number;
    passedFirstAttempt: number;
    reworked: number;
    acceptedMarginal: number;
    escalatedRung: number;
  };
  metrics: {
    queuedMs: number | null;
    runMs: number | null;
    gpuCostUsd: number | null;
    qualityCostUsd: number | null;
    warmCostUsd: number | null;
  };
  errors: ResultError[];
  /** Present only when errors[] was capped at MAX_ERRORS. */
  errorsTotal?: number;
}

export interface ResultFacts {
  project: { id: string; requestId: string; cohortId: string; createdAt: Date; request?: unknown };
  /** Result assembly time; defaults to now. Injectable so buildResult() stays deterministic in tests. */
  finishedAt?: Date;
  steps: Array<{ seq: number; name: string; warmAt: Date | null; startedAt: Date | null; finishedAt: Date | null }>;
  jobs: Array<{
    id: number;
    stepSeq: number;
    frameId: string | null;
    status: string;
    qualityStatus: string | null;
    triedRungs: string[];
    submittedAt: Date | null;
    completedAt: Date | null;
    output: unknown;
    error: unknown;
  }>;
  verdicts: Array<{ jobId: number; attempt: number; verdict: string; action: string | null; costUsd: number | null }>;
  gpuCostUsd: number | null;
  warmCostUsd: number | null;
}

/** A stalled 690-frame cohort would otherwise put thousands of not_run rows
 * in one callback body. */
export const MAX_ERRORS = 200;

const IMAGE_EDIT_STEP_SEQ = 0;
const IMAGE_STEP_SEQ = 1;
const TTS_STEP_SEQ = 2;
const ANIMATION_STEP_SEQ = 3;
const BGM_STEP_SEQ = 5;
const MERGE_STEP_SEQ = 6;
const REMOVE_SILENCE_STEP_SEQ = 7;
const CAPTION_STEP_SEQ = 11;
const UPSCALE_FRAME_STEP_SEQ = 14;

function projectMeta(request: unknown): ResultProjectMeta | null {
  const r = asRecord(request);
  if (!r) return null;
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    tier: str(r.tier),
    product: str(r.product),
    language: str(r.language),
    aspectRatio: str(r.aspectRatio),
    resolution: str(r.resolution),
    frameCount: Array.isArray(r.frames) ? r.frames.length : 0,
    options: asRecord(r.options) ?? {},
  };
}

function buildFrames(f: ResultFacts): ResultFrame[] {
  const requested = asRecord(f.project.request)?.frames;
  const order: string[] = Array.isArray(requested)
    ? requested.map((fr) => asRecord(fr)?.frameId).filter((id): id is string => typeof id === 'string')
    : [...new Set(f.jobs.map((j) => j.frameId).filter((id): id is string => !!id))];

  return order.map((frameId, index) => {
    const own = f.jobs.filter((j) => j.frameId === frameId);
    const done = (seq: number) => own.find((j) => j.stepSeq === seq && j.status === 'complete');
    const urlOf = (...seqs: number[]) => {
      for (const seq of seqs) {
        const u = runpodOutUrl(done(seq)?.output);
        if (u) return u;
      }
      return null;
    };
    const tts = done(TTS_STEP_SEQ);
    return {
      index,
      frameId,
      status: own.length > 0 && own.every((j) => j.status === 'complete') ? 'completed' : 'failed',
      qualityFlagged: own.some((j) => j.qualityStatus === 'fail'),
      imageUrl: urlOf(IMAGE_EDIT_STEP_SEQ, IMAGE_STEP_SEQ),
      narrationAudioUrl: urlOf(TTS_STEP_SEQ),
      narrationDurationS: num(asRecord(tts?.output)?.duration_s),
      clipUrl: urlOf(UPSCALE_FRAME_STEP_SEQ, ANIMATION_STEP_SEQ),
      mergedClipUrl: urlOf(REMOVE_SILENCE_STEP_SEQ, MERGE_STEP_SEQ),
    };
  });
}

function asRecord(x: unknown): Record<string, unknown> | undefined {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
}

function num(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function errorReason(error: unknown): string {
  const e = asRecord(error);
  const raw =
    (typeof error === 'string' && error) ||
    (e && typeof e.error === 'string' && e.error) ||
    (e && typeof e.message === 'string' && e.message) ||
    (e && typeof e.status === 'string' && e.status) ||
    'failed';
  return raw.length > 300 ? `${raw.slice(0, 297)}...` : raw;
}

function span(from: Date | null | undefined, to: Date | null | undefined): number | null {
  if (!from || !to) return null;
  const ms = to.getTime() - from.getTime();
  return ms >= 0 ? ms : null;
}

export function leafSeq(stepSeqs: number[]): number | undefined {
  if (stepSeqs.length === 0) return undefined;
  const tail = stepSeqs.filter((s) => catalogEntry(s)?.scope === 'project');
  return Math.max(...(tail.length > 0 ? tail : stepSeqs));
}

export function buildResult(f: ResultFacts): QmResult {
  const jobSeqs = [...new Set(f.jobs.map((j) => j.stepSeq))];
  const leaf = leafSeq(jobSeqs);
  const leafJobs = f.jobs.filter((j) => j.stepSeq === leaf);
  const leafDelivered =
    leafJobs.length > 0 &&
    leafJobs.every((j) => j.status === 'complete' && runpodOutUrl(j.output) && j.qualityStatus !== 'fail');

  const errors: ResultError[] = [];
  for (const j of f.jobs) {
    const base = { frameId: j.frameId, step: j.stepSeq, triedRungs: j.triedRungs };
    if (j.status === 'failed') errors.push({ ...base, agent: 'generator', reason: errorReason(j.error) });
    else if (j.status === 'complete' && j.qualityStatus === 'fail')
      errors.push({ ...base, agent: 'quality', reason: 'quality_attempts_exhausted' });
    else if (j.status !== 'complete')
      errors.push({ ...base, agent: 'orchestrator', reason: j.status === 'submitted' ? 'in_flight_at_stop' : 'not_run' });
  }

  const status: ResultStatus = !leafDelivered ? 'failed' : errors.length > 0 ? 'partial' : 'completed';

  // ── assets ──
  const outputOf = (seq: number) => f.jobs.find((j) => j.stepSeq === seq && j.status === 'complete')?.output;
  let final: QmResult['assets']['final'] = null;
  if (leafDelivered && leafJobs.length === 1) {
    const out = asRecord(leafJobs[0].output);
    const up = asRecord(outputOf(UPSCALE_FRAME_STEP_SEQ));
    const w = num(up?.width);
    const h = num(up?.height);
    final = {
      url: runpodOutUrl(leafJobs[0].output)!,
      durationS: num(out?.duration_s),
      bytes: null,
      resolution: w && h ? `${w}x${h}` : null,
    };
  }
  const assets: QmResult['assets'] = { final, frames: buildFrames(f), shorts: [] };
  const captionSrt = asRecord(outputOf(CAPTION_STEP_SEQ))?.srt;
  if (typeof captionSrt === 'string' && captionSrt.startsWith('http')) {
    assets.subtitles = { url: captionSrt, burnedIn: true };
  }
  const bgmUrl = runpodOutUrl(outputOf(BGM_STEP_SEQ));
  if (bgmUrl) assets.bgm = { url: bgmUrl };

  // ── steps[] ── per-project job counts; warm from the cohort-level step row
  const stepRow = new Map(f.steps.map((s) => [s.seq, s] as const));
  const steps: QmResult['steps'] = jobSeqs
    .sort((a, b) => (catalogEntry(a)?.scope === 'project' ? 1 : 0) - (catalogEntry(b)?.scope === 'project' ? 1 : 0) || a - b)
    .map((seq) => {
      const js = f.jobs.filter((j) => j.stepSeq === seq);
      const row = stepRow.get(seq);
      const submitted = js.map((j) => j.submittedAt).filter((d): d is Date => !!d);
      const completed = js.map((j) => j.completedAt).filter((d): d is Date => !!d);
      return {
        seq,
        name: row?.name ?? catalogEntry(seq)?.name ?? `step${seq}`,
        total: js.length,
        completed: js.filter((j) => j.status === 'complete').length,
        failed: js.filter((j) => j.status === 'failed').length,
        warmMs: span(row?.startedAt, row?.warmAt),
        runMs:
          submitted.length && completed.length
            ? span(new Date(Math.min(...submitted.map(Number))), new Date(Math.max(...completed.map(Number))))
            : null,
      };
    });

  // ── quality{} ── from the verdict trail
  const byJob = new Map<number, ResultFacts['verdicts']>();
  for (const v of f.verdicts) byJob.set(v.jobId, [...(byJob.get(v.jobId) ?? []), v]);
  const jobById = new Map(f.jobs.map((j) => [j.id, j] as const));
  let passedFirstAttempt = 0;
  let reworked = 0;
  let acceptedMarginal = 0;
  let gated = 0;
  for (const [jobId, vs] of byJob) {
    const job = jobById.get(jobId);
    if (!job) continue;
    // GATED: skipped by the image pre-gate; EVAL_ERROR: evaluation kept failing. Neither was evaluated.
    if (vs.every((v) => v.verdict === 'GATED' || v.verdict === 'EVAL_ERROR')) continue;
    gated += 1;
    if (vs.some((v) => v.attempt === 1 && v.verdict === 'PASS')) passedFirstAttempt += 1;
    if (vs.some((v) => v.action === 'rework')) reworked += 1;
    if (job.qualityStatus === 'fail') acceptedMarginal += 1; // attempts exhausted, asset still used downstream
  }
  const qualityCost = f.verdicts.reduce((sum, v) => sum + (v.costUsd ?? 0), 0);

  // ── metrics{} ──
  const allSubmitted = f.jobs.map((j) => j.submittedAt).filter((d): d is Date => !!d);
  const allCompleted = f.jobs.map((j) => j.completedAt).filter((d): d is Date => !!d);
  const firstSubmit = allSubmitted.length ? new Date(Math.min(...allSubmitted.map(Number))) : null;
  const lastComplete = allCompleted.length ? new Date(Math.max(...allCompleted.map(Number))) : null;

  const result: QmResult = {
    requestId: f.project.requestId,
    projectId: f.project.id,
    cohortId: f.project.cohortId,
    status,
    createdAt: f.project.createdAt.toISOString(),
    finishedAt: (f.finishedAt ?? new Date()).toISOString(),
    project: projectMeta(f.project.request),
    assets,
    steps,
    quality: {
      gated,
      passedFirstAttempt,
      reworked,
      acceptedMarginal,
      escalatedRung: f.jobs.filter((j) => j.triedRungs.length > 1).length,
    },
    metrics: {
      queuedMs: span(f.project.createdAt, firstSubmit),
      runMs: span(firstSubmit, lastComplete),
      gpuCostUsd: f.gpuCostUsd,
      qualityCostUsd: f.verdicts.length ? Math.round(qualityCost * 1e6) / 1e6 : null,
      warmCostUsd: f.warmCostUsd,
    },
    errors: errors.slice(0, MAX_ERRORS),
  };
  if (errors.length > MAX_ERRORS) result.errorsTotal = errors.length;
  return result;
}

export async function loadResultFacts(db: Queryable, projectId: string): Promise<ResultFacts | undefined> {
  const { rows: projectRows } = await db.query(
    `SELECT id, request_id, cohort_id, created_at, request FROM projects WHERE id = $1`,
    [projectId],
  );
  const p = projectRows[0];
  if (!p || !p.cohort_id) return undefined;

  const [steps, jobs, verdicts, gpu, warm] = await Promise.all([
    db.query(`SELECT seq, name, warm_at, started_at, finished_at FROM steps WHERE cohort_id = $1`, [p.cohort_id]),
    db.query(
      `SELECT id, step_seq, frame_id, status, quality_status, tried_rungs, submitted_at, completed_at, output, error
         FROM jobs WHERE project_id = $1 ORDER BY step_seq, seq`,
      [projectId],
    ),
    db.query(
      `SELECT qv.job_id, qv.attempt, qv.verdict, qv.action, qv.cost_usd
         FROM quality_verdicts qv JOIN jobs j ON j.id = qv.job_id WHERE j.project_id = $1`,
      [projectId],
    ),
    db.query(
      `SELECT count(jc.job_id)::int AS n, sum(jc.cost_usd) AS usd
         FROM job_costs jc JOIN jobs j ON j.id = jc.job_id WHERE j.project_id = $1`,
      [projectId],
    ),
    // Cohort-wide: allocation_costs has no project dimension. Nothing writes
    // it yet, so this is null in practice — reported as unmeasured, not $0.
    db.query(
      `SELECT count(*)::int AS n, sum(warm_ms / 1000.0 * workers * rate_usd_s) AS usd
         FROM allocation_costs WHERE cohort_id = $1`,
      [p.cohort_id],
    ),
  ]);

  const toNum = (x: unknown) => (x === null || x === undefined ? null : Number(x));
  return {
    project: { id: p.id, requestId: p.request_id, cohortId: p.cohort_id, createdAt: p.created_at, request: p.request },
    steps: steps.rows.map((s) => ({ seq: s.seq, name: s.name, warmAt: s.warm_at, startedAt: s.started_at, finishedAt: s.finished_at })),
    jobs: jobs.rows.map((j) => ({
      id: Number(j.id),
      stepSeq: j.step_seq,
      frameId: j.frame_id,
      status: j.status,
      qualityStatus: j.quality_status,
      triedRungs: j.tried_rungs ?? [],
      submittedAt: j.submitted_at,
      completedAt: j.completed_at,
      output: j.output,
      error: j.error,
    })),
    verdicts: verdicts.rows.map((v) => ({
      jobId: Number(v.job_id),
      attempt: v.attempt,
      verdict: v.verdict,
      action: v.action,
      costUsd: toNum(v.cost_usd),
    })),
    gpuCostUsd: gpu.rows[0]?.n > 0 ? Math.round(Number(gpu.rows[0].usd) * 1e6) / 1e6 : null,
    warmCostUsd: warm.rows[0]?.n > 0 ? Math.round(Number(warm.rows[0].usd) * 1e6) / 1e6 : null,
  };
}
