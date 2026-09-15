/**
 * Quality agent (impl plan §6.5, M4). Gates completed jobs against a VLM
 * scoring rubric and reworks failures on the still-warm endpoint.
 *
 * Runs CONCURRENTLY with generator.ts's runStep() (driven by
 * agents/orchestrator.ts's driveCohort() via Promise.allSettled), not
 * strictly after it — this is what the spec means by gating assets "as
 * they land" and reworking "while the endpoint is still warm". The
 * mechanism needs zero changes to generator.ts: when a REWORK/FAIL verdict
 * resets a job's `status` from 'complete' back to 'planned',
 * stepJobCounts()'s `terminal` count (status IN ('complete','failed'))
 * drops, so runStep()'s own `terminal >= total` loop-exit condition stops
 * being true — its very next tick (≤5s later) sees the reopened row and
 * `claimNextBatch`'s existing `WHERE status='planned' AND deps_remaining=0`
 * query picks it straight back up. generator.ts was already written
 * rework-agnostic; only this module needed to exist.
 *
 * Scope: image gate (step 1) and motion gate (step 3) only — the two steps
 * that exist today. The assembly gate (step 12) has nowhere to attach until
 * M5 adds that step's catalog entry, and its failure action is different
 * anyway (flag partial, no automatic rework) — a different function
 * entirely when it lands, not a third branch here.
 */
import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config';
import type { CatalogEntry } from '../steps/catalog';
import type { FallbackRung, FrameJobInput } from '../steps/builders/types';
import { rewritePrompt } from '../quality/rewrite';
import { harnessGateOneJob } from '../harness/quality-bridge';
import { log } from '../telemetry/log';
import { updateStepStatus } from '../db/repo/steps';
import {
  listUngated,
  countUngated,
  countInFlightForGatedStep,
  getQualityGatesOption,
  applyPass,
  applyRework,
  applyExhausted,
  applySkipped,
  latestImageScoreForFrame,
  sourceImageForFrame,
  type UngatedJob,
} from '../db/repo/quality';
import { runpodOutUrl } from '../runpod/output';
import {
  IMAGE_QA_SYSTEM_PROMPT,
  VIDEO_QA_SYSTEM_PROMPT,
  scoreImage,
  scoreVideo,
  imageEvalFailedResult,
  videoEvalFailedResult,
  isVideoGatedByImageScore,
  videoGatedResult,
  type GateResult,
  type VideoGateResult,
  type Issue,
} from '../quality/rubric';
import { callVisionJson, type ReplicateDeps } from '../quality/replicate';

