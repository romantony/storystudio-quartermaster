/**
 * Per-frame plan-time preparation (prompt harness plan §6.1-§6.2). Turns a
 * request frame (+ optional caller-supplied `shot`) into a validated
 * contract and a pair of guardrail-compiled prompts, deterministically
 * fixing what it can and falling back to the GPT-5 mini regenerate tool
 * only for what it can't.
 *
 * Deliberately simpler than the plan's literal "iteratively re-lint the
 * empty-string draft" description: most guardrail violations here are
 * either (a) purely a fact about the CONTRACT (facing/side/move/motion
 * level), fixed once by `normalizeContractForCompile` before anything is
 * compiled, or (b) purely a fact about compiled TEXT, which the compiler
 * (compile/image.ts, compile/motion.ts) never gets wrong by construction —
 * see __tests__/harness-compile.test.ts. The post-compile lint pass exists
 * as a regression net and to catch the few violations neither of those
 * covers (I-SUB-01's missing hand-authored detail, I-HAND-01's routing,
 * V-ACT-02's state change), which genuinely need the tool or a route hint.
 */
import { ShotContractSchema, primarySubject, withContract, type ShotContract } from './contract';
import { ALLOWED_FACING_FOR_DIRECTION, REQUIRED_SIDE_FOR_DIRECTION } from './direction-table';
import { applyEdit } from './correct/edits';
import { compileImagePrompt } from './compile/image';
import { compileMotionPrompt } from './compile/motion';
import { lintImage, type ImageLintContext } from './lint/image';
import { lintVideo, type VideoLintContext } from './lint/video';
import { loadActiveGuardrails, guardrailSetVersion } from './guardrails/store';
import type { Guardrail, Violation } from './guardrails/types';
import { extractContract } from './tool/extract';
import { regeneratePrompt } from './tool/regenerate';
import type { ReplicateDeps } from '../quality/replicate';
import { profileForRung, inferenceProfile, seedForAttempt } from './profiles';
import { insertFinding } from '../db/repo/harness';
import { log } from '../telemetry/log';
import type { Pool } from 'pg';

const DUMMY: Violation = { guardrailId: '', severity: 'fix', fixTarget: 'contract', message: '' };

function normalizeContractForCompile(contract: ShotContract, videoProfile: string): ShotContract {
  let c = contract;
  const bump = (name: string) => {
    const updated = applyEdit(name, c, DUMMY, videoProfile);
    if (updated) c = updated;
  };
  const primary = primarySubject(c);
  const dir = c.action.screenDirection;
  if (dir !== 'none') {
    const allowedFacing = ALLOWED_FACING_FOR_DIRECTION[dir];
    const reqSide = REQUIRED_SIDE_FOR_DIRECTION[dir];
    const needsAlign =
      (allowedFacing && (!primary?.facing || !allowedFacing.includes(primary.facing))) || (reqSide && c.camera.side !== reqSide);
    if (needsAlign) bump('align_facing');
  }
  bump('lead_room');
  bump('ground_secondary');
  bump('downgrade_move');
  bump('downgrade_motion_level');
  if (c.transformation === 'state_change') bump('continuation_beat');
  return c;
}

export interface PrepareFrameInput {
  frameId: string;
  /** Only used to derive the frame's seed (harness/profiles/inference.ts's
   * seedForAttempt) — omitted by callers that don't have it, which just
   * makes the seed a function of frameId alone. */
  projectId?: string;
  imagePrompt: string;
  motionPrompt?: string;
  narration?: string;
  referenceImage: boolean;
  aspectRatio?: string;
  fallbackRung?: string; // already-set rung (resumed/re-planned frame), if any
  shot?: unknown; // caller-supplied, unvalidated
  previousContract?: ShotContract;
}

export interface PrepareFrameOutput {
  contract: ShotContract;
  imagePrompt: string;
  motionPrompt: string;
  imageFallbackRung?: 'flux-4b';
  motionFallbackRung?: 'replicate-wan22-fast';
  splitShot: boolean;
  /** First-attempt sampler seed for this frame's video job, and the
   * inference profile it is meant to run under (harness/profiles/
   * inference.ts). Submitted only in 'enforce' mode — a seed changes the
   * sample, and 'lint' must not change what is generated. */
  seed: number;
  inferenceProfile: string;
  harnessVersion: string;
  harnessError?: string;
  findings: Array<{ domain: 'image' | 'video'; source: 'lint'; signature: string; guardrailId?: string; confidence: 'high' | 'low'; message: string }>;
}

export interface PrepareFrameDeps {
  replicate: ReplicateDeps;
  extractCfg: { model: string; reasoningEffort: string };
  regenerateCfg: { model: string; reasoningEffort: string };
  pool?: Pool; // omit for pure/dry-run use (CLI, tests) — skips DB-sourced learned guardrails
}

/** True when `contract`'s primary/action fields make the prompt harness's
 * downstream checks meaningful — a hand-typed `frames[].shot` is trusted
 * as-is; an extracted one still needs to satisfy the same schema. */
function violationToFindingSignature(domain: 'image' | 'video', v: Violation): string {
  return `${domain}.lint.${v.guardrailId || 'unknown'}`;
}

