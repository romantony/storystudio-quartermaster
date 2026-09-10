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
import type { FrameJobInput } from '../steps/builders/types';
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

async function gateOneJob(deps: QualityDeps, cohortId: string, gate: 'image' | 'motion', job: UngatedJob): Promise<void> {
  const input = job.input as FrameJobInput;
  const assetUrl = runpodOutUrl(job.output) ?? null;

  let result: GateResult;
  if (gate === 'image') {
    try {
      result = await evaluateImage(deps, job);
    } catch (err) {
      // Infra failure (Replicate timeout, both models down) — NOT a content
      // verdict. Must not consume a rework attempt; log and retry next tick.
      log().warn({ jobId: job.id, gate, err }, 'quality: evaluation call failed, will retry next tick');
      return;
    }
  } else {
    const imageScore = await latestImageScoreForFrame(deps.pool, cohortId, job.frameId ?? '');
    if (imageScore == null) {
      log().warn({ jobId: job.id, frameId: job.frameId }, 'quality: motion gate has no image score for this frame yet, will retry next tick');
      return;
    }
    try {
      result = await evaluateVideo(deps, job, imageScore);
    } catch (err) {
      log().warn({ jobId: job.id, gate, err }, 'quality: evaluation call failed, will retry next tick');
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

  await withTransaction(deps.pool, async (client) => {
    if (result.passStatus === 'PASS' || result.passStatus === 'GATED') {
      // GATED (motion gate skipped its VLM call) is a pass-through, not a
      // rejection — the image gate already caught what needed catching.
      await applyPass(client, write);
    } else if (job.qualityAttempts < deps.cfg.maxAttempts) {
      await applyRework(client, write, {
        promptField,
        correctedPrompt: correctedPrompt(originalPrompt, issueSummary),
        rungLabel: `${gate}:prompt-correction:${attempt}`,
      });
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

      await gateOneJob(deps, cohortId, gate, job);
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