export interface QualityDeps {
  pool: Pool;
  replicate: Pick<ReplicateDeps, 'apiToken' | 'apiBase' | 'visionModel' | 'visionModelFallback' | 'pollIntervalMs' | 'maxPollAttempts' | 'timeoutMs'>;
  cfg: Pick<
    Config,
    | 'qualityGates'
    | 'maxAttempts'
    | 'reconcileIntervalMs'
    | 'qualityVlmCostUsd'
    | 'qualityImagePassThreshold'
    | 'qualityImageReviewThreshold'
    | 'qualityVideoGateThreshold'
    | 'qualityVideoPassThreshold'
    | 'qualityVideoReviewThreshold'
    | 'qualityEvalMaxFailures'
    | 'replicateRewriteModel'
    | 'replicateRewriteReasoning'
  >;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function truncate(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Builds the corrected prompt for a rework: appends the VLM's own issue
 * summary to the original prompt, same "prompt correction" tier the spec's
 * two-tier rework plan describes — rung escalation isn't built (no rung
 * ladder exists in this codebase yet; that's §16 q1's Wan 2.2 sweep, itself
 * gated on this gate existing first), so both reworks are same-endpoint
 * prompt corrections for M4. */
/** Names the model the next attempt runs on, for the prompt rewriter. */
export function targetModelLabel(gate: 'image' | 'motion', input: FrameJobInput, fallbackRung: FallbackRung | undefined): string {
  if (fallbackRung === 'flux-4b') return 'FLUX.2 klein 4B (image-to-image with a character reference image)';
  if (fallbackRung === 'replicate-wan22-fast') return 'Wan 2.2 image-to-video (non-distilled), 480p, ~5-7 s';
  if (gate === 'motion') return 'Wan 2.2 image-to-video, 4-step Lightning distillation, 480p, ~5-7 s';
  return input.referenceImageUrl ? 'Qwen-Image-Edit (edits a character reference image)' : 'Qwen-Image (text-to-image)';
}

function correctedPrompt(original: string, issueSummary: string): string {
  const note = truncate(issueSummary);
  return note ? `${original} (avoid: ${note})` : original;
}

async function evaluateImage(deps: QualityDeps, job: UngatedJob): Promise<GateResult> {
  const input = job.input as FrameJobInput;
  const imageUrl = runpodOutUrl(job.output);
  if (!imageUrl) return imageEvalFailedResult('No image URL available — image generation may have failed');

  const userMsg = `Image prompt used to generate the image:
  ${input.imagePrompt ?? ''}

Motion prompt (the motion this image will be animated into — context only, not evaluated here):
  ${input.motionPrompt ?? ''}

Character reference image used: NO — text-to-image, no identity to preserve

Evaluate this image and return your scores + issues as specified. Pay particular
attention to hallucinated duplicate bodies/characters and anatomy defects.`;

  const vlmResult = await callVisionJson(deps.replicate, { systemPrompt: IMAGE_QA_SYSTEM_PROMPT, userMsg, imageUrls: [imageUrl] });
  return scoreImage(vlmResult as { scores?: Record<string, number>; issues?: Issue[]; summary?: string }, {
    passThreshold: deps.cfg.qualityImagePassThreshold,
    reviewThreshold: deps.cfg.qualityImageReviewThreshold,
  });
}

async function evaluateVideo(deps: QualityDeps, job: UngatedJob, imageQaScore: number): Promise<VideoGateResult> {
  const thresholds = {
    gateThreshold: deps.cfg.qualityVideoGateThreshold,
    passThreshold: deps.cfg.qualityVideoPassThreshold,
    reviewThreshold: deps.cfg.qualityVideoReviewThreshold,
  };
  if (isVideoGatedByImageScore(imageQaScore, thresholds)) return videoGatedResult(imageQaScore, thresholds);

  const input = job.input as FrameJobInput;
  const videoUrl = runpodOutUrl(job.output);
  if (!videoUrl) return videoEvalFailedResult('No video URL available — animation generation may have failed');

  const duration = input.durationS ?? 5.0;
  const userMsg = `Video (motion) prompt used to generate this clip:
  ${input.motionPrompt ?? ''}

Expected clip duration: ~${duration.toFixed(1)} seconds

Evaluate this video clip and return your assessment. Watch the FULL clip for
duplicate/hallucinated bodies, not just the first frame.`;

  const vlmResult = await callVisionJson(deps.replicate, { systemPrompt: VIDEO_QA_SYSTEM_PROMPT, userMsg, videoUrls: [videoUrl] });
  return scoreVideo(vlmResult as { scores?: Record<string, number>; motion_type_detected?: string; issues?: Issue[]; summary?: string }, thresholds);
}

/** Evaluation-call failures (not verdicts) per job within one gateStep() run.
 * Before 2026-09-15 an infra failure retried every tick forever — one clip
 * Replicate's Gemini persistently can't process ("E006 Video processing
 * failed", seen live on win_2026_09_15_06) would have hung the cohort. */
async function recordEvalFailure(
  deps: QualityDeps,
  gate: 'image' | 'motion',
  job: UngatedJob,
  err: unknown,
  failures: Map<number, number>,
  assetUrl: string | null,
): Promise<void> {
  const n = (failures.get(job.id) ?? 0) + 1;
  failures.set(job.id, n);
  if (n < deps.cfg.qualityEvalMaxFailures) {
    log().warn({ jobId: job.id, gate, err, failures: n }, 'quality: evaluation call failed, will retry next tick');
    return;
  }
  // Give up on EVALUATING this asset, not on the asset: let it through
  // unevaluated, with a verdict row saying so (buildResult() counts it as
  // not gated), rather than blocking every other frame behind it.
  const message = err instanceof Error ? err.message : String(err);
  await withTransaction(deps.pool, async (client) => {
    await applyPass(client, {
      jobId: job.id,
      gate,
      attempt: job.qualityAttempts + 1,
      verdict: 'EVAL_ERROR',
      issues: [{ category: 'EVALUATION_UNAVAILABLE', description: message.slice(0, 500) }],
      action: 'skipped_eval_error',
      ruleCandidate: false,
      costUsd: null,
      assetUrl,
      weightedScore: null,
    });
  });
  log().error({ jobId: job.id, gate, failures: n, error: message }, 'quality: evaluation failed repeatedly, passing asset through unevaluated');
}

async function gateOneJob(
  deps: QualityDeps,
  cohortId: string,
  gate: 'image' | 'motion',
  job: UngatedJob,
  evalFailures: Map<number, number>,
): Promise<void> {
  const input = job.input as FrameJobInput;
  const assetUrl = runpodOutUrl(job.output) ?? null;

  let result: GateResult;
  if (gate === 'image') {
    try {
      result = await evaluateImage(deps, job);
    } catch (err) {
      // Infra failure (Replicate timeout, both models down) — NOT a content
      // verdict. Must not consume a rework attempt; retry next tick, capped.
      await recordEvalFailure(deps, gate, job, err, evalFailures, assetUrl);
      return;
    }
  } else {
    const imageScore = await latestImageScoreForFrame(deps.pool, cohortId, job.projectId, job.frameId ?? '');
    if (imageScore == null) {
      log().warn({ jobId: job.id, frameId: job.frameId }, 'quality: motion gate has no image score for this frame yet, will retry next tick');
      return;
    }
    try {
      result = await evaluateVideo(deps, job, imageScore);
    } catch (err) {
      await recordEvalFailure(deps, gate, job, err, evalFailures, assetUrl);
      return;
    }
  }

  const attempt = job.qualityAttempts + 1;
  const promptField = gate === 'image' ? ('imagePrompt' as const) : ('motionPrompt' as const);
  const originalPrompt = (gate === 'image' ? input.imagePrompt : input.motionPrompt) ?? '';
  const issueSummary = result.issues.map((i) => i.description).join('; ') || result.summary;

  const write = {
    jobId: job.id,
    gate,
    attempt,
    verdict: result.passStatus,
    issues: result.issues,
    action: result.passStatus === 'GATED' ? 'skipped_gated' : result.passStatus === 'PASS' ? 'none' : 'rework',
    ruleCandidate: result.passStatus !== 'PASS' && result.passStatus !== 'GATED',
    costUsd: result.passStatus === 'GATED' ? null : deps.cfg.qualityVlmCostUsd,
    assetUrl,
    weightedScore: result.weightedScore,
  };

  // Rework ladder (2026-09-15), maxAttempts reworks before accepting:
  //   every rework: an LLM rewrites the prompt from the QA issues;
  //   the LAST rework also switches model (image -> Flux-4B,
  //   motion -> Replicate Wan 2.2 i2v fast; steps/catalog.ts `fallbacks`).
  // The rewrite is a network call, so it runs before the transaction.
  const reworking = result.passStatus !== 'PASS' && result.passStatus !== 'GATED' && job.qualityAttempts < deps.cfg.maxAttempts;
  let rework: Parameters<typeof applyRework>[2] | undefined;

  // Prompt harness (docs/qm-orchestrator-prompt-harness-implementation-plan.md
  // §7.6/§9.2): a job the harness prepared at plan time carries a
  // ShotContract — its rework goes through the guardrail-driven corrective
  // ladder instead of the plain LLM-defect-summary rewrite below. A job
  // with no contract (harness off, or extraction failed for this frame)
  // falls straight to the unchanged legacy path.
  if (input.contract) {
    const harnessOutcome = await harnessGateOneJob({
      pool: deps.pool,
      replicate: deps.replicate as ReplicateDeps,
      regenerateCfg: { model: deps.cfg.replicateRewriteModel, reasoningEffort: deps.cfg.replicateRewriteReasoning },
      cohortId,
      gate,
      jobId: job.id,
      projectId: job.projectId,
      frameId: job.frameId,
      attempt,
      triedRungs: job.triedRungs,
      input,
      result,
      assetUrl,
      canRework: reworking,
      maxAttemptsReached: attempt >= deps.cfg.maxAttempts,
      targetModelLabel: targetModelLabel(gate, input, input.fallbackRung),
    });
    rework = harnessOutcome.rework;
  } else if (reworking) {
    const switchModel = attempt >= deps.cfg.maxAttempts;
    const fallbackRung: FallbackRung | undefined = switchModel ? (gate === 'image' ? 'flux-4b' : 'replicate-wan22-fast') : undefined;
    const originalField = gate === 'image' ? 'originalImagePrompt' : 'originalMotionPrompt';
    const firstPrompt = (input[originalField] as string | undefined) ?? originalPrompt;
    const sourceImage =
      gate === 'image' ? assetUrl : runpodOutUrl(await sourceImageForFrame(deps.pool, cohortId, job.projectId, job.frameId ?? ''));
    const rewritten = await rewritePrompt(
      deps.replicate as ReplicateDeps,
      { model: deps.cfg.replicateRewriteModel, reasoningEffort: deps.cfg.replicateRewriteReasoning },
      {
        gate,
        originalPrompt: firstPrompt,
        currentPrompt: originalPrompt,
        issues: result.issues,
        summary: result.summary,
        imageUrl: sourceImage ?? undefined,
        narration: input.narration,
        imagePrompt: gate === 'motion' ? input.imagePrompt : undefined,
        targetModel: targetModelLabel(gate, input, fallbackRung),
      },
    );
    rework = {
      promptField,
      correctedPrompt: rewritten ?? correctedPrompt(originalPrompt, issueSummary),
      rungLabel: fallbackRung ? `${gate}:${fallbackRung}:${attempt}` : `${gate}:${rewritten ? 'prompt-rewrite' : 'prompt-correction'}:${attempt}`,
      inputPatch: {
        ...(input[originalField] ? {} : { [originalField]: originalPrompt }),
        ...(fallbackRung ? { fallbackRung } : {}),
      },
    };
  }

  await withTransaction(deps.pool, async (client) => {
    if (result.passStatus === 'PASS' || result.passStatus === 'GATED') {
      // GATED (motion gate skipped its VLM call) is a pass-through, not a
      // rejection — the image gate already caught what needed catching.
      await applyPass(client, write);
    } else if (rework) {
      await applyRework(client, write, rework);
    } else {
      await applyExhausted(client, write);
    }
  });

  log().info(
    { jobId: job.id, gate, verdict: result.passStatus, score: result.weightedScore, attempt },
    'quality: verdict recorded',
  );
}

/**
 * Runs until this step's gate queue is fully drained: no ungated completed
 * jobs AND nothing still planned/submitted (i.e. generation — including any
 * rework resubmission — is truly done). Called alongside runStep(), not
 * after it. No-ops (resolves immediately) when the step isn't gated.
 */
export async function gateStep(deps: QualityDeps, cohortId: string, step: CatalogEntry, _targetWorkers: number): Promise<void> {
  if (step.gate !== 'image' && step.gate !== 'motion') return;
  const gate = step.gate;

  if (deps.cfg.qualityGates === 'off') {
    log().info({ stepSeq: step.seq, gate }, 'quality: ORCH_QUALITY_GATES=off, account-wide kill switch — skipping');
  }

  await updateStepStatus(deps.pool, cohortId, step.seq, 'gating');
  log().info({ stepSeq: step.seq, gate }, 'quality: gating step');

  let warnedSampled = false;
  const evalFailures = new Map<number, number>();

  for (;;) {
    const ungated = await listUngated(deps.pool, cohortId, step.seq);
    for (const job of ungated) {
      const projectOption = deps.cfg.qualityGates === 'off' ? 'off' : await getQualityGatesOption(deps.pool, job.projectId);

      if (projectOption === 'off' || (projectOption === 'image-only' && gate === 'motion')) {
        await applySkipped(deps.pool, job.id);
        continue;
      }
      if (projectOption === 'sampled' && !warnedSampled) {
        warnedSampled = true;
        log().warn(
          { cohortId, stepSeq: step.seq },
          "quality: options.qualityGates='sampled' has no defined rate anywhere in the spec (§16 q5) — running as 'full' until one is decided",
        );
      }

      await gateOneJob(deps, cohortId, gate, job, evalFailures);
    }

    const [stillUngated, inFlight] = await Promise.all([
      countUngated(deps.pool, cohortId, step.seq),
      countInFlightForGatedStep(deps.pool, cohortId, step.seq),
    ]);
    if (stillUngated === 0 && inFlight === 0) break;

    await sleep(Math.min(5_000, deps.cfg.reconcileIntervalMs));
  }

  log().info({ stepSeq: step.seq, gate }, 'quality: gate queue drained');
}
