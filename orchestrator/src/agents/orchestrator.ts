/**
 * The driver (impl plan §2's repo layout: "agents/orchestrator.ts — the
 * driver: step sequencing, drain gating, cohort lifecycle"). Scoped narrowly
 * for M2 (see the M2 plan's decision 3): sequences a cohort's catalogued
 * steps in order — allocate, run, release-if-drainAfter, next — with no
 * gating phase, because agents/quality.ts does not exist yet (lands M4).
 * Full §8.2 state machine (generated -> gating -> draining) is not
 * implemented; M2 goes straight from generated to draining/complete.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { RunpodClient } from '../runpod/client';
import { log } from '../telemetry/log';
import { listSteps } from '../db/repo/steps';
import { getCohort, setCurrentStep } from '../db/repo/cohorts';
import { catalogEntry } from '../steps/catalog';
import { allocate, release, type FleetDeps } from './fleet';
import { runStep, GeneratorStallError, type GeneratorDeps } from './generator';

export interface DriverDeps {
  pool: Pool;
  runpod: RunpodClient;
  cfg: Config;
  publicBaseUrl: string;
}

/**
 * Runs a cohort's steps to completion. Called fire-and-forget from
 * POST /v1/requests (the ack returns immediately; this keeps going in the
 * background) — errors are logged, not thrown into the HTTP response.
 */
export async function driveCohort(deps: DriverDeps, cohortId: string): Promise<void> {
  const fleetDeps: FleetDeps = { pool: deps.pool, runpod: deps.runpod, cfg: deps.cfg };
  const generatorDeps: GeneratorDeps = {
    pool: deps.pool,
    runpod: deps.runpod,
    cfg: deps.cfg,
    publicBaseUrl: deps.publicBaseUrl,
    webhookSecret: deps.cfg.webhookSecret,
  };

  const dbSteps = await listSteps(deps.pool, cohortId);
  const runnable = dbSteps
    .map((s) => ({ dbStep: s, catalog: catalogEntry(s.seq) }))
    .filter((x): x is { dbStep: (typeof dbSteps)[number]; catalog: NonNullable<ReturnType<typeof catalogEntry>> } => x.catalog !== undefined)
    .sort((a, b) => a.dbStep.seq - b.dbStep.seq);

  for (const { dbStep, catalog } of runnable) {
    await setCurrentStep(deps.pool, cohortId, dbStep.seq);
    log().info({ cohortId, seq: dbStep.seq, name: catalog.name }, 'driver: starting step');

    try {
      await allocate(fleetDeps, cohortId, { ...catalog, workers: dbStep.workersTarget });
    } catch (err) {
      log().error({ cohortId, seq: dbStep.seq, err }, 'driver: allocate failed, stopping cohort (stalled)');
      return;
    }

    try {
      await runStep(generatorDeps, cohortId, catalog, dbStep.workersTarget);
    } catch (err) {
      const stalled = err instanceof GeneratorStallError;
      log().error(
        { cohortId, seq: dbStep.seq, err },
        stalled ? 'driver: generator stalled, stopping cohort' : 'driver: generator failed, stopping cohort',
      );
      return;
    }

    // No quality agent yet (M4) — generated jobs go straight to drain
    // eligibility. §8.2's `gating` state is skipped entirely for now.
    if (dbStep.drainAfter) {
      try {
        await release(fleetDeps, cohortId, catalog);
      } catch (err) {
        log().error({ cohortId, seq: dbStep.seq, err }, 'driver: release failed, stopping cohort (stalled)');
        return;
      }
    } else {
      log().info({ cohortId, seq: dbStep.seq }, 'driver: drainAfter=false, keeping endpoint warm for next step');
    }
  }

  await setCurrentStep(deps.pool, cohortId, null);
  log().info({ cohortId }, 'driver: every catalogued step for this cohort is done');
}

/** Read-only convenience for the admin routes / tests. */
export async function cohortSummary(pool: Pool, cohortId: string) {
  const cohort = await getCohort(pool, cohortId);
  const steps = await listSteps(pool, cohortId);
  return { cohort, steps };
}
