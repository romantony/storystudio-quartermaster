/**
 * Step id -> { endpoint, workers, gate, payload builder } (impl plan §2's
 * repo layout, `steps/catalog.ts`).
 *
 * M2 registers only steps 1-3 (image, tts, animation) — the vertical slice
 * the milestone is scoped to. `agents/planner.ts` resolves the FULL spec
 * step-set from the request's tier/options (§6.2 step 2) but only emits
 * `steps[]`/`jobs` rows for steps present here, logging a warning for
 * anything resolved-but-uncatalogued. Steps 4-13 land one at a time in M5 —
 * adding a catalog entry (endpoint id already known from FLEET or the media
 * endpoint) is the only change needed; planner.ts does not change.
 */
import { FLEET } from '../fleet-registry';
import { buildImageInput } from './builders/image';
import { buildTtsInput } from './builders/tts';
import { buildI2vInput } from './builders/i2v';
import type { PayloadBuilder } from './builders/types';

function endpointFor(counterKey: string): string {
  const entry = FLEET.find((e) => e.counterKey === counterKey);
  if (!entry) throw new Error(`fleet-registry.ts has no entry for ${counterKey}`);
  return entry.endpointId;
}

export interface CatalogEntry {
  seq: number;
  name: string;
  endpointId: string;
  gate: string | null;
  dependsOn: number[];
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
    builder: buildImageInput,
  },
  {
    seq: 2,
    name: 'tts',
    endpointId: endpointFor('runpod:flux-tts-s2t'),
    gate: null,
    dependsOn: [],
    builder: buildTtsInput,
  },
  {
    seq: 3,
    name: 'animation',
    endpointId: endpointFor('runpod:wan2-i2v'),
    gate: 'motion', // §6.5's motion gate — M4
    dependsOn: [1],
    builder: buildI2vInput,
  },
] as const;

export function catalogEntry(seq: number): CatalogEntry | undefined {
  return STEP_CATALOG.find((s) => s.seq === seq);
}
