/**
 * Shared corrective-ladder engine (prompt harness plan §7.6). Given a
 * finding SIGNATURE (already classified by learn/signatures.ts from a VLM
 * issue, optionally sharpened by the deterministic motion probe), looks up
 * the guardrail whose corrective list handles it and applies the first
 * measure not already tried on this job — a contract edit + recompile, a
 * model-switch route, the GPT-5 mini regenerate tool, or (every measure
 * exhausted) a plain reseed, which is what the 2026-08-14 sampling-variance
 * finding (qm-video-conformity-prompt-testing) says is actually worth
 * trying first for a camera move that simply didn't execute.
 *
 * correct/image-ladder.ts and correct/video-ladder.ts are thin,
 * domain-specific wrappers around this engine (compiler + guardrail domain
 * differ; the fix-selection logic does not).
 *
 * Scope note: a video finding whose guardrail's `fixTarget` is
 * `'image_prompt'` (V-CAM-03, V-DIR-02) still gets its contract edited and
 * ITS OWN (motion) prompt recompiled from the corrected contract — the
 * cross-step reopen of the SIBLING image job that the implementation plan
 * describes is not wired in this build (it would touch
 * `jobs.deps_remaining` bookkeeping the generator's dependency graph relies
 * on — see agents/generator.ts's resolveDeps() and 005_invariants.sql).
 * The finding is still recorded with `crossDomainFixDeferred: true` in its
 * evidence so promotion/operators can see how often this actually matters.
 */
import { compileImagePrompt } from '../compile/image';
import { compileMotionPrompt } from '../compile/motion';
import { withContract, type ShotContract } from '../contract';
import { applyEdit } from './edits';
import type { CorrectiveMeasure, Domain, Guardrail, Violation } from '../guardrails/types';
import type { ReplicateDeps } from '../../quality/replicate';
import { regeneratePrompt } from '../tool/regenerate';
import { signatureToGuardrailId } from '../learn/signatures';
import { log } from '../../telemetry/log';

export interface LadderContext {
  domain: Domain;
  profile: string; // capability profile ('wan2-lightning' | 'replicate-wan22-fast') or 'any' for image
  contract: ShotContract;
  currentPrompt: string;
  signature: string;
  guardrails: Guardrail[];
  regenerateDeps: ReplicateDeps;
  regenerateCfg: { model: string; reasoningEffort: string };
  targetModelLabel: string;
  imageUrl?: string;
  aspectRatio?: string;
  examples?: Array<{ before: string; after: string }>;
  /** Measure keys already tried for THIS job (reuses jobs.tried_rungs, same
   * text[] column applyRework already appends to). */
  triedMeasures: string[];
}

export interface LadderOutcome {
  contract: ShotContract;
  prompt: string;
  /** `${measure.type}:${edit-or-route-name}` — also used as the rungLabel
   * appended to jobs.tried_rungs, so the next rework knows what's been tried. */
  measure: string;
  route?: string;
  guardrailId?: string;
  crossDomainFixDeferred?: boolean;
}

function measureKey(measure: CorrectiveMeasure): string {
  if (measure.type === 'contract_edit') return `contract_edit:${measure.edit}`;
  if (measure.type === 'route') return `route:${measure.to}`;
  if (measure.type === 'regenerate') return 'regenerate';
  if (measure.type === 'reseed') return 'reseed';
  return 'split_shot';
}

function compile(domain: Domain, contract: ShotContract, aspectRatio?: string): string {
  return domain === 'image' ? compileImagePrompt(contract, { aspectRatio }) : compileMotionPrompt(contract);
}

export async function runLadder(ctx: LadderContext): Promise<LadderOutcome> {
  const guardrailId = signatureToGuardrailId(ctx.domain, ctx.signature);
  const guardrail = ctx.guardrails.find((g) => g.id === guardrailId);

  if (!guardrail) {
    // Uncovered signature — try the regenerate tool with a generic
    // instruction built from the signature itself; this is also exactly
    // the input the promotion job (learn/promote.ts) later reads to decide
    // whether a new guardrail is warranted.
    const regen = await regeneratePrompt(ctx.regenerateDeps, ctx.regenerateCfg, {
      domain: ctx.domain,
      targetProfile: ctx.targetModelLabel,
      videoProfile: ctx.profile,
      contract: ctx.contract,
      draft: ctx.currentPrompt,
      violations: [{ guardrailId: 'uncovered', severity: 'fix', fixTarget: 'contract', message: `unclassified failure: ${ctx.signature}` }],
      guardrails: ctx.guardrails,
      imageUrl: ctx.imageUrl,
      examples: ctx.examples,
    });
    return regen
      ? { contract: ctx.contract, prompt: regen, measure: 'regenerate:uncovered' }
      : { contract: ctx.contract, prompt: ctx.currentPrompt, measure: 'reseed:uncovered' };
  }

  const dummyViolation: Violation = { guardrailId: guardrail.id, severity: guardrail.severity, fixTarget: guardrail.fixTarget, message: guardrail.instruction };

  for (const measure of guardrail.corrective) {
    const key = measureKey(measure);
    if (ctx.triedMeasures.includes(key)) continue;

    if (measure.type === 'contract_edit') {
      const updated = applyEdit(measure.edit, ctx.contract, dummyViolation, ctx.profile);
      if (!updated) continue; // not applicable here — try the next measure
      const crossDomain = guardrail.fixTarget === 'image_prompt' && ctx.domain === 'video';
      if (crossDomain) {
        log().warn(
          { guardrailId: guardrail.id, signature: ctx.signature },
          'harness: fix targets the image prompt but the cross-step re-image is not wired — applying to this contract/prompt only',
        );
      }
      return {
        contract: updated,
        prompt: compile(ctx.domain, updated, ctx.aspectRatio),
        measure: key,
        guardrailId: guardrail.id,
        crossDomainFixDeferred: crossDomain,
      };
    }

    if (measure.type === 'route') {
      return { contract: ctx.contract, prompt: ctx.currentPrompt, measure: key, route: measure.to, guardrailId: guardrail.id };
    }

    if (measure.type === 'regenerate') {
      const regen = await regeneratePrompt(ctx.regenerateDeps, ctx.regenerateCfg, {
        domain: ctx.domain,
        targetProfile: ctx.targetModelLabel,
        videoProfile: ctx.profile,
        contract: ctx.contract,
        draft: ctx.currentPrompt,
        violations: [dummyViolation],
        guardrails: ctx.guardrails,
        imageUrl: ctx.imageUrl,
        examples: ctx.examples,
      });
      if (regen) return { contract: ctx.contract, prompt: regen, measure: key, guardrailId: guardrail.id };
      continue;
    }

    if (measure.type === 'reseed') {
      return { contract: ctx.contract, prompt: ctx.currentPrompt, measure: key, guardrailId: guardrail.id };
    }

    if (measure.type === 'split_shot') {
      const flagged = withContract(ctx.contract, () => undefined);
      return { contract: flagged, prompt: ctx.currentPrompt, measure: key, guardrailId: guardrail.id };
    }
  }

  // Every corrective for this guardrail already tried this job — reseed as
  // the last resort (sampling variance can still fix it; see
  // qm-video-conformity-prompt-testing's 2026-08-14 finding).
  return { contract: ctx.contract, prompt: ctx.currentPrompt, measure: 'reseed:exhausted', guardrailId: guardrail.id };
}
