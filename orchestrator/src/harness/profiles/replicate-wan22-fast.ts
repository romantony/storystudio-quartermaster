/**
 * Capability profile for the Replicate `wan-video/wan-2.2-i2v-fast`
 * fallback (non-distilled, real CFG) — prompt harness plan §7.1/§5.2. It
 * inherits every wan2-lightning guardrail (harness/guardrails/store.ts
 * clones the video-wan2-lightning seed set under this profile name) except
 * the capability tables below: more moves on probation instead of banned,
 * and `high` motion allowed on probation. Camera-lock rules (V-CAM-03,
 * V-DIR-*) apply unchanged — no model can move the camera to the other
 * side of the subject from a single source frame.
 */
import type { VideoProfile } from './types';

export const REPLICATE_WAN22_FAST_PROFILE: VideoProfile = {
  name: 'replicate-wan22-fast',
  label: 'Wan 2.2 image-to-video (non-distilled), 480p, ~5-7 s',
  maxMotionLevel: 'high',
  moves: {
    static: { status: 'allowed' },
    push_in: { status: 'allowed' },
    pull_out: { status: 'allowed' },
    zoom_in: { status: 'allowed' },
    zoom_out: { status: 'allowed' },
    pan_left: { status: 'allowed' },
    pan_right: { status: 'allowed' },
    truck_left: { status: 'probation', downgradeTo: 'static' },
    truck_right: { status: 'probation', downgradeTo: 'static' },
    tilt_up: { status: 'probation', downgradeTo: 'static' },
    tilt_down: { status: 'probation', downgradeTo: 'static' },
    pedestal_up: { status: 'banned', downgradeTo: 'static' },
    pedestal_down: { status: 'banned', downgradeTo: 'static' },
    arc: { status: 'probation', downgradeTo: 'push_in' },
    tracking: { status: 'probation', downgradeTo: 'static' },
    handheld: { status: 'banned', downgradeTo: 'static' },
  },
};
