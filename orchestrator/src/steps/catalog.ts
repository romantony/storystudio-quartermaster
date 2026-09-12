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
import { POSTPROD_LITE_ENDPOINT_ID } from './tail-endpoints';
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
import type { PayloadBuilder } from './builders/types';

function endpointFor(counterKey: string): string {
  const entry = FLEET.find((e) => e.counterKey === counterKey);
  if (!entry) throw new Error(`fleet-registry.ts has no entry for ${counterKey}`);
  return entry.endpointId;
}

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
  /** Orthogonal to `scope`: when true, agents/planner.ts plans exactly ONE
   * job for this step per project (frameId: null) instead of one per frame,
   * fanned in on ALL of dependsOn's per-frame outputs — see
   * agents/generator.ts's resolveProjectDeps() and
   * steps/builders/concat.ts's header comment for the full mechanism.
   * Unset/false preserves today's one-job-per-frame behavior. */
  singleJobPerProject?: boolean;
  builder: PayloadBuilder;
}

// Deliberately no `workers` field here — worker count is a plan-time,
// cohort-scale decision (cfg.workersHead/workersTail), not a fact about
// which step this is. agents/planner.ts sets each planned step's
// workers_target from config; agents/fleet.ts verifies against whatever was
// actually persisted for that cohort, which is what lets the M2 acceptance
// run hand-scale one endpoint to a small real number (see the M2 plan's
// decision 5) instead of always expecting a full 25.
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
    builder: buildImageEditInput,
  },
  {
    seq: 1,
    name: 'image',
    endpointId: endpointFor('runpod:qwen-image-gen'),
    gate: 'image', // §6.5's image gate — M4
    dependsOn: [],
    scope: 'bulk',
    builder: buildImageInput,
  },
  {
    seq: 2,
    name: 'tts',
    endpointId: endpointFor('runpod:flux-tts-s2t'),
    gate: null,
    dependsOn: [],
    scope: 'bulk',
    builder: buildTtsInput,
  },
  {
    seq: 3,
    name: 'animation',
    endpointId: endpointFor('runpod:wan2-i2v'),
    gate: 'motion', // §6.5's motion gate — M4
    dependsOn: [0, 1], // whichever image step actually ran (mutually exclusive)
    scope: 'bulk',
    builder: buildI2vInput,
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
    singleJobPerProject: true,
    builder: buildBgmInput,
  },
  {
    seq: 6,
    name: 'merge',
    endpointId: POSTPROD_LITE_ENDPOINT_ID,
    gate: null,
    dependsOn: [2, 3],
    scope: 'project', // M5 phase 1 — agents/assembler.ts, not the bulk generator
    builder: buildMergeInput,
  },
  {
    // First singleJobPerProject step: one job for the whole project, fanned
    // in on every frame's step-6 output, not one job per frame like every
    // other catalogued step. Shares postprod-lite with merge, so it rides
    // the same assembler.ts tail allocation with zero drain in between
    // (computeDrainAfter already collapses same-endpoint adjacent steps).
    seq: 8,
    name: 'concat',
    endpointId: POSTPROD_LITE_ENDPOINT_ID,
    gate: null,
    dependsOn: [6],
    scope: 'project',
    singleJobPerProject: true,
    builder: buildConcatInput,
  },
  {
    // Second singleJobPerProject step, but depending on ANOTHER
    // singleJobPerProject step (8) rather than fanning in on every frame —
    // its fan-in is 1, not req.frames.length (see agents/planner.ts's
    // buildStepsAndJobs()). Gated by options.upscale (STEP_TOPOLOGY).
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
    dependsOn: [10, 8],
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
] as const;

export function catalogEntry(seq: number): CatalogEntry | undefined {
  return STEP_CATALOG.find((s) => s.seq === seq);
}
