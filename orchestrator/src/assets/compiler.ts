/**
 * The project compiler agent (2026-09-19) — the one agent that thinks in
 * projects.
 *
 * The per-frame generator agents are deliberately blind to projects: each owns
 * an asset type and drains its own queue across every project at once, which
 * is what keeps the GPUs saturated. That leaves exactly one question
 * unanswered, and it is a project-level one: *is this project whole yet, and
 * if not, what is holding it up?* This agent answers it. Its remit, in the
 * operator's own terms:
 *
 *   1. compile every asset postprod-lite needs to run;
 *   2. if something is missing, check its status — if it is stuck, cancel the
 *      job and resubmit it as rework;
 *   3. once all of a project's assets exist, write a JSON file and trigger
 *      the postprod-lite endpoint;
 *   4. one request completes all the tail work and returns the final url.
 *
 * On (3) and (4): the compiler does NOT call postprod-lite itself. It writes
 * the manifest and *arms* the project's own project-scoped `postprod-lite`
 * asset row, and the postprod-lite agent dispatches it like any other row.
 * That is what makes "one pod processes one project" an enforced property
 * rather than a hope: the number of projects assembling at once is that
 * endpoint's pod count, applied by the same in-flight ceiling every other
 * agent obeys. The worker then does the whole tail locally — animate, merge,
 * trim, concat, caption, mix — and returns one url (`postprod-lite/API.md`
 * §10). A later tick sees that row complete and finishes the project.
 *
 * What this agent must never do: run generation work itself, or reach into
 * another project. Repair and rework happen by writing the SAME asset tables
 * the generator agents poll, so a repaired asset is picked up by its own
 * agent under its own pod limit like any other.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import { extractErrorText } from '../runpod/types';
import { log } from '../telemetry/log';
import type { FrameJobInput } from '../steps/builders/types';
import { assetSpec, type AssetKind } from './kinds';
import { clipKind, inputsSatisfied, type AssetPlan } from './plan';
import { buildManifest, manifestKey, type ManifestFrame, type TailManifest } from './manifest';
import { putJsonToR2, type R2Transport } from '../r2/client';
import {
  armProjectAsset,
  gateAssetSkipped,
  insertAssets,
  listProjectAssets,
  listStaleUngated,
  releaseSatisfiedBlocked,
  reworkAsset,
  PROJECT_SCOPE,
  type AssetRow,
} from '../db/repo/assets';
import { resolveHandoffs } from './agent';
import {
  beginAssembly,
  finishPipelineProject,
  getPipelineProject,
  listLivePipelineProjects,
  returnToGenerating,
  touchPipelineProject,
  PIPELINE_ATTEMPTS_HARD_CAP,
  type PipelineProject,
} from '../db/repo/pipeline';
import { getProject } from '../db/repo/projects';
import { finalizeAssetProject } from './result';
import type { OrchestratorRequest } from '../agents/planner';

export interface CompilerDeps {
  pool: Pool;
  runpod: RunpodClient;
  cfg: Config;
  r2?: R2Transport;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

/** How long a completed asset may sit unjudged before the compiler releases
 * it anyway. Generous: the QA agent ticks every ~10s, so reaching this means
 * it is genuinely not running, not that it is busy. */
const UNGATED_GRACE_MS = 20 * 60_000;

/** Separator for the (kind, frame) lookup key. Neither part can contain it. */
const KEY_SEP = '::';

// ── completeness ─────────────────────────────────────────────────────────

export interface ProjectAssetState {
  /** (kind, frameId) rows the plan says must exist but do not. */
  missing: Array<{ kind: AssetKind; frameId: string; seq: number }>;
  /** `submitted` rows whose provider job has gone quiet past its kind's budget. */
  stuck: AssetRow[];
  /** `blocked` rows whose inputs are all present — a lost handoff. */
  strandedBlocked: AssetRow[];
  /** Still legitimately working. */
  inProgress: AssetRow[];
  failed: AssetRow[];
  /** Frames that produced everything the plan asked of them. */
  readyFrames: Array<{ frameId: string; seq: number; rows: AssetRow[] }>;
  /** Frames that did not, with the reason. */
  droppedFrames: Array<{ frameId: string; reason: string }>;
  /** Every frame-scoped asset has reached a terminal state. */
  generated: boolean;
}

