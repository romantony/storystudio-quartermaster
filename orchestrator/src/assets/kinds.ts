/**
 * The asset-type registry — one entry per generator agent (2026-09-19).
 *
 * `steps/catalog.ts` is the cohort model's answer to "what does this step
 * do"; this file is the asset model's. The difference is what each one is
 * keyed by: a catalog entry is a position in one project's ordered step
 * graph, an asset spec is a KIND OF WORK that one agent owns across every
 * project at once. Nothing here mentions a cohort, a window or a sequence.
 *
 * Payload builders are reused from `steps/builders/` verbatim rather than
 * reimplemented: they are already pure `(BuildContext) -> payload` functions,
 * already exercised by builders.test.ts, and already carry hard-won
 * no-silent-degrade rules (merge throwing on a missing upscale/SFX input, i2v
 * sizing itself to the real TTS duration). `legacySeq` is what lets that
 * reuse work — it maps an asset kind back to the step seq those builders read
 * out of `ResolvedDeps`, so `assets/agent.ts` can present a row's `sources`
 * in exactly the shape they already expect.
 *
 * WORKER COUNTS ARE READ, NEVER WRITTEN. `maxInFlight` is the endpoint's real,
 * static pod count — the ceiling this kind's agent keeps itself under so the
 * eight agents cannot oversubscribe the 40-worker account cap between them.
 * No function in this file or anything downstream of it may PATCH workersMax:
 * the fixed-pod policy (memory qm-orchestrator-diagnostics-and-fixed-pods-
 * 20260917) is absolute, and an admin maintains all eight endpoints from the
 * RunPod dashboard.
 */
import { FLEET } from '../fleet-registry';
import {
  POSTPROD_LITE_V2_ENDPOINT_ID,
  POSTPROD_LITE_V2_PODS,
  DREAMX_REFINER_ENDPOINT_ID,
  AUDIO_POOL_ENDPOINT_ID,
  AUDIO_POOL_PODS,
} from '../steps/tail-endpoints';
import { buildImageInput } from '../steps/builders/image';
import { buildImageEditInput } from '../steps/builders/image-edit';
import { buildTtsInput } from '../steps/builders/tts';
import { buildI2vInput } from '../steps/builders/i2v';
import { buildUpscaleFrameInput } from '../steps/builders/upscale-frame';
import { buildSfxInput } from '../steps/builders/sfx';
import { buildBgmInput } from '../steps/builders/bgm';
import { buildMergeInput } from '../steps/builders/merge';
import { buildRemotionOverlayInput } from '../steps/builders/remotion-overlay';
import { buildPostprodInput } from '../steps/builders/postprod';
import type { PayloadBuilder } from '../steps/builders/types';

export const ASSET_KINDS = [
  'qwen-image-gen',
  'qwen-edit',
  'tts',
  'wan2-i2v',
  'dreamx-refine',
  'mmaudio',
  'remotion',
  'merge',
  'bgm',
  'postprod-lite',
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export function isAssetKind(v: string): v is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(v);
}

/** Reserved: a kind that needs more than one provider call walks these inside
 * one row. No kind uses it today — postprod-lite's merge/remove-silence/concat
 * chain became a single `postprod` call on the worker — but the Remotion
 * overlay is the obvious next user. */
export type AssetStage = string;

