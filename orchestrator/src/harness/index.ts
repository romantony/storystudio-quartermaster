/**
 * Prompt harness entry points (implementation plan §6.1).
 *
 * `prepareCohort()` is called once per cohort, before the bulk steps start
 * (agents/orchestrator.ts's driveCohort(), right after `catalogued`/
 * `runnable` are computed) — for every project whose `options.promptHarness`
 * isn't 'off', it turns each frame's request prompts into a validated
 * ShotContract and a pair of guardrail-compiled prompts, and writes the
 * result back onto that frame's still-`planned` job rows (steps 0/1 image,
 * step 3 motion) before generation begins. A failure anywhere in this
 * function for one frame/project must never abort the cohort — every
 * per-frame and per-project step is wrapped so a bad extraction or a DB
 * hiccup just leaves that frame on its original, pre-harness prompts.
 *
 * `lintRequest()` is the dry-run used by `npm run harness:lint` and
 * `POST /v1/harness/lint` — same per-frame pipeline, no DB, no writes.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { OrchestratorRequest } from '../agents/planner';
import { listProjectsForCohort } from '../db/repo/projects';
import { patchFrameJobInputs } from '../db/repo/jobs';
import { prepareFrame, recordPrepareFindings, type PrepareFrameDeps, type PrepareFrameOutput } from './prepare';
import type { ShotContract } from './contract';
import { log } from '../telemetry/log';

export type { PrepareFrameOutput } from './prepare';

export interface HarnessDeps {
  pool: Pool;
  cfg: Pick<
    Config,
    | 'replicateApiToken'
    | 'replicateApiBase'
    | 'replicateTimeoutMs'
    | 'replicatePollIntervalMs'
    | 'replicateMaxPollAttempts'
    | 'replicateVisionModel'
    | 'replicateVisionModelFallback'
    | 'replicateRewriteModel'
    | 'replicateRewriteReasoning'
    | 'harnessToolConcurrency'
  >;
}

function toolDeps(deps: HarnessDeps): PrepareFrameDeps {
  return {
    replicate: {
      apiToken: deps.cfg.replicateApiToken,
      apiBase: deps.cfg.replicateApiBase,
      timeoutMs: deps.cfg.replicateTimeoutMs,
      // Not actually used by runReplicateText (extract/regenerate only need
      // it), but ReplicateDeps requires them — reuse the quality-gate VLM
      // config rather than a made-up placeholder.
      visionModel: deps.cfg.replicateVisionModel,
      visionModelFallback: deps.cfg.replicateVisionModelFallback,
      pollIntervalMs: deps.cfg.replicatePollIntervalMs,
      maxPollAttempts: deps.cfg.replicateMaxPollAttempts,
    },
    extractCfg: { model: deps.cfg.replicateRewriteModel, reasoningEffort: deps.cfg.replicateRewriteReasoning },
    regenerateCfg: { model: deps.cfg.replicateRewriteModel, reasoningEffort: deps.cfg.replicateRewriteReasoning },
    pool: deps.pool,
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const IMAGE_STEP_SEQS = [0, 1];
const MOTION_STEP_SEQS = [3];

async function prepareProject(
  deps: PrepareFrameDeps,
  pool: Pool,
  cohortId: string,
  projectId: string,
  req: OrchestratorRequest,
): Promise<void> {
  const mode = req.options.promptHarness;
  if (mode === 'off') return;

  let previousContract: ShotContract | undefined;
  for (const frame of req.frames) {
    try {
      const output = await prepareFrame(deps, {
        frameId: frame.frameId,
        imagePrompt: frame.imagePrompt,
        motionPrompt: frame.motionPrompt,
        narration: frame.narration,
        referenceImage: req.options.referenceImage,
        aspectRatio: req.aspectRatio,
        shot: frame.shot,
        previousContract,
      });

      if (output.contract) previousContract = output.contract;

      await recordPrepareFindings(pool, { cohortId, projectId, frameId: frame.frameId }, output.harnessVersion, output);

      if (!output.contract) {
        log().warn({ cohortId, projectId, frameId: frame.frameId, error: output.harnessError }, 'harness: no contract for frame, leaving prompts untouched');
        continue;
      }

      const common = { contract: output.contract, harnessVersion: output.harnessVersion, splitShot: output.splitShot };
      const imagePatch: Record<string, unknown> = { ...common };
      const motionPatch: Record<string, unknown> = { ...common };
      if (mode === 'enforce') {
        imagePatch.imagePrompt = output.imagePrompt;
        motionPatch.motionPrompt = output.motionPrompt;
      } else {
        imagePatch.harnessImagePrompt = output.imagePrompt;
        motionPatch.harnessMotionPrompt = output.motionPrompt;
      }
      if (output.imageFallbackRung) imagePatch.fallbackRung = output.imageFallbackRung;
      if (output.motionFallbackRung) motionPatch.fallbackRung = output.motionFallbackRung;

      await patchFrameJobInputs(pool, { cohortId, projectId, frameId: frame.frameId, stepSeqs: IMAGE_STEP_SEQS, patch: imagePatch });
      await patchFrameJobInputs(pool, { cohortId, projectId, frameId: frame.frameId, stepSeqs: MOTION_STEP_SEQS, patch: motionPatch });
    } catch (err) {
      log().error({ cohortId, projectId, frameId: frame.frameId, err }, 'harness: prepareFrame failed, leaving this frame on its original prompts');
    }
  }
}

export async function prepareCohort(deps: HarnessDeps, cohortId: string): Promise<void> {
  const projects = await listProjectsForCohort(deps.pool, cohortId);
  const prepDeps = toolDeps(deps);
  await mapWithConcurrency(projects, deps.cfg.harnessToolConcurrency, async (project) => {
    try {
      await prepareProject(prepDeps, deps.pool, cohortId, project.id, project.request as OrchestratorRequest);
    } catch (err) {
      log().error({ cohortId, projectId: project.id, err }, 'harness: prepareProject failed, cohort continues on original prompts');
    }
  });
}

export interface LintRequestFrameResult {
  frameId: string;
  output: PrepareFrameOutput;
}

/** Dry run: same per-frame pipeline, no DB, no writes — `npm run
 * harness:lint` and `POST /v1/harness/lint`. */
export async function lintRequest(deps: PrepareFrameDeps, req: OrchestratorRequest): Promise<LintRequestFrameResult[]> {
  const results: LintRequestFrameResult[] = [];
  let previousContract: ShotContract | undefined;
  for (const frame of req.frames) {
    const output = await prepareFrame(deps, {
      frameId: frame.frameId,
      imagePrompt: frame.imagePrompt,
      motionPrompt: frame.motionPrompt,
      narration: frame.narration,
      referenceImage: req.options.referenceImage,
      aspectRatio: req.aspectRatio,
      shot: frame.shot,
      previousContract,
    });
    if (output.contract) previousContract = output.contract;
    results.push({ frameId: frame.frameId, output });
  }
  return results;
}
