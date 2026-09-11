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
import { buildTtsInput } from './builders/tts';
import { buildI2vInput } from './builders/i2v';
import { buildMergeInput } from './builders/merge';
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
    dependsOn: [1],
    scope: 'bulk',
    builder: buildI2vInput,
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
] as const;

export function catalogEntry(seq: number): CatalogEntry | undefined {
  return STEP_CATALOG.find((s) => s.seq === seq);
}
