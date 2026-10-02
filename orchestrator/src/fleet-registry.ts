// ─────────────────────────────────────────────────────────────────────────────
// HAND-MAINTAINED. The orchestrator owns its fleet.
//
// Until 2026-10-02 this file was generated from src/shared/fleet.ts (the AWS
// live path's fleet). The AWS path no longer generates assets — asset and
// video generation run on RunPod through this orchestrator (VPS), and AWS
// (Step Functions + ECS) is only the assembly tail — so the two lists are
// independent and this one is the source of truth. Do NOT run
// `npm run gen:fleet`: the generator is obsolete and would overwrite this
// file. Keep these counts matched to the RunPod dashboard; the watchdog
// compares them against it.
//
// Last synced: 2026-10-02 (dashboard screenshot + live RunPod API).
// ─────────────────────────────────────────────────────────────────────────────

/** RunPod account-wide worker cap. */
export const ACCOUNT_CAP = 40;

export interface FleetEndpoint {
  /** Per-endpoint semaphore key (dynamo-gate / provisioner convention). */
  counterKey: string;
  /** RunPod serverless endpoint id. */
  endpointId: string;
  /** Static max workers == real pod count == the orchestrator's in-flight ceiling. */
  workers: number;
}

/**
 * The orchestrator's RunPod pool: asset generation + the two audio calls the
 * Step Functions tail makes. Fixed pod counts, set on the dashboard only —
 * orchestrator code never changes workersMax (agents/fleet.ts).
 *
 * NOT in this list, deliberately (all 0 workers on the dashboard 2026-10-02):
 * PostProd-Lite (`n6252hm01qz0xh`) and DreamX-Refine (`w0h49vn1pn0r87`) —
 * merge/concat/silence/upscale/caption-burn/BGM-overlay moved to the SFN+ECS
 * tail and DreamX is no longer used for upscaling; multitalk
 * (`mt6vmstwzw0evp`), long2shorts, story-studio-ernie. The remaining 11
 * workers of the 40 belong to the 3D pipeline (Trellis2 4, 3d-rigging 3,
 * Blender-headless 2, Hunyuan-3D 2).
 */
export const FLEET: readonly FleetEndpoint[] = [
  // TTS (Kokoro / Qwen-TTS) — and nothing else once BGM/caption/SFX have
  // their own endpoints below.
  { counterKey: "runpod:flux-tts-s2t", endpointId: "rnqxi6c0mlq517", workers: 7 },
  { counterKey: "runpod:qwen-image-gen", endpointId: "e165se4r3eo5hp", workers: 4 },
  { counterKey: "runpod:qwen-image-edit", endpointId: "oxwx8o879qwtla", workers: 4 },
  { counterKey: "runpod:wan2-i2v", endpointId: "nd7wloyvj09xwy", workers: 6 },
  // Word-level captions (Whisper) + BGM (ACE-Step), called by the SFN tail
  // right after remove-silence.
  { counterKey: "runpod:bgm-s2t", endpointId: "6apg6j7suzuezw", workers: 3 },
  // MMAudio SFX on its own endpoint again (was pooled onto flux-tts-s2t
  // 2026-09-20).
  { counterKey: "runpod:mm-audio", endpointId: "nzkcsef9t2iv7s", workers: 5 },
] as const;

/** Sum of the pool's worker counts. */
export const FLEET_TOTAL = FLEET.reduce((a, e) => a + e.workers, 0);

/** Look up one endpoint's pooled worker count (0 if not in the pool). */
export function pooledWorkers(counterKey: string): number {
  return FLEET.find((e) => e.counterKey === counterKey)?.workers ?? 0;
}
