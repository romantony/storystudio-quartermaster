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
import * as assemblerAgent from '../src/agents/assembler';

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
jest.mock('../src/agents/assembler', () => ({
  ...jest.requireActual('../src/agents/assembler'),
  runAssembler: jest.fn(),
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
  (fleetAgent.emergencyDrain as jest.Mock).mockResolvedValue(undefined);
  (assemblerAgent.runAssembler as jest.Mock).mockResolvedValue(undefined);
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
    // Real 2026-09-11 incident: this path used to leave allocate()'s
    // already-raised workers orphaned for 2+ hours because nothing
    // compensated on a runStep() failure. It must now.
    expect(fleetAgent.emergencyDrain).toHaveBeenCalledWith(expect.anything(), 'e165se4r3eo5hp');
  });

  it('stops the cohort on an allocate() failure without calling runStep()/gateStep(), but still drains', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([{ ...dbStep(1), gate: 'image' }]);
    (fleetAgent.allocate as jest.Mock).mockRejectedValue(new Error('cap breach'));

    await driveCohort(BASE_DEPS, 'win_test');

    expect(generatorAgent.runStep).not.toHaveBeenCalled();
    expect(qualityAgent.gateStep).not.toHaveBeenCalled();
    // allocate() PATCHes workersMax before its own cap_breach/unreachable
    // checks can fail, so even this early failure must still drain.
    expect(fleetAgent.emergencyDrain).toHaveBeenCalledWith(expect.anything(), 'e165se4r3eo5hp');
  });

  it('drains again on a release() failure (idempotent backstop, resends the PATCH)', async () => {
    // seq 2 (tts) is genuinely ungated in the real catalog (gate: null), so
    // this doesn't touch gateStep() at all — deliberately avoiding seq 1
    // (image, gate: 'image'), where jest.clearAllMocks() (unlike
    // mockReset()) leaves a PRIOR test's gateStep() mock implementation in
    // place across tests; an earlier version of this test used seq 1 and
    // hung forever inheriting the "never resolves" gateStep() stub from the
    // test above it.
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([dbStep(2)]);
    (generatorAgent.runStep as jest.Mock).mockResolvedValue(undefined);
    (fleetAgent.release as jest.Mock).mockRejectedValue(new Error('drain timeout'));

    await driveCohort(BASE_DEPS, 'win_test');

    expect(fleetAgent.emergencyDrain).toHaveBeenCalledWith(expect.anything(), 'rnqxi6c0mlq517');
  });
});

describe('driveCohort() — assembler dispatch fork (M5 phase 1, 2026-09-11)', () => {
  it('does not call the assembler at all when only bulk-scope steps are planned', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([dbStep(2)]); // seq 2 (tts) is scope: 'bulk'
    (generatorAgent.runStep as jest.Mock).mockResolvedValue(undefined);

    await driveCohort(BASE_DEPS, 'win_test');

    expect(assemblerAgent.runAssembler).not.toHaveBeenCalled();
  });

  it('calls the assembler once, after every bulk step finishes, when a project-scope step is planned', async () => {
    // seq 2 (tts, bulk) + seq 6 (merge, project) — both real catalog entries.
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([dbStep(2), dbStep(6)]);
    (generatorAgent.runStep as jest.Mock).mockResolvedValue(undefined);

    await driveCohort(BASE_DEPS, 'win_test');

    expect(assemblerAgent.runAssembler).toHaveBeenCalledTimes(1);
    // Called after seq 2's own runStep()/release() — the bulk loop entirely
    // skips seq 6 (driveCohort()'s `runnable` filters to scope: 'bulk'),
    // so runStep() itself must never see it.
    expect(generatorAgent.runStep).toHaveBeenCalledTimes(1);
    expect(generatorAgent.runStep).toHaveBeenCalledWith(expect.anything(), 'win_test', expect.objectContaining({ seq: 2 }), 5);
  });

  it('emergency-drains the tail endpoint and stops the cohort when the assembler fails', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([dbStep(6)]);
    (assemblerAgent.runAssembler as jest.Mock).mockRejectedValue(new Error('postprod-lite down'));

    await driveCohort(BASE_DEPS, 'win_test');

    // Real catalog entry for seq 6 — postprod-lite, not a synthetic dbStep() id.
    expect(fleetAgent.emergencyDrain).toHaveBeenCalledWith(expect.anything(), 'n6252hm01qz0xh');
  });
});
