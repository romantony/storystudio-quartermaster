/**
 * Video guardrail detectors + lint runner (prompt harness plan §5.2, §6.2,
 * §7.2). Profile-aware: `moveAllowedForProfile`/`motionLevelAllowed` check
 * against the capability table for `ctx.profile` (harness/profiles), not a
 * fixed constant — the same guardrail row is reused for wan2-lightning and
 * replicate-wan22-fast (guardrails/store.ts clones the seed set).
 */
import { primarySubject, type CameraMove, type ScreenDir, type ShotContract } from '../contract';
import { ALLOWED_FACING_FOR_DIRECTION, REQUIRED_SIDE_FOR_DIRECTION } from '../direction-table';
import type { Guardrail, LintResult, Violation } from '../guardrails/types';
import { moveCapability, videoProfile } from '../profiles';
import { lexiconMatch } from './lexicons';
import { newWords } from './nouns';
import { wordCount } from './util';

export interface VideoLintContext {
  contract: ShotContract;
  motionPrompt: string;
  imagePrompt: string; // for V-HAL-01's subject-in-image check
  profile: string; // 'wan2-lightning' | 'replicate-wan22-fast'
  /** The previous frame's contract in the same scene, for V-DIR-04. */
  previousInScene?: ShotContract;
  draft?: string;
}

type CheckResult = { message: string; detail?: Record<string, unknown> } | null;
type CheckFn = (ctx: VideoLintContext) => CheckResult;

const MOVE_WORDS: Record<CameraMove, RegExp> = {
  static: /\bstatic camera|fixed camera\b/i,
  push_in: /\bpush(es|ing)? in\b/i,
  pull_out: /\bpulls? out\b/i,
  zoom_in: /\bzooms? in\b/i,
  zoom_out: /\bzooms? out\b/i,
  pan_left: /\bpans? left\b/i,
  pan_right: /\bpans? right\b/i,
  truck_left: /\btrucks? left\b/i,
  truck_right: /\btrucks? right\b/i,
  tilt_up: /\btilts? up\b/i,
  tilt_down: /\btilts? down\b/i,
  pedestal_up: /\bpedestal(s)? up|crane(s)? up\b/i,
  pedestal_down: /\bpedestal(s)? down|crane(s)? down\b/i,
  arc: /\barcs?( around| shot)?|orbit(s|ing)?\b/i,
  tracking: /\btracking shot|tracks? (her|him|them)\b/i,
  handheld: /\bhandheld\b/i,
};
const ALL_MOVE_RE = new RegExp(Object.values(MOVE_WORDS).map((r) => r.source).join('|'), 'gi');

const SCREEN_DIR_WORDS: Record<ScreenDir, RegExp> = {
  toward_camera: /\btoward(s)? the camera\b/i,
  away_from_camera: /\baway from the camera\b/i,
  screen_left: /\bscreen-left\b/i,
  screen_right: /\bscreen-right\b/i,
  up: /\bupward|climbs? up\b/i,
  down: /\bdownward|descends?\b/i,
  none: /$^/,
};

const HIGH_VERBS = /\b(sprint(s|ing)?|lunge(s|d)?|leap(s|ing)?|dash(es|ing)?)\b/i;
const PUBLIC_OR_SPARSE = /\b(street|platform|corridor|hallway|station|subway|plaza|alley|lobby|stairwell)\b/i;
const EXPOSING_MOVE = new Set<CameraMove>(['pan_left', 'pan_right', 'truck_left', 'truck_right', 'pull_out']);

