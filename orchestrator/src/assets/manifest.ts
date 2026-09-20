/**
 * The project compiler's tail manifest (2026-09-19) — the contract between
 * this orchestrator and postprod-lite's `postprod` mode.
 *
 * "Compile every asset postprod-lite needs to run" made into one document:
 * every frame's clip-or-still plus its narration, the project's BGM track, and
 * the flags for what to do after the per-frame work. The worker does the rest
 * on one pod, on local disk, and returns one url.
 *
 * It is written to R2 as a FILE and the call carries the URL rather than the
 * document — oversized inline manifests have broken this pipeline twice (the
 * SFN 256KB DataLimitExceeded incidents of 2026-08-12 and 2026-08-17), and a
 * file is also the artifact you want to read when a project's tail produced
 * the wrong thing.
 *
 * Keep this in lockstep with `postprod-lite/API.md` §10. Pure —
 * `assets/compiler.ts` uploads it and arms the tail row with it.
 */
import type { AssetPlan, TailSteps } from './plan';

/** v2 is the one-shot manifest. (v1 was the short-lived per-call-chain shape
 * this replaced; nothing ever ran it in production.) */
export const MANIFEST_VERSION = 2;

/** postprod-lite's own default, and what the Wan2 clips it sits beside use. */
export const DEFAULT_FPS = 16;

export interface ManifestFrame {
  frameId: string;
  seq: number;
  /** A generated clip. Mutually exclusive with `imageUrl`. */
  videoUrl?: string;
  /** A still for the worker to Ken Burns, when the project has no motion
   * model (`options.motionEngine: 'animate'`). */
  imageUrl?: string;
  /** Narration. Always required — the worker sizes the clip to its REAL
   * probed length, not to `durationS`. */
  audioUrl: string;
  durationS: number | null;
  narration: string;
  /** True when `videoUrl` is MMAudio's output, which already carries the SFX
   * muxed in: the worker extracts that track and mixes it under the narration
   * instead of taking a separate SFX file. */
  sfxFromVideo?: boolean;
  /** True when `videoUrl` is the `merge` agent's own output (2026-09-20):
   * narration (and sfx, if planned) is already mixed in, so postprod-lite-v2
   * downloads it and skips straight to concat instead of merging again. Only
   * ever set when postprod-lite-v2 is the tail target (v1 has no branch for
   * it and would just harmlessly redo the merge). */
  preMerged?: boolean;
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
  steps: { removeSilence: boolean; burnCaptions: boolean; upscale: boolean };
  captions?: { wordsPerGroup: number; fontSize: number; highlightColor: string; position: string };
  bgm?: { url: string; volume: number };
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
  /** The project's generated music bed, when `options.bgm` asked for one. */
  bgmUrl?: string;
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
      upscale: tail.upscale,
    },
    ...(tail.burnCaptions ? { captions: { ...CAPTION_DEFAULTS } } : {}),
    // Only when the track actually exists. A `bgm: {url: undefined}` would
    // read as "mix nothing", which is the same as omitting it but says less.
    ...(tail.bgm && input.bgmUrl ? { bgm: { url: input.bgmUrl, volume: BGM_VOLUME } } : {}),
    options: input.request.options,
  };
}

/** Where the manifest file lives. Timestamped, never overwritten: a second
 * assembly attempt is a second manifest, and comparing them is how you see
 * what changed between a failed tail and its retry. */
export function manifestKey(projectId: string, at: Date = new Date()): string {
  return `pipeline-manifests/${projectId}/${at.toISOString().replace(/[:.]/g, '-')}.json`;
}
