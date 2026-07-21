/**
 * RunPod GPU-hour pricing for cost attribution.
 *
 * Every self-hosted QM endpoint runs on an A40 EXCEPT the Wan2 i2v endpoint,
 * which runs on an RTX6000 Ada (see runpod/API.md's Endpoint Directory,
 * verified 2026-07-02: Flux-TTS-S2T/qwen-image-gen/qwen-image-edit are all
 * A40/A6000; Wan2-14b-fp8-RTX6000ADA is RTX6000 Ada/L40/L40S/H100). Rates
 * confirmed against the RunPod account 2026-07-11.
 */

import { WAN2_I2V } from './fleet';

export const A40_RATE_USD_PER_HOUR = 0.44;
export const RTX6000ADA_RATE_USD_PER_HOUR = 0.77;

export function gpuTypeForRung(counterKey?: string): 'A40' | 'RTX6000ADA' {
  return counterKey === WAN2_I2V ? 'RTX6000ADA' : 'A40';
}

export function gpuRateUsdPerHour(counterKey?: string): number {
  return gpuTypeForRung(counterKey) === 'RTX6000ADA' ? RTX6000ADA_RATE_USD_PER_HOUR : A40_RATE_USD_PER_HOUR;
}

/** RunPod's own billed executionTime (ms) -> USD, at the given endpoint's GPU rate. */
export function gpuCostUsd(executionTimeMs: number, counterKey?: string): number {
  return (executionTimeMs / 3_600_000) * gpuRateUsdPerHour(counterKey);
}
