/**
 * The estimate (impl plan §6.8): `Σ over steps of (warmSec + ceil(jobs /
 * workers) × secPerJob) / 60`. Always reports which basis it used — an
 * estimate labelled "measured" that is actually a guess is worse than none.
 *
 * M2 does not yet write `step_baselines` (the rolling-median table migration
 * `002` created) — that's real measured data from a generator that has run
 * jobs, and M2's own acceptance run is the first time any job runs at all.
 * So M2 always reports `estimateBasis: "default"`, using this static seconds-
 * per-job table until there's something real to average (see the M2 plan's
 * decision 6). Swapping in `step_baselines` lookups here, with a fallback to
 * this same default table, is the only change M6/M7 need to make this
 * "measured" for real.
 */

const DEFAULT_SEC_PER_JOB: Record<string, number> = {
  image: 12,
  tts: 8,
  animation: 90, // Wan2.2 4-step Lightning rung — see qm-orchestrator-wan2-cfg-rungs
};
const DEFAULT_WARM_SEC = 174; // spec §8's measured cold-start figure

export interface StepEstimateInput {
  name: string;
  jobs: number;
  workers: number;
}

export function estimateMinutes(steps: StepEstimateInput[]): { minutes: number; basis: 'default' } {
  let totalSeconds = 0;
  for (const s of steps) {
    const secPerJob = DEFAULT_SEC_PER_JOB[s.name] ?? 60;
    const workers = Math.max(1, s.workers);
    totalSeconds += DEFAULT_WARM_SEC + Math.ceil(s.jobs / workers) * secPerJob;
  }
  return { minutes: Math.ceil(totalSeconds / 60), basis: 'default' };
}
