import { WAN2_LIGHTNING_PROFILE } from './wan2-lightning';
import { REPLICATE_WAN22_FAST_PROFILE } from './replicate-wan22-fast';
import type { VideoProfile } from './types';

export * from './types';
export { WAN2_LIGHTNING_PROFILE, REPLICATE_WAN22_FAST_PROFILE };

const PROFILES: Record<string, VideoProfile> = {
  'wan2-lightning': WAN2_LIGHTNING_PROFILE,
  'replicate-wan22-fast': REPLICATE_WAN22_FAST_PROFILE,
};

export function videoProfile(name: string): VideoProfile {
  return PROFILES[name] ?? WAN2_LIGHTNING_PROFILE;
}

/** The profile a frame's next generation attempt runs on, given the model
 * fallback rung the quality ladder has (or hasn't) switched to yet. */
export function profileForRung(fallbackRung: string | undefined): string {
  return fallbackRung === 'replicate-wan22-fast' ? 'replicate-wan22-fast' : 'wan2-lightning';
}
