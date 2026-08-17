/**
 * Single source of truth for the RunPod fleet shape.
 *
 * Consumed by the executor (per-endpoint concurrency limit), the provisioner
 * (static workersMax ceiling + scale targets), and admission (which endpoints a
 * project touches + the next-admit backlog gate). One place defines the real
 * pod counts so capacity planning, real SFN parallelism, and worker
 * provisioning can never drift apart — a mismatch there is what silently
 * dropped 12 of 21 frames in the first live premium run (2026-07-04), and again
 * silently failed 13+ of 17 Wan2 i2v frames when this file claimed 4 wan2-i2v
 * workers against only 3 real pods (2026-07-05, see WAN2_I2V's entry below).
 *
 * Model (agreed with StoryStudio 2026-07-04):
 *   - `workers` is BOTH the static max worker count AND the QM concurrency limit
 *     for that endpoint — they are the same number because QM should feed a pod
 *     at its real pod rate, not oversubmit and let RunPod's queue (or an
 *     overwhelmed external fallback) absorb the overflow.
 *   - The narration-serving endpoints (flux-tts-s2t, qwen-image-gen/edit,
 *     wan2-i2v, bgm-s2t) are a *static* allocation, never dynamically
 *     reshuffled, summing to 32 of ACCOUNT_CAP's 40 (account-wide cap raised
 *     30→40 on 2026-08-04; qwen-image-gen raised 0→2 on 2026-07-21 when the
 *     explainer/educational/advertisement/documentary/product-promotion T2I
 *     rung moved onto it from the now-retired ernie-image endpoint — see
 *     image.explainer.t2i in background.json).
 *     Re-confirmed against the dashboard 2026-08-11 ("39/40 Workers
 *     deployed"): Flux-TTS-ANIM=8 (was 12), qwen-image-gen=6 (was 3),
 *     qwen-image-edit=4 (unchanged), Wan2-14b-fp8-RTX6000ADA=10 (was 12),
 *     BGM-S2T=4 (unchanged). The other 7 of the account's 40 total deployed
 *     workers are outside this pool entirely (long2shorts=4 — a direct
 *     RunPod call, see pipeline-stack.ts's ShortsTriggerFunction — not
 *     routed through QM's catalog/provisioner, so it isn't tracked here;
 *     LTX-DUB=1 and multitalk=2 are new endpoints seen on the dashboard
 *     2026-08-11, neither routed through QM either; story-studio-ernie and
 *     story-studio-stable-video are both at 0).
 *   - Idle floor is 0 (true scale-to-zero) — we don't pay for a warm worker with
 *     no job in front of it. Pre-warm raises workers only on admission, timed to
 *     overlap the ~2-3 min cold start with Convex's brain window.
 *
 * Per-tier T2I/I2I routing (confirmed against background.json 2026-08-11, THEN
 * corrected same day — see below):
 *   - ALL tiers' real T2I now goes to qwen-image-gen (e165se4r3eo5hp,
 *     `mode:"t2i"`); real I2I now goes to qwen-image-edit (oxwx8o879qwtla,
 *     `mode:"i2i"`). flux-tts-s2t (rnqxi6c0mlq517) serves NO image gen at
 *     all anymore.
 *   - qwen-image-gen hosts two models, selected per-request via the RunPod
 *     payload's `model` field (`"flux"`|`"qwen"` — see runpod.ts's `t2i`
 *     case, derived from the rung's catalog `model` label so Narration
 *     rungs keep requesting Flux Klein 4B while explainer/Dialogue rungs
 *     keep requesting Qwen-Image). qwen-image-edit hosts one model
 *     (Qwen-Image-Edit) — no Flux variant to select there.
 *   CORRECTION (2026-08-11, same day as the note above): this file previously
 *   documented Narration Basic/Premium's T2I (and Basic's I2I) as still
 *   living on flux-tts-s2t's `mode:"image"` — that was accurate until a live
 *   RunPod error ("mode 'image' not served by the TTS endpoint (this
 *   endpoint serves: ['tts','voice_clone_prompt'])") revealed rnqxi6c0mlq517
 *   had been cut down to TTS-only in production. Re-pointed
 *   image.narrationBasic.t2i/i2i and image.narrationPremium.t2i (plus
 *   image.basic.t2i/image.premium.t2i) to qwen-image-gen/qwen-image-edit in
 *   background.json the same day. NOT yet fixed: `movie.premium.image.t2i`
 *   is aliased by `movie.premium.image.i2i` (one Flux `mode:"image"` rung
 *   handling both via `reference_images`) — qwen-image-gen's `t2i` case has
 *   no reference-image support, so blindly re-pointing it would silently
 *   drop the reference on i2i calls instead of erroring. Left on the (now
 *   broken) flux-tts-s2t rung, relying on its `fb:true` KIE fallback
 *   (nano-banana-2) until this gets a real fix.
 */

