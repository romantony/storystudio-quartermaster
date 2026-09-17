/**
 * The driver (impl plan §2's repo layout: "agents/orchestrator.ts — the
 * driver: step sequencing, drain gating, cohort lifecycle"). Sequences a
 * cohort's catalogued steps in order — allocate, run (+ gate, concurrently,
 * if the step is gated), release-if-drainAfter, next.
 *
 * M4: when a step is gated (catalog.gate set), runStep() and gateStep() run
 * CONCURRENTLY via Promise.all (not allSettled — allSettled waits for BOTH
 * to settle even after one rejects, which a real test caught hanging
 * forever on a still-running gateStep() after runStep() had already
 * stalled; Promise.all rejects as soon as either does) — this is what the
 * spec means by gating assets "as they land" and reworking "while the
 * endpoint is still warm". See agents/quality.ts's header comment for why
 * this needs zero changes to generator.ts. §8.2's
 * `generated -> gating -> draining` hop is deliberately collapsed:
 * gateStep() writes 'generated'->'gating' at its own start, and the
 * existing 'draining' write already at the top of fleet.ts's release() is
 * what closes it out — no separate write here.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import { log } from '../telemetry/log';
import { listSteps } from '../db/repo/steps';
import { getCohort, setCurrentStep } from '../db/repo/cohorts';
import { auxiliaryEndpoints, catalogEntry } from '../steps/catalog';
import { allocate, release, emergencyDrain, allocateAuxiliary, releaseAuxiliary, type FleetDeps } from './fleet';
import { runStep, GeneratorStallError, type GeneratorDeps } from './generator';
import { gateStep, type QualityDeps } from './quality';
import { runAssembler, type AssemblerDeps } from './assembler';
import { finalizeCohort, type DriverOutcome } from '../result/finalize';
import { prepareCohort, type HarnessDeps } from '../harness';

export interface DriverDeps {
  pool: Pool;
  runpod: RunpodClient;
  cfg: Config;
  publicBaseUrl: string;
}

/**
 * Runs a cohort's steps to completion, then always finalizes it
 * (result/finalize.ts: §9.6 results, cohort row closed, callbacks) — on a
 * stall too, so a caller learns its project failed instead of waiting
 * forever. Called fire-and-forget from POST /v1/requests (the ack returns
 * immediately; this keeps going in the background) — errors are logged, not
 * thrown into the HTTP response.
 */
export async function driveCohort(deps: DriverDeps, cohortId: string): Promise<void> {
  let outcome: DriverOutcome = 'stopped';
  try {
    outcome = (await runCohort(deps, cohortId)) ? 'completed' : 'stopped';
  } finally {
    try {
      await finalizeCohort({ pool: deps.pool, cfg: deps.cfg, runpod: deps.runpod }, cohortId, outcome);
    } catch (err) {
      log().error({ cohortId, outcome, err }, 'driver: finalize failed');
    }
  }
}

