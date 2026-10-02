/**
 * The project compiler's tail manifest — the contract between this
 * orchestrator and the assembly tail (an AWS Step Functions execution whose
 * ECS task reads this file; docs/qm-sfn-ecs-tail-implementation-2026-10-02.md).
 *
 * "Compile every asset the tail needs" made into one document: every frame's
 * clip-or-still plus its narration, and the flags for what to do after the
 * per-frame work. The BGM is NOT in here as a URL — the tail generates it
 * (`bgm.prompt`) once it knows the assembled video's real length.
 *
 * It is written to R2 as a FILE and the call carries the URL rather than the
 * document — oversized inline manifests have broken this pipeline twice (the
 * SFN 256KB DataLimitExceeded incidents of 2026-08-12 and 2026-08-17), and a
 * file is also the artifact you want to read when a project's tail produced
 * the wrong thing.
 *
 * Pure — `assets/compiler.ts` uploads it and arms the tail row with its URL.
 */
import type { AssetPlan, TailSteps } from './plan';

/** v3: read by the SFN/ECS tail. (v2 was postprod-lite's one-shot manifest, v1
 * a short-lived per-call-chain shape; neither is read by anything now.) */
export const MANIFEST_VERSION = 3;

/** What the Wan2 clips the tail sits beside use. */
export const DEFAULT_FPS = 16;

export interface ManifestFrame {
  frameId: string;
  seq: number;
  /** A generated clip. Mutually exclusive with `imageUrl`. */
  videoUrl?: string;
  /** A still for the tail to Ken Burns, when the project has no motion
   * model (`options.motionEngine: 'animate'`). */
  imageUrl?: string;
  /** Narration. Always required — the tail sizes the clip to its REAL
   * probed length, not to `durationS`. */
  audioUrl: string;
  durationS: number | null;
  narration: string;
  /** True when `videoUrl` carries MMAudio's SFX track (the mp4 MMAudio
   * returns, possibly with a Remotion overlay rendered over it): the tail
   * extracts that track and mixes it under the narration instead of taking a
   * separate SFX file. */
  sfxFromVideo?: boolean;
  animate?: { effect: string; fps: number };
}

export interface TailManifest {
  version: number;
  projectId: string;
  requestId: string;
  compiledAt: string;
  fps: number;
  project: {
    tier: string;
    product: string;
    language: string;
    aspectRatio: string;
    resolution: string;
    frameCount: number;
  };
  /** Which model actually produced each layer, so a manifest explains the
   * project it belongs to without a join. */
  chain: { image: string; motion: string | null; overlay: boolean };
  frames: ManifestFrame[];
  /** Frames that produced nothing and are therefore NOT in `frames`. Present
   * even when empty: a reader must be able to tell "no frame was dropped"
   * apart from "this manifest doesn't say". */
  droppedFrames: Array<{ frameId: string; reason: string }>;
  steps: { removeSilence: boolean; burnCaptions: boolean };
  captions?: { wordsPerGroup: number; fontSize: number; highlightColor: string; position: string };
  /** Music for the tail to generate (BGM-S2T) to the assembled video's real
   * length and overlay at `volume`. Absent when no BGM was asked for. */
  bgm?: { prompt: string; volume: number };
  options: Record<string, unknown>;
}

/** Matches the cohort path's steps/builders/bgm-overlay.ts. */
const BGM_VOLUME = 0.15;
const CAPTION_DEFAULTS = { wordsPerGroup: 3, fontSize: 64, highlightColor: 'yellow', position: 'bottom' };

export interface ManifestInput {
  projectId: string;
  requestId: string;
  plan: AssetPlan;
  request: {
    tier: string;
    product: string;
    language: string;
    aspectRatio: string;
    resolution: string;
    options: Record<string, unknown>;
  };
  frames: ManifestFrame[];
  droppedFrames: Array<{ frameId: string; reason: string }>;
  /** The request's music prompt, when `options.bgm` asked for a music bed. */
  bgmPrompt?: string;
  compiledAt?: Date;
}

export function buildManifest(input: ManifestInput): TailManifest {
  const tail: TailSteps = input.plan.tail;
  return {
    version: MANIFEST_VERSION,
    projectId: input.projectId,
    requestId: input.requestId,
    compiledAt: (input.compiledAt ?? new Date()).toISOString(),
    fps: DEFAULT_FPS,
    project: {
      tier: input.request.tier,
      product: input.request.product,
      language: input.request.language,
      aspectRatio: input.request.aspectRatio,
      resolution: input.request.resolution,
      frameCount: input.plan.frameCount,
    },
    chain: { image: input.plan.imageKind, motion: input.plan.motionKind, overlay: input.plan.frameKinds.includes('remotion') },
    frames: [...input.frames].sort((a, b) => a.seq - b.seq),
    droppedFrames: input.droppedFrames,
    steps: {
      removeSilence: tail.removeSilence,
      burnCaptions: tail.burnCaptions,
    },
    ...(tail.burnCaptions ? { captions: { ...CAPTION_DEFAULTS } } : {}),
    // Only when there is something to generate: a `bgm` with no prompt would
    // read as "mix nothing", which is the same as omitting it but says less.
    ...(tail.bgm && input.bgmPrompt ? { bgm: { prompt: input.bgmPrompt, volume: BGM_VOLUME } } : {}),
    options: input.request.options,
  };
}

/** Where the manifest file lives. Timestamped, never overwritten: a second
 * assembly attempt is a second manifest, and comparing them is how you see
 * what changed between a failed tail and its retry. */
export function manifestKey(projectId: string, at: Date = new Date()): string {
  return `pipeline-manifests/${projectId}/${at.toISOString().replace(/[:.]/g, '-')}.json`;
}
