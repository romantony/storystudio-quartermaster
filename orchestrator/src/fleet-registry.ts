// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — do not edit by hand.
// Source: src/shared/fleet.ts  ·  Regenerate: npm run gen:fleet
// A drift between this file and the source fails fleet-registry.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** RunPod account-wide worker cap, mirrored from src/shared/fleet.ts. */
export const ACCOUNT_CAP = 40;

export interface FleetEndpoint {
  /** Per-endpoint semaphore key (dynamo-gate / provisioner convention). */
  counterKey: string;
  /** RunPod serverless endpoint id. */
  endpointId: string;
  /** Static max workers == real pod count, from the live path. */
  workers: number;
}

/**
 * The Quartermaster pool as the live path sees it. The background orchestrator
 * treats these counts as the ceiling it must rebalance against (spec §4.1
 * step 5); it does not own them.
 */
export const FLEET: readonly FleetEndpoint[] = [
  { counterKey: "runpod:flux-tts-s2t", endpointId: "rnqxi6c0mlq517", workers: 8 },
  { counterKey: "runpod:qwen-image-gen", endpointId: "e165se4r3eo5hp", workers: 6 },
  { counterKey: "runpod:qwen-image-edit", endpointId: "oxwx8o879qwtla", workers: 4 },
  { counterKey: "runpod:wan2-i2v", endpointId: "nd7wloyvj09xwy", workers: 10 },
  { counterKey: "runpod:bgm-s2t", endpointId: "6apg6j7suzuezw", workers: 4 },
  { counterKey: "runpod:multitalk", endpointId: "mt6vmstwzw0evp", workers: 2 },
] as const;

/** Sum of the pooled worker counts (spec §5.2's "FLEET sums to"). */
export const FLEET_TOTAL = 34;

/** Look up one endpoint's pooled worker count (0 if not in the pool). */
export function pooledWorkers(counterKey: string): number {
  return FLEET.find((e) => e.counterKey === counterKey)?.workers ?? 0;
}