export const FLUX_TTS_S2T = 'runpod:flux-tts-s2t';
export const QWEN_IMAGE_GEN = 'runpod:qwen-image-gen';
export const QWEN_IMAGE_EDIT = 'runpod:qwen-image-edit';
export const WAN2_I2V = 'runpod:wan2-i2v';
export const BGM_S2T = 'runpod:bgm-s2t';

export interface FleetEndpoint {
  counterKey: string;
  endpointId: string;
  /** Static max workers == QM concurrency limit == real pod count. */
  workers: number;
}

export const FLEET: FleetEndpoint[] = [
  // flux-tts-s2t (ENDPOINT_ROLE, effectively TTS-only in production as of
  // 2026-08-11 — see this file's top comment) hosts TTS-kokoro/TTS-qwen (all
  // tiers), animate, the one-shot `pipeline`, concat, and merge-fallback. NO
  // tier routes image gen here anymore — every tier's T2I/I2I lives on
  // qwen-image-gen/qwen-image-edit (see top comment), except the still-broken
  // movie.premium.image.t2i/i2i (also documented there). merge moved
  // off this pool onto QM-owned Lambda 2026-07-27 (see qm-merge-lambda-migration
  // memory), directly relieving the contention that caused real image-t2i/TTS
  // timeouts here the same day. BGM (ACE-Step) + SRT (Whisper) were split off
  // to the dedicated bgm-s2t endpoint so once-per-project audio-gen/STT can't
  // steal workers/VRAM from the pipeline. Concurrency = worker count (one req/worker).
  // Lowered 12→8 (2026-08-11): re-synced against the dashboard ("39/40
  // Workers deployed", Flux-TTS-ANIM 0/8 running, 0 idle) — real pod count
  // dropped since the 2026-08-04 10→12 raise; keep this matched to the
  // dashboard, not the last-known-good direction.
  { counterKey: FLUX_TTS_S2T,    endpointId: 'rnqxi6c0mlq517', workers: 8 },
  // Raised 0→2 (2026-07-21): now the primary rung for image.explainer.t2i
  // (explainer/educational/advertisement/documentary/product-promotion T2I —
  // see background.json), replacing the retired ernie-image endpoint. No
  // longer explainer-only as of 2026-08-11: EVERY tier's real T2I lives here
  // now (see this file's top comment) after flux-tts-s2t's mode:"image" broke
  // in production. Raised 3→6 (2026-08-11): re-synced against the dashboard
  // ("39/40 Workers deployed", qwen-image-gen 0/6 running, 3 idle) — this
  // number predates the routing fix and may need another real look now that
  // demand here is materially higher.
  { counterKey: QWEN_IMAGE_GEN,  endpointId: 'e165se4r3eo5hp', workers: 6 },
  // Unchanged at 4 (2026-08-11): re-confirmed against the dashboard ("39/40
  // Workers deployed", qwen-image-edit 0/4 running, 0 idle).
  { counterKey: QWEN_IMAGE_EDIT, endpointId: 'oxwx8o879qwtla', workers: 4 },
  // Keep this number matched to the real pod count: a prior mismatch (4
  // claimed vs 3 real) silently failed 13+ of 17 frames in a live premium
  // run (2026-07-05) because QM's own concurrency gate (endpointWorkers())
  // let jobs submit believing there was room, when they actually queued
  // invisibly behind RunPod's real workers. Lowered 12→10 (2026-08-11):
  // re-synced against the dashboard ("39/40 Workers deployed",
  // Wan2-14b-fp8-RTX6000ADA 0/10 running, 10 idle) — real pod count dropped
  // since the 2026-08-04 8→12 raise.
  { counterKey: WAN2_I2V,        endpointId: 'nd7wloyvj09xwy', workers: 10 },
  // bgm-s2t (ENDPOINT_ROLE=audio) — ACE-Step BGM + Whisper SRT, shared by
  // Basic + Premium. Off the per-frame hot path in terms of call volume
  // (~1 BGM call/project), but fourLang's TranscribeAudioFourLang fires up
  // to 4 concurrent SRT calls (one per language) against this same pool —
  // found live 2026-07-27: 2 of 4 concurrent SRT calls failed ("all rungs
  // exhausted", both the internal rung and the Replicate fallback) on a
  // real fourLang execution when this was still only 2 workers. Raised
  // 2→4 (2026-07-27, RunPod cap 20→30 — see FLUX_TTS_S2T's entry); left at 4
  // through the 2026-08-04 30→40 cap raise (dashboard confirmed BGM-S2T
  // 0/4 running, 4 idle — unchanged). Shares the flux2-TTS-S2T-Bgm network
  // volume with flux-tts-s2t (each endpoint loads only its own models).
  { counterKey: BGM_S2T,         endpointId: '6apg6j7suzuezw', workers: 4 },
];

