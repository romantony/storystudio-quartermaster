/**
 * Step id -> { endpoint, workers, gate, payload builder } (impl plan §2's
 * repo layout, `steps/catalog.ts`).
 *
 * M2 registered steps 1-3 (image, tts, animation) — the vertical slice that
 * milestone was scoped to. `agents/planner.ts` resolves the FULL spec
 * step-set from the request's tier/options (§6.2 step 2) but only emits
 * `steps[]`/`jobs` rows for steps present here, logging a warning for
 * anything resolved-but-uncatalogued. planner.ts does not change as more
 * steps land — that part of the original comment still holds.
 *
 * What DOES change, added with step 6 (M5 phase 1, 2026-09-11): `scope`.
 * Steps 1-5 are bulk/stage-major (asset-type-scoped — no job depends on
 * another project's output) and run through agents/generator.ts's
 * runStep() across the whole cohort at once, exactly as before. Steps 6-13
 * are assembly — project-scoped by nature (you cannot merge project A's
 * audio with project B's video) — and run through the new
 * agents/assembler.ts, one project's whole tail at a time. See
 * docs/qm-orchestrator-implementation-plan.md §6.10/§9 for the full
 * reasoning. agents/orchestrator.ts's driveCohort() branches on this field.
 */
import { FLEET } from '../fleet-registry';
import { POSTPROD_LITE_ENDPOINT_ID, DREAMX_REFINER_ENDPOINT_ID, AUDIO_POOL_ENDPOINT_ID } from './tail-endpoints';
import { buildImageInput } from './builders/image';
import { buildImageEditInput } from './builders/image-edit';
import { buildTtsInput } from './builders/tts';
import { buildI2vInput } from './builders/i2v';
import { buildMergeInput } from './builders/merge';
import { buildConcatInput } from './builders/concat';
import { buildUpscaleInput } from './builders/upscale';
import { buildCaptionInput } from './builders/caption';
import { buildBgmInput } from './builders/bgm';
import { buildBgmOverlayInput } from './builders/bgm-overlay';
import { buildRemoveSilenceInput } from './builders/remove-silence';
import { buildRemotionOverlayInput } from './builders/remotion-overlay';
import { buildUpscaleFrameInput } from './builders/upscale-frame';
import { buildSfxInput } from './builders/sfx';
import { buildFluxImageInput, buildReplicateWanInput, buildNormalizeInput } from './builders/fallbacks';
import type { BuildContext, FallbackRung, FrameJobInput, PayloadBuilder } from './builders/types';

function endpointFor(counterKey: string): string {
  const entry = FLEET.find((e) => e.counterKey === counterKey);
  if (!entry) throw new Error(`fleet-registry.ts has no entry for ${counterKey}`);
  return entry.endpointId;
}

/** Fixed pod count for a FLEET endpoint (2026-09-17), used as `maxWorkers` so
 * agents/planner.ts's workersTarget never exceeds the endpoint's real,
 * static pool — see agents/fleet.ts's header comment for why this replaced
 * dynamically PATCHing workersMax per step. */
function maxWorkersFor(counterKey: string): number {
  const entry = FLEET.find((e) => e.counterKey === counterKey);
  if (!entry) throw new Error(`fleet-registry.ts has no entry for ${counterKey}`);
  return entry.workers;
}

/** Image model switch: FLUX.2 klein 4B on qwen-image-gen (steps 0 and 1). */
const FLUX_IMAGE_FALLBACK = (): FallbackRoute => ({
  provider: 'runpod',
  endpointId: endpointFor('runpod:qwen-image-gen'),
  builder: buildFluxImageInput,
  auxWorkers: 2,
});

/** Motion model switch: Replicate Wan 2.2 i2v fast, normalized on postprod-lite (step 3). */
export const REPLICATE_WAN_FALLBACK_MODEL = 'wan-video/wan-2.2-i2v-fast';

/** 'bulk' = agents/generator.ts drives it across the whole cohort at once.
 * 'project' = agents/assembler.ts drives it one project's tail at a time.
 * See this file's header comment. */
export type StepScope = 'bulk' | 'project';

