/**
 * Project assembler agent (impl plan §6.10, M5 phase 1, 2026-09-11).
 *
 * Drives every `scope: 'project'` catalogued step (steps/catalog.ts) for a
 * cohort, one project's whole tail at a time — the opposite of
 * agents/generator.ts's bulk/stage-major loop, and deliberately so: assembly
 * steps combine one project's own outputs (its own audio with its own
 * video, etc.), so running them bulk-per-stage across every project in the
 * cohort risks either cross-project contamination or pointless
 * synchronization waves for no benefit, since the tail endpoint
 * (postprod-lite) is one shared warm pool regardless of submission order.
 * See docs/qm-orchestrator-implementation-plan.md §6.10/§9 for the full
 * reasoning behind the split.
 *
 * Reuses agents/generator.ts's runStep() as-is (M5 phase 1's `projectId`
 * parameter addition), just called once per project per step instead of
 * once per step across the whole cohort — no new claim/submit/reconcile
 * logic here, only new sequencing around the existing, already-tested loop.
 *
 * Allocation is NOT per-project or per-step: postprod-lite is allocated
 * ONCE for the whole tail (the "tail collapse" M5's build order already
 * calls for) and released once at the end, matching M1's deployed
 * `workersMin=0`/`workersMax=2` pool. Scope for this phase: step 6 (merge)
 * only — steps 8+ need a one-job-per-project planning model this phase
 * does not build (see the M5 phase 1 plan's "explicitly not in this pass").
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import { log } from '../telemetry/log';
import { STEP_CATALOG, type CatalogEntry } from '../steps/catalog';
import { listSteps, updateStepStatus } from '../db/repo/steps';
import { listProjectIdsForStep } from '../db/repo/jobs';
import { setProjectStatus } from '../db/repo/projects';
import { allocate, release, type FleetDeps } from './fleet';
import { runStep, type GeneratorDeps } from './generator';

export interface AssemblerDeps {
  pool: Pool;
  runpod: RunpodClient;
  cfg: Config;
  publicBaseUrl: string;
}

/** The catalogued, planned tail steps for this cohort, in STEP_CATALOG's
 * declared order — intersected against what's actually persisted (mirrors
 * driveCohort()'s own `runnable` construction in orchestrator.ts, same
 * reasoning: a step resolved by the planner but not (yet) catalogued never
 * got a `steps` row at all).
 *
 * Ordered by STEP_CATALOG array position, NOT by numeric `seq` value — the
 * bulk-step driver (orchestrator.ts) sorts by seq because 0-5/14/15 really
 * are meant to run in strict ascending seq order, but the tail's seq numbers
 * were never guaranteed contiguous (remove-silence is 7 "because 7 is the
 * only free integer" between merge=6 and concat=8; step 16, added
 * 2026-09-16, sits BETWEEN 7 and 8 in real execution order despite its
 * higher number, since concat needs to prefer its output). Sorting by seq
 * here would silently run concat before its own dependency exists. See
 * steps/catalog.ts's seq-16 entry for the full story. */
async function plannedTailSteps(pool: Pool, cohortId: string): Promise<CatalogEntry[]> {
  const dbSteps = await listSteps(pool, cohortId);
  const catalogBySeq = new Map(STEP_CATALOG.map((c) => [c.seq, c] as const));
  const catalogOrder = new Map(STEP_CATALOG.map((c, i) => [c.seq, i] as const));
  return dbSteps
    .map((s) => catalogBySeq.get(s.seq))
    .filter((c): c is CatalogEntry => c !== undefined && c.scope === 'project')
    .sort((a, b) => (catalogOrder.get(a.seq) ?? 0) - (catalogOrder.get(b.seq) ?? 0));
}

export async function runAssembler(deps: AssemblerDeps, cohortId: string): Promise<void> {
  const tailSteps = await plannedTailSteps(deps.pool, cohortId);
  if (tailSteps.length === 0) return;

  const fleetDeps: FleetDeps = { pool: deps.pool, runpod: deps.runpod, cfg: deps.cfg };
  const generatorDeps: GeneratorDeps = {
    pool: deps.pool,
    runpod: deps.runpod,
    cfg: deps.cfg,
    publicBaseUrl: deps.publicBaseUrl,
    webhookSecret: deps.cfg.webhookSecret,
    lambda: {
      functionName: deps.cfg.remotionLambdaFunctionName,
      region: deps.cfg.remotionLambdaRegion,
    },
    r2: {
      accountId: deps.cfg.r2AccountId,
      bucket: deps.cfg.r2Bucket,
      publicUrl: deps.cfg.r2PublicUrl,
      accessKeyId: deps.cfg.r2AccessKeyId ?? '',
      secretAccessKey: deps.cfg.r2SecretAccessKey ?? '',
    },
  };

  const firstStep = tailSteps[0];
  const lastStep = tailSteps[tailSteps.length - 1];

  log().info({ cohortId, tailSteps: tailSteps.map((s) => s.seq) }, 'assembler: allocating tail pool');
  await allocate(fleetDeps, cohortId, { ...firstStep, workers: deps.cfg.workersTail });

  const projectIds = await listProjectIdsForStep(deps.pool, cohortId, firstStep.seq);
  for (const projectId of projectIds) {
    log().info({ cohortId, projectId }, 'assembler: starting project tail');
    for (const step of tailSteps) {
      await runStep(generatorDeps, cohortId, step, deps.cfg.workersTail, projectId);
      // Real bug found live 2026-09-12 (single-project case, chain longer
      // than one tail step) and again 2026-09-16 (a real 2nd project's
      // tail, first time it ran live): runStep() leaves a step at
      // 'generated' (steps_one_live_per_cohort's live-status set) when it
      // finishes. Previously this was only cleared for non-last steps —
      // lastStep was left 'generated' for release() to act on — but the
      // OUTER loop here runs one project at a time, so between projects
      // lastStep is STILL 'generated' from the previous project when the
      // next project's first tail step calls updateStepStatus('running'):
      // duplicate key on steps_one_live_per_cohort, assembler crashes,
      // every project after the first ends up 'failed' despite every one
      // of its jobs actually succeeding (cohortId win_2026_09_16_12). Mark
      // EVERY step 'complete' here, lastStep included — release() below
      // doesn't require 'generated' as a precondition (it unconditionally
      // writes 'draining' then 'complete' itself), so this is safe even on
      // the truly final project's truly final step. Direct write, not the
      // full release(): that would also drain postprod-lite between
      // steps/projects, defeating the whole point of the tail collapse (one
      // shared warm pool across 6->7->8->10->11->12 and across every
      // project in the cohort).
      await updateStepStatus(deps.pool, cohortId, step.seq, 'complete', { finishedAt: new Date() });
      await setProjectStatus(deps.pool, projectId, `${step.name}-complete`);
    }
    log().info({ cohortId, projectId }, 'assembler: project tail complete');
  }

  await release(fleetDeps, cohortId, lastStep);
  log().info({ cohortId }, 'assembler: tail pool released, every project done');
}