/**
 * Pure classification of one project's asset rows against its plan. Separated
 * from the tick so the decision — "whole", "stuck", "broken" — is unit
 * testable without a database, a clock or RunPod.
 *
 * Only FRAME-scoped kinds are judged here. `bgm` is handled separately (it is
 * optional to the tail, not to the frames), and `postprod-lite` is the thing
 * this state decides whether to arm.
 */
export function classifyProjectAssets(
  plan: AssetPlan,
  frames: Array<{ frameId: string; seq: number }>,
  rows: AssetRow[],
  now: number,
  stuckAfterMs: (kind: AssetKind) => number,
): ProjectAssetState {
  const byKey = new Map(rows.map((r) => [`${r.kind}${KEY_SEP}${r.frameId}`, r]));
  const missing: ProjectAssetState['missing'] = [];
  const stuck: AssetRow[] = [];
  const strandedBlocked: AssetRow[] = [];
  const inProgress: AssetRow[] = [];
  const failed: AssetRow[] = [];

  const classifyOne = (row: AssetRow | undefined, kind: AssetKind, frame: { frameId: string; seq: number }): void => {
    if (!row) {
      missing.push({ kind, frameId: frame.frameId, seq: frame.seq });
      return;
    }
    if (row.status === 'complete') {
      // Complete but unjudged is NOT done — for ASSEMBLY. The handoff already
      // happened (QA does not block the next agent, by design), so downstream
      // generation is already running; what waits here is the compiler. This
      // is the "only when the QA gate is clear for the project can the
      // compiler compile" rule, and it is the only thing making the gate
      // mean anything.
      if (assetSpec(kind).gate !== null && row.qualityStatus === null) inProgress.push(row);
      return;
    }
    if (row.status === 'failed') {
      failed.push(row);
      return;
    }
    if (row.status === 'blocked') {
      if (inputsSatisfied(row.requiredInputs, row.sources)) strandedBlocked.push(row);
      else inProgress.push(row);
      return;
    }
    // pending / submitted / cancelled. Measured from `submitted_at`, not
    // `updated_at`: polling a running job touches `updated_at`, so a clock
    // based on it can never age (real bug, 2026-09-19).
    const outstandingMs = row.submittedAt ? now - row.submittedAt.getTime() : 0;
    if (row.status === 'submitted' && outstandingMs > stuckAfterMs(kind)) stuck.push(row);
    else inProgress.push(row);
  };

  for (const kind of plan.frameKinds) {
    for (const frame of frames) classifyOne(byKey.get(`${kind}${KEY_SEP}${frame.frameId}`), kind, frame);
  }
  // The BGM track is project-scoped but IS a generation input to the tail, so
  // assembly waits for it the same way it waits for a frame.
  if (plan.kinds.includes('bgm')) {
    classifyOne(byKey.get(`bgm${KEY_SEP}${PROJECT_SCOPE}`), 'bgm', { frameId: PROJECT_SCOPE, seq: -1 });
  }

  const readyFrames: ProjectAssetState['readyFrames'] = [];
  const droppedFrames: ProjectAssetState['droppedFrames'] = [];
  for (const frame of frames) {
    const mine = plan.frameKinds.map((k) => byKey.get(`${k}${KEY_SEP}${frame.frameId}`));
    const usable = (r: AssetRow | undefined, k: AssetKind): boolean =>
      !!r && r.status === 'complete' && !!r.assetUrl && (assetSpec(k).gate === null || r.qualityStatus !== null);
    if (plan.frameKinds.every((k, i) => usable(mine[i], k))) {
      readyFrames.push({ frameId: frame.frameId, seq: frame.seq, rows: mine as AssetRow[] });
    } else {
      droppedFrames.push({
        frameId: frame.frameId,
        reason: describeDrop(rows.filter((r) => r.frameId === frame.frameId)),
      });
    }
  }

  return {
    missing,
    stuck,
    strandedBlocked,
    inProgress,
    failed,
    readyFrames,
    droppedFrames,
    // Generated means: nothing is missing, nothing is stranded, nothing is
    // stuck and nothing is still working. Failed rows do NOT block it — a
    // frame that genuinely could not be generated drops out and the project
    // finishes `partial`, the same contract the cohort path has.
    generated: missing.length === 0 && strandedBlocked.length === 0 && stuck.length === 0 && inProgress.length === 0,
  };
}

