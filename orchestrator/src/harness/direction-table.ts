/**
 * The direction/angle truth table (prompt harness plan §7.2). I2V can't
 * change what the first frame fixes — camera side, angle, shot size and
 * facing — so a screen-direction/facing/side conflict must be resolved in
 * the IMAGE contract, never by changing the story's action. Shared between
 * lint/video.ts's `directionConsistent` check and correct/edits.ts's
 * `align_facing`/`derive_facing_from_motion` fixes, so both sides of a
 * check-then-fix pair agree on the same table.
 */
import type { CameraSide, Facing, ScreenDir } from './contract';

export const ALLOWED_FACING_FOR_DIRECTION: Partial<Record<ScreenDir, Facing[]>> = {
  toward_camera: ['camera', 'three_quarter_left', 'three_quarter_right'],
  away_from_camera: ['away'],
  screen_left: ['screen_left', 'three_quarter_left'],
  screen_right: ['screen_right', 'three_quarter_right'],
};

export const REQUIRED_SIDE_FOR_DIRECTION: Partial<Record<ScreenDir, CameraSide>> = {
  toward_camera: 'front',
  away_from_camera: 'back',
};

export function preferredFacing(dir: ScreenDir): Facing | undefined {
  return ALLOWED_FACING_FOR_DIRECTION[dir]?.[0];
}

export function preferredSide(dir: ScreenDir): CameraSide | undefined {
  return REQUIRED_SIDE_FOR_DIRECTION[dir];
}
