/**
 * The shot contract (prompt harness plan §4). One per frame — the single
 * source of truth for both compiled prompts and every lint/probe check.
 * Pure types + zod schema + normalizers only: no I/O, no DB, no clock (same
 * contract as steps/builders/*.ts).
 *
 * Movie Gen App. B.2's 16-class camera motion taxonomy is reused verbatim
 * for `CameraMove` — see docs/qm-orchestrator-prompt-harness-implementation-plan.md §2.
 */
import { z } from 'zod';

export const SCREEN_DIRECTIONS = ['toward_camera', 'away_from_camera', 'screen_left', 'screen_right', 'up', 'down', 'none'] as const;
export type ScreenDir = (typeof SCREEN_DIRECTIONS)[number];

export const FACINGS = ['camera', 'away', 'screen_left', 'screen_right', 'three_quarter_left', 'three_quarter_right'] as const;
export type Facing = (typeof FACINGS)[number];

export const SHOT_SIZES = [
  'extreme_close_up',
  'close_up',
  'medium_close_up',
  'medium',
  'medium_wide',
  'wide',
  'extreme_wide',
] as const;
export type ShotSize = (typeof SHOT_SIZES)[number];

export const CAMERA_ANGLES = ['eye_level', 'low_angle', 'high_angle', 'overhead', 'over_the_shoulder', 'first_person', 'aerial'] as const;
export type CameraAngle = (typeof CAMERA_ANGLES)[number];

export const CAMERA_SIDES = ['front', 'back', 'left_profile', 'right_profile'] as const;
export type CameraSide = (typeof CAMERA_SIDES)[number];

/** Movie Gen App. B.2: 16 camera motion classes. */
export const CAMERA_MOVES = [
  'static',
  'push_in',
  'pull_out',
  'zoom_in',
  'zoom_out',
  'pan_left',
  'pan_right',
  'truck_left',
  'truck_right',
  'tilt_up',
  'tilt_down',
  'pedestal_up',
  'pedestal_down',
  'arc',
  'tracking',
  'handheld',
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const POPULATIONS = ['empty', 'sparse', 'crowd'] as const;
export type Population = (typeof POPULATIONS)[number];

export const SUBJECT_KINDS = ['character', 'animal', 'prop'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const SUBJECT_POSITIONS = ['left_third', 'center', 'right_third', 'foreground', 'background'] as const;
export type SubjectPosition = (typeof SUBJECT_POSITIONS)[number];

export const MOTION_LEVELS = ['low', 'medium', 'high'] as const;
export type MotionLevel = (typeof MOTION_LEVELS)[number];

export const TRANSFORMATIONS = ['none', 'continuation', 'state_change'] as const;
export type Transformation = (typeof TRANSFORMATIONS)[number];

export const ShotSubjectSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(SUBJECT_KINDS),
    count: z.number().int().positive(),
    ref: z.literal('reference_image').optional(),
    // Optional, not defaulted: a secondary subject extraction couldn't
    // place is exactly I-SUB-01's "ungrounded" signal (lint/image.ts's
    // secondarySubjectsGrounded) and correct/edits.ts's `ground_secondary`
    // fixes it — a required-with-default would silently hide that gap.
    position: z.enum(SUBJECT_POSITIONS).optional(),
    facing: z.enum(FACINGS).optional(),
    pose: z.string().optional(),
    handContact: z.boolean().optional(),
    /** Free-text appearance/placement detail — what I-SUB-01 checks is
     * present for every subject after the first. */
    detail: z.string().optional(),
  })
  .strict();
export type ShotSubject = z.infer<typeof ShotSubjectSchema>;

export const ShotContractSchema = z
  .object({
    frameId: z.string().min(1),
    sceneId: z.string().min(1),
    setting: z
      .object({
        place: z.string().min(1),
        population: z.enum(POPULATIONS),
        timeOfDay: z.string().optional(),
        lighting: z.string().optional(),
      })
      .strict(),
    subjects: z.array(ShotSubjectSchema).min(1),
    camera: z
      .object({
        shotSize: z.enum(SHOT_SIZES),
        angle: z.enum(CAMERA_ANGLES),
        side: z.enum(CAMERA_SIDES),
        move: z.enum(CAMERA_MOVES),
        speed: z.enum(['slow', 'medium']).default('slow'),
        /** True when the story genuinely needs this move and a downgrade
         * should route to a stronger model instead of silently weakening
         * the shot (plan §7.6, video.camera.move_not_executed rung 2). */
        essential: z.boolean().default(false),
      })
      .strict(),
    action: z
      .object({
        subjectId: z.string().min(1),
        verb: z.string().min(1),
        screenDirection: z.enum(SCREEN_DIRECTIONS),
        motionLevel: z.enum(MOTION_LEVELS),
        ambient: z.array(z.string()).default([]),
      })
      .strict(),
    transformation: z.enum(TRANSFORMATIONS).default('none'),
    vfx: z.boolean().default(false),
  })
  .strict();
export type ShotContract = z.infer<typeof ShotContractSchema>;

/** Fields that must be resolved before lint can meaningfully run — an
 * `unknown` value on any of these is a `fix`-severity violation of its own
 * (I-DIR-01/V-DIR-01), never silently defaulted. Extraction (tool/extract.ts)
 * is allowed to omit fields it can't determine; zod's `.optional()` on the
 * raw extraction output is handled there, not here — by the time a contract
 * reaches lint it is either complete (this schema) or the frame is flagged
 * `harness_error` and falls back to the caller's prompts. */
export function primarySubject(contract: ShotContract): ShotSubject | undefined {
  return contract.subjects.find((s) => s.id === contract.action.subjectId) ?? contract.subjects[0];
}

export function secondarySubjects(contract: ShotContract): ShotSubject[] {
  const primary = primarySubject(contract);
  return contract.subjects.filter((s) => s !== primary);
}

/** Deep-clones + validates a candidate contract edit, so every deterministic
 * fix in lint/*.ts produces a fresh, still-valid ShotContract rather than
 * mutating the one currently being checked. */
export function withContract(contract: ShotContract, patch: (draft: ShotContract) => void): ShotContract {
  const draft = JSON.parse(JSON.stringify(contract)) as ShotContract;
  patch(draft);
  return ShotContractSchema.parse(draft);
}
