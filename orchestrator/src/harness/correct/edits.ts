/**
 * Named, deterministic contract edits (prompt harness plan §5.0's "a
 * promoted guardrail can only recombine existing checks and fixes").
 * `EDITS[name]` is what `CorrectiveMeasure.type === 'contract_edit'` refers
 * to by `edit` name in the guardrail seed files.
 *
 * Return `undefined` to mean "not applicable here" — the caller
 * (harness/index.ts's fix-application loop) then tries this guardrail's
 * next corrective measure instead (e.g. `downgrade_move` deliberately
 * declines when the contract marks the move `essential`, so the loop falls
 * through to `route`).
 */
import { SHOT_SIZES, primarySubject, withContract, type ShotContract } from '../contract';
import { preferredFacing, preferredSide } from '../direction-table';
import type { Violation } from '../guardrails/types';
import { moveCapability, videoProfile } from '../profiles';

export type EditFn = (contract: ShotContract, violation: Violation, opts: { profile: string }) => ShotContract | undefined;

/** The compiler already renders every subject's count/facing/side/camera
 * lead from the contract by construction — these detectors only ever fire
 * against a CALLER-supplied prompt whose text doesn't match its own
 * contract yet. The fix is "recompile", which harness/index.ts always does
 * after applying edits — so these edits are legitimately no-ops on the
 * contract itself. */
const RECOMPILE_ONLY: EditFn = (c) => c;

export const EDITS: Record<string, EditFn> = {
  render_counts: RECOMPILE_ONLY,
  noop_compile_leads: RECOMPILE_ONLY,
  keep_primary_move: RECOMPILE_ONLY,
  keep_primary_action: RECOMPILE_ONLY,
  drop_missing_subject_reference: RECOMPILE_ONLY,
  keep_scene_direction: RECOMPILE_ONLY, // enforced across frames by harness/index.ts, not per-contract

  ground_secondary(c) {
    const changed = c.subjects.some((s, i) => i > 0 && !s.position);
    if (!changed) return undefined;
    return withContract(c, (d) => {
      d.subjects.forEach((s, i) => {
        if (i > 0 && !s.position) s.position = 'background';
      });
    });
  },

  widen_shot(c) {
    const idx = SHOT_SIZES.indexOf(c.camera.shotSize);
    const mediumIdx = SHOT_SIZES.indexOf('medium');
    if (idx >= mediumIdx) return undefined;
    return withContract(c, (d) => {
      d.camera.shotSize = 'medium';
    });
  },

  derive_facing_from_motion(c) {
    const dir = c.action.screenDirection;
    const facing = preferredFacing(dir);
    const side = preferredSide(dir);
    if (!facing && !side) return undefined;
    return withContract(c, (d) => {
      const p = primarySubject(d);
      if (p && facing) p.facing = facing;
      if (side) d.camera.side = side;
    });
  },

  align_facing(c) {
    return EDITS.derive_facing_from_motion(c, { guardrailId: '', severity: 'block', fixTarget: 'image_prompt', message: '' }, { profile: 'any' });
  },

  population_empty(c) {
    if (c.setting.population === 'empty') return undefined;
    return withContract(c, (d) => {
      d.setting.population = 'empty';
    });
  },

  lead_room(c) {
    const p = primarySubject(c);
    if (!p) return undefined;
    const dir = c.action.screenDirection;
    const target = dir === 'screen_left' ? 'right_third' : dir === 'screen_right' ? 'left_third' : undefined;
    if (!target || p.position === target || p.position === 'center') return undefined;
    return withContract(c, (d) => {
      const primary = primarySubject(d);
      if (primary) primary.position = target;
    });
  },

  three_quarter_facing(c) {
    const p = primarySubject(c);
    if (!p || p.facing !== 'camera') return undefined;
    return withContract(c, (d) => {
      const primary = primarySubject(d);
      if (primary) primary.facing = 'three_quarter_left';
    });
  },

  continuation_beat(c) {
    if (c.transformation === 'continuation') return undefined;
    return withContract(c, (d) => {
      d.transformation = 'continuation';
    });
  },

  downgrade_move(c, _v, opts) {
    if (c.camera.essential) return undefined; // let `route` handle it instead
    const cap = moveCapability(videoProfile(opts.profile), c.camera.move);
    if (cap.status === 'allowed' || !cap.downgradeTo) return undefined;
    const to = cap.downgradeTo;
    return withContract(c, (d) => {
      d.camera.move = to;
    });
  },

  slow_down(c) {
    if (c.camera.speed === 'slow') return undefined;
    return withContract(c, (d) => {
      d.camera.speed = 'slow';
    });
  },

  static_wide_from_image(c) {
    if (c.camera.move === 'static' && c.camera.shotSize === 'extreme_wide') return undefined;
    return withContract(c, (d) => {
      d.camera.move = 'static';
      d.camera.shotSize = 'extreme_wide';
    });
  },

  // Only downgrades a level the PROFILE cannot execute. It used to downgrade
  // anything above `low` unconditionally, which disagreed with its own
  // guardrail: V-ACT-03's motionLevelAllowed passes `medium` on
  // wan2-lightning (maxMotionLevel: 'medium'), but prepare.ts applies this
  // edit as an unconditional normalization step — so every medium-motion shot
  // in the product was silently flattened to low before it was ever
  // generated. Found 2026-09-18 by dry-running a real 2-frame request
  // through /v1/harness/lint.
  downgrade_motion_level(c, _v, opts) {
    const order = { low: 0, medium: 1, high: 2 } as const;
    const max = videoProfile(opts.profile).maxMotionLevel;
    if (order[c.action.motionLevel] <= order[max]) return undefined;
    const next = c.action.motionLevel === 'high' ? 'medium' : 'low';
    return withContract(c, (d) => {
      d.action.motionLevel = next;
    });
  },
};

export function applyEdit(name: string, contract: ShotContract, violation: Violation, profile: string): ShotContract | undefined {
  const fn = EDITS[name];
  return fn ? fn(contract, violation, { profile }) : undefined;
}
