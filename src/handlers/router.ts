import type { JobType, Rung } from '../types';
import { getInflight } from '../gate/dynamo-gate';

// Realtime routing: an internal RunPod endpoint is only used for a live UI
// request when it has confirmed warm capacity, i.e. fewer than this many
// generations already in flight. At/above it, realtime falls straight through
// to the external (KIE/Replicate) rungs so the user never waits on a queue.
const REALTIME_INTERNAL_MAX = Number(process.env.REALTIME_INTERNAL_MAX ?? 5);

/** A rung is "internal" (self-hosted RunPod) iff it carries an endpointId. */
export function isInternalRung(rung: Rung): boolean {
  return rung.provider === 'runpod' && !!rung.endpointId;
}

/** Stable identity for a rung — used for triedRungs + circuit-breaker keys. */
export function rungKey(rung: Rung): string {
  return `${rung.provider}:${rung.endpointId ?? rung.endpoint ?? rung.model}`;
}

export interface EndpointCapacity {
  inflight: number;
  /** True when the endpoint is known to be warm (workers up). */
  warm: boolean;
}

/**
 * Pure rung-ordering policy (§Pillar 1). Kept side-effect-free so it can be
 * unit-tested without AWS; the async {@link selectRungOrder} wrapper supplies
 * live capacity.
 *
 * - `jobType` absent → ladder order unchanged (zero impact on callers that
 *   haven't opted in — Documentary/Movie/etc.).
 * - `batch` → internal RunPod rungs first (absorb the cold start once, amortize
 *   across the batch), external rungs after as fallback.
 * - `realtime` → an internal rung leads only if that endpoint has warm free
 *   capacity (`warm && inflight < REALTIME_INTERNAL_MAX`); otherwise the
 *   external rungs lead and internal is demoted to a last-resort tail.
 */
export function orderRungs(
  ladder: Rung[],
  jobType: JobType | undefined,
  capacity: Record<string, EndpointCapacity>,
): Rung[] {
  if (!jobType) return ladder;

  const internal: Rung[] = [];
  const external: Rung[] = [];
  for (const rung of ladder) {
    (isInternalRung(rung) ? internal : external).push(rung);
  }
  if (internal.length === 0) return ladder;

  if (jobType === 'batch') {
    return [...internal, ...external];
  }

  // realtime: internal leads only where warm + free capacity exists.
  const leadInternal: Rung[] = [];
  const tailInternal: Rung[] = [];
  for (const rung of internal) {
    const cap = rung.counterKey ? capacity[rung.counterKey] : undefined;
    const hasCapacity = !!cap && cap.warm && cap.inflight < REALTIME_INTERNAL_MAX;
    (hasCapacity ? leadInternal : tailInternal).push(rung);
  }
  // Warm internal first (fast + cheap), then external fallback, then any cold
  // internal as an absolute last resort (better than total failure).
  return [...leadInternal, ...external, ...tailInternal];
}

/**
 * Resolve the live rung order for a job. Reads each internal endpoint's
 * in-flight count once. Warmth proxy: an endpoint with inflight > 0 has workers
 * up, so it's warm with a free slot when still under the cap; inflight 0 is
 * treated as possibly-cold and demoted for realtime (never blocks a user on a
 * ~5-min cold load — matches the locked "cold realtime → external" decision).
 */
export async function selectRungOrder(ladder: Rung[], jobType: JobType | undefined): Promise<Rung[]> {
  if (!jobType || jobType === 'batch') {
    return orderRungs(ladder, jobType, {});
  }

  const counterKeys = Array.from(
    new Set(ladder.filter(isInternalRung).map(r => r.counterKey).filter(Boolean) as string[]),
  );
  const entries = await Promise.all(
    counterKeys.map(async (k): Promise<[string, EndpointCapacity]> => {
      const inflight = await getInflight(k);
      return [k, { inflight, warm: inflight > 0 }];
    }),
  );
  return orderRungs(ladder, jobType, Object.fromEntries(entries));
}
