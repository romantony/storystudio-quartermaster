/**
 * Capability profile for the self-hosted Wan 2.2 I2V-A14B, LightX2V 4-step
 * Lightning distillation, cfg 1.0 (guidance distilled out) — prompt harness
 * plan §7.1. Statuses are a starting SEED, calibrated by the §7.5 sweep
 * (`harness_profiles` table overrides these once real agreement rates
 * exist — see harness/profiles/store.ts).
 */
import type { VideoProfile } from './types';

export const WAN2_LIGHTNING_PROFILE: VideoProfile = {
  name: 'wan2-lightning',
  label: 'Wan 2.2 image-to-video, 4-step Lightning distillation, 480p, ~5-7 s',
  maxMotionLevel: 'medium',
  moves: {
    static: { status: 'allowed' },
    push_in: { status: 'allowed' },
    pull_out: { status: 'probation', downgradeTo: 'static' },
    zoom_in: { status: 'probation', downgradeTo: 'push_in' },
    zoom_out: { status: 'probation', downgradeTo: 'static' },
    pan_left: { status: 'probation', downgradeTo: 'push_in' },
    pan_right: { status: 'probation', downgradeTo: 'push_in' },
    truck_left: { status: 'probation', downgradeTo: 'static' },
    truck_right: { status: 'probation', downgradeTo: 'static' },
    tilt_up: { status: 'probation', downgradeTo: 'static' },
    tilt_down: { status: 'probation', downgradeTo: 'static' },
    pedestal_up: { status: 'banned', downgradeTo: 'static' },
    pedestal_down: { status: 'banned', downgradeTo: 'static' },
    arc: { status: 'banned', downgradeTo: 'push_in' },
    tracking: { status: 'banned', downgradeTo: 'static' },
    handheld: { status: 'banned', downgradeTo: 'static' },
  },
};
