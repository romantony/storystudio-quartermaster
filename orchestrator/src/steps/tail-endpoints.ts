/**
 * Orchestrator-only endpoint ids for the assembly tail (steps 6+) — NOT
 * auto-generated, unlike fleet-registry.ts. These endpoints are never shared
 * with the AWS live path (that's the whole point of M1: postprod-lite was
 * purpose-built on its own new RunPod endpoint specifically so the
 * background path never touches a live-path-shared endpoint), so they have
 * no entry in src/shared/fleet.ts and never will.
 *
 * See orchestrator/containers/media.md for the full contract.
 */

/** "PostProd-Lite" — merge/concat/upscale/caption/mix_bgm/remove_silence/
 * transcribe/animate, all 8 modes deployed and live-tested 2026-09-10.
 * workersMin=0/workersMax=2/workersStandby=2 — see cfg.workersTail. */
export const POSTPROD_LITE_ENDPOINT_ID = 'n6252hm01qz0xh';
