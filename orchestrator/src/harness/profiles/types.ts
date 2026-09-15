import type { CameraMove } from '../contract';

export type MoveStatus = 'allowed' | 'probation' | 'banned';

export interface MoveCapability {
  status: MoveStatus;
  downgradeTo?: CameraMove;
}

export interface VideoProfile {
  name: string;
  moves: Record<CameraMove, MoveCapability>;
  /** Highest action.motionLevel this profile can execute reliably. */
  maxMotionLevel: 'low' | 'medium' | 'high';
  /** Model label injected into compiled prompts / the regenerate tool, e.g.
   * "Wan 2.2 image-to-video, 4-step Lightning distillation, 480p". */
  label: string;
}

export function moveCapability(profile: VideoProfile, move: CameraMove): MoveCapability {
  return profile.moves[move] ?? { status: 'banned' };
}
