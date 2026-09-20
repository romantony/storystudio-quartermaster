/**
 * The §9.6 result document, assembled from asset rows (2026-09-19).
 *
 * Deliberately produces the SAME shape `result/assemble.ts` produces from the
 * cohort model — same `QmResult`, same `assets.frames[]`, same `project`
 * metadata — so StoryStudio's receiver cannot tell which pipeline generated a
 * project. Switching ORCH_PIPELINE_MODE must be invisible on the wire; if it
 * is not, this file is wrong, not the receiver.
 *
 * `buildAssetResult()` is pure and unit-tested. `finalizeAssetProject()` is
 * the only part that touches the database or the network, and it reuses
 * `result/callback.ts`'s delivery + retry verbatim.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import { log } from '../telemetry/log';
import { deliverCallback, type CallbackAttempt } from '../result/callback';
import type { QmResult, ResultError, ResultFrame, ResultStatus } from '../result/assemble';
import { listProjectAssets, type AssetRow } from '../db/repo/assets';
import { projectAssetCost } from '../db/repo/asset-costs';
import { getPipelineProject } from '../db/repo/pipeline';
import { getProject } from '../db/repo/projects';
import type { AssetPlan } from './plan';
import type { OrchestratorRequest } from '../agents/planner';
import { extractErrorText } from '../runpod/types';

/** Same cap and same reason as result/assemble.ts's: a broken 690-frame
 * project would otherwise put thousands of rows in one callback body. */
export const MAX_ERRORS = 200;

export interface AssetResultFacts {
  project: { id: string; requestId: string; createdAt: Date; request: OrchestratorRequest };
  plan: AssetPlan;
  rows: AssetRow[];
  status: ResultStatus;
  finalUrl: string | null;
  finalDurationS: number | null;
  gpuCostUsd: number | null;
  startedAt: Date;
  finishedAt?: Date;
}

function urlOf(rows: AssetRow[], kind: string, frameId: string): string | null {
  const r = rows.find((x) => x.kind === kind && x.frameId === frameId && x.status === 'complete');
  return r?.assetUrl ?? null;
}

/**
 * Per-frame merged clips, read back out of the one-shot tail's own response.
 * The worker hosts each finished clip (`frames[].url`) even though concat
 * consumes the local file, so this contract field is populated exactly as the
 * cohort path populates it — there is just one row carrying all of them
 * instead of one row per frame.
 */
function mergedClipUrls(rows: AssetRow[]): Map<string, string> {
  const out = new Map<string, string>();
  const tail = rows.find((r) => r.kind === 'postprod-lite' && r.status === 'complete');
  const frames = (tail?.output as { frames?: Array<{ frameId?: string; url?: string }> } | null)?.frames;
  for (const f of frames ?? []) {
    if (f.frameId && f.url) out.set(f.frameId, f.url);
  }
  return out;
}

