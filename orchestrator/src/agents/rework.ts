/**
 * Admin-triggered rework (2026-09-16, http/routes/admin.ts's
 * `POST /v1/admin/projects/:id/rework`). Regenerates ONLY a partial/failed
 * project's failed frames — already-successful ones are left untouched —
 * and the project ends up `completed`. See agents/rework.ts's header
 * context in the implementation plan for why this can't just reset the
 * failed job back to `planned` in place: once a cohort closes, nothing
 * polls its steps anymore, and reopening it risks touching step rows now
 * possibly shared by other projects batched into the same cohort
 * (stepsJoinable()/ORCH_SCHEDULING_MODE=batch, shipped earlier the same
 * session).
 *
 * Instead: the failed frames run through the SAME, completely unmodified
 * `plan()`/`driveCohort()` pipeline as any other small project (a "repair
 * sub-project", `${projectId}__repair{n}`) — its own final assembled video
 * is a throwaway nobody serves; only its PER-FRAME outputs matter. Once it
 * finishes, this splices its fixed frames into the ORIGINAL project's
 * already-stored §9.6 result (patching, not rebuilding from scratch — the
 * original's successful frames' URLs are already sitting right there),
 * re-runs concat(+caption+bgm) directly against postprod-lite for the new
 * complete frame set, and re-finalizes the ORIGINAL project — a normal
 * `completed` callback, StoryStudio never needs to know a repair happened.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import { RunpodClient } from '../runpod/client';
import { isTerminal } from '../runpod/types';
import { runpodOutUrl } from '../runpod/output';
import { log } from '../telemetry/log';
import { getProject, updateProjectResult } from '../db/repo/projects';
import { plan, type OrchestratorRequest } from './planner';
import { driveCohort } from './orchestrator';
import { deliverCallback, type CallbackAttempt } from '../result/callback';
import { POSTPROD_LITE_ENDPOINT_ID } from '../steps/tail-endpoints';
import type { QmResult, ResultFrame } from '../result/assemble';

export interface ReworkDeps {
  pool: Pool;
  runpod: RunpodClient;
  cfg: Config;
  publicBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export class ReworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReworkError';
  }
}

async function runPostprodLite(runpod: RunpodClient, payload: Record<string, unknown>, timeoutMs = 300_000): Promise<Record<string, unknown>> {
  const res = await runpod.run(POSTPROD_LITE_ENDPOINT_ID, payload);
  if (res.status === 'COMPLETED') return (res.output ?? {}) as Record<string, unknown>;
  if (isTerminal(res.status)) {
    throw new ReworkError(`postprod-lite ${payload.mode} failed: ${JSON.stringify(res.output ?? res.error)}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    const poll = await runpod.status(POSTPROD_LITE_ENDPOINT_ID, res.id);
    if (poll.status === 'COMPLETED') return (poll.output ?? {}) as Record<string, unknown>;
    if (isTerminal(poll.status)) {
      throw new ReworkError(`postprod-lite ${payload.mode} failed: ${JSON.stringify(poll.output ?? poll.error)}`);
    }
  }
  throw new ReworkError(`postprod-lite ${payload.mode} timed out after ${timeoutMs}ms`);
}

async function headBytes(fetchImpl: typeof fetch, url: string): Promise<number | null> {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    const len = Number(res.headers.get('content-length'));
    return res.ok && Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

export interface PreparedRework {
  projectId: string;
  originalRequest: OrchestratorRequest;
  originalResult: QmResult;
  originalCallbackUrl: string | null;
  originalRequestId: string;
  failedFrameIds: Set<string>;
  repairId: string;
  repairRequest: OrchestratorRequest;
}

/**
 * Every check that can run WITHOUT kicking off real generation — mirrors
 * agents/planner.ts's own validateRequest()/plan() split for exactly the
 * same reason: http/routes/admin.ts's rework route awaits this synchronously
 * so an invalid projectId or "nothing to rework" comes back as a real `400`,
 * not silently swallowed by driveRework()'s fire-and-forget `.catch()`.
 */
export async function validateRework(deps: ReworkDeps, projectId: string): Promise<PreparedRework> {
  const original = await getProject(deps.pool, projectId);
  if (!original) throw new ReworkError(`project ${projectId} not found`);
  if (original.status !== 'partial' && original.status !== 'failed') {
    throw new ReworkError(`project ${projectId} is '${original.status}', not partial/failed — nothing to rework`);
  }
  const originalResult = original.result as QmResult | null;
  if (!originalResult) throw new ReworkError(`project ${projectId}: no stored result to patch (was it ever finalized?)`);

  const { rows: failedFrameRows } = await deps.pool.query<{ frame_id: string }>(
    `SELECT DISTINCT frame_id FROM jobs WHERE project_id = $1 AND status = 'failed' AND frame_id IS NOT NULL`,
    [projectId],
  );
  const failedFrameIds = new Set(failedFrameRows.map((r) => r.frame_id));
  if (failedFrameIds.size === 0) throw new ReworkError(`project ${projectId}: no failed frames found to rework`);

  const originalRequest = original.request as OrchestratorRequest;
  const { rows: countRows } = await deps.pool.query<{ count: string }>(`SELECT count(*) FROM projects WHERE id LIKE $1`, [
    `${projectId}\\_\\_repair%`,
  ]);
  const attempt = Number(countRows[0]?.count ?? 0) + 1;
  const repairId = `${projectId}__repair${attempt}`;

  const repairFrames = originalRequest.frames.filter((f) => failedFrameIds.has(f.frameId));
  if (repairFrames.length !== failedFrameIds.size) {
    throw new ReworkError(`project ${projectId}: ${failedFrameIds.size} failed frame id(s) not found in the stored request — cannot rebuild it`);
  }
  const repairRequest: OrchestratorRequest = { ...originalRequest, requestId: `req_${repairId}`, projectId: repairId, frames: repairFrames };

  return {
    projectId,
    originalRequest,
    originalResult,
    originalCallbackUrl: original.callbackUrl,
    originalRequestId: original.requestId,
    failedFrameIds,
    repairId,
    repairRequest,
  };
}

