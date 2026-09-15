/**
 * Bridges the prompt harness's guardrail-driven corrective ladder into
 * agents/quality.ts's existing rework mechanism (prompt harness plan §7.6,
 * §9.2). Active only for a frame whose job carries `input.contract` — i.e.
 * one the harness actually prepared (harness/prepare.ts, plan-time). A job
 * with no contract (harness was off, or extraction failed for that frame)
 * takes quality.ts's original quality/rewrite.ts path unchanged, so every
 * existing rework test keeps exercising exactly the behavior it always has.
 *
 * Deliberately does NOT reopen the sibling image job when a video finding's
 * fix targets the image prompt (V-CAM-03/V-DIR-02) — see
 * correct/ladder.ts's header comment for why that cross-step write is
 * scoped out of this build.
 */
import type { Pool } from 'pg';
import type { GateResult, VideoGateResult } from '../quality/rubric';
import type { ReplicateDeps } from '../quality/replicate';
import type { FrameJobInput } from '../steps/builders/types';
import { loadActiveGuardrails, guardrailSetVersion } from './guardrails/store';
import { profileForRung } from './profiles';
import { classifyImageSignature, classifyVideoSignature, signatureToGuardrailId } from './learn/signatures';
import { runImageLadder } from './correct/image-ladder';
import { runVideoLadder } from './correct/video-ladder';
import {
  insertFinding,
  insertCorrection,
  resolveCorrection,
  latestPendingCorrectionForJob,
  approvedExamplesForSignature,
} from '../db/repo/harness';
import { log } from '../telemetry/log';

export interface HarnessGateInput {
  pool: Pool;
  replicate: ReplicateDeps;
  regenerateCfg: { model: string; reasoningEffort: string };
  cohortId: string;
  gate: 'image' | 'motion';
  jobId: number;
  projectId: string;
  frameId: string | null;
  attempt: number;
  triedRungs: string[];
  input: FrameJobInput;
  result: GateResult | VideoGateResult;
  assetUrl: string | null;
  /** Same condition as quality.ts's own `reworking` — attempts remain. */
  canRework: boolean;
  maxAttemptsReached: boolean;
  targetModelLabel: string;
}

export interface HarnessGateOutcome {
  rework?: {
    promptField: 'imagePrompt' | 'motionPrompt';
    correctedPrompt: string;
    rungLabel: string;
    inputPatch: Record<string, unknown>;
  };
}

/**
 * Runs once per gated verdict for a harness-prepared job. Resolves the
 * PREVIOUS rework's correction outcome (if any) against this verdict,
 * records a finding for a non-PASS verdict, and — while reworking — asks
 * the corrective ladder for the next measure. Any internal failure (DB
 * error, tool outage) is swallowed and logged: a harness bookkeeping
 * failure must never block quality.ts's own PASS/REWORK/FAIL decision,
 * only degrade to "no rework produced", which quality.ts's caller already
 * handles by falling to applyExhausted.
 */
export async function harnessGateOneJob(ctx: HarnessGateInput): Promise<HarnessGateOutcome> {
  const contract = ctx.input.contract;
  if (!contract) return {};

  const domain = ctx.gate === 'image' ? ('image' as const) : ('video' as const);
  const profile = domain === 'video' ? profileForRung(ctx.input.fallbackRung) : 'any';

  try {
    const guardrails = await loadActiveGuardrails(ctx.pool, domain, profile);
    const guardrailSet = guardrailSetVersion(guardrails);

    const pending = await latestPendingCorrectionForJob(ctx.pool, ctx.jobId);
    if (pending) {
      const outcome = ctx.result.passStatus === 'PASS' ? 'passed' : ctx.maxAttemptsReached ? 'accepted_flagged' : 'failed';
      await resolveCorrection(ctx.pool, pending.id, outcome, { attempt: ctx.attempt, score: ctx.result.weightedScore ?? undefined });
    }

    if (ctx.result.passStatus === 'PASS' || ctx.result.passStatus === 'GATED') return {};

    const issue = ctx.result.issues[0];
    const signature = issue
      ? domain === 'image'
        ? classifyImageSignature(issue)
        : classifyVideoSignature(issue)
      : `${domain}.uncovered.no_issues`;
    const guardrailId = signatureToGuardrailId(domain, signature);

    const findingId = await insertFinding(ctx.pool, {
      cohortId: ctx.cohortId,
      projectId: ctx.projectId,
      frameId: ctx.frameId ?? undefined,
      jobId: ctx.jobId,
      domain,
      profile,
      source: ctx.gate === 'image' ? 'image_gate' : 'motion_gate',
      signature,
      guardrailId,
      contract,
      evidence: { issue, summary: ctx.result.summary },
      assetUrl: ctx.assetUrl ?? undefined,
      guardrailSet,
    });

    if (!ctx.canRework) return {};

    const promptField = ctx.gate === 'image' ? ('imagePrompt' as const) : ('motionPrompt' as const);
    const currentPrompt = (ctx.gate === 'image' ? ctx.input.imagePrompt : ctx.input.motionPrompt) ?? '';
    const examples = await approvedExamplesForSignature(ctx.pool, signature);
    const runLadder = ctx.gate === 'image' ? runImageLadder : runVideoLadder;

    const outcome = await runLadder({
      profile,
      contract,
      currentPrompt,
      signature,
      guardrails,
      regenerateDeps: ctx.replicate,
      regenerateCfg: ctx.regenerateCfg,
      targetModelLabel: ctx.targetModelLabel,
      imageUrl: ctx.assetUrl ?? undefined,
      aspectRatio: ctx.input.aspectRatio,
      examples,
      triedMeasures: ctx.triedRungs,
    });

    await insertCorrection(ctx.pool, {
      findingId,
      measure: { type: outcome.measure, guardrailId: outcome.guardrailId, route: outcome.route },
      promptBefore: currentPrompt,
      promptAfter: outcome.prompt,
      contractBefore: contract,
      contractAfter: outcome.contract,
    });

    const inputPatch: Record<string, unknown> = { contract: outcome.contract, harnessVersion: guardrailSet };
    if (outcome.route) inputPatch.fallbackRung = outcome.route;

    return {
      rework: {
        promptField,
        correctedPrompt: outcome.prompt,
        rungLabel: `${ctx.gate}:harness:${outcome.measure}:${ctx.attempt}`,
        inputPatch,
      },
    };
  } catch (err) {
    log().error({ jobId: ctx.jobId, gate: ctx.gate, err }, 'harness: gate bridge failed — falling through to exhausted/no-rework');
    return {};
  }
}
