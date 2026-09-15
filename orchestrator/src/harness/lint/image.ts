/**
 * Image guardrail detectors + lint runner (prompt harness plan §5.1, §6.2).
 * Each function here is a named `detector.check` target from
 * guardrails/seed/image.ts — a promoted/learned guardrail can only
 * reference an EXISTING function here, never inject new logic.
 */
import { primarySubject, secondarySubjects, type ShotContract } from '../contract';
import type { Guardrail, LintResult, Violation } from '../guardrails/types';
import { lexiconMatch } from './lexicons';
import { newWords } from './nouns';
import { countStated, wordCount } from './util';

export interface ImageLintContext {
  contract: ShotContract;
  imagePrompt: string;
  /** Present only when validating a regenerate-tool candidate output
   * against the template draft it started from (tool/regenerate.ts §8.3). */
  draft?: string;
}

type CheckResult = { message: string; detail?: Record<string, unknown> } | null;
type CheckFn = (ctx: ImageLintContext) => CheckResult;

const PUBLIC_PLACE = /\b(street|platform|corridor|hallway|station|subway|plaza|sidewalk|square|alley|lobby|stairwell)\b/i;
const REFLECTIVE_SURFACE = /\b(wall|mirror|window|glass)\b/i;
const CLOSE_SHOT = new Set(['extreme_close_up', 'close_up', 'medium_close_up']);

export const IMAGE_DETECTORS: Record<string, CheckFn> = {
  countsExplicit(ctx) {
    const uncounted = ctx.contract.subjects.filter((s) => s.count > 1 && !countStated(ctx.imagePrompt, s.count));
    if (uncounted.length === 0) return null;
    return {
      message: `prompt does not state the count for: ${uncounted.map((s) => `${s.id} (${s.count})`).join(', ')}`,
      detail: { subjects: uncounted.map((s) => s.id) },
    };
  },

  singleCharacterAlone(ctx) {
    const characters = ctx.contract.subjects.filter((s) => s.kind === 'character');
    if (characters.length !== 1) return null;
    if (countStated(ctx.imagePrompt, 1) || /\balone in frame\b/i.test(ctx.imagePrompt)) return null;
    return { message: 'single-character shot does not state "one [character], alone in frame"' };
  },

  secondarySubjectsGrounded(ctx) {
    const ungrounded = secondarySubjects(ctx.contract).filter((s) => !s.detail || !s.position);
    if (ungrounded.length === 0) return null;
    return {
      message: `secondary subject(s) missing appearance/position grounding: ${ungrounded.map((s) => s.id).join(', ')}`,
      detail: { subjects: ungrounded.map((s) => s.id) },
    };
  },

  handContactRisk(ctx) {
    const risky = ctx.contract.subjects.find((s) => s.handContact && CLOSE_SHOT.has(ctx.contract.camera.shotSize));
    if (!risky) return null;
    return { message: `hand contact ("${risky.id}") at ${ctx.contract.camera.shotSize} — known Qwen duplicate-hand failure mode`, detail: { subjectId: risky.id } };
  },

  facingConsistentWithAction(ctx) {
    const primary = primarySubject(ctx.contract);
    if (!primary?.facing) return { message: 'primary subject has no stated facing' };
    return null; // cross-checked against action/camera by directionConsistent (video side) — image-side only requires it be present
  },

  shotSizeAngleAtStart(ctx) {
    const size = ctx.contract.camera.shotSize.replace(/_/g, '-');
    const angle = ctx.contract.camera.angle.replace(/_/g, '-');
    const head = ctx.imagePrompt.slice(0, 60).toLowerCase();
    if (head.includes(size.split('-')[0]) || head.includes(angle.split('-')[0])) return null;
    return { message: `prompt does not lead with shot size/angle ("${size}", "${angle}")` };
  },

  cameraSideExplicitWhenNeeded(ctx) {
    const needsSide = ctx.contract.action.screenDirection !== 'none';
    if (!needsSide) return null;
    const sideWords: Record<string, RegExp> = {
      front: /\bfacing (the )?camera|front(al)? view\b/i,
      back: /\bfrom behind|back to the camera|seen from behind\b/i,
      left_profile: /\bleft profile|facing screen-left\b/i,
      right_profile: /\bright profile|facing screen-right\b/i,
    };
    const re = sideWords[ctx.contract.camera.side];
    if (re && re.test(ctx.imagePrompt)) return null;
    return { message: `prompt does not state camera side ("${ctx.contract.camera.side}") explicitly` };
  },

  populationDeclaredInPublicPlace(ctx) {
    if (!PUBLIC_PLACE.test(ctx.contract.setting.place)) return null;
    if (ctx.contract.setting.population !== 'empty') return null;
    if (/\bempty\b|\bonly person\b|\balone\b/i.test(ctx.imagePrompt)) return null;
    return { message: `public setting "${ctx.contract.setting.place}" does not declare population` };
  },

  leadRoomOk(ctx) {
    const primary = primarySubject(ctx.contract);
    if (!primary) return null;
    const dir = ctx.contract.action.screenDirection;
    if (dir === 'screen_left' && primary.position !== 'right_third' && primary.position !== 'center') {
      return { message: 'no lead room: subject moves screen-left but is not placed right-of-center' };
    }
    if (dir === 'screen_right' && primary.position !== 'left_third' && primary.position !== 'center') {
      return { message: 'no lead room: subject moves screen-right but is not placed left-of-center' };
    }
    return null;
  },

  closeFacingReflectiveSurface(ctx) {
    const primary = primarySubject(ctx.contract);
    if (!primary) return null;
    const closeUp = CLOSE_SHOT.has(ctx.contract.camera.shotSize) || ctx.contract.camera.shotSize === 'medium';
    if (closeUp && primary.facing === 'camera' && REFLECTIVE_SURFACE.test(ctx.contract.setting.place)) {
      return { message: 'character close to and facing a reflective surface — prefer three-quarter facing' };
    }
    return null;
  },

  referenceAnchorOnce(ctx) {
    const hasRef = ctx.contract.subjects.some((s) => s.ref === 'reference_image');
    if (!hasRef) return null;
    const matches = ctx.imagePrompt.match(/from the reference image/gi) ?? [];
    if (matches.length === 1) return null;
    return { message: `reference-image anchor appears ${matches.length} times, expected exactly 1` };
  },

  imageLengthOk(ctx) {
    const words = wordCount(ctx.imagePrompt);
    if (words <= 110) return null;
    return { message: `prompt is ${words} words, cap is 110` };
  },

  noInventedNouns(ctx) {
    if (ctx.draft === undefined) return null; // only meaningful for tool-output validation
    const invented = newWords(ctx.imagePrompt, ctx.draft, ctx.contract);
    if (invented.length === 0) return null;
    return { message: `candidate adds words not in the contract or draft: ${invented.slice(0, 8).join(', ')}`, detail: { words: invented } };
  },
};

