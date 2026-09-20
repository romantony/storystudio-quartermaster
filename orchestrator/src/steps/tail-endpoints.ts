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
 * workersMin=0/workersMax=2/workersStandby=2 — see cfg.workersTail.
 *
 * UPGRADED IN PLACE 2026-09-20: this endpoint's image was swapped to
 * `romantony/story-studio-postprod-lite-v2:latest` (see
 * POSTPROD_LITE_V2_ENDPOINT_ID's own comment for what v2 adds) — same
 * endpoint id, same 4 workers, not a new endpoint. `POSTPROD_LITE_ENDPOINT_ID`
 * and `POSTPROD_LITE_V2_ENDPOINT_ID` are consequently the same literal id;
 * both constants are kept only because the cohort model's catalog.ts and
 * agents/rework.ts already reference this one by name, and renaming every
 * call site for a same-value rename would be pure churn. v2 is a strict,
 * backward-compatible superset of v1 (same 8 modes; `preMerged` is a new
 * OPTIONAL field only the asset model's `merge` kind sends), so every
 * existing caller of this constant keeps working unchanged. */
export const POSTPROD_LITE_ENDPOINT_ID = 'n6252hm01qz0xh';

/**
 * "PostProd-Lite" v2 — same physical endpoint as POSTPROD_LITE_ENDPOINT_ID
 * above (operator repurposed it in place, same as flux-tts-s2t/audio-pool),
 * now running the v2 image: normalized concat (mismatched clip resolution/
 * fps no longer silently stretches the video), a real BGM loop instead of
 * one that died at the track's own length, an A/V duration-parity assertion
 * before upload, and `preMerged` per-frame clip support for the `merge`
 * asset kind below (docs/qm-orchestrator-three-project-run-analysis-
 * 2026-09-19.md and its merge-parallelization follow-up). Image:
 * `~/flux4B-Wan2/Flux-klien-4b/postprod-lite-v2` (built + pushed 2026-09-20).
 *
 * `postprod-lite` AND `merge` both point here (same as they'd have to if
 * this were a genuinely separate endpoint) — merge's whole point is feeding
 * v2's `preMerged` path.
 */
export const POSTPROD_LITE_V2_ENDPOINT_ID = 'n6252hm01qz0xh';
export const POSTPROD_LITE_V2_PODS = 4;

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
 * image romantony/mmaudio-worker). LICENSE: checkpoints are CC-BY-NC-4.0
 * (non-commercial) — wired in 2026-09-14 on the user's explicit go-ahead
 * despite the 2026-08-14 decision that dropped it for production; see
 * ~/mmaudio/API.md.
 *
 * DECOMMISSIONED 2026-09-20: superseded by AUDIO_POOL_ENDPOINT_ID below,
 * scaled to 0 workers on the RunPod dashboard (operator's call — not this
 * endpoint used elsewhere, and its own image/history stay intact if it's
 * ever needed again). Nothing in kinds.ts references this constant or id
 * any more; kept here only as a record of which id it was. */
const _DECOMMISSIONED_MMAUDIO_ENDPOINT_ID = 'nzkcsef9t2iv7s';
void _DECOMMISSIONED_MMAUDIO_ENDPOINT_ID;

/**
 * "Audio-Pool" — TTS + MMAudio + BGM pooled onto the endpoint that used to
 * be TTS-only (docs/qm-orchestrator-three-project-run-analysis-2026-09-19.md's
 * follow-up: pooling analysis found these three feasible to co-reside —
 * combined VRAM ~29GB against ~44GB usable on the same 48GB cards, with NO
 * model-swap cost, unlike qwen-image-gen/qwen-image-edit which cannot
 * co-reside — see that conversation for why only this pair was pooled).
 *
 * This is `flux-tts-s2t` (`src/shared/fleet.ts`'s `FLUX_TTS_S2T`), the LIVE
 * endpoint — not a fresh one. Operator's call, 2026-09-20: repurpose it
 * in place (image swapped to `audio-pool`, workers raised 5→7) rather than
 * standing up a new endpoint; MM-Audio-A40 and BGM-S2T scaled to 0 in the
 * same move (see their own now-decommissioned constants above/below).
 * `fleet-registry.ts`'s own `flux-tts-s2t` entry (still 5 workers, still
 * generated from shared/fleet.ts) is now STALE for this purpose — this
 * constant is the one kinds.ts's tts/mmaudio/bgm actually read; that
 * generated file only matters if/when the AWS live path's own use of this
 * same endpoint id is confirmed clear (still open — see conversation).
 *
 * Image: `~/flux4B-Wan2/Flux-klien-4b/audio-pool` (built + pushed
 * 2026-09-20, `9e7b9dc`; the three source images — tts/, bgm-s2t/,
 * ~/mmaudio — are untouched, just no longer what this specific endpoint
 * runs). Contract: `{mode: 'tts'|'voice_clone_prompt'|'bgm'|'sfx'|
 * 'transcribe'|'caption'|'v2a'|'i2a'|'t2a', ...}` (see audio-pool/API.md) —
 * routes on the SAME `mode` field buildTtsInput/buildBgmInput/buildSfxInput
 * already send today, so no builder changes were needed.
 *
 * Volume: `flux2-TTS-S2T-Bgm-A40`, already attached (unchanged) — already
 * carries everything tts/bgm-s2t need under `models/`; MMAudio's weights
 * were primed onto the same volume at `models/mmaudio/` + top-level
 * `hf-cache/` (2026-09-20, verified live from the pod).
 */
export const AUDIO_POOL_ENDPOINT_ID = 'rnqxi6c0mlq517';
export const AUDIO_POOL_PODS = 7;