export const ACCOUNT_CAP = Number(process.env.RUNPOD_ACCOUNT_CAP ?? 40);

/** Static worker count / concurrency limit for an endpoint (0 if unknown/off). */
export function endpointWorkers(counterKey: string): number {
  return FLEET.find(e => e.counterKey === counterKey)?.workers ?? 0;
}

/**
 * Per-project-type fleet plan: which endpoints to pre-warm on admission, and the
 * next-admit backlog gate. The gate watches the project type's bottleneck
 * endpoint: admit the next project only when that endpoint's backlog (queued +
 * not-yet-submitted reservations) is at/under `gateMax`, so by the time the new
 * project's jobs reach that endpoint (~2-3 min later, after its image phase) the
 * current project has drained enough to absorb them.
 */
export interface ProjectFleetPlan {
  /** Endpoints to pre-warm (all their workers) on grant. */
  endpoints: string[];
  /** Endpoint whose backlog gates the next admission. */
  gateEndpoint: string;
  /** When set, count only this operation's jobs on the gate endpoint (basic: merge). */
  gateOperation?: string;
  /** Admit next iff gate backlog <= this. (basic "< 10" == <= 9; premium "<= 6".) */
  gateMax: number;
}

export const PROJECT_FLEET: Record<string, ProjectFleetPlan> = {
  // Basic runs the per-frame pipeline on flux-tts-s2t, plus one BGM + one SRT on
  // bgm-s2t (project-level). gateOperation changed 'merge'→'animate'
  // (2026-07-27): merge moved off flux-tts-s2t onto QM-owned Lambda that same
  // day (see qm-merge-lambda-migration memory), so the old 'merge' backlog
  // lookup (byEndpointOp['runpod:flux-tts-s2t#merge']) would have silently
  // always read 0 — no merge job ever lands on that counterKey anymore — and
  // this gate would have stopped pacing next-admission on real backlog at
  // all, found while re-syncing this file against the RunPod pod-count
  // increase, not by a live incident. animate is now the terminal
  // flux-tts-s2t-hosted per-frame step (image → TTS x4 → animate →
  // [merge x4, now Lambda] → overlay x4), so it's the new cleanest
  // "frames still unfinished on this pool" signal.
  // qwen-image-gen removed from this tier's pre-warm 2026-07-27 (was added
  // 2026-07-10 for the imageModel=="ernie"/"qwen-image-gen" explainer-genre
  // text-free-image path): user confirmed narration-basic never actually
  // exercises that path at all — on-screen text is rendered via Remotion
  // overlay, not by asking the image model for a clean text-free frame, so
  // narration-basic always sends imageModel:"flux-klein-4b" and
  // RouteImageModelFourLang's ernie/qwen-image-gen branch is dead code for
  // this tier.
  // RE-ADDED 2026-08-11, for an unrelated reason: rnqxi6c0mlq517
  // (Flux-TTS-ANIM) got cut down to TTS-only in production (confirmed via a
  // live "mode 'image' not served" error), so image.narrationBasic.t2i/i2i
  // moved off it onto qwen-image-gen/qwen-image-edit (background.json) —
  // this tier now genuinely needs both warm, same as every other tier.
  'narration-basic': {
    endpoints: [FLUX_TTS_S2T, BGM_S2T, QWEN_IMAGE_GEN, QWEN_IMAGE_EDIT],
    gateEndpoint: FLUX_TTS_S2T,
    gateOperation: 'animate',
    gateMax: 9, // "< 10"
  },
  // Premium touches image (qwen-edit), video (wan2), per-frame audio/merge
  // (flux), and project-level SRT+BGM (bgm-s2t). Wan2 is the bottleneck
  // (90s/job), so it's the gate. qwen-image-gen pre-warm — same explainer-frame
  // rationale as narration-basic above (moved from ernie-image 2026-07-21);
  // Premium's RouteImageGen Choice (pipeline-stack.ts:1131-1157) hits the same
  // image.explainer.t2i rung. gateMax raised 6→8 (2026-07-27) to match Wan2's
  // real, re-confirmed pod count (fleet.ts's WAN2_I2V entry, 6→8 same day) —
  // "keep the gate matched to real capacity" reasoning, same as 2026-07-21's
  // 8→6 correction in the other direction.
  'narration-premium': {
    endpoints: [QWEN_IMAGE_EDIT, WAN2_I2V, FLUX_TTS_S2T, BGM_S2T, QWEN_IMAGE_GEN],
    gateEndpoint: WAN2_I2V,
    gateMax: 8, // "<= 8"
  },
  // Dialogue Basic (storystudio-dialogue-qm-sfn-handoff.md): narrator persona +
  // per-segment TTS on flux-tts-s2t, silent Wan2 scenes (~1 clip/5s, same
  // proportion as narration-premium), narrator lip-sync on RunComfy
  // (external — deliberately NOT pre-warmed here, it isn't a RunPod
  // endpoint), project-level SRT+BGM on bgm-s2t. Wan2 is still the shared
  // RunPod bottleneck, so it gates admission the same way narration-premium's
  // does — starting from the same gateMax until real dialogue-basic traffic
  // says otherwise.
  'dialogue-basic': {
    endpoints: [QWEN_IMAGE_GEN, QWEN_IMAGE_EDIT, WAN2_I2V, FLUX_TTS_S2T, BGM_S2T],
    gateEndpoint: WAN2_I2V,
    gateMax: 8, // "<= 8" — same starting point as narration-premium
  },
  // Dialogue Premium: image per shot (mostly i2i — coverage singles anchor on
  // a character reference, §7.10.2), per-turn TTS on flux-tts-s2t,
  // monologue/dialogue lip-sync on RunComfy (external, not pre-warmed here —
  // same reasoning as dialogue-basic), project-level SRT+BGM+ambience beds on
  // bgm-s2t. 2026-08-17: action/narration-kind video (Wan2 i2v) moved off the
  // self-hosted RunPod pod onto Replicate's hosted wan-2.2-i2v-fast
  // (background.json's video.dialoguePremium.i2v, quality-driven product
  // decision — same reasoning already proven for video.dialogueRework.i2v) —
  // no counterKey/pre-warm for it anymore, this tier no longer touches
  // WAN2_I2V at all. Gate moved to qwen-image-edit instead (every shot needs
  // one, mostly i2i) — real pod count is 4 workers (see QWEN_FLEET above),
  // gateMax kept conservatively under that pending real dialogue-premium
  // traffic under the new routing.
  'dialogue-premium': {
    endpoints: [QWEN_IMAGE_EDIT, QWEN_IMAGE_GEN, FLUX_TTS_S2T, BGM_S2T],
    gateEndpoint: QWEN_IMAGE_EDIT,
    gateMax: 3,
  },
};

/** Max projects admitted (active reservations) at once — pipelines 2 via the gate, no more. */
export const MAX_ACTIVE_PROJECTS = Number(process.env.QM_MAX_ACTIVE_PROJECTS ?? 2);