/** Why a frame produced no clip — read off its own rows, so the manifest
 * says which asset broke rather than just "missing". */
export function describeDrop(frameRows: AssetRow[]): string {
  const failed = frameRows.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    return failed.map((r) => `${r.kind}: ${extractErrorText(r.error)?.slice(0, 160) ?? 'failed'}`).join('; ');
  }
  const unfinished = frameRows.filter((r) => r.status !== 'complete');
  if (unfinished.length > 0) return unfinished.map((r) => `${r.kind} ${r.status}`).join('; ');
  return 'no asset rows';
}

// ── the manifest ─────────────────────────────────────────────────────────

/** One frame's manifest entry, assembled from its completed rows. Pure. */
export function manifestFrame(
  plan: AssetPlan,
  frame: { frameId: string; seq: number; rows: AssetRow[] },
  request: { frames: Array<{ frameId: string; narration: string; durationS: number; animateEffect?: string }> },
): ManifestFrame {
  const url = (kind: AssetKind): string | undefined =>
    frame.rows.find((r) => r.kind === kind && r.status === 'complete')?.assetUrl ?? undefined;

  const tts = frame.rows.find((r) => r.kind === 'tts');
  const audioUrl = tts?.assetUrl;
  if (!audioUrl) throw new Error(`frame ${frame.frameId}: no narration audio`);

  const clip = clipKind(plan);
  const source = clip ? url(clip) : undefined;
  const requested = request.frames.find((f) => f.frameId === frame.frameId);

  if (clip && !source) throw new Error(`frame ${frame.frameId}: no clip from ${clip}`);

  const entry: ManifestFrame = {
    frameId: frame.frameId,
    seq: frame.seq,
    audioUrl,
    // TTS's own reported length — the worker re-probes it anyway, this is for
    // the reader of the manifest.
    durationS: tts?.durationS ?? requested?.durationS ?? null,
    narration: requested?.narration ?? (tts?.input as FrameJobInput | undefined)?.narration ?? '',
  };

  if (source) {
    entry.videoUrl = source;
    // MMAudio's output carries the SFX already muxed in, so the worker lifts
    // the SFX layer off the clip's own audio rather than being handed a
    // separate track — same `sfx_from_video` contract the cohort path's merge
    // builder uses.
    if (clip === 'mmaudio') entry.sfxFromVideo = true;
  } else {
    const image = url(plan.imageKind);
    if (!image) throw new Error(`frame ${frame.frameId}: no still to animate`);
    entry.imageUrl = image;
    entry.animate = { effect: requested?.animateEffect ?? 'zoom_in', fps: 16 };
  }

  return entry;
}

// ── the tick ─────────────────────────────────────────────────────────────

export interface CompilerTickResult {
  projectId: string;
  action: 'waiting' | 'repaired' | 'armed' | 'assembled' | 'failed';
  detail?: string;
}

/**
 * Bring a project's asset rows back to a state the generator agents can make
 * progress on. Everything here writes the asset tables and nothing else —
 * repaired work is picked up by its own agent, under its own pod limit, like
 * any other row.
 */