export interface CatalogEntry {
  seq: number;
  name: string;
  endpointId: string;
  gate: string | null;
  dependsOn: number[];
  scope: StepScope;
  /** Dispatch mechanism for this step's jobs. Unset/'runpod' preserves
   * today's `deps.runpod.run/status/health` protocol (agents/generator.ts).
   * 'lambda' is the one deliberate exception (2026-09-16, Remotion text
   * overlay): a direct, synchronous AWS Lambda invoke instead — no
   * run/status/webhook cycle, no RunPod worker allocation/health-check
   * applies (agents/generator.ts's submitOne()/runStep() both branch on
   * this). config.ts still has no other AWS SDK usage; this is the one
   * exception, made because the Remotion Lambda already exists and was
   * live-tested rather than reimplemented on RunPod. */
  source?: 'runpod' | 'lambda';
  /** Orthogonal to `scope`: when true, agents/planner.ts plans exactly ONE
   * job for this step per project (frameId: null) instead of one per frame,
   * fanned in on ALL of dependsOn's per-frame outputs — see
   * agents/generator.ts's resolveProjectDeps() and
   * steps/builders/concat.ts's header comment for the full mechanism.
   * Unset/false preserves today's one-job-per-frame behavior. */
  singleJobPerProject?: boolean;
  /** Hard ceiling on this step's workers_target, applied by
   * agents/planner.ts on top of cfg.workersHead. For an endpoint whose real
   * capacity is far below the cohort-scale default (step 14's DreamX
   * refiner: 3 RTX 6000 Ada workers, not 25) — without it allocate() would
   * PATCH workersMax to 25 and eat most of the 40-worker account cap. */
  maxWorkers?: number;
  builder: PayloadBuilder;
  /** Model-switch routes the quality gate can send a frame to on its last
   * rework (FrameJobInput.fallbackRung). See steps/builders/fallbacks.ts. */
  fallbacks?: Partial<Record<FallbackRung, FallbackRoute>>;
}

export type FallbackRoute =
  | {
      provider: 'runpod';
      endpointId: string;
      builder: PayloadBuilder;
      /** workersMax the driver raises on this endpoint for the step when it
       * isn't the step's own endpoint (agents/fleet.ts allocateAuxiliary). */
      auxWorkers: number;
    }
  | {
      provider: 'replicate';
      model: string;
      builder: PayloadBuilder;
      /** Second hop on RunPod once the prediction succeeds. */
      normalize: { endpointId: string; builder: (videoUrl: string, ctx: Pick<BuildContext, 'projectId' | 'frameId'>) => Record<string, unknown> };
      auxWorkers: number;
    };

/** The route a job's next attempt uses, if the gate switched its model. */
export function fallbackRouteFor(step: Pick<CatalogEntry, 'fallbacks'>, input: unknown): FallbackRoute | undefined {
  const rung = (input as FrameJobInput | null)?.fallbackRung;
  return rung ? step.fallbacks?.[rung] : undefined;
}

/** RunPod endpoints a step's fallbacks may submit to, other than its own. */
export function auxiliaryEndpoints(step: Pick<CatalogEntry, 'endpointId' | 'fallbacks'>): Array<{ endpointId: string; workers: number }> {
  const out = new Map<string, number>();
  for (const route of Object.values(step.fallbacks ?? {})) {
    if (!route) continue;
    const endpointId = route.provider === 'runpod' ? route.endpointId : route.normalize.endpointId;
    if (endpointId !== step.endpointId) out.set(endpointId, Math.max(out.get(endpointId) ?? 0, route.auxWorkers));
  }
  return [...out].map(([endpointId, workers]) => ({ endpointId, workers }));
}