/** true = every catalogued step finished; false = the driver stopped early. */
async function runCohort(deps: DriverDeps, cohortId: string): Promise<boolean> {
  const fleetDeps: FleetDeps = { pool: deps.pool, runpod: deps.runpod, cfg: deps.cfg };
  const generatorDeps: GeneratorDeps = {
    pool: deps.pool,
    runpod: deps.runpod,
    cfg: deps.cfg,
    publicBaseUrl: deps.publicBaseUrl,
    webhookSecret: deps.cfg.webhookSecret,
    replicate: {
      apiToken: deps.cfg.replicateApiToken,
      apiBase: deps.cfg.replicateApiBase,
      timeoutMs: deps.cfg.replicateTimeoutMs,
    },
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
  const qualityDeps: QualityDeps = {
    pool: deps.pool,
    replicate: {
      apiToken: deps.cfg.replicateApiToken,
      apiBase: deps.cfg.replicateApiBase,
      visionModel: deps.cfg.replicateVisionModel,
      visionModelFallback: deps.cfg.replicateVisionModelFallback,
      pollIntervalMs: deps.cfg.replicatePollIntervalMs,
      maxPollAttempts: deps.cfg.replicateMaxPollAttempts,
      timeoutMs: deps.cfg.replicateTimeoutMs,
    },
    cfg: deps.cfg,
  };

  const dbSteps = await listSteps(deps.pool, cohortId);
  const catalogued = dbSteps
    .map((s) => ({ dbStep: s, catalog: catalogEntry(s.seq) }))
    .filter((x): x is { dbStep: (typeof dbSteps)[number]; catalog: NonNullable<ReturnType<typeof catalogEntry>> } => x.catalog !== undefined)
    .sort((a, b) => a.dbStep.seq - b.dbStep.seq);
  // Bulk (1-5) drives here, stage-major, exactly as before M5. Project-scope
  // (6+) is handed off to the assembler once, after every bulk step is
  // done — see steps/catalog.ts's header comment for why the split exists.
  const runnable = catalogued.filter((x) => x.catalog.scope === 'bulk');
  const tailPlanned = catalogued.some((x) => x.catalog.scope === 'project');

  // Prompt harness (docs/qm-orchestrator-prompt-harness-implementation-plan.md
  // §6.1): turns each frame's request prompts into a guardrail-compiled
  // pair before steps 0/1 (image) and 3 (motion) claim their jobs. Runs
  // once per cohort, before the bulk loop below — every write it makes
  // targets status='planned' rows, so it is a no-op on anything already
  // generated (a resumed cohort re-drives this harmlessly). Best-effort by
  // construction (prepareCohort() itself never throws past a per-project
  // catch) — a harness failure must never stall a cohort the way an
  // allocate()/runStep() failure does below.
  const harnessDeps: HarnessDeps = { pool: deps.pool, cfg: deps.cfg };
  try {
    await prepareCohort(harnessDeps, cohortId);
  } catch (err) {
    log().error({ cohortId, err }, 'driver: prompt harness prepareCohort failed, cohort continues on original prompts');
  }

  for (const { dbStep, catalog } of runnable) {
    // Resume (index.ts re-drives 'running' cohorts on boot): a step that
    // already reached 'complete' was generated, gated and released — don't
    // re-allocate and re-drain its endpoint for nothing.
    if (dbStep.status === 'complete') {
      log().info({ cohortId, seq: dbStep.seq }, 'driver: step already complete, skipping');
      continue;
    }
    // Model-switch fallbacks (steps/catalog.ts) may submit to other endpoints
    // during this step; raise their ceilings now and always drop them after.
    const auxEndpoints = catalog.gate && deps.cfg.qualityGates !== 'off' ? auxiliaryEndpoints(catalog) : [];
    for (const aux of auxEndpoints) {
      try {
        await allocateAuxiliary(fleetDeps, cohortId, dbStep.seq, aux);
      } catch (err) {
        log().warn({ cohortId, seq: dbStep.seq, endpointId: aux.endpointId, err }, 'driver: auxiliary allocation failed, fallbacks on it will queue');
      }
    }
    try {
      await setCurrentStep(deps.pool, cohortId, dbStep.seq);
      log().info({ cohortId, seq: dbStep.seq, name: catalog.name }, 'driver: starting step');

      try {
        await allocate(fleetDeps, cohortId, { ...catalog, workers: dbStep.workersTarget });
      } catch (err) {
        log().error({ cohortId, seq: dbStep.seq, err }, 'driver: allocate failed, stopping cohort (stalled)');
        // allocate() PATCHes workersMax up before its own failure modes
        // (unreachable, cap_breach) can fire — those raised workers must not
        // be left behind just because the step never got past allocation.
        await emergencyDrain(fleetDeps, catalog.endpointId);
        return false;
      }

      // Dispatch ceiling gets cfg.queueBufferWorkers extra headroom (2026-09-16)
      // so jobs sit queued in RunPod itself instead of waiting on our next
      // poll tick — allocate() just above kept the REAL worker count at
      // dbStep.workersTarget unbuffered, so this doesn't cost extra GPU
      // spend. gateStep() doesn't submit generation jobs, so it stays
      // unbuffered too.
      const dispatchTarget = dbStep.workersTarget + deps.cfg.queueBufferWorkers;
      const runStepPromise = runStep(generatorDeps, cohortId, catalog, dispatchTarget);
      const gateStepPromise = catalog.gate ? gateStep(qualityDeps, cohortId, catalog, dbStep.workersTarget) : undefined;
      // A no-op catch on each promise individually, BEFORE the Promise.all
      // below — otherwise the one that doesn't win the race below still has
      // its rejection observed asynchronously later (by the try/catch), so
      // this isn't strictly needed for the current single-await shape, but
      // keeps the invariant explicit as this function's shape evolves.
      runStepPromise.catch(() => undefined);
      gateStepPromise?.catch(() => undefined);

      try {
        // Promise.all, NOT allSettled: rejects as soon as EITHER promise
        // does, so a runStep() stall stops the cohort immediately rather
        // than waiting for a possibly still-running gateStep() to also
        // finish first (allSettled's actual behavior — verified by a real
        // test that hung for gateStep() never resolving until this was
        // fixed). Known, accepted limitation: the promise that didn't cause
        // the rejection may still be running in the background after this
        // function returns — gateStep()'s loop has no cancellation
        // mechanism yet. Acceptable for now: the cohort is already being
        // abandoned on error, and gateStep()'s own loop naturally winds down
        // once its jobs_ungated query empties out.
        await (gateStepPromise ? Promise.all([runStepPromise, gateStepPromise]) : runStepPromise);
      } catch (err) {
        const stalled = err instanceof GeneratorStallError;
        log().error(
          { cohortId, seq: dbStep.seq, err },
          stalled ? 'driver: generator stalled, stopping cohort' : 'driver: step failed, stopping cohort',
        );
        // The real 2026-09-11 incident: this path used to just return, leaving
        // the workers allocate() had already raised for this step orphaned —
        // billing, unclaimed, for 2+ hours until a human noticed the
        // watchdog's alert-only log lines and drained manually.
        await emergencyDrain(fleetDeps, catalog.endpointId);
        return false;
      }

      if (dbStep.drainAfter) {
        try {
          await release(fleetDeps, cohortId, catalog);
        } catch (err) {
          log().error({ cohortId, seq: dbStep.seq, err }, 'driver: release failed, stopping cohort (stalled)');
          // release()'s own drain PATCH may not have gone out at all (e.g. it
          // threw before reaching the PATCH) or may have gone out but timed
          // out waiting for confirmation — either way, resend it. Idempotent:
          // harmless if release() already succeeded in PATCHing to 0.
          await emergencyDrain(fleetDeps, catalog.endpointId);
          return false;
        }
      } else {
        log().info({ cohortId, seq: dbStep.seq }, 'driver: drainAfter=false, keeping endpoint warm for next step');
      }
    } finally {
      for (const aux of auxEndpoints) await releaseAuxiliary(fleetDeps, aux.endpointId);
    }
  }

  if (tailPlanned) {
    const assemblerDeps: AssemblerDeps = {
      pool: deps.pool,
      runpod: deps.runpod,
      cfg: deps.cfg,
      publicBaseUrl: deps.publicBaseUrl,
    };
    try {
      await runAssembler(assemblerDeps, cohortId);
    } catch (err) {
      log().error({ cohortId, err }, 'driver: assembler failed, stopping cohort (stalled)');
      // Same discipline as the bulk-step failure paths above: the
      // assembler's own allocate() may have already raised the tail pool
      // before whatever failed. First project-scope step's endpoint is the
      // one it allocated (see assembler.ts's runAssembler()).
      const firstTailStep = catalogued.find((x) => x.catalog.scope === 'project')?.catalog;
      if (firstTailStep) await emergencyDrain(fleetDeps, firstTailStep.endpointId);
      return false;
    }
  }

  await setCurrentStep(deps.pool, cohortId, null);
  log().info({ cohortId }, 'driver: every catalogued step for this cohort is done');
  return true;
}

/** Read-only convenience for the admin routes / tests. */
export async function cohortSummary(pool: Pool, cohortId: string) {
  const cohort = await getCohort(pool, cohortId);
  const steps = await listSteps(pool, cohortId);
  return { cohort, steps };
}
