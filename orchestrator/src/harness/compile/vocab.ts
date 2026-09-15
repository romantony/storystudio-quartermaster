/**
 * Human-language phrase tables shared by compile/image.ts and
 * compile/motion.ts. Kept in sync with lint/image.ts and lint/video.ts's own
 * detector regexes — a phrase emitted here must satisfy the corresponding
 * "stated in the prompt" check (I-ANG-01, I-SIDE-01, V-CAM-04, etc).
 */
import type { CameraAngle, CameraMove, CameraSide, Facing, ShotSize } from '../contract';

export const SHOT_SIZE_PHRASE: Record<ShotSize, string> = {
  extreme_close_up: 'Extreme close-up',
  close_up: 'Close-up',
  medium_close_up: 'Medium close-up',
  medium: 'Medium shot',
  medium_wide: 'Medium-wide shot',
  wide: 'Wide shot',
  extreme_wide: 'Extreme wide shot',
};

export const CAMERA_ANGLE_PHRASE: Record<CameraAngle, string> = {
  eye_level: 'at eye level',
  low_angle: 'at a low angle',
  high_angle: 'at a high angle',
  overhead: 'from overhead',
  over_the_shoulder: 'over the shoulder',
  first_person: 'first-person view',
  aerial: 'aerial view',
};

export const CAMERA_SIDE_PHRASE: Record<CameraSide, string> = {
  front: 'facing the camera',
  back: 'seen from behind, her back to the camera',
  left_profile: 'left profile, facing screen-left',
  right_profile: 'right profile, facing screen-right',
};

export const FACING_PHRASE: Record<Facing, string> = {
  camera: 'facing the camera',
  away: 'facing away from the camera',
  screen_left: 'facing screen-left',
  screen_right: 'facing screen-right',
  three_quarter_left: 'three-quarter facing screen-left',
  three_quarter_right: 'three-quarter facing screen-right',
};

/** Matches lint/video.ts's MOVE_WORDS regex for each move — a phrase here
 * must satisfy its own detector when compiled into a prompt. */
export const CAMERA_MOVE_PHRASE: Record<CameraMove, string> = {
  static: 'Static camera',
  push_in: 'Slow push in',
  pull_out: 'Slow pull out',
  zoom_in: 'Slow zoom in',
  zoom_out: 'Slow zoom out',
  pan_left: 'Slow pan left',
  pan_right: 'Slow pan right',
  truck_left: 'Slow truck left',
  truck_right: 'Slow truck right',
  tilt_up: 'Slow tilt up',
  tilt_down: 'Slow tilt down',
  pedestal_up: 'Slow pedestal up',
  pedestal_down: 'Slow pedestal down',
  arc: 'Slow arc around the subject',
  // Deliberately NOT "tracking shot behind her" — that phrasing itself
  // trips V-DIR-01's relative-direction lexicon ("behind her"). Compiled
  // only when camera.move stays 'tracking' after an `essential:true` escape
  // (banned/probation on both video profiles otherwise).
  tracking: 'Tracking shot, the camera following from behind',
  handheld: 'Handheld camera, slight natural sway',
};

const SCREEN_DIR_PHRASE_TOWARD = 'toward the camera';
const SCREEN_DIR_PHRASE_AWAY = 'away from the camera';

export function screenDirectionPhrase(dir: string): string {
  switch (dir) {
    case 'toward_camera':
      return SCREEN_DIR_PHRASE_TOWARD;
    case 'away_from_camera':
      return SCREEN_DIR_PHRASE_AWAY;
    case 'screen_left':
      return 'screen-left';
    case 'screen_right':
      return 'screen-right';
    case 'up':
      return 'upward';
    case 'down':
      return 'downward';
    default:
      return '';
  }
}
