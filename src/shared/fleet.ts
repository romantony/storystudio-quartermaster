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
 *     reshuffled, summing to 35 of ACCOUNT_CAP's 40 (account-wide cap raised
 *     30→40 on 2026-08-04; qwen-image-gen raised 0→2 on 2026-07-21 when the
 *     explainer/educational/advertisement/documentary/product-promotion T2I
 *     rung moved onto it from the now-retired ernie-image endpoint — see
 *     image.explainer.t2i in background.json).
 *     Re-confirmed against the dashboard 2026-08-04 ("39/40 Workers
 *     deployed"): Flux-TTS-ANIM=12 (was 10), qwen-image-gen=3 (was 2),
 *     qwen-image-edit=4 (was 2), Wan2-14b-fp8-RTX6000ADA=12 (was 8),
 *     BGM-S2T=4 (unchanged). The other 4 of the account's 40 total deployed
 *     workers are outside this pool entirely (long2shorts=4 — a direct
 *     RunPod call, see pipeline-stack.ts's ShortsTriggerFunction — not
 *     routed through QM's catalog/provisioner, so it isn't tracked here;
 *     story-studio-ernie and story-studio-stable-video are both at 0).
 *   - Idle floor is 0 (true scale-to-zero) — we don't pay for a warm worker with
 *     no job in front of it. Pre-warm raises workers only on admission, timed to
 *     overlap the ~2-3 min cold start with Convex's brain window.
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
  // flux-tts-s2t (ENDPOINT_ROLE=media) hosts the hot per-frame path: t2i, i2i,
  // TTS-kokoro, TTS-qwen, animate, and the one-shot `pipeline` (~20
  // calls/project) — merge moved off this pool onto QM-owned Lambda
  // 2026-07-27 (see qm-merge-lambda-migration memory), directly relieving
  // the contention that caused real image-t2i/TTS timeouts here the same
  // day. BGM (ACE-Step) + SRT (Whisper) were split off to the dedicated
  // bgm-s2t endpoint so once-per-project audio-gen/STT can't steal
  // workers/VRAM from the pipeline. Concurrency = worker count (one req/worker).
  // Raised 10→12 (2026-08-04): RunPod account cap raised 30→40 same day;
  // confirmed against the dashboard ("39/40 Workers deployed", Flux-TTS-ANIM
  // 0/12 running, 9 idle).
  { counterKey: FLUX_TTS_S2T,    endpointId: 'rnqxi6c0mlq517', workers: 12 },
  // Raised 0→2 (2026-07-21): now the primary rung for image.explainer.t2i
  // (explainer/educational/advertisement/documentary/product-promotion T2I —
  // see background.json), replacing the retired ernie-image endpoint. Premium
  // frames without a character reference still route to Flux4b t2i on
  // flux-tts-s2t, not here — this endpoint is explainer-tier only for now.
  // Raised 2→3 (2026-08-04, RunPod cap 30→40 — see FLUX_TTS_S2T's entry);
  // confirmed against the dashboard ("39/40 Workers deployed", qwen-image-gen
  // 0/3 running, 2 idle).
  { counterKey: QWEN_IMAGE_GEN,  endpointId: 'e165se4r3eo5hp', workers: 3 },
  // Raised 2→4 (2026-08-04, RunPod cap 30→40 — see FLUX_TTS_S2T's entry);
  // confirmed against the dashboard ("39/40 Workers deployed", qwen-image-edit
  // 1/4 running, 0 idle).
  { counterKey: QWEN_IMAGE_EDIT, endpointId: 'oxwx8o879qwtla', workers: 4 },
  // Raised 8→12 (2026-08-04, RunPod cap 30→40 — see FLUX_TTS_S2T's entry).
  // Keep this number matched to the real pod count: a prior mismatch (4
  // claimed vs 3 real) silently failed 13+ of 17 frames in a live premium
  // run (2026-07-05) because QM's own concurrency gate (endpointWorkers())
  // let jobs submit believing there was room, when they actually queued
  // invisibly behind RunPod's real workers. Re-confirmed against the
  // dashboard 2026-08-04 ("39/40 Workers deployed", Wan2-14b-fp8-RTX6000ADA
  // 3/12 running, 1 queued, 5 idle).
  { counterKey: WAN2_I2V,        endpointId: 'nd7wloyvj09xwy', workers: 12 },
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
  // this tier. Pre-warming qwen-image-gen here was real wasted RunPod spend
  // on every single narration-basic admission for a path that never fires.
  // (Premium's PROJECT_FLEET entry below keeps its own qwen-image-gen
  // pre-warm — Premium's text-free-genre frames are confirmed live traffic,
  // per that entry's own comment.)
  'narration-basic': {
    endpoints: [FLUX_TTS_S2T, BGM_S2T],
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
  // a character reference, §7.10.2), Wan2 only for `action` shots (NOT
  // derivable from duration — see assetLoad.ts's shotCounts-aware estimate),
  // per-turn TTS on flux-tts-s2t, monologue/dialogue lip-sync on RunComfy
  // (external, not pre-warmed here — same reasoning as dialogue-basic),
  // project-level SRT+BGM+ambience beds on bgm-s2t. Wan2 still gates
  // admission even though its share of shots is now the minority (§1) —
  // it remains the slowest per-job endpoint this tier touches.
  'dialogue-premium': {
    endpoints: [QWEN_IMAGE_EDIT, QWEN_IMAGE_GEN, WAN2_I2V, FLUX_TTS_S2T, BGM_S2T],
    gateEndpoint: WAN2_I2V,
    gateMax: 8,
  },
};

/** Max projects admitted (active reservations) at once — pipelines 2 via the gate, no more. */
export const MAX_ACTIVE_PROJECTS = Number(process.env.QM_MAX_ACTIVE_PROJECTS ?? 2);