export interface AssetSpec {
  kind: AssetKind;
  /** The partition this agent polls — migration 013 names them this way. */
  table: string;
  endpointId: string;
  /** Frame-scoped kinds get one row per frame and are released by the
   * per-frame handoff. Project-scoped kinds ('*' as the frame id) get one row
   * per project: `bgm`, which has no per-frame input at all, and
   * `postprod-lite`, whose fan-in spans every frame and is therefore armed by
   * the project compiler rather than by a handoff. */
  scope: 'frame' | 'project';
  /** How this kind's work is dispatched. 'runpod' is everything except
   * `remotion`, which is a direct, synchronous AWS Lambda invoke — the same
   * deliberate exception steps/catalog.ts's seq 16 makes, for the same
   * reason: that Lambda already exists and was live-tested rather than
   * reimplemented on RunPod. `maxInFlight` then reads as a self-imposed
   * concurrency limit, not a pod count. */
  provider: 'runpod' | 'lambda';
  /** Which QA rubric applies to this kind's output, or null for "nothing to
   * judge". Only the three generation kinds are gated — everything after them
   * is ffmpeg, which either works or errors. A gated kind's completion does
   * NOT hand off until a verdict lands (db/repo/assets.ts's completeAsset). */
  gate: 'image' | 'motion' | null;
  /** Endpoint's real pod count. A read-only ceiling; see the file header. */
  maxInFlight: number;
  /**
   * How long ONE request to this endpoint may stay outstanding before the
   * agent cancels it and resubmits. Measured from `submitted_at`, never from
   * `updated_at` — polling the provider touches `updated_at`, so a clock
   * based on it can never age and the timeout would never fire (real bug,
   * found 2026-09-19).
   *
   * Operator's numbers (2026-09-19), from measured generation times plus cold
   * start: a warm qwen image is ~15s and a cold one ~120s, so 150s covers a
   * cold pod with headroom; Wan2 i2v gets 300s. These are deliberately tight
   * — a timeout costs one duplicate job, a wedged request costs the project.
   *
   * `null` means never time out. Only `remotion` uses it: a synchronous
   * Lambda invoke has no provider-side job to outlive or to cancel, so there
   * is nothing for a timeout to act on. It is still recovered if the invoking
   * process dies — see assets/agent.ts's lambda branch, which is orphan
   * recovery, not a timeout.
   */
  timeoutMs: number | null;
  /**
   * Whether a timeout cancels the provider job before resubmitting.
   *
   * False for `postprod-lite`: the pod enforces its own 900s execution limit,
   * so the request is already over by the time we would ask — cancelling adds
   * an API call that can only fail. Everywhere else a cancel stops a wedged
   * job from holding a pod against the endpoint's in-flight budget.
   */
  cancelOnTimeout: boolean;
  /** The step seq `steps/builders/*` read this kind's output at. */
  legacySeq: number;
  /** What the completed asset is, for the manifest and the §9.6 result. */
  produces: 'image' | 'audio' | 'video';
  /** Single-call kinds leave this empty; assets.stage stays NULL. */
  stages: readonly AssetStage[];
  /** Per stage for a multi-call kind, else the single builder. */
  build: PayloadBuilder | Readonly<Record<string, PayloadBuilder>>;
}

function endpointFor(counterKey: string): string {
  const entry = FLEET.find((e) => e.counterKey === counterKey);
  if (!entry) throw new Error(`fleet-registry.ts has no entry for ${counterKey}`);
  return entry.endpointId;
}

function podsFor(counterKey: string): number {
  const entry = FLEET.find((e) => e.counterKey === counterKey);
  if (!entry) throw new Error(`fleet-registry.ts has no entry for ${counterKey}`);
  return entry.workers;
}

/** Endpoints outside src/shared/fleet.ts (steps/tail-endpoints.ts) have no
 * generated pod count, so their real dashboard values are stated here —
 * re-synced 2026-09-20 (raised 2->4, operator's call, alongside the
 * audio-pool cutover: dreamx-refine went from opt-in to mandatory on every
 * wan2-i2v frame this same session — see plan.ts's `refine` comment — and
 * 2 pods was not going to keep up). mmaudio's and postprod-lite's own pod
 * counts moved to tail-endpoints.ts's AUDIO_POOL_PODS/POSTPROD_LITE_V2_PODS
 * (2026-09-20 pooling/merge-parallelization) — only dreamx-refine still has
 * its own siloed endpoint. */
const DREAMX_PODS = 4;

