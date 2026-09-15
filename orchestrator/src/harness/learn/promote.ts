/**
 * Guardrail promotion (prompt harness plan §9.3). Run periodically
 * (`npm run harness:promote`, or wire into a cron once this proves out —
 * not done in this build, see docs/TODO.md) against the
 * `harness_findings`/`harness_corrections` history:
 *
 *   1. A recurring UNCOVERED signature (no guardrail_id, >= minCount
 *      occurrences across >= 2 projects) becomes a `proposed` guardrail —
 *      title/instruction only, built from a fixed template per signature
 *      prefix (video.* / image.*), never free-form LLM text. An operator
 *      reviews and activates it via `POST /v1/harness/guardrails/:id/:v/activate`
 *      (plan §9.4 — block/fix rules are never auto-activated).
 *   2. Every existing guardrail's corrective outcomes are summarized so an
 *      operator can see which measure actually works for it — reordering
 *      the `corrective` array itself is a deliberate, reviewed edit to the
 *      seed file (harness/guardrails/seed/*.ts) in this build, not an
 *      automatic DB write; see the plan's §9.4 activation-gate rationale.
 *
 * This is intentionally the MVP version of §9.3 — no replay-before-activate
 * (§9.4) is implemented yet; a proposed guardrail's `replay` column stays
 * null until that lands.
 */
import type { Pool } from 'pg';
import { uncoveredSignatures, correctionOutcomeStats, upsertGuardrail, type SignatureCount, type CorrectionOutcomeStats } from '../../db/repo/harness';
import type { Guardrail } from '../guardrails/types';
import { log } from '../../telemetry/log';

const TITLE_TEMPLATES: Record<string, string> = {
  'video.uncovered': 'Recurring uncovered video failure',
  'image.uncovered': 'Recurring uncovered image failure',
};

function proposalFromSignature(sig: SignatureCount): Guardrail {
  const domain = sig.domain;
  const idBase = sig.signature.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
  return {
    id: `${domain === 'video' ? 'V' : 'I'}-AUTO-${idBase}`.slice(0, 60),
    domain,
    profile: domain === 'video' ? 'wan2-lightning' : 'any',
    version: 1,
    status: 'proposed',
    severity: 'warn', // never auto-propose block/fix — an operator upgrades severity on review, plan §9.4
    title: TITLE_TEMPLATES[sig.signature.split('.').slice(0, 2).join('.')] ?? `Recurring failure: ${sig.signature}`,
    detector: { type: 'contract', check: 'noInventedNouns' }, // placeholder — a proposal has no working detector until an operator writes one
    fixTarget: 'contract',
    corrective: [{ type: 'regenerate', instruction: `Address the recurring "${sig.signature}" failure pattern.` }],
    instruction: `Signature "${sig.signature}" recurred ${sig.count} times across ${sig.projects} projects with no covering guardrail — review and refine before activating.`,
    evidence: [`${sig.count} findings, ${sig.projects} projects, signature=${sig.signature}`],
  };
}

export interface PromotionReport {
  proposed: Guardrail[];
  correctionStats: CorrectionOutcomeStats[];
}

export async function runPromotion(pool: Pool, opts: { sinceDays?: number; minCount?: number } = {}): Promise<PromotionReport> {
  const sigs = await uncoveredSignatures(pool, opts.sinceDays ?? 14, opts.minCount ?? 3);
  const proposed: Guardrail[] = [];
  for (const sig of sigs) {
    const guardrail = proposalFromSignature(sig);
    try {
      await upsertGuardrail(pool, guardrail);
      proposed.push(guardrail);
    } catch (err) {
      log().error({ err, signature: sig.signature }, 'harness: failed to write proposed guardrail');
    }
  }
  const correctionStats = await correctionOutcomeStats(pool, opts.sinceDays ?? 30);
  return { proposed, correctionStats };
}