export async function prepareFrame(deps: PrepareFrameDeps, input: PrepareFrameInput): Promise<PrepareFrameOutput> {
  const imageGuardrails = await loadActiveGuardrails(deps.pool, 'image', 'any');
  const videoProfileName = profileForRung(input.fallbackRung);
  const videoGuardrails = await loadActiveGuardrails(deps.pool, 'video', videoProfileName);
  const harnessVersion = guardrailSetVersion([...imageGuardrails, ...videoGuardrails]);
  const seed = seedForAttempt(input.projectId ?? '', input.frameId, 0);
  const inferenceProfileId = inferenceProfile(videoProfileName).id;

  let contract: ShotContract | undefined;
  if (input.shot) {
    const parsed = ShotContractSchema.safeParse(input.shot);
    if (parsed.success) contract = parsed.data;
  }
  if (!contract) {
    contract = await extractContract(deps.replicate, deps.extractCfg, {
      frameId: input.frameId,
      imagePrompt: input.imagePrompt,
      motionPrompt: input.motionPrompt,
      narration: input.narration,
      referenceImage: input.referenceImage,
      previous: input.previousContract,
    });
  }

  if (!contract) {
    return {
      contract: undefined as unknown as ShotContract,
      imagePrompt: input.imagePrompt,
      motionPrompt: input.motionPrompt ?? '',
      splitShot: false,
      seed,
      inferenceProfile: inferenceProfileId,
      harnessVersion,
      harnessError: 'no contract (caller-supplied shot invalid and extraction failed) — falling back to original prompts',
      findings: [],
    };
  }

  const wasStateChange = contract.transformation === 'state_change';
  contract = normalizeContractForCompile(contract, videoProfileName);

  let imagePrompt = compileImagePrompt(contract, { aspectRatio: input.aspectRatio });
  let motionPrompt = compileMotionPrompt(contract);

  const findings: PrepareFrameOutput['findings'] = [];
  let imageFallbackRung: 'flux-4b' | undefined;
  let motionFallbackRung: 'replicate-wan22-fast' | undefined;

  const imageLint = lintImage({ contract, imagePrompt }, imageGuardrails);
  for (const v of imageLint.violations) {
    findings.push({ domain: 'image', source: 'lint', signature: violationToFindingSignature('image', v), guardrailId: v.guardrailId, confidence: 'high', message: v.message });
    const guardrail = imageGuardrails.find((g) => g.id === v.guardrailId);
    if (!guardrail) continue;
    if (guardrail.corrective.some((c) => c.type === 'route')) {
      imageFallbackRung = 'flux-4b';
    } else if (v.severity !== 'warn' && guardrail.corrective.some((c) => c.type === 'regenerate')) {
      const regen = await regeneratePrompt(deps.replicate, deps.regenerateCfg, {
        domain: 'image',
        targetProfile: input.referenceImage ? 'Qwen-Image-Edit (edits a character reference image)' : 'Qwen-Image (text-to-image)',
        contract,
        draft: imagePrompt,
        violations: [v],
        guardrails: imageGuardrails,
      });
      if (regen) imagePrompt = regen;
    }
  }

  const videoLint = lintVideo({ contract, motionPrompt, imagePrompt, profile: videoProfileName, previousInScene: input.previousContract }, videoGuardrails);
  for (const v of videoLint.violations) {
    findings.push({ domain: 'video', source: 'lint', signature: violationToFindingSignature('video', v), guardrailId: v.guardrailId, confidence: 'high', message: v.message });
    const guardrail = videoGuardrails.find((g) => g.id === v.guardrailId);
    if (!guardrail) continue;
    if (guardrail.corrective.some((c) => c.type === 'route') && v.severity !== 'warn') {
      motionFallbackRung = 'replicate-wan22-fast';
    } else if (v.severity !== 'warn' && guardrail.corrective.some((c) => c.type === 'regenerate')) {
      const regen = await regeneratePrompt(deps.replicate, deps.regenerateCfg, {
        domain: 'video',
        targetProfile: profileForRung(motionFallbackRung ?? input.fallbackRung),
        videoProfile: videoProfileName,
        contract,
        draft: motionPrompt,
        violations: [v],
        guardrails: videoGuardrails,
      });
      if (regen) motionPrompt = regen;
    }
  }

  return {
    contract,
    imagePrompt,
    motionPrompt,
    imageFallbackRung,
    motionFallbackRung,
    splitShot: wasStateChange,
    seed,
    // The rung lint just routed to, when it routed — so the recorded profile
    // matches the endpoint the frame will actually run on.
    inferenceProfile: motionFallbackRung ? inferenceProfile(profileForRung(motionFallbackRung)).id : inferenceProfileId,
    harnessVersion,
    findings,
  };
}

/** Writes plan-time lint findings for observability/promotion (plan §9.2).
 * Best-effort — a DB error here must never fail the frame's preparation. */
export async function recordPrepareFindings(
  pool: Pool,
  ctx: { cohortId: string; projectId: string; frameId: string },
  guardrailSet: string,
  output: PrepareFrameOutput,
): Promise<void> {
  try {
    for (const f of output.findings) {
      await insertFinding(pool, {
        cohortId: ctx.cohortId,
        projectId: ctx.projectId,
        frameId: ctx.frameId,
        domain: f.domain,
        profile: f.domain === 'video' ? profileForRung(output.motionFallbackRung) : 'any',
        source: 'lint',
        signature: f.signature,
        guardrailId: f.guardrailId,
        confidence: f.confidence,
        contract: output.contract,
        guardrailSet,
      });
    }
    if (output.harnessError) {
      await insertFinding(pool, {
        cohortId: ctx.cohortId,
        projectId: ctx.projectId,
        frameId: ctx.frameId,
        domain: 'image',
        profile: 'any',
        source: 'lint',
        signature: 'harness.prepare.error',
        confidence: 'low',
        evidence: { message: output.harnessError },
        guardrailSet,
      });
    }
  } catch (err) {
    log().warn({ err, frameId: ctx.frameId }, 'harness: failed to record plan-time findings (non-fatal)');
  }
}