export const VIDEO_DETECTORS: Record<string, CheckFn> = {
  oneMoveStated(ctx) {
    const matches = ctx.motionPrompt.match(ALL_MOVE_RE) ?? [];
    if (matches.length <= 1) return null;
    return { message: `more than one camera move named in the prompt: ${matches.join(', ')}`, detail: { matches } };
  },

  moveAllowedForProfile(ctx) {
    // Fires for BOTH 'probation' and 'banned' — `essential` doesn't suppress
    // the finding, it only changes which corrective the ladder tries first
    // (correct/edits.ts's downgrade_move declines when essential, so
    // correct/ladder.ts falls through to the guardrail's `route` measure
    // instead). See the implementation plan §7.1/§7.6.
    const cap = moveCapability(videoProfile(ctx.profile), ctx.contract.camera.move);
    if (cap.status === 'allowed') return null;
    return {
      message: `camera move "${ctx.contract.camera.move}" is ${cap.status} on profile "${ctx.profile}"`,
      detail: { move: ctx.contract.camera.move, status: cap.status, downgradeTo: cap.downgradeTo, essential: ctx.contract.camera.essential },
    };
  },

  cameraLockedToImage(ctx) {
    // The image's own contract IS this contract (image and video share one
    // ShotContract per frame — see harness/index.ts). If a caller-authored
    // motion prompt claims a different side/angle than the contract states,
    // that's the mismatch this rule exists to catch.
    const impliesSideChange = /\bfrom (the )?(front|behind|the side)\b|\bcamera (moves|swings) to\b/i.test(ctx.motionPrompt);
    if (!impliesSideChange) return null;
    return { message: 'motion prompt implies a camera-side change mid-clip, which a single source frame cannot do' };
  },

  speedIsSlowOrMedium(ctx) {
    if (/\b(fast|rapid|whip|quick(ly)?|sudden(ly)?)\b/i.test(ctx.motionPrompt)) {
      return { message: 'motion prompt uses a fast/rapid/whip speed word — Lightning has no real CFG to hold it together' };
    }
    return null;
  },

  directionInScreenSpace(ctx) {
    if (lexiconMatch(ctx.motionPrompt, 'relativeDirection')) {
      return { message: 'direction expressed in relative terms, not screen space' };
    }
    return null;
  },

  directionConsistent(ctx) {
    const primary = primarySubject(ctx.contract);
    const dir = ctx.contract.action.screenDirection;
    if (dir === 'none' || !primary?.facing) return null;
    const allowedFacings = ALLOWED_FACING_FOR_DIRECTION[dir];
    if (allowedFacings && !allowedFacings.includes(primary.facing)) {
      return {
        message: `screenDirection "${dir}" is inconsistent with facing "${primary.facing}"`,
        detail: { screenDirection: dir, facing: primary.facing },
      };
    }
    const side = REQUIRED_SIDE_FOR_DIRECTION[dir];
    if (side && ctx.contract.camera.side !== side) {
      return { message: `screenDirection "${dir}" expects camera.side "${side}", got "${ctx.contract.camera.side}"` };
    }
    return null;
  },

  lockClausePresent(ctx) {
    if (/\b(keeps?|stays?)\s+(facing|her back|his back)\b/i.test(ctx.motionPrompt) && /\bcamera stays\b/i.test(ctx.motionPrompt)) return null;
    return { message: 'motion prompt has no direction/angle lock clause at the end' };
  },

  oneActionStated(ctx) {
    // Heuristic: more than one finite verb clause joined by "and"/"then" for
    // the primary subject beyond the one contract action + ambient list.
    const clauses = ctx.motionPrompt.split(/\band then\b|\bthen\b/i);
    if (clauses.length > 2) return { message: 'more than one sequential action clause ("then") in the motion prompt' };
    return null;
  },

  noStateChange(ctx) {
    if (ctx.contract.transformation !== 'state_change') return null;
    return { message: 'contract marks this shot as a state change (appear/vanish/transform) — not renderable as one continuous clip' };
  },

  motionLevelAllowed(ctx) {
    const max = videoProfile(ctx.profile).maxMotionLevel;
    const order = { low: 0, medium: 1, high: 2 } as const;
    if (order[ctx.contract.action.motionLevel] <= order[max]) return null;
    return { message: `motionLevel "${ctx.contract.action.motionLevel}" exceeds profile "${ctx.profile}" max "${max}"` };
  },

  noHallucinatedSubjects(ctx) {
    const imageSubjectIds = new Set(ctx.contract.subjects.map((s) => s.id));
    // Look for capitalized/named references in the motion prompt that don't
    // correspond to a contract subject id or a generic pronoun/ambient word.
    const stray = ctx.contract.action.ambient.filter((a) => /\b(person|man|woman|figure|stranger|someone)\b/i.test(a));
    if (stray.length > 0 || ![...imageSubjectIds].includes(ctx.contract.action.subjectId)) {
      return { message: 'motion prompt references a subject not present in the image contract' };
    }
    return null;
  },

  populationHallucinationGuard(ctx) {
    if (ctx.contract.setting.population === 'crowd') return null;
    if (!EXPOSING_MOVE.has(ctx.contract.camera.move)) return null;
    if (/\bonly person\b|\balone\b/i.test(ctx.motionPrompt)) return null;
    return { message: `move "${ctx.contract.camera.move}" exposes frame edges in a ${ctx.contract.setting.population} setting without an only-person clause` };
  },

  motionLengthOk(ctx) {
    const words = wordCount(ctx.motionPrompt);
    if (words >= 12 && words <= 45) return null;
    return { message: `motion prompt is ${words} words, expected 12-45` };
  },

  noInventedNouns(ctx) {
    if (ctx.draft === undefined) return null;
    const invented = newWords(ctx.motionPrompt, ctx.draft, ctx.contract);
    if (invented.length === 0) return null;
    return { message: `candidate adds words not in the contract or draft: ${invented.slice(0, 8).join(', ')}`, detail: { words: invented } };
  },
};

