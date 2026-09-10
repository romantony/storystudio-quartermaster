/**
 * Unit tests for agents/orchestrator.ts's driveCohort() — the driver had no
 * direct test before M4 (only exercised indirectly via the real
 * acceptance runs). Mocks fleet.ts/generator.ts/quality.ts entirely so
 * this exercises only the driver's own sequencing/concurrency/error-
 * handling logic: does a gated step run runStep()+gateStep() concurrently,
 * does an ungated step skip gateStep() entirely, and does a runStep()
 * rejection still stop the cohort even when gateStep() never resolves.
 */
import type { Pool } from 'pg';
import { driveCohort, type DriverDeps } from '../src/agents/orchestrator';
import * as stepsRepo from '../src/db/repo/steps';
import * as cohortsRepo from '../src/db/repo/cohorts';
import * as fleetAgent from '../src/agents/fleet';
import * as generatorAgent from '../src/agents/generator';
import * as qualityAgent from '../src/agents/quality';

jest.mock('../src/db/repo/steps');
jest.mock('../src/db/repo/cohorts');
jest.mock('../src/agents/fleet');
jest.mock('../src/agents/generator', () => ({
  ...jest.requireActual('../src/agents/generator'),
  runStep: jest.fn(),
}));
jest.mock('../src/agents/quality', () => ({
  ...jest.requireActual('../src/agents/quality'),
  gateStep: jest.fn(),
}));

function dbStep(seq: number, workersTarget = 5, drainAfter = true) {
  return {
    cohortId: 'win_test',
    seq,
    name: `step${seq}`,
    endpointId: `ep-${seq}`,
    workersTarget,
    gate: null,
    drainAfter,
    dependsOn: [],
    status: 'pending',
    jobTotal: 3,
    jobCompleted: 0,
    jobFailed: 0,
    warmAt: null,
    startedAt: null,
    finishedAt: null,
  };
}

const BASE_DEPS: DriverDeps = {
  pool: {} as Pool,
  runpod: {} as DriverDeps['runpod'],
  cfg: {
    webhookSecret: 'secret',
    qualityGates: 'full',
    maxAttempts: 2,
    reconcileIntervalMs: 1000,
    qualityVlmCostUsd: 0.002,
    qualityImagePassThreshold: 8,
    qualityImageReviewThreshold: 7,
    qualityVideoGateThreshold: 7.5,
    qualityVideoPassThreshold: 5,
    qualityVideoReviewThreshold: 5,
    replicateApiToken: undefined,
    replicateApiBase: 'https://api.replicate.com/v1',
    replicateVisionModel: 'google/gemini-2.5-flash',
    replicateVisionModelFallback: 'google/gemini-3-pro',
    replicatePollIntervalMs: 3000,
    replicateMaxPollAttempts: 80,
    replicateTimeoutMs: 120000,
  } as unknown as DriverDeps['cfg'],
  publicBaseUrl: 'https://vps.example',
};

beforeEach(() => {
  jest.clearAllMocks();
  (cohortsRepo.setCurrentStep as jest.Mock).mockResolvedValue(undefined);
  (fleetAgent.allocate as jest.Mock).mockResolvedValue(undefined);
  (fleetAgent.release as jest.Mock).mockResolvedValue(undefined);
});

describe('driveCohort() — gating concurrency', () => {
  it('runs runStep() and gateStep() concurrently for a gated step', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([{ ...dbStep(1), gate: 'image' }]);

    let runStepResolve!: () => void;
    let gateStepResolve!: () => void;
    (generatorAgent.runStep as jest.Mock).mockReturnValue(new Promise<void>((r) => (runStepResolve = r)));
    (qualityAgent.gateStep as jest.Mock).mockReturnValue(new Promise<void>((r) => (gateStepResolve = r)));

    const done = driveCohort(BASE_DEPS, 'win_test');

    // Both must have been CALLED before either resolves — proves
    // concurrency, not runStep() then gateStep() sequentially. Several
    // real setTimeout(0) ticks (not just microtask Promise.resolve()s) to
    // flush past setCurrentStep()/allocate()'s own await hops first.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(generatorAgent.runStep).toHaveBeenCalledTimes(1);
    expect(qualityAgent.gateStep).toHaveBeenCalledTimes(1);
    expect(fleetAgent.release).not.toHaveBeenCalled(); // neither settled yet

    runStepResolve();
    gateStepResolve();
    await done;
    expect(fleetAgent.release).toHaveBeenCalledTimes(1);
  });

  it('does not call gateStep() at all for an ungated step', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([dbStep(2)]); // gate: null
    (generatorAgent.runStep as jest.Mock).mockResolvedValue(undefined);

    await driveCohort(BASE_DEPS, 'win_test');

    expect(qualityAgent.gateStep).not.toHaveBeenCalled();
    expect(fleetAgent.release).toHaveBeenCalledTimes(1);
  });
});

describe('driveCohort() — error handling', () => {
  it('a runStep() rejection stops the cohort even when gateStep() never resolves', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([{ ...dbStep(1), gate: 'image' }]);

    const stallError = new generatorAgent.GeneratorStallError('warm_timeout', {});
    (generatorAgent.runStep as jest.Mock).mockRejectedValue(stallError);
    (qualityAgent.gateStep as jest.Mock).mockReturnValue(new Promise(() => {})); // never resolves

    await driveCohort(BASE_DEPS, 'win_test');

    expect(fleetAgent.release).not.toHaveBeenCalled();
    // the cohort loop returned (didn't hang forever on the pending
    // gateStep() promise) — reaching this line at all proves that.
  });

  it('stops the cohort on an allocate() failure without calling runStep()/gateStep()', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([{ ...dbStep(1), gate: 'image' }]);
    (fleetAgent.allocate as jest.Mock).mockRejectedValue(new Error('cap breach'));

    await driveCohort(BASE_DEPS, 'win_test');

    expect(generatorAgent.runStep).not.toHaveBeenCalled();
    expect(qualityAgent.gateStep).not.toHaveBeenCalled();
  });
});