/** The long-running part — real generation, minutes not milliseconds.
 * Always called with an already-`validateRework()`-checked `prepared`
 * (the route does this fire-and-forget, matching http/routes/requests.ts's
 * plan()-then-driveCohort() split exactly). */
export async function driveRework(deps: ReworkDeps, prepared: PreparedRework): Promise<void> {
  const { projectId, originalRequest, originalResult, originalCallbackUrl, originalRequestId, failedFrameIds, repairId, repairRequest } = prepared;

  log().info({ projectId, repairId, failedFrameIds: [...failedFrameIds] }, 'rework: submitting repair sub-project');
  const ack = await plan(deps.pool, deps.cfg, repairRequest);
  await driveCohort({ pool: deps.pool, runpod: deps.runpod, cfg: deps.cfg, publicBaseUrl: deps.publicBaseUrl }, ack.cohortId);

  const repaired = await getProject(deps.pool, repairId);
  const repairResult = repaired?.result as QmResult | undefined;
  if (!repairResult) throw new ReworkError(`rework: repair project ${repairId} never produced a result`);

  const repairFramesByFrameId = new Map(repairResult.assets.frames.map((f) => [f.frameId, f] as const));
  const patchedFrames: ResultFrame[] = originalResult.assets.frames.map((f) => {
    if (!failedFrameIds.has(f.frameId)) return f; // already-successful frame, untouched
    const fixed = repairFramesByFrameId.get(f.frameId);
    if (!fixed || fixed.status !== 'completed' || !fixed.mergedClipUrl) {
      throw new ReworkError(`rework: frame ${f.frameId} still failed after repair (${repairId}) — aborting, ${projectId} left untouched`);
    }
    return fixed;
  });

  const orderedClipUrls = patchedFrames.map((f) => f.mergedClipUrl!);
  log().info({ projectId, repairId, frameCount: orderedClipUrls.length }, 'rework: splicing repaired frames, re-running assembly');

  const concatOut = await runPostprodLite(deps.runpod, { mode: 'concat', video_urls: orderedClipUrls, project_id: projectId });
  let finalUrl = runpodOutUrl(concatOut);
  let finalDurationS = typeof concatOut.duration_s === 'number' ? concatOut.duration_s : null;
  if (!finalUrl) throw new ReworkError(`rework: concat produced no output URL for ${projectId}`);

  if (originalRequest.options.burnCaptions) {
    const captionOut = await runPostprodLite(deps.runpod, { mode: 'caption', video_url: finalUrl });
    const captionUrl = runpodOutUrl(captionOut);
    if (captionUrl) finalUrl = captionUrl;
  }
  if (originalRequest.options.bgm && originalResult.assets.bgm?.url) {
    const bgmOut = await runPostprodLite(deps.runpod, { mode: 'mix_bgm', video_url: finalUrl, bgm_url: originalResult.assets.bgm.url });
    const bgmUrl = runpodOutUrl(bgmOut);
    if (bgmUrl) finalUrl = bgmUrl;
    if (typeof bgmOut.duration_s === 'number') finalDurationS = bgmOut.duration_s;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const finalBytes = await headBytes(fetchImpl, finalUrl);

  const patchedResult: QmResult = {
    ...originalResult,
    status: 'completed',
    finishedAt: new Date().toISOString(),
    assets: {
      ...originalResult.assets,
      final: { url: finalUrl, durationS: finalDurationS, bytes: finalBytes, resolution: originalResult.assets.final?.resolution ?? null },
      frames: patchedFrames,
    },
    errors: originalResult.errors.filter((e) => !failedFrameIds.has(e.frameId ?? '')),
  };

  await updateProjectResult(deps.pool, projectId, { result: patchedResult, status: 'completed' });
  log().info({ projectId, repairId }, 'rework: original project patched and marked completed');

  if (originalCallbackUrl) {
    const { outcome: delivery } = await deliverCallback({
      url: originalCallbackUrl,
      body: patchedResult,
      requestId: originalRequestId,
      secret: deps.cfg.callbackSecret,
      maxAttempts: deps.cfg.callbackMaxAttempts,
      baseDelayMs: deps.cfg.callbackBaseDelayMs,
      maxDelayMs: deps.cfg.callbackMaxDelayMs,
      timeoutMs: deps.cfg.callbackTimeoutMs,
      fetchImpl,
      onAttempt: async (a: CallbackAttempt) => {
        await deps.pool.query(`UPDATE projects SET callback_attempts = callback_attempts || $2::jsonb WHERE id = $1`, [
          projectId,
          JSON.stringify([a]),
        ]);
      },
    });
    await deps.pool.query(`UPDATE projects SET callback_status = $2 WHERE id = $1`, [projectId, delivery]);
    log().info({ projectId, delivery }, 'rework: callback finished');
  }
}
