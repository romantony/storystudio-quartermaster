/** Shared shot-contract fixture builder for the harness test suite. */
import type { ShotContract } from '../../src/harness/contract';

export function validContract(overrides: Partial<ShotContract> = {}): ShotContract {
  return {
    frameId: 'f_01',
    sceneId: 'scene_bedroom',
    setting: { place: 'a small bedroom', population: 'empty', timeOfDay: 'night', lighting: 'lamp light' },
    subjects: [
      { id: 'maya', kind: 'character', count: 1, ref: 'reference_image', position: 'center', facing: 'camera', pose: 'sitting' },
    ],
    camera: { shotSize: 'medium', angle: 'eye_level', side: 'front', move: 'push_in', speed: 'slow', essential: false },
    action: { subjectId: 'maya', verb: 'turns the crystal', screenDirection: 'toward_camera', motionLevel: 'low', ambient: ['light flickers'] },
    transformation: 'none',
    vfx: false,
    ...overrides,
  };
}