export function buildAssetResult(facts: AssetResultFacts): QmResult {
  const { project, plan, rows } = facts;
  const req = project.request;
  const finishedAt = facts.finishedAt ?? new Date();

  const merged = mergedClipUrls(rows);
  const frames: ResultFrame[] = req.frames.map((f, index) => {
    const mine = rows.filter((r) => r.frameId === f.frameId);
    const tts = mine.find((r) => r.kind === 'tts' && r.status === 'complete');
    // Every frame-scoped kind the plan asked of this frame actually landed.
    // Not "did its merged clip exist": the one-shot tail keeps per-frame
    // intermediates on the worker's local disk and only ever returns the
    // final video, so there is no per-frame merged URL to test (or to
    // report — see mergedClipUrl below).
    const complete = plan.frameKinds.every((k) =>
      mine.some((r) => r.kind === k && r.status === 'complete' && r.assetUrl),
    );
    return {
      index,
      frameId: f.frameId,
      status: complete ? 'completed' : 'failed',
      // The asset pipeline has no quality gate of its own yet — the prompt
      // harness is the intended replacement (feedback-prompt-harness-over-
      // llm-rework), and nothing here ever accepts a marginal asset, so this
      // is structurally false rather than unknown.
      qualityFlagged: false,
      imageUrl: urlOf(rows, plan.imageKind, f.frameId),
      narrationAudioUrl: tts?.assetUrl ?? null,
      narrationDurationS: tts?.durationS ?? null,
      clipUrl:
        urlOf(rows, 'merge', f.frameId) ??
        urlOf(rows, 'mmaudio', f.frameId) ??
        urlOf(rows, 'dreamx-refine', f.frameId) ??
        (plan.motionKind ? urlOf(rows, plan.motionKind, f.frameId) : null),
      // From the tail's own per-frame report. Null until the tail has run
      // (a project that failed before assembly), and null for a frame the
      // tail dropped.
      mergedClipUrl: merged.get(f.frameId) ?? null,
    };
  });

  const allErrors: ResultError[] = rows
    .filter((r) => r.status === 'failed')
    .map((r) => ({
      frameId: r.frameId === '*' ? null : r.frameId,
      // `step` is a number in the wire contract and the asset model has no
      // step numbers; the kind's legacy seq is the honest mapping, and the
      // reason names the kind anyway.
      step: legacySeqOf(r.kind),
      agent: 'generator' as const,
      reason: `${r.kind}: ${extractErrorText(r.error)?.slice(0, 300) ?? 'failed'}`,
      triedRungs: [],
    }));
  const errors = allErrors.slice(0, MAX_ERRORS);

  const kindCounts = new Map<string, { total: number; completed: number; failed: number }>();
  for (const r of rows) {
    const c = kindCounts.get(r.kind) ?? { total: 0, completed: 0, failed: 0 };
    c.total += 1;
    if (r.status === 'complete') c.completed += 1;
    if (r.status === 'failed') c.failed += 1;
    kindCounts.set(r.kind, c);
  }

  const firstSubmit = rows
    .map((r) => r.submittedAt)
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    requestId: project.requestId,
    projectId: project.id,
    // The asset pipeline has no cohorts. The field stays in the contract
    // because the receiver's schema has it; this names the pipeline instead
    // of inventing a cohort id that nothing could be looked up by.
    cohortId: 'asset-pipeline',
    status: facts.status,
    createdAt: project.createdAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    project: {
      tier: req.tier,
      product: req.product,
      language: req.language,
      aspectRatio: req.aspectRatio,
      resolution: req.resolution,
      frameCount: req.frames.length,
      options: req.options as unknown as Record<string, unknown>,
    },
    assets: {
      final: facts.finalUrl
        ? { url: facts.finalUrl, durationS: facts.finalDurationS, bytes: null, resolution: req.resolution }
        : null,
      frames,
      shorts: [],
    },
    steps: [...kindCounts.entries()]
      .map(([kind, c]) => ({
        seq: legacySeqOf(kind),
        name: kind,
        total: c.total,
        completed: c.completed,
        failed: c.failed,
        warmMs: null,
        runMs: null,
      }))
      .sort((a, b) => a.seq - b.seq),
    quality: { gated: 0, passedFirstAttempt: 0, reworked: rows.filter((r) => r.reworks > 0).length, acceptedMarginal: 0, escalatedRung: 0 },
    metrics: {
      queuedMs: firstSubmit ? firstSubmit.getTime() - facts.startedAt.getTime() : null,
      runMs: finishedAt.getTime() - facts.startedAt.getTime(),
      gpuCostUsd: facts.gpuCostUsd,
      qualityCostUsd: null,
      warmCostUsd: null,
    },
    errors,
    ...(allErrors.length > errors.length ? { errorsTotal: allErrors.length } : {}),
  };
}