export const CONTINUITY_DETECTORS: Record<string, (ctx: VideoLintContext) => CheckResult> = {
  sceneDirectionConsistent(ctx) {
    const prev = ctx.previousInScene;
    if (!prev || prev.sceneId !== ctx.contract.sceneId) return null;
    if (prev.action.screenDirection === 'none' || ctx.contract.action.screenDirection === 'none') return null;
    if (prev.action.screenDirection !== ctx.contract.action.screenDirection && !ctx.contract.vfx) {
      return {
        message: `screen direction changes within scene "${ctx.contract.sceneId}" (${prev.action.screenDirection} -> ${ctx.contract.action.screenDirection}) without a marked direction change`,
      };
    }
    if (prev.camera.side !== ctx.contract.camera.side) {
      return { message: `camera side changes within scene "${ctx.contract.sceneId}" (${prev.camera.side} -> ${ctx.contract.camera.side})` };
    }
    return null;
  },
};

export function lintVideo(ctx: VideoLintContext, guardrails: Guardrail[]): LintResult {
  const violations: Violation[] = [];
  for (const g of guardrails) {
    if (g.domain !== 'video') continue;
    let hit: CheckResult = null;
    if (g.detector.type === 'contract') {
      const fn = VIDEO_DETECTORS[g.detector.check];
      hit = fn ? fn(ctx) : { message: `unknown video detector "${g.detector.check}"` };
    } else if (g.detector.type === 'continuity') {
      const fn = CONTINUITY_DETECTORS[g.detector.check];
      hit = fn ? fn(ctx) : { message: `unknown continuity detector "${g.detector.check}"` };
    } else if (g.detector.type === 'lexicon') {
      const field = g.detector.field === 'imagePrompt' ? undefined : ctx.motionPrompt;
      if (field !== undefined) {
        const m = lexiconMatch(field, g.detector.list);
        if (m) hit = { message: `matched lexicon "${g.detector.list}": "${m[0]}"` };
      }
    } else if (g.detector.type === 'regex') {
      const field = g.detector.field === 'imagePrompt' ? undefined : ctx.motionPrompt;
      if (field !== undefined) {
        const re = new RegExp(g.detector.pattern, g.detector.flags);
        if (re.test(field)) hit = { message: `matched pattern "${g.detector.pattern}"` };
      }
    }
    if (hit) violations.push({ guardrailId: g.id, severity: g.severity, fixTarget: g.fixTarget, message: hit.message, detail: hit.detail });
  }
  return { violations, blocking: violations.some((v) => v.severity === 'block') };
}
