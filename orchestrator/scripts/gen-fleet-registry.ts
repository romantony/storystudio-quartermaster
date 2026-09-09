/**
 * Emits orchestrator/src/fleet-registry.ts from the live-path's single source
 * of fleet truth, src/shared/fleet.ts.
 *
 * Why generate rather than hand-copy: every incident comment in fleet.ts is a
 * history of two hand-maintained copies of the same worker number drifting
 * apart. The orchestrator gets a projection it never edits, and
 * __tests__/fleet-registry.test.ts fails the build if this output is stale.
 *
 *   npm run gen:fleet        # from orchestrator/
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Relative, not @qm/*: this script is the ONE place the orchestrator reaches
// into the live-path source tree, and it does so explicitly.
import { ACCOUNT_CAP, FLEET } from '../../src/shared/fleet';

const OUT = join(__dirname, '..', 'src', 'fleet-registry.ts');

const rows = FLEET.map(
  (e) => `  { counterKey: ${JSON.stringify(e.counterKey)}, endpointId: ${JSON.stringify(e.endpointId)}, workers: ${e.workers} },`,
).join('\n');

const body = `// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — do not edit by hand.
// Source: src/shared/fleet.ts  ·  Regenerate: npm run gen:fleet
// A drift between this file and the source fails fleet-registry.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** RunPod account-wide worker cap, mirrored from src/shared/fleet.ts. */
export const ACCOUNT_CAP = ${ACCOUNT_CAP};

export interface FleetEndpoint {
  /** Per-endpoint semaphore key (dynamo-gate / provisioner convention). */
  counterKey: string;
  /** RunPod serverless endpoint id. */
  endpointId: string;
  /** Static max workers == real pod count, from the live path. */
  workers: number;
}

/**
 * The Quartermaster pool as the live path sees it. The background orchestrator
 * treats these counts as the ceiling it must rebalance against (spec §4.1
 * step 5); it does not own them.
 */
export const FLEET: readonly FleetEndpoint[] = [
${rows}
] as const;

/** Sum of the pooled worker counts (spec §5.2's "FLEET sums to"). */
export const FLEET_TOTAL = ${FLEET.reduce((a, e) => a + e.workers, 0)};

/** Look up one endpoint's pooled worker count (0 if not in the pool). */
export function pooledWorkers(counterKey: string): number {
  return FLEET.find((e) => e.counterKey === counterKey)?.workers ?? 0;
}
`;

writeFileSync(OUT, body);
console.info(`[gen:fleet] wrote ${OUT} — ${FLEET.length} endpoints, FLEET_TOTAL=${FLEET.reduce((a, e) => a + e.workers, 0)}, ACCOUNT_CAP=${ACCOUNT_CAP}`);
