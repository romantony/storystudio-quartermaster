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
 *     reshuffled, currently summing to 18 of ACCOUNT_CAP's 20 (raised from 10
 *     once account balance crossed $200, confirmed against the RunPod
 *     dashboard 2026-07-07: Flux-TTS-ANIM=6, qwen-image-gen=0,
 *     qwen-image-edit=2, Wan2-14b-fp8-RTX6000ADA=8, BGM-S2T=2 — 2 units of
 *     headroom, not artificially inflated to hit the cap). ernie-image sits on
 *     its own dedicated GPU/volume outside this pool (see its entry below), so
 *     it isn't part of that sum and isn't in provisioner.ts's ENDPOINTS (the
 *     list that actually enforces the shared account cap — a separate array
 *     from this file's FLEET).
 *   - Idle floor is 0 (true scale-to-zero) — we don't pay for a warm worker with
 *     no job in front of it. Pre-warm raises workers only on admission, timed to
 *     overlap the ~2-3 min cold start with Convex's brain window.
 */

export const FLUX_TTS_S2T = 'runpod:flux-tts-s2t';
export const QWEN_IMAGE_GEN = 'runpod:qwen-image-gen';
export const QWEN_IMAGE_EDIT = 'runpod:qwen-image-edit';
export const WAN2_I2V = 'runpod:wan2-i2v';
export const BGM_S2T = 'runpod:bgm-s2t';
export const ERNIE_IMAGE = 'runpod:ernie-image';

export interface FleetEndpoint {
  counterKey: string;
  endpointId: string;
  /** Static max workers == QM concurrency limit == real pod count. */
  workers: number;
}

export const FLEET: FleetEndpoint[] = [
  // flux-tts-s2t (ENDPOINT_ROLE=media) hosts the hot per-frame path: t2i, i2i,
  // TTS-kokoro, TTS-qwen, animate, merge, and the one-shot `pipeline` (~20
  // calls/project). BGM (ACE-Step) + SRT (Whisper) were split off to the
  // dedicated bgm-s2t endpoint so once-per-project audio-gen/STT can't steal
  // workers/VRAM from the pipeline. Concurrency = worker count (one req/worker).
  // Raised 3→6 (2026-07-07): account balance crossed $200, RunPod cap doubled
  // 10→20; confirmed against the dashboard (Flux-TTS-ANIM 0/6 running, 4 idle).
  { counterKey: FLUX_TTS_S2T,    endpointId: 'rnqxi6c0mlq517', workers: 6 },
  // Off: StoryStudio always sends a character reference (→ i2i on qwen-image-edit),
  // and reference-less premium frames route to Flux4b t2i on flux-tts-s2t. Raise
  // to 2 only if a dedicated premium t2i endpoint is ever needed.
  { counterKey: QWEN_IMAGE_GEN,  endpointId: 'e165se4r3eo5hp', workers: 0 },
  { counterKey: QWEN_IMAGE_EDIT, endpointId: 'oxwx8o879qwtla', workers: 2 },
  // Raised 3→8 (2026-07-07): account balance crossed $200, RunPod cap doubled
  // 10→20; confirmed against the dashboard (Wan2-14b-fp8-RTX6000ADA 0/8
  // running, 8 idle) — 8 real Wan2 pods now exist. Keep this number matched to
  // the real pod count: a prior mismatch (4 claimed vs 3 real) silently failed
  // 13+ of 17 frames in a live premium run (2026-07-05) because QM's own
  // concurrency gate (endpointWorkers()) let jobs submit believing there was
  // room, when they actually queued invisibly behind RunPod's real workers.
  { counterKey: WAN2_I2V,        endpointId: 'nd7wloyvj09xwy', workers: 8 },
  // bgm-s2t (ENDPOINT_ROLE=audio) — ACE-Step BGM + Whisper SRT, ~1 call each per
  // project, shared by Basic + Premium. Off the per-frame hot path, so low
  // concurrency is fine. Shares the flux2-TTS-S2T-Bgm network volume with
  // flux-tts-s2t (each endpoint loads only its own models). Raised 1→2
  // (2026-07-07) to match the dashboard (BGM-S2T 0/2 running, 2 idle).
  { counterKey: BGM_S2T,         endpointId: '6apg6j7suzuezw', workers: 2 },
  // ernie-image — baidu/ERNIE-Image-Turbo, dedicated A40 (own network volume,
  // not shared with flux-tts-s2t/bgm-s2t). Explainer/educational t2i where
  // in-image text must render correctly (image.explainer.t2i) — validated
  // strongest at dense EN text; non-EN routing stays on nano-banana until
  // language-conditional rung selection is added. Standalone: NOT in
  // PROJECT_FLEET (no admission-gated project type calls it yet) and NOT in
  // provisioner.ts's ENDPOINTS (that list enforces the shared narration
  // account cap; this endpoint's own worker sits outside that pool on its own
  // GPU, so it doesn't compete with flux/qwen/wan2 for the cap). Raised 1→2
  // (2026-07-07) to match the dashboard (story-studio-ernie 0/2 running, 2 idle).
  { counterKey: ERNIE_IMAGE,     endpointId: 'teaye48ss7oywb', workers: 2 },
];

export const ACCOUNT_CAP = Number(process.env.RUNPOD_ACCOUNT_CAP ?? 20);

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
  /** Admit next iff gate backlog <= this. (basic "< 10" == <= 9; premium "<= 8".) */
  gateMax: number;
}

export const PROJECT_FLEET: Record<string, ProjectFleetPlan> = {
  // Basic runs the per-frame pipeline on flux-tts-s2t, plus one BGM + one SRT on
  // bgm-s2t (project-level). Merge is the terminal per-frame step, so its backlog
  // is the cleanest "frames still unfinished" signal → still the gate.
  'narration-basic': {
    endpoints: [FLUX_TTS_S2T, BGM_S2T],
    gateEndpoint: FLUX_TTS_S2T,
    gateOperation: 'merge',
    gateMax: 9, // "< 10"
  },
  // Premium touches image (qwen-edit), video (wan2), per-frame audio/merge
  // (flux), and project-level SRT+BGM (bgm-s2t). Wan2 is the bottleneck
  // (90s/job), so it's the gate.
  'narration-premium': {
    endpoints: [QWEN_IMAGE_EDIT, WAN2_I2V, FLUX_TTS_S2T, BGM_S2T],
    gateEndpoint: WAN2_I2V,
    gateMax: 8, // "<= 8"
  },
};

/** Max projects admitted (active reservations) at once — pipelines 2 via the gate, no more. */
export const MAX_ACTIVE_PROJECTS = Number(process.env.QM_MAX_ACTIVE_PROJECTS ?? 2);