async function repair(deps: CompilerDeps, pp: PipelineProject, state: ProjectAssetState, rows: AssetRow[]): Promise<boolean> {
  let changed = false;

  // 1. Lost handoff: inputs all present, status never flipped.
  const released = await releaseSatisfiedBlocked(deps.pool, pp.projectId);
  if (released > 0) {
    changed = true;
    log().warn({ projectId: pp.projectId, released }, 'compiler: released rows whose inputs were satisfied but still blocked');
  }

  // 2. A row the plan expects that does not exist at all. Recreate it with
  //    whatever its upstreams already produced, so it can run immediately if
  //    those are done and wait if they are not.
  if (state.missing.length > 0) {
    const byFrame = new Map<string, AssetRow[]>();
    for (const r of rows) {
      const list = byFrame.get(r.frameId) ?? [];
      list.push(r);
      byFrame.set(r.frameId, list);
    }
    for (const m of state.missing) {
      const siblings = byFrame.get(m.frameId) ?? [];
      const spec = assetSpec(m.kind);
      const required = pp.plan.requires[m.kind] ?? [];
      const sources: Record<string, { url?: string; durationS?: number }> = {};
      for (const dep of required) {
        const done = siblings.find((s) => s.kind === dep && s.status === 'complete' && s.assetUrl);
        if (done) sources[dep] = { url: done.assetUrl as string, durationS: done.durationS ?? undefined };
      }
      await insertAssets(deps.pool, [
        {
          kind: m.kind,
          projectId: pp.projectId,
          frameId: m.frameId,
          seq: m.seq,
          endpointId: spec.endpointId,
          requiredInputs: required,
          // Any sibling's input carries the frame's own generation
          // parameters — they are copied identically onto every row of a
          // frame at submission time.
          input: siblings[0]?.input ?? {},
          stage: null,
          stages: [],
        },
      ]);
      if (Object.keys(sources).length > 0) {
        await deps.pool.query(
          `UPDATE assets SET sources = sources || $4::jsonb, updated_at = now(),
                  status = CASE WHEN NOT EXISTS (
                    SELECT 1 FROM unnest(required_inputs) r WHERE NOT ((sources || $4::jsonb) ? r)
                  ) THEN 'pending' ELSE status END
            WHERE asset_kind = $1 AND project_id = $2 AND frame_id = $3`,
          [m.kind, pp.projectId, m.frameId, JSON.stringify(sources)],
        );
      }
      changed = true;
    }
    log().warn({ projectId: pp.projectId, missing: state.missing.length }, 'compiler: recreated asset rows the plan expects');
  }

  // 2b. A gated asset nobody judged. If the QA agent is down or wedged, a
  //     `complete` row with no verdict never hands off and the project waits
  //     forever — strictly worse than shipping an unjudged asset. Release it
  //     ungated (which also writes the handoff it was holding), loudly.
  const ungatedDeadline = new Date(Date.now() - UNGATED_GRACE_MS);
  for (const row of await listStaleUngated(deps.pool, pp.projectId, ungatedDeadline)) {
    if (!row.assetUrl) continue;
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const released = await gateAssetSkipped(
        client,
        row,
        { url: row.assetUrl, durationS: row.durationS ?? undefined },
        resolveHandoffs(pp.plan, row.kind, row.input),
      );
      await client.query('COMMIT');
      if (released) {
        changed = true;
        log().error(
          { projectId: pp.projectId, assetId: row.id, kind: row.kind, frameId: row.frameId },
          'compiler: asset sat ungated past the grace window — releasing it unjudged, the QA agent is not keeping up',
        );
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      log().error({ assetId: row.id, err }, 'compiler: failed to release a stale ungated asset');
    } finally {
      client.release();
    }
  }

  // 3. Stuck: the provider job is wedged or gone. Cancel it, then resubmit as
  //    rework. `reworkAsset` continues the attempt budget rather than
  //    resetting it and has its own rework cap, so a genuinely broken asset
  //    cannot resubmit forever — the bound the deadlock of 2026-09-18 taught
  //    this pipeline to always put on a retry path.
  for (const row of state.stuck) {
    if (row.providerJobId) {
      try {
        await deps.runpod.cancel(assetSpec(row.kind).endpointId, row.providerJobId);
      } catch (err) {
        // Already gone is the common case, and is exactly what we wanted.
        log().warn({ assetId: row.id, kind: row.kind, err }, 'compiler: cancel of stuck provider job failed, reworking anyway');
      }
    }
    const requeued = await reworkAsset(deps.pool, row.id, row.kind, {
      reason: 'stuck',
      stalledForMs: row.submittedAt ? Date.now() - row.submittedAt.getTime() : null,
      providerJobId: row.providerJobId,
    });
    changed = true;
    log().warn(
      { projectId: pp.projectId, assetId: row.id, kind: row.kind, frameId: row.frameId, requeued },
      requeued ? 'compiler: stuck asset cancelled and resubmitted as rework' : 'compiler: stuck asset exhausted its rework budget, failed',
    );
  }

  return changed;
}

/**
 * One project's turn. Everything here is idempotent and restart-safe: arming
 * the tail is a conditional UPDATE (so two ticks cannot arm it twice), and a
 * process that dies between arming and completion leaves a `pending`
 * postprod-lite row the agent simply picks up.
 */
