/**
 * Submission into the asset pipeline (2026-09-19) — the counterpart to
 * `agents/planner.ts`'s `plan()`.
 *
 * "A project submitted to the orchestrator is saved to the DB, and every
 * asset it needs is written as a row in that asset's own table." That is the
 * whole of this file. There is no cohort, no window, no step graph and no
 * driver kicked off in the background: the rows ARE the schedule, and the
 * eight generator agents are already polling for them.
 *
 * Validation is `agents/planner.ts`'s `validateRequest()` verbatim — the same
 * zod schema and the same business rules, so a malformed request fails at
 * submission in both modes and the two paths can never disagree about what a
 * valid request is.
 *
 * The acknowledgement keeps the §9.2 field set even where a field has no
 * meaning here (there is no window to close), for the same reason
 * `assets/result.ts` keeps the §9.6 shape: flipping ORCH_PIPELINE_MODE must
 * be invisible to StoryStudio.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import { log } from '../telemetry/log';
import { validateRequest, type PlanAck } from '../agents/planner';
import { insertProject, getProject } from '../db/repo/projects';
import { insertAssets, PROJECT_SCOPE, type NewAsset } from '../db/repo/assets';
import { insertPipelineProject } from '../db/repo/pipeline';
import { assetSpec } from './kinds';
import { compilePlan, expectedAssetCount, type AssetPlan } from './plan';
import { estimateMinutes } from '../telemetry/ledger';
import type { FrameJobInput } from '../steps/builders/types';
import type { OrchestratorRequest } from '../agents/planner';

/** Every asset row a project needs, in one list. Pure — no DB, no clock —
 * so the fan-out is unit-testable the way the cohort planner's
 * `buildStepsAndJobs()` is.
 *
 * Frame-scoped kinds get one row per frame, released by the per-frame handoff.
 * Project-scoped kinds get exactly one row at `frame_id = '*'`: `bgm`, which
 * has no per-frame input and so is runnable immediately, and `postprod-lite`,
 * which stays `blocked` until the compiler arms it with the manifest. */
export function buildAssetRows(req: OrchestratorRequest, plan: AssetPlan): NewAsset[] {
  const rows: NewAsset[] = [];

  for (const kind of plan.kinds.filter((k) => assetSpec(k).scope === 'project')) {
    const spec = assetSpec(kind);
    rows.push({
      kind,
      projectId: req.projectId,
      frameId: PROJECT_SCOPE,
      seq: 0,
      endpointId: spec.endpointId,
      // `bgm` has nothing to wait for; `postprod-lite` waits for the whole
      // project, which no `requires` list can express — the compiler arms it.
      // A sentinel keeps it out of the "blocked with nothing outstanding"
      // invariant and out of releaseSatisfiedBlocked()'s reach.
      requiredInputs: [],
      // `bgm` is runnable from submission — it waits for nothing. The tail
      // waits for the WHOLE project, which no `requires` list can express,
      // so it starts blocked and the compiler arms it with the manifest.
      initialStatus: kind === 'postprod-lite' ? 'blocked' : 'pending',
      input:
        kind === 'bgm'
          ? {
              // builders/bgm.ts reads both off ctx.job, exactly as the cohort
              // path's singleJobPerProject bgm job does.
              bgmPrompt: req.bgmPrompt,
              totalDurationS: req.frames.reduce((sum, f) => sum + f.durationS, 0),
            }
          : {},
      stage: null,
      stages: [],
    });
  }

  for (const kind of plan.frameKinds) {
    const spec = assetSpec(kind);
    const stages = plan.stages[kind] ?? [];
    req.frames.forEach((frame, index) => {
      // The frame's generation parameters are copied identically onto every
      // one of its rows, so any agent can build its payload from its own row
      // alone — no join back to the request at generation time.
      const input: FrameJobInput = {
        frameId: frame.frameId,
        imagePrompt: frame.imagePrompt,
        narration: frame.narration,
        durationS: frame.durationS,
        motionPrompt: frame.motionPrompt,
        audioPrompt: frame.audioPrompt,
        animateEffect: frame.animateEffect,
        aspectRatio: req.aspectRatio,
        language: req.language,
        referenceImageUrl: frame.referenceImageUrl,
        voiceEngine: req.options.voiceEngine,
        voiceSpeaker: req.voiceSpeaker,
        voiceInstruct: req.voiceInstruct,
        voiceLanguage: req.voiceLanguage,
        cloneArtifactUrl: req.cloneArtifactUrl,
        // The same no-silent-degrade flags the cohort path sets: they are
        // what lets builders/merge.ts tell "upscale wasn't requested" apart
        // from "upscale was requested and this frame's asset is missing".
        upscaleFrames: plan.frameKinds.includes('dreamx-refine') || undefined,
        sfx: plan.frameKinds.includes('mmaudio') || undefined,
        textManifest: frame.textManifest,
      };
      rows.push({
        kind,
        projectId: req.projectId,
        frameId: frame.frameId,
        seq: index,
        endpointId: spec.endpointId,
        requiredInputs: plan.requires[kind] ?? [],
        input,
        stage: stages[0] ?? null,
        stages: [...stages],
      });
    });
  }
  return rows;
}

