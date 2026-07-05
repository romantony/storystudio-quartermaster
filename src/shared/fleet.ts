/**
 * Single source of truth for the RunPod fleet shape.
 *
 * Consumed by the executor (per-endpoint concurrency limit), the provisioner
 * (static workersMax ceiling + scale targets), and admission (which endpoints a
 * project touches + the next-admit backlog gate). One place defines 0/4/2/4 so
 * capacity planning, real SFN parallelism, and worker provisioning can never
 * drift apart — a mismatch there is what silently dropped 12 of 21 frames in the
 * first live premium run (2026-07-04).
 *
 * Model (agreed with StoryStudio 2026-07-04):
 *   - `workers` is BOTH the static max worker count AND the QM concurrency limit
 *     for that endpoint — they are the same number because QM should feed a pod
 *     at its real pod rate, not oversubmit and let RunPod's queue (or an
 *     overwhelmed external fallback) absorb the overflow.
 *   - The five `workers` sum to ACCOUNT_CAP (10), so it's a *static* allocation,
 *     never dynamically reshuffled.
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
  // TTS-kokoro, TTS-qwen, animate, merge, and the one-shot `pipeline` (~20
  // calls/project). BGM (ACE-Step) + SRT (Whisper) were split off to the
  // dedicated bgm-s2t endpoint so once-per-project audio-gen/STT can't steal
  // workers/VRAM from the pipeline. Concurrency = worker count (one req/worker).
  { counterKey: FLUX_TTS_S2T,    endpointId: 'rnqxi6c0mlq517', workers: 3 },
  // Off: StoryStudio always sends a character reference (→ i2i on qwen-image-edit),
  // and reference-less premium frames route to Flux4b t2i on flux-tts-s2t. Raise
  // to 2 only if a dedicated premium t2i endpoint is ever needed.
  { counterKey: QWEN_IMAGE_GEN,  endpointId: 'e165se4r3eo5hp', workers: 0 },
  { counterKey: QWEN_IMAGE_EDIT, endpointId: 'oxwx8o879qwtla', workers: 2 },
  { counterKey: WAN2_I2V,        endpointId: 'nd7wloyvj09xwy', workers: 4 },
  // bgm-s2t (ENDPOINT_ROLE=audio) — ACE-Step BGM + Whisper SRT, ~1 call each per
  // project, shared by Basic + Premium. 1 worker: it's off the per-frame hot
  // path, so low concurrency is fine. Shares the flux2-TTS-S2T-Bgm network
  // volume with flux-tts-s2t (each endpoint loads only its own models).
  { counterKey: BGM_S2T,         endpointId: '6apg6j7suzuezw', workers: 1 },
];

export const ACCOUNT_CAP = Number(process.env.RUNPOD_ACCOUNT_CAP ?? 10);

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