// Deliberately no `workers` field here — worker count is a plan-time,
// cohort-scale decision (cfg.workersHead/workersTail), not a fact about
// which step this is. agents/planner.ts sets each planned step's
// workers_target from config; agents/fleet.ts verifies against whatever was
// actually persisted for that cohort, which is what lets the M2 acceptance
// run hand-scale one endpoint to a small real number (see the M2 plan's
// decision 5) instead of always expecting a full 25. `maxWorkers` above is
// only a ceiling on that config value, never a target.
export const STEP_CATALOG: readonly CatalogEntry[] = [
  {
    // Narration Premium's reference-image flow (options.referenceImage) —
    // mutually exclusive with seq 1 (see agents/planner.ts's STEP_TOPOLOGY).
    // seq 0, not a new number after 13: it must sort BEFORE seq 1/2/3/6,
    // since agents/orchestrator.ts's driveCohort() runs bulk steps in strict
    // ascending seq order, and this replaces step 1's position in the plan
    // when it runs. Not part of the original 1-13 spec topology, same kind
    // of orchestrator-specific extension as tail-endpoints.ts's
    // POSTPROD_LITE_ENDPOINT_ID.
    seq: 0,
    name: 'image-i2i',
    endpointId: endpointFor('runpod:qwen-image-edit'),
    gate: 'image', // same gate as seq 1 — quality.ts keys off `gate`, not seq
    dependsOn: [],
    scope: 'bulk',
    maxWorkers: maxWorkersFor('runpod:qwen-image-edit'), // fixed pod pool — see agents/fleet.ts
    builder: buildImageEditInput,
    fallbacks: { 'flux-4b': FLUX_IMAGE_FALLBACK() },
  },
  {
    seq: 1,
    name: 'image',
    endpointId: endpointFor('runpod:qwen-image-gen'),
    gate: 'image', // §6.5's image gate — M4
    dependsOn: [],
    scope: 'bulk',
    maxWorkers: maxWorkersFor('runpod:qwen-image-gen'), // fixed pod pool — see agents/fleet.ts
    builder: buildImageInput,
    // Same endpoint as the step itself, so no auxiliary allocation — but a
    // worker that already loaded Qwen may OOM loading Flux too
    // (~/Qwen-Edit/docs/quartermaster-endpoint-integration.md); a failed
    // fallback retries via markFailedOrRetry and lands on another worker.
    fallbacks: { 'flux-4b': FLUX_IMAGE_FALLBACK() },
  },
  {
    seq: 2,
    name: 'tts',
    endpointId: endpointFor('runpod:flux-tts-s2t'),
    gate: null,
    dependsOn: [],
    scope: 'bulk',
    maxWorkers: maxWorkersFor('runpod:flux-tts-s2t'), // fixed pod pool — see agents/fleet.ts
    builder: buildTtsInput,
  },
  {
    seq: 3,
    name: 'animation',
    endpointId: endpointFor('runpod:wan2-i2v'),
    gate: 'motion', // §6.5's motion gate — M4
    maxWorkers: maxWorkersFor('runpod:wan2-i2v'), // fixed pod pool — see agents/fleet.ts
    // [0,1]: whichever image step actually ran (mutually exclusive). [2]:
    // added 2026-09-12 — i2v's duration_s must track TTS's ACTUAL generated
    // audio length, not the caller's pre-estimated frame.durationS (the two
    // routinely diverge; merge's `-shortest` was silently clipping narration
    // when the estimate undershot). Serializes animation behind tts (was
    // parallel with it before), a deliberate latency-for-correctness
    // tradeoff — see steps/builders/i2v.ts.
    dependsOn: [0, 1, 2],
    scope: 'bulk',
    builder: buildI2vInput,
    fallbacks: {
      'replicate-wan22-fast': {
        provider: 'replicate',
        model: REPLICATE_WAN_FALLBACK_MODEL,
        builder: buildReplicateWanInput,
        normalize: { endpointId: POSTPROD_LITE_ENDPOINT_ID, builder: buildNormalizeInput },
        auxWorkers: 1,
      },
    },
  },
  {
    // singleJobPerProject but scope:'bulk' — it has dependsOn:[] (nothing to
    // wait on), so it runs alongside steps 0-3 (driveCohort()'s bulk loop)
    // rather than waiting for the assembly tail to start; scope and
    // singleJobPerProject are orthogonal (steps/catalog.ts's CatalogEntry
    // doc). Its prompt/target duration travel via ctx.job, not
    // ctx.perFrameOutputs — see steps/builders/bgm.ts. Gated by options.bgm
    // (STEP_TOPOLOGY, same flag step 12 rides).
    seq: 5,
    name: 'bgm',
    endpointId: endpointFor('runpod:bgm-s2t'),
    gate: null,
    dependsOn: [],
    scope: 'bulk',
    maxWorkers: maxWorkersFor('runpod:bgm-s2t'), // fixed pod pool — see agents/fleet.ts
    singleJobPerProject: true,
    builder: buildBgmInput,
  },
  {
    seq: 6,
    name: 'merge',
    endpointId: POSTPROD_LITE_ENDPOINT_ID,
    gate: null,
    // [14, 3]: prefer step 14's upscaled clip, else step 3's raw one — NOT
    // mutually exclusive (animation always runs; 14 is optional), so
    // agents/planner.ts's resolveDirectDependencies() collapses 3 out of the
    // fan-in whenever 14 is planned, same as concat's [7, 6]. [15]: the
    // frame's SFX track (options.sfx), mixed under the narration.
    dependsOn: [2, 15, 14, 3],
    scope: 'project', // M5 phase 1 — agents/assembler.ts, not the bulk generator
    builder: buildMergeInput,
  },
  {
    // Repurposes the spec's Remotion slot (agents/planner.ts's
    // STEP_TOPOLOGY header comment) — sorts between merge (6) and concat
    // (8), the only free integer there, since it trims each frame's clip
    // BEFORE they're joined ("concat-and-trim", matching the real system's
    // convention). A plain per-frame step, NOT singleJobPerProject, unlike
    // everything else added this session — same shape as merge/i2v. Gated
    // by options.removeSilence (STEP_TOPOLOGY).
    seq: 7,
    name: 'remove-silence',
    endpointId: POSTPROD_LITE_ENDPOINT_ID,
    gate: null,
    dependsOn: [6],
    scope: 'project',
    builder: buildRemoveSilenceInput,
  },
  {
    // Educational/explainer text overlay (2026-09-16 — see
    // orchestrator/containers/README.md's `remotion` row and
    // agents/planner.ts's STEP_TOPOLOGY header comment for the full
    // history). Not part of the original 1-13 spec numbering or the
    // postprod-lite tail — seq 16 (next free integer) is fine numerically
    // ONLY because agents/assembler.ts's plannedTailSteps() orders
    // project-scope tail steps by their position in STEP_CATALOG below, not
    // by raw seq value (fixed alongside this entry — see that file). Must
    // sit here, between remove-silence (7) and concat (8): it needs the
    // already-merged/trimmed per-frame clip as its Remotion composition's
    // video background (StoryStudio's own request-examples doc explicitly
    // leaves `textManifest.background.src` empty for this exact reason —
    // the orchestrator, not the caller, resolves it, since the clip doesn't
    // exist yet when StoryStudio submits the request), and concat needs
    // ITS output once it ran. `source: 'lambda'` — dispatches to the
    // existing, live-tested AWS `QM-remotion-overlay` Lambda
    // (src/lambda/client.ts) instead of RunPod; `endpointId` here is a
    // sentinel only (logging/computeDrainAfter bookkeeping), never passed
    // to `deps.runpod`. Gated by options.textOverlay (STEP_TOPOLOGY). A
    // plain per-frame step, NOT singleJobPerProject, same shape as
    // remove-silence.
    seq: 16,
    name: 'remotion-overlay',
    source: 'lambda',
    endpointId: 'lambda:qm-remotion-overlay',
    gate: null,
    dependsOn: [7, 6],
    scope: 'project',
    builder: buildRemotionOverlayInput,
  },
  {
    // First singleJobPerProject step: one job for the whole project, fanned
    // in on every frame's clip, from whichever of step 16 (if
    // options.textOverlay ran), step 7 (if options.removeSilence ran), or
    // step 6 (always) produced it — NOT mutually exclusive (merge always
    // runs; remove-silence and text-overlay are each independently
    // optional), so listing all three relies on agents/planner.ts's
    // resolveDirectDependencies() to collapse 6/7 out of the fan-in count
    // whenever a later one is also present (each depends directly on the
    // one before it). Shares postprod-lite with merge/remove-silence, so it
    // rides the same assembler.ts tail allocation with zero drain in
    // between (computeDrainAfter already collapses same-endpoint adjacent
    // steps) — the Lambda-sourced step 16 riding in the middle doesn't
    // change that: it just runs while postprod-lite's workers sit idle for
    // the ~11-17s Remotion call, unbilled (RunPod only bills active workers).
    seq: 8,
    name: 'concat',
    endpointId: POSTPROD_LITE_ENDPOINT_ID,
    gate: null,
    dependsOn: [16, 7, 6],
    scope: 'project',
    singleJobPerProject: true,
    builder: buildConcatInput,
  },
  {
    // Second singleJobPerProject step, but depending on ANOTHER
    // singleJobPerProject step (8) rather than fanning in on every frame —
    // its fan-in is 1, not req.frames.length (see agents/planner.ts's
    // buildStepsAndJobs()). Gated by options.upscale with
    // options.upscaleEngine 'realesrgan' (STEP_TOPOLOGY) — step 14 is the
    // per-frame DreamX alternative.
    seq: 10,
    name: 'upscale',
    endpointId: POSTPROD_LITE_ENDPOINT_ID,
    gate: null,
    dependsOn: [8],
    scope: 'project',
    singleJobPerProject: true,
    builder: buildUpscaleInput,
  },
  {
    // Reads step 10's output if it ran, else falls back to step 8's — NOT
    // mutually exclusive like image steps 0/1 (concat always runs; upscale
    // is independently optional), so listing both here relies on
    // agents/planner.ts's resolveDirectDependencies() to collapse 8 out of
    // the fan-in count whenever 10 is also present. Gated by
    // options.burnCaptions (STEP_TOPOLOGY).
    seq: 11,
    name: 'burn-captions',
    endpointId: POSTPROD_LITE_ENDPOINT_ID,
    gate: null,
    // 7/6 are listed only so the generator resolves each frame's trimmed
    // (or merged) clip duration for the script-timed captions — the planner
    // collapses them away (both are 8's own deps), so the fan-in stays [10|8].
    dependsOn: [10, 8, 7, 6],
    scope: 'project',
    singleJobPerProject: true,
    builder: buildCaptionInput,
  },
  {
    // Last step in the assembly tail. Reads whichever of 11/10/8 is the
    // "final video" for this request (same non-mutually-exclusive fallback
    // as step 11, hence listing the full chain in dependsOn so
    // agents/planner.ts's resolveDirectDependencies() can collapse the
    // shadowed entries), plus step 5's bgm track. Gated by options.bgm
    // (STEP_TOPOLOGY, same flag step 5 rides).
    seq: 12,
    name: 'bgm-overlay',
    endpointId: POSTPROD_LITE_ENDPOINT_ID,
    gate: null,
    dependsOn: [11, 10, 8, 5],
    scope: 'project',
    singleJobPerProject: true,
    builder: buildBgmOverlayInput,
  },
  {
    // Per-frame upscale on DreamX's SR-DiT refiner (options.upscale with
    // options.upscaleEngine 'dreamx') — the alternative to step 10, which
    // upscales the whole concat video on postprod-lite and can't use this
    // endpoint (241-frame input limit; see steps/builders/upscale-frame.ts).
    // seq 14, not a number between 3 and 6: the only free integers there
    // are taken (4 = the spec's dialogue lip-sync slot, 5 = bgm), and none
    // is needed — driveCohort() runs every bulk step before handing off to
    // the assembler, so a bulk seq 14 still finishes before merge (6)
    // starts; its only real ordering constraint is after step 3, which any
    // seq > 3 satisfies. Listed last here and in STEP_TOPOLOGY so both stay
    // seq-sorted like every other consumer expects.
    seq: 14,
    name: 'upscale-frame',
    endpointId: DREAMX_REFINER_ENDPOINT_ID,
    gate: null,
    dependsOn: [3],
    scope: 'bulk',
    maxWorkers: 2, // endpoint's real pool (2026-09-17 dashboard re-sync, was 3) — see CatalogEntry.maxWorkers
    builder: buildUpscaleFrameInput,
  },
  {
    // Per-frame SFX (options.sfx) on MMAudio — after upscale (14), before
    // merge (6), per the requested frame flow. Bulk, like 14: seq 15 sorts
    // after 14 in driveCohort()'s bulk loop, and every bulk step finishes
    // before the assembler starts merge. Non-commercial weights — see
    // tail-endpoints.ts's AUDIO_POOL_ENDPOINT_ID.
    //
    // STALE (2026-09-20): MM-Audio-A40 (this step's own dedicated endpoint)
    // was decommissioned and mmaudio pooled onto the ex-TTS-only endpoint,
    // now shared with this catalog's OWN 'tts' step above (endpointFor/
    // maxWorkersFor('runpod:flux-tts-s2t'), still reading 5 workers from
    // fleet-registry.ts — also stale, it's 7 now). Repointed here just to
    // keep this compiling and not dispatch into a 0-worker dead endpoint;
    // maxWorkers below no longer represents a real per-endpoint ceiling for
    // either step, and this catalog has no equivalent of the asset model's
    // countInFlightForEndpoint (db/repo/assets.ts) to pool them correctly.
    // Only matters if ORCH_PIPELINE_MODE=cohort is still live somewhere
    // (default in config.ts, unconfirmed on the actual VPS) — needs a real
    // fix (or shared/fleet.ts's own worker count corrected to 7) before
    // trusting cohort-mode SFX/TTS concurrency again.
    seq: 15,
    name: 'sfx',
    endpointId: AUDIO_POOL_ENDPOINT_ID,
    gate: null,
    dependsOn: [14, 3],
    scope: 'bulk',
    maxWorkers: 2, // stale — see comment above
    builder: buildSfxInput,
  },
] as const;

export function catalogEntry(seq: number): CatalogEntry | undefined {
  return STEP_CATALOG.find((s) => s.seq === seq);
}