export const ASSET_SPECS: Readonly<Record<AssetKind, AssetSpec>> = {
  'qwen-image-gen': {
    kind: 'qwen-image-gen',
    provider: 'runpod',
    gate: 'image',
    scope: 'frame',
    table: 'asset_qwen_image_gen',
    endpointId: endpointFor('runpod:qwen-image-gen'),
    maxInFlight: podsFor('runpod:qwen-image-gen'),
    timeoutMs: 150_000, // warm ~15s, cold pod ~120s
    cancelOnTimeout: true,
    legacySeq: 1,
    produces: 'image',
    stages: [],
    build: buildImageInput,
  },
  'qwen-edit': {
    kind: 'qwen-edit',
    provider: 'runpod',
    gate: 'image',
    scope: 'frame',
    table: 'asset_qwen_edit',
    endpointId: endpointFor('runpod:qwen-image-edit'),
    maxInFlight: podsFor('runpod:qwen-image-edit'),
    timeoutMs: 150_000, // warm ~15s, cold pod ~120s
    cancelOnTimeout: true,
    legacySeq: 0,
    produces: 'image',
    stages: [],
    build: buildImageEditInput,
  },
  tts: {
    kind: 'tts',
    provider: 'runpod',
    gate: null,
    scope: 'frame',
    table: 'asset_tts',
    // Same physical endpoint as ever (flux-tts-s2t, rnqxi6c0mlq517) — now
    // pooled with mmaudio+bgm, repurposed in place (image swapped, workers
    // raised 5->7, tail-endpoints.ts) rather than moved to a new endpoint.
    endpointId: AUDIO_POOL_ENDPOINT_ID,
    maxInFlight: AUDIO_POOL_PODS,
    timeoutMs: 150_000, // operator-set
    cancelOnTimeout: true,
    legacySeq: 2,
    produces: 'audio',
    stages: [],
    build: buildTtsInput,
  },
  'wan2-i2v': {
    kind: 'wan2-i2v',
    provider: 'runpod',
    gate: 'motion',
    scope: 'frame',
    table: 'asset_wan2_i2v',
    endpointId: endpointFor('runpod:wan2-i2v'),
    maxInFlight: podsFor('runpod:wan2-i2v'),
    // The long pole of the whole pipeline; a cold worker plus a queued
    // 5-second clip is routinely minutes, not seconds.
    timeoutMs: 300_000, // the long pole — a 5s clip on a cold pod
    cancelOnTimeout: true,
    legacySeq: 3,
    produces: 'video',
    stages: [],
    build: buildI2vInput,
  },
  'dreamx-refine': {
    kind: 'dreamx-refine',
    provider: 'runpod',
    gate: null,
    scope: 'frame',
    table: 'asset_dreamx_refine',
    endpointId: DREAMX_REFINER_ENDPOINT_ID,
    maxInFlight: DREAMX_PODS,
    timeoutMs: 150_000, // operator-set
    cancelOnTimeout: true,
    legacySeq: 14,
    produces: 'video',
    stages: [],
    build: buildUpscaleFrameInput,
  },
  mmaudio: {
    kind: 'mmaudio',
    provider: 'runpod',
    gate: null,
    scope: 'frame',
    table: 'asset_mmaudio',
    // Pooled onto the ex-TTS-only endpoint, now 7 pods shared with tts+bgm
    // (tail-endpoints.ts) — was its own siloed 2-pod endpoint, MM-Audio-A40,
    // decommissioned (scaled to 0) 2026-09-20.
    endpointId: AUDIO_POOL_ENDPOINT_ID,
    maxInFlight: AUDIO_POOL_PODS,
    timeoutMs: 150_000, // operator-set
    cancelOnTimeout: true,
    legacySeq: 15,
    produces: 'video',
    stages: [],
    build: buildSfxInput,
  },
  remotion: {
    // On-screen text for educational/explainer frames, rendered by the
    // existing AWS `QM-remotion-overlay` Lambda (src/lambda/client.ts) — the
    // one non-RunPod agent. It renders onto the frame's SILENT clip, before
    // the postprod-lite one-shot merges narration into it; in the cohort
    // model the equivalent step sits after merge instead, because there the
    // merge is its own call.
    //
    // A frame with no `textManifest` is a passthrough: the builder returns a
    // marker and the agent completes the row with the clip unchanged, never
    // invoking Lambda. That keeps a mixed project (some frames captioned,
    // some not) from dropping the uncaptioned ones.
    kind: 'remotion',
    scope: 'frame',
    provider: 'lambda',
    gate: null,
    table: 'asset_remotion',
    // A sentinel, never passed to RunPod — logging and in-flight bookkeeping
    // only, matching steps/catalog.ts's seq 16.
    endpointId: 'lambda:qm-remotion-overlay',
    // Self-imposed: Lambda scales itself, but each render is ~11-17s and
    // costs, so this bounds how many frames are in flight at once.
    maxInFlight: 8,
    // No timeout and no cancellation (operator, 2026-09-19): a synchronous
    // Lambda invoke has no provider-side job to outlive or to cancel. A row
    // left `submitted` because the invoking process died is still recovered,
    // by the lambda branch of assets/agent.ts's reconcile — that is orphan
    // recovery, not a timeout.
    timeoutMs: null,
    cancelOnTimeout: false,
    // The seq the cohort path's overlay output is read at.
    legacySeq: 16,
    produces: 'video',
    stages: [],
    build: buildRemotionOverlayInput,
  },
  merge: {
    // Frame + narration -> one clip, moved OUT of the postprod-lite one-shot
    // tail and into its own parallel per-frame agent (2026-09-20 merge-
    // parallelization — docs/qm-orchestrator-three-project-run-analysis-
    // 2026-09-19.md's follow-up). Reuses steps/builders/merge.ts VERBATIM —
    // it already reads exactly the same resolvedDeps seqs (2=tts, 3=wan2-i2v,
    // 14=dreamx-refine, 15=mmaudio, 16=remotion) this kind's `requires` graph
    // resolves (assets/plan.ts), because it is the SAME step the cohort
    // model already calls "merge" at seq 6.
    //
    // Only planned when the project has a motion model at all: an
    // `motionEngine:'animate'` project has no per-frame clip to pre-merge —
    // Ken Burns only happens inside the tail — so it keeps merging there,
    // same as before this kind existed.
    //
    // Targets postprod-lite-v2's endpoint, not v1's: v1's `_prepare_frame`
    // has no `preMerged` branch, so it would just re-merge a clip that
    // already has narration in it — harmless but pointless. `postprod-lite`
    // below points at the same v2 endpoint for the same reason; they move
    // together.
    kind: 'merge',
    provider: 'runpod',
    gate: null,
    scope: 'frame',
    table: 'asset_merge',
    endpointId: POSTPROD_LITE_V2_ENDPOINT_ID,
    maxInFlight: POSTPROD_LITE_V2_PODS,
    timeoutMs: 150_000, // ffmpeg mux, `-c:v copy` — fast, same budget class as mmaudio/dreamx-refine
    cancelOnTimeout: true,
    legacySeq: 6, // the cohort model's own 'merge' step — see steps/catalog.ts seq 6
    produces: 'video',
    stages: [],
    build: buildMergeInput,
  },
  bgm: {
    // Project-scoped, and the only kind with no per-frame anything: one music
    // bed for the whole video, generated in parallel with every frame's work
    // and handed to the tail as `manifest.bgm.url`. It exists as an agent
    // rather than as a call the compiler makes inline so the track is ready
    // BEFORE assembly starts instead of adding a cold ACE-Step generation to
    // the critical path — and so it retries, reworks and reports like any
    // other asset.
    kind: 'bgm',
    provider: 'runpod',
    gate: null,
    scope: 'project',
    table: 'asset_bgm',
    // Pooled onto the ex-TTS-only endpoint, now 7 pods shared with tts+mmaudio
    // (tail-endpoints.ts) — was its own siloed 2-pod endpoint, BGM-S2T,
    // decommissioned (scaled to 0) 2026-09-20.
    endpointId: AUDIO_POOL_ENDPOINT_ID,
    maxInFlight: AUDIO_POOL_PODS,
    // Same as MMAudio (operator, 2026-09-19).
    timeoutMs: 150_000,
    cancelOnTimeout: true,
    legacySeq: 5,
    produces: 'audio',
    stages: [],
    build: buildBgmInput,
  },
  'postprod-lite': {
    // The whole project's tail in ONE call: animate stills (where there is no
    // generated clip), merge each frame's narration and SFX, trim silences,
    // concat, burn captions, mix the BGM — all on one pod, all on that pod's
    // local disk, returning one final url. Nothing intermediate is ever
    // uploaded, which is both why concurrent projects cannot mix assets and
    // why this replaced a per-frame call chain that round-tripped every clip
    // through R2 twice.
    //
    // Project-scoped, so `maxInFlight` reads as "how many projects assemble at
    // once" — one per pod, exactly as intended.
    kind: 'postprod-lite',
    provider: 'runpod',
    gate: null,
    scope: 'project',
    table: 'asset_postprod_lite',
    // v2, not v1 (tail-endpoints.ts) — v1 is untouched and still live; v2 has
    // the concat-normalize/bgm-loop/av-assert fixes and understands a
    // `merge`-produced `preMerged` clip.
    endpointId: POSTPROD_LITE_V2_ENDPOINT_ID,
    maxInFlight: POSTPROD_LITE_V2_PODS,
    // 900s, matching the pod's OWN execution limit (operator, 2026-09-19) —
    // so this fires at the moment the worker has already given up, never
    // before. Measured 2026-09-19 on a real 10-frame project: 33s.
    //
    // No cancel: the pod has already timed the request out by then, so the
    // call could only fail. Resubmit straight away.
    timeoutMs: 900_000,
    cancelOnTimeout: false,
    legacySeq: 6,
    produces: 'video',
    stages: [],
    build: buildPostprodInput,
  },
};

export function assetSpec(kind: AssetKind): AssetSpec {
  return ASSET_SPECS[kind];
}

/** The builder for a row's current stage (or the kind's only builder). */
export function builderFor(spec: AssetSpec, stage: string | null): PayloadBuilder {
  if (typeof spec.build === 'function') return spec.build;
  const b = stage ? spec.build[stage] : undefined;
  if (!b) throw new Error(`${spec.kind}: no payload builder for stage ${stage ?? '(none)'}`);
  return b;
}

/** Sum of every kind's in-flight ceiling — the number that must stay inside
 * the RunPod account cap once every agent is saturated. Counted per endpoint,
 * so two kinds sharing one endpoint count its pods once. */
export function totalInFlightCeiling(): number {
  const perEndpoint = new Map<string, number>();
  for (const spec of Object.values(ASSET_SPECS)) {
    perEndpoint.set(spec.endpointId, Math.max(perEndpoint.get(spec.endpointId) ?? 0, spec.maxInFlight));
  }
  return [...perEndpoint.values()].reduce((a, b) => a + b, 0);
}