/**
 * Validate, plan, and write every row — project, pipeline state and assets —
 * in one transaction. Nothing is dispatched here: the agents find the rows on
 * their next tick, which is at most `ORCH_ASSET_TICK_MS` away.
 */
export async function submitToAssetPipeline(
  pool: Pool,
  cfg: Pick<Config, 'workersHead'>,
  rawRequest: unknown,
): Promise<PlanAck> {
  const { req } = validateRequest(rawRequest);
  const plan = compilePlan(req);

  const client = await pool.connect();
  try {
    // §10.1 request-level idempotency: a replayed requestId returns the
    // original acknowledgement, never a second set of asset rows.
    const existing = await getProject(client, req.projectId);
    if (existing && existing.requestId === req.requestId) {
      const { rows } = await client.query<{ n: string }>('SELECT count(*) AS n FROM assets WHERE project_id = $1', [
        req.projectId,
      ]);
      log().info({ requestId: req.requestId }, 'asset-submit: replay, returning existing acknowledgement');
      return ack(req, plan, Number(rows[0]?.n ?? 0), 0);
    }

    await client.query('BEGIN');
    try {
      const { project, wasNew } = await insertProject(client, {
        id: req.projectId,
        // No cohort. `projects.cohort_id` has always been nullable; the asset
        // pipeline is the first caller to actually use that.
        cohortId: null,
        requestId: req.requestId,
        tier: req.tier,
        language: req.language,
        request: req,
        callbackUrl: req.callbackUrl,
      });
      if (!wasNew) {
        await client.query('ROLLBACK');
        throw new Error(`asset-submit: project ${req.projectId} already exists under a different requestId`);
      }

      const rows = buildAssetRows(req, plan);
      const inserted = await insertAssets(client, rows);
      await insertPipelineProject(client, {
        projectId: project.id,
        plan,
        expectedAssets: expectedAssetCount(plan),
      });
      await client.query(`UPDATE projects SET status = 'generating' WHERE id = $1`, [project.id]);
      await client.query('COMMIT');

      const est = estimateMinutes(
        plan.frameKinds.map((k) => ({ name: k, jobs: req.frames.length, workers: assetSpec(k).maxInFlight })),
      );
      log().info(
        { requestId: req.requestId, projectId: project.id, kinds: plan.kinds, assets: inserted },
        'asset-submit: committed',
      );
      return ack(req, plan, inserted, est.minutes, est.basis);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

function ack(
  req: OrchestratorRequest,
  plan: AssetPlan,
  assetCount: number,
  estimatedRunMinutes: number,
  basis: 'measured' | 'default' = 'default',
): PlanAck {
  return {
    requestId: req.requestId,
    accepted: true,
    // There is no cohort in this model. The literal names the pipeline rather
    // than inventing an id nothing could be looked up by — assets/result.ts
    // reports the same value.
    cohortId: 'asset-pipeline',
    // No window either: work starts on the next agent tick, not at a boundary.
    windowClosesAt: new Date().toISOString(),
    estimatedRunMinutes,
    estimatedResultAt: new Date(Date.now() + estimatedRunMinutes * 60_000).toISOString(),
    estimateBasis: basis,
    jobCount: assetCount,
    cohortProjects: 1,
    // Extra, additive field: which asset tables this project is queued in.
    // Additive so an existing receiver is unaffected.
    assetKinds: plan.kinds,
  } as PlanAck & { assetKinds: string[] };
}