export async function compileProject(deps: CompilerDeps, projectId: string): Promise<CompilerTickResult> {
  const pp = await getPipelineProject(deps.pool, projectId);
  if (!pp) return { projectId, action: 'waiting', detail: 'no pipeline row' };

  const project = await getProject(deps.pool, projectId);
  if (!project) return { projectId, action: 'waiting', detail: 'no project row' };
  const request = project.request as OrchestratorRequest;
  const frames = request.frames.map((f, i) => ({ frameId: f.frameId, seq: i }));

  const rows = await listProjectAssets(deps.pool, projectId);
  const tailRow = rows.find((r) => r.kind === 'postprod-lite' && r.frameId === PROJECT_SCOPE);

  // ── already assembling: is the one-shot done? ──────────────────────────
  if (pp.status === 'assembling') {
    if (!tailRow) {
      await returnToGenerating(deps.pool, projectId, { reason: 'assembling with no postprod-lite row' });
      return { projectId, action: 'waiting', detail: 'no tail row' };
    }
    if (tailRow.status === 'complete' && tailRow.assetUrl) {
      const manifest = pp.manifest as TailManifest | null;
      const anyDropped = (manifest?.droppedFrames.length ?? 0) > 0 || rows.some((r) => r.status === 'failed');
      const status = anyDropped ? 'partial' : 'completed';
      await finishPipelineProject(deps.pool, projectId, { status, finalUrl: tailRow.assetUrl });
      await finalizeAssetProject(deps, projectId, { status, finalUrl: tailRow.assetUrl });
      log().info({ projectId, status, finalUrl: tailRow.assetUrl }, 'compiler: project finished');
      return { projectId, action: 'assembled', detail: tailRow.assetUrl };
    }
    if (tailRow.status === 'failed') {
      const reason = extractErrorText(tailRow.error)?.slice(0, 300) ?? 'tail failed';
      if (pp.attempts >= PIPELINE_ATTEMPTS_HARD_CAP) {
        await finishPipelineProject(deps.pool, projectId, { status: 'failed', error: { tail: reason } });
        await finalizeAssetProject(deps, projectId, { status: 'failed', finalUrl: null });
        log().error({ projectId, reason }, 'compiler: tail failed and attempts are exhausted');
        return { projectId, action: 'failed', detail: reason };
      }
      // Back to `generating`: the next tick re-checks the assets (one may have
      // been reworked in the meantime) and recompiles the manifest from
      // scratch before arming the tail again.
      await returnToGenerating(deps.pool, projectId, { tail: reason });
      log().warn({ projectId, reason, attempt: pp.attempts }, 'compiler: tail failed, will recompile and retry');
      return { projectId, action: 'failed', detail: reason };
    }
    // pending / submitted — the postprod-lite agent owns it. Its own
    // its own timeout brings it back here if the provider job wedges.
    await touchPipelineProject(deps.pool, projectId);
    return { projectId, action: 'waiting', detail: `tail ${tailRow.status}` };
  }

  // ── generating ────────────────────────────────────────────────────────
  const state = classifyProjectAssets(pp.plan, frames, rows, Date.now(), // The agent enforces `timeoutMs` per request from `submitted_at`; this is
    // only the backstop for rows no agent is watching (agent down, process
    // restarted), so it waits a generous multiple before intervening.
    (k) => assetSpec(k).timeoutMs * 4);

  if (!state.generated) {
    const changed = await repair(deps, pp, state, rows);
    if (!changed) await touchPipelineProject(deps.pool, projectId);
    return {
      projectId,
      action: changed ? 'repaired' : 'waiting',
      detail: `missing=${state.missing.length} stuck=${state.stuck.length} stranded=${state.strandedBlocked.length} working=${state.inProgress.length}`,
    };
  }

  // Every frame-scoped asset has reached a terminal state. concat needs two
  // clips; below that there is nothing to assemble and the project failed.
  if (state.readyFrames.length < 2) {
    await finishPipelineProject(deps.pool, projectId, {
      status: 'failed',
      error: { reason: 'too few frames to assemble', ready: state.readyFrames.length, dropped: state.droppedFrames },
    });
    await finalizeAssetProject(deps, projectId, { status: 'failed', finalUrl: null });
    log().error({ projectId, ready: state.readyFrames.length }, 'compiler: project failed — fewer than two usable frames');
    return { projectId, action: 'failed', detail: 'fewer than two usable frames' };
  }

  if (pp.attempts >= PIPELINE_ATTEMPTS_HARD_CAP) {
    await finishPipelineProject(deps.pool, projectId, { status: 'failed', error: { reason: 'assembly attempts exhausted' } });
    await finalizeAssetProject(deps, projectId, { status: 'failed', finalUrl: null });
    return { projectId, action: 'failed', detail: 'assembly attempts exhausted' };
  }

  if (!tailRow) {
    await returnToGenerating(deps.pool, projectId, { reason: 'no postprod-lite row to arm' });
    return { projectId, action: 'waiting', detail: 'no tail row' };
  }

  // Build the manifest. A frame that cannot produce one joins the dropped
  // list rather than failing the project — same contract as everywhere else.
  const manifestFrames: ManifestFrame[] = [];
  const dropped = [...state.droppedFrames];
  for (const frame of state.readyFrames) {
    try {
      manifestFrames.push(manifestFrame(pp.plan, frame, request));
    } catch (err) {
      dropped.push({ frameId: frame.frameId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (manifestFrames.length < 2) {
    await finishPipelineProject(deps.pool, projectId, { status: 'failed', error: { reason: 'manifest has fewer than two frames', dropped } });
    await finalizeAssetProject(deps, projectId, { status: 'failed', finalUrl: null });
    return { projectId, action: 'failed', detail: 'manifest has fewer than two frames' };
  }

  const bgmRow = rows.find((r) => r.kind === 'bgm' && r.status === 'complete');
  const manifest = buildManifest({
    projectId,
    requestId: project.requestId,
    plan: pp.plan,
    request: {
      tier: request.tier,
      product: request.product,
      language: request.language,
      aspectRatio: request.aspectRatio,
      resolution: request.resolution,
      options: request.options as unknown as Record<string, unknown>,
    },
    frames: manifestFrames,
    droppedFrames: dropped,
    bgmUrl: bgmRow?.assetUrl ?? undefined,
  });

  // The manifest travels as a FILE. Inline is the fallback when R2 isn't
  // configured, and steps/builders/postprod.ts refuses an oversized one
  // rather than sending it.
  let manifestUrl: string | null = null;
  if (deps.r2?.accessKeyId && deps.r2?.secretAccessKey) {
    try {
      manifestUrl = await putJsonToR2(deps.r2, manifestKey(projectId), manifest);
    } catch (err) {
      log().warn({ projectId, err }, 'compiler: manifest upload failed, falling back to an inline manifest');
    }
  }

  const claimed = await beginAssembly(deps.pool, projectId, manifest, manifestUrl);
  if (!claimed) return { projectId, action: 'waiting', detail: 'another tick claimed assembly' };

  // Arm the project-scoped tail row. From here the postprod-lite agent owns
  // it: it dispatches under that endpoint's pod limit — one project per pod —
  // and the next compiler tick collects the result.
  await armProjectAsset(deps.pool, projectId, 'postprod-lite', {
    ...(manifestUrl ? { manifestUrl } : { manifest }),
    frameId: PROJECT_SCOPE,
  });

  log().info(
    { projectId, frames: manifestFrames.length, dropped: dropped.length, manifestUrl, steps: manifest.steps, bgm: !!manifest.bgm },
    'compiler: manifest compiled, tail armed',
  );
  return { projectId, action: 'armed', detail: manifestUrl ?? 'inline manifest' };
}

/** One pass over every live project. */
export async function runCompilerTick(deps: CompilerDeps): Promise<CompilerTickResult[]> {
  const live = await listLivePipelineProjects(deps.pool);
  const out: CompilerTickResult[] = [];
  for (const pp of live) {
    try {
      out.push(await compileProject(deps, pp.projectId));
    } catch (err) {
      log().error({ projectId: pp.projectId, err }, 'compiler: project tick crashed');
      out.push({ projectId: pp.projectId, action: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export function startCompiler(deps: CompilerDeps, intervalMs: number): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runCompilerTick(deps)
      .catch((err) => log().error({ err }, 'compiler: tick crashed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  log().info({ intervalMs }, 'compiler: started');
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
