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
import { buildImageInput } from '../steps/builders/image';
import { buildImageEditInput } from '../steps/builders/image-edit';
import { buildTtsInput } from '../steps/builders/tts';
import { buildI2vInput } from '../steps/builders/i2v';
import { buildSfxInput } from '../steps/builders/sfx';
import { buildRemotionOverlayInput } from '../steps/builders/remotion-overlay';
import { buildAnimateInput } from '../steps/builders/animate';
import { buildSfnTailInput } from '../steps/builders/sfn-tail';
import type { PayloadBuilder } from '../steps/builders/types';

export const ASSET_KINDS = [
  'qwen-image-gen',
  'qwen-edit',
  'tts',
  'wan2-i2v',
  'mmaudio',
  'animate',
  'remotion',
  'sfn-tail',
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export function isAssetKind(v: string): v is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(v);
}

/** Reserved: a kind that needs more than one provider call walks these inside
 * one row. No kind uses it today. */
export type AssetStage = string;

export interface AssetSpec {
  kind: AssetKind;
  /** The partition this agent polls — migration 013 names them this way. */
  table: string;
  endpointId: string;
  /** Frame-scoped kinds get one row per frame and are released by the
   * per-frame handoff. Project-scoped kinds ('*' as the frame id) get one row
   * per project: `sfn-tail`, whose fan-in spans every frame and is therefore
   * armed by the project compiler rather than by a handoff. */
  scope: 'frame' | 'project';
  /** How this kind's work is dispatched. 'runpod' is every asset the
   * orchestrator generates on a GPU. `remotion` is a direct, synchronous AWS
   * Lambda invoke — the same deliberate exception steps/catalog.ts's seq 16
   * makes, for the same reason: that Lambda already exists and was
   * live-tested rather than reimplemented on RunPod. `sfn-tail` starts an AWS
   * Step Functions execution (the assembly tail: ECS merge/concat/silence,
   * RunPod captions + BGM, ECS finalize) and polls it. For the last two,
   * `maxInFlight` is a self-imposed concurrency limit, not a pod count. */
  provider: 'runpod' | 'lambda' | 'sfn';
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

/** The assembly tail is an AWS Step Functions execution, not a RunPod
 * endpoint: this sentinel is never sent anywhere, it only keys in-flight
 * bookkeeping (`countInFlightForEndpoint`) the way `lambda:qm-remotion-overlay`
 * does. */
export const SFN_TAIL_ENDPOINT_ID = 'aws-sfn:tail';

/** Concurrent tail executions across all projects — an operator-set limit on
 * ECS task quota and cost, NOT a pod count (nothing in RunPod is held). */
export const SFN_TAIL_MAX_EXECUTIONS = 3;

export const ASSET_SPECS: Readonly<Record<AssetKind, AssetSpec>> = {
  'qwen-image-gen': {
    kind: 'qwen-image-gen',
    provider: 'runpod',
    gate: 'image',
    scope: 'frame',
    table: 'asset_qwen_image_gen',
    endpointId: endpointFor('runpod:qwen-image-gen'),
    maxInFlight: podsFor('runpod:qwen-image-gen'),
    timeoutMs: 300_000, // warm ~15s; cold start measured 150-190s on 2026-09-30/10-01, raised from 150s
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
    timeoutMs: 300_000, // warm ~15s; cold start measured 150-190s on 2026-09-30/10-01, raised from 150s
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
    // TTS only: BGM and captions moved to BGM-S2T (called from the SFN tail)
    // and SFX to its own MM-Audio endpoint, so this endpoint is no longer pooled.
    endpointId: endpointFor('runpod:flux-tts-s2t'),
    maxInFlight: podsFor('runpod:flux-tts-s2t'),
    timeoutMs: 300_000, // cold start measured 150-190s on 2026-09-30/10-01, raised from 150s
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
  mmaudio: {
    kind: 'mmaudio',
    provider: 'runpod',
    gate: null,
    scope: 'frame',
    table: 'asset_mmaudio',
    // MM-Audio-A40, its own endpoint again (5 pods, dashboard 2026-10-02) —
    // it was pooled onto flux-tts-s2t from 2026-09-20.
    endpointId: endpointFor('runpod:mm-audio'),
    maxInFlight: podsFor('runpod:mm-audio'),
    timeoutMs: 150_000, // operator-set
    cancelOnTimeout: true,
    legacySeq: 15,
    produces: 'video',
    stages: [],
    build: buildSfxInput,
  },
  animate: {
    // Narration-basic's motion (2026-10-03): the QM-animate Lambda renders a
    // Ken Burns clip of the frame's still, sized to its real narration. It
    // takes Wan2's place in the chain — same legacy seq, never both in one
    // plan — so the Remotion overlay and the tail read it as THE clip.
    kind: 'animate',
    scope: 'frame',
    provider: 'lambda',
    gate: null, // ffmpeg on a still: it renders or it errors
    table: 'asset_animate',
    endpointId: 'lambda:qm-animate',
    // Self-imposed: ~7s per frame at 10 GB; Lambda scales itself.
    maxInFlight: 16,
    timeoutMs: null, // synchronous invoke — see `remotion`
    cancelOnTimeout: false,
    legacySeq: 3,
    produces: 'video',
    stages: [],
    build: buildAnimateInput,
  },
  remotion: {
    // On-screen text for educational/explainer frames, rendered by the
    // existing AWS `QM-remotion-overlay` Lambda (src/lambda/client.ts) — the
    // one non-RunPod agent. It renders onto the frame's SILENT clip, before
    // the SFN tail's ECS merge mixes narration into it; in the cohort
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
  'sfn-tail': {
    // The whole project's assembly tail as ONE Step Functions execution
    // (docs/qm-sfn-ecs-tail-implementation-2026-10-02.md): ECS merges each
    // frame's clip with its narration (+SFX), concatenates and removes
    // silence; RunPod BGM-S2T then produces word-level captions and the BGM
    // in parallel; ECS finalize upscales to 1080p, burns the captions and
    // overlays the BGM. The orchestrator hands over asset REFERENCES only —
    // a manifest file on R2 — and gets back one final url.
    //
    // Project-scoped and armed by the compiler once every frame's assets
    // exist, exactly as `postprod-lite` was. It replaces `postprod-lite`,
    // `merge`, `bgm` and `dreamx-refine` (those endpoints are at 0 pods).
    kind: 'sfn-tail',
    provider: 'sfn',
    gate: null,
    scope: 'project',
    table: 'asset_sfn_tail',
    endpointId: SFN_TAIL_ENDPOINT_ID,
    maxInFlight: SFN_TAIL_MAX_EXECUTIONS,
    // Wall-clock budget for one execution. The state machine's own timeout
    // (90 min) fires first and is reported as TIMED_OUT; this only catches an
    // execution that is stuck RUNNING past that, and stops it.
    timeoutMs: 5_700_000,
    cancelOnTimeout: true,
    legacySeq: 6,
    produces: 'video',
    stages: [],
    build: buildSfnTailInput,
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