export function lintImage(ctx: ImageLintContext, guardrails: Guardrail[]): LintResult {
  const violations: Violation[] = [];
  for (const g of guardrails) {
    if (g.domain !== 'image') continue;
    let hit: CheckResult = null;
    if (g.detector.type === 'contract') {
      const fn = IMAGE_DETECTORS[g.detector.check];
      hit = fn ? fn(ctx) : { message: `unknown image detector "${g.detector.check}"` };
    } else if (g.detector.type === 'lexicon') {
      const field = g.detector.field === 'motionPrompt' ? undefined : ctx.imagePrompt;
      if (field !== undefined) {
        const m = lexiconMatch(field, g.detector.list);
        if (m) hit = { message: `matched lexicon "${g.detector.list}": "${m[0]}"` };
      }
    } else if (g.detector.type === 'regex') {
      const field = g.detector.field === 'motionPrompt' ? undefined : ctx.imagePrompt;
      if (field !== undefined) {
        const re = new RegExp(g.detector.pattern, g.detector.flags);
        if (re.test(field)) hit = { message: `matched pattern "${g.detector.pattern}"` };
      }
    }
    if (hit) violations.push({ guardrailId: g.id, severity: g.severity, fixTarget: g.fixTarget, message: hit.message, detail: hit.detail });
  }
  return { violations, blocking: violations.some((v) => v.severity === 'block') };
}