/** Kept local so assets/kinds.ts stays free of result-shape concerns. */
function legacySeqOf(kind: string): number {
  const map: Record<string, number> = {
    'qwen-edit': 0,
    'qwen-image-gen': 1,
    tts: 2,
    'wan2-i2v': 3,
    bgm: 5,
    'postprod-lite': 6,
    merge: 6,
    'dreamx-refine': 14,
    mmaudio: 15,
  };
  return map[kind] ?? 99;
}

export interface FinalizeDeps {
  pool: Pool;
  cfg: Config;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** Best-effort Content-Length of the final asset; null on any failure —
 * mirrors result/finalize.ts's headBytes(). */
async function headBytes(fetchImpl: typeof fetch, url: string): Promise<number | null> {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    const len = Number(res.headers.get('content-length'));
    return res.ok && Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

/**
 * Store the result on `projects` and deliver the callback. Idempotent: a
 * project whose `finished_at` is already set is left alone, so a compiler
 * retry cannot fire a second callback for the same completion.
 */
export async function finalizeAssetProject(
  deps: FinalizeDeps,
  projectId: string,
  outcome: { status: ResultStatus; finalUrl: string | null },
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const project = await getProject(deps.pool, projectId);
  const pp = await getPipelineProject(deps.pool, projectId);
  if (!project || !pp) {
    log().error({ projectId }, 'asset-result: cannot finalize, project or pipeline row missing');
    return;
  }

  const { rows: already } = await deps.pool.query<{ finished_at: Date | null; created_at: Date; callback_url: string | null }>(
    `SELECT finished_at, created_at, callback_url FROM projects WHERE id = $1`,
    [projectId],
  );
  if (already[0]?.finished_at) {
    log().info({ projectId }, 'asset-result: already finalized, no second callback');
    return;
  }

  const rows = await listProjectAssets(deps.pool, projectId);
  const gpuCostUsd = await projectAssetCost(deps.pool, projectId);

  const result = buildAssetResult({
    project: {
      id: project.id,
      requestId: project.requestId,
      createdAt: already[0]?.created_at ?? pp.startedAt,
      request: project.request as OrchestratorRequest,
    },
    plan: pp.plan,
    rows,
    status: outcome.status,
    finalUrl: outcome.finalUrl,
    // The one-shot reports the finished video's real length on its own row.
    finalDurationS: rows.find((r) => r.kind === 'postprod-lite' && r.status === 'complete')?.durationS ?? null,
    gpuCostUsd,
    startedAt: pp.startedAt,
  });
  if (result.assets.final) result.assets.final.bytes = await headBytes(fetchImpl, result.assets.final.url);

  const callbackUrl = already[0]?.callback_url ?? project.callbackUrl;
  await deps.pool.query(
    `UPDATE projects SET result = $2, status = $3, finished_at = now(), callback_status = $4 WHERE id = $1`,
    [projectId, result, result.status, callbackUrl ? 'pending' : 'skipped'],
  );
  log().info({ projectId, status: result.status, errors: result.errors.length }, 'asset-result: result stored');

  if (!callbackUrl) return;

  const { outcome: delivery } = await deliverCallback({
    url: callbackUrl,
    body: result,
    requestId: project.requestId,
    secret: deps.cfg.callbackSecret,
    maxAttempts: deps.cfg.callbackMaxAttempts,
    baseDelayMs: deps.cfg.callbackBaseDelayMs,
    maxDelayMs: deps.cfg.callbackMaxDelayMs,
    timeoutMs: deps.cfg.callbackTimeoutMs,
    fetchImpl,
    sleepImpl: deps.sleepImpl,
    onAttempt: async (a: CallbackAttempt) => {
      await deps.pool.query(`UPDATE projects SET callback_attempts = callback_attempts || $2::jsonb WHERE id = $1`, [
        projectId,
        JSON.stringify([a]),
      ]);
    },
  });
  await deps.pool.query(`UPDATE projects SET callback_status = $2 WHERE id = $1`, [projectId, delivery]);
  log()[delivery === 'delivered' ? 'info' : 'error']({ projectId, delivery }, 'asset-result: callback finished');
}
