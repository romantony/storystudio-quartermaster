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

/** "DreamX-RTX6000ADA -Refine" — DreamX-Creator's SR-DiT video refiner
 * (~/dreamx-creator-runpod/refiner/, image romantony/dreamx-creator-refiner).
 * Not a tail endpoint despite living in this file: step 14 (per-frame
 * upscale) is a bulk step. Same "orchestrator-only, never in
 * src/shared/fleet.ts" property as postprod-lite, which is why it's here.
 * Contract mirrors postprod-lite's `upscale` mode minus `mode`:
 * `{video_url, target_height | sr_scale}` -> `{video, video_url, upscale,
 * width, height, ...}`. Hard limits enforced by the worker: sr_scale
 * 1.0-2.25, input <= 241 frames (MAX_INPUT_FRAMES) — see
 * steps/builders/upscale-frame.ts. */
export const DREAMX_REFINER_ENDPOINT_ID = 'w0h49vn1pn0r87';

/** "MM-Audio-A40" — MMAudio large_44k_v2 video-to-audio (~/mmaudio,
 * image romantony/mmaudio-worker). Step 15 (per-frame SFX), bulk like step
 * 14. `v2a` mode: `{video_url, prompt, negative_prompt}` -> `{audio_url}`
 * (the generated track only, never muxed). LICENSE: checkpoints are
 * CC-BY-NC-4.0 (non-commercial) — wired in 2026-09-14 on the user's explicit
 * go-ahead despite the 2026-08-14 decision that dropped it for production;
 * see ~/mmaudio/API.md. Opt-in only (options.sfx). */
export const MMAUDIO_ENDPOINT_ID = 'nzkcsef9t2iv7s';
