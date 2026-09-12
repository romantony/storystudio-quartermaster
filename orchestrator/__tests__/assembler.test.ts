/**
 * Unit tests for agents/assembler.ts's runAssembler() — new M5 phase 1
 * (2026-09-11). Mocks fleet.ts/generator.ts/the repo layer entirely, same
 * convention as orchestrator.test.ts: this exercises only the assembler's
 * own sequencing (allocate once, one project's whole tail at a time,
 * release once), not generator.ts's/fleet.ts's own already-tested internals.
 *
 * Also mocks steps/catalog.ts with a small synthetic fixture rather than
 * using the real STEP_CATALOG — this file tests the assembler's sequencing
 * logic, not catalog content, and only one real project-scope step (6,
 * merge) exists as of this milestone; the project-major-not-stage-major
 * ordering test genuinely needs two to be meaningful.
 */
import type { Pool } from 'pg';
import type { CatalogEntry } from '../src/steps/catalog';
import { runAssembler, type AssemblerDeps } from '../src/agents/assembler';
import * as stepsRepo from '../src/db/repo/steps';
import * as jobsRepo from '../src/db/repo/jobs';
import * as projectsRepo from '../src/db/repo/projects';
import * as fleetAgent from '../src/agents/fleet';
import * as generatorAgent from '../src/agents/generator';

const FAKE_BUILDER = (() => ({})) as CatalogEntry['builder'];
const MERGE: CatalogEntry = {
  seq: 6,
  name: 'merge',
  endpointId: 'n6252hm01qz0xh',
  gate: null,
  dependsOn: [2, 3],
  scope: 'project',
  builder: FAKE_BUILDER,
};
const CONCAT: CatalogEntry = {
  seq: 8,
  name: 'concat',
  endpointId: 'n6252hm01qz0xh',
  gate: null,
  dependsOn: [6],
  scope: 'project',
  builder: FAKE_BUILDER,
};
const IMAGE: CatalogEntry = {
  seq: 1,
  name: 'image',
  endpointId: 'e165se4r3eo5hp',
  gate: 'image',
  dependsOn: [],
  scope: 'bulk',
  builder: FAKE_BUILDER,
};
const FIXTURE_CATALOG = [IMAGE, MERGE, CONCAT] as const;

jest.mock('../src/steps/catalog', () => ({
  __esModule: true,
  get STEP_CATALOG() {
    return FIXTURE_CATALOG;
  },
}));
jest.mock('../src/db/repo/steps');
jest.mock('../src/db/repo/jobs');
jest.mock('../src/db/repo/projects');
jest.mock('../src/agents/fleet');
jest.mock('../src/agents/generator', () => ({
  ...jest.requireActual('../src/agents/generator'),
  runStep: jest.fn(),
}));

function dbStep(seq: number, name: string, endpointId: string) {
  return {
    cohortId: 'win_test',
    seq,
    name,
    endpointId,
    workersTarget: 2,
    gate: null,
    drainAfter: true,
    dependsOn: [],
    status: 'pending',
    jobTotal: 2,
    jobCompleted: 0,
    jobFailed: 0,
    warmAt: null,
    startedAt: null,
    finishedAt: null,
  };
}

const BASE_DEPS: AssemblerDeps = {
  pool: {} as Pool,
  runpod: {} as AssemblerDeps['runpod'],
  cfg: { workersTail: 2, webhookSecret: 'secret' } as unknown as AssemblerDeps['cfg'],
  publicBaseUrl: 'https://vps.example',
};

beforeEach(() => {
  jest.clearAllMocks();
  (fleetAgent.allocate as jest.Mock).mockResolvedValue(undefined);
  (fleetAgent.release as jest.Mock).mockResolvedValue(undefined);
  (generatorAgent.runStep as jest.Mock).mockResolvedValue(undefined);
  (projectsRepo.setProjectStatus as jest.Mock).mockResolvedValue(undefined);
});

describe('agents/assembler.ts runAssembler()', () => {
  it('no-ops entirely when no project-scope steps are catalogued+planned for this cohort', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([dbStep(1, 'image', 'e165se4r3eo5hp')]); // bulk only

    await runAssembler(BASE_DEPS, 'win_test');

    expect(fleetAgent.allocate).not.toHaveBeenCalled();
    expect(fleetAgent.release).not.toHaveBeenCalled();
    expect(generatorAgent.runStep).not.toHaveBeenCalled();
  });

  it('allocates the tail pool once, drives every project through every tail step in order, releases once', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([dbStep(6, 'merge', 'n6252hm01qz0xh')]);
    (jobsRepo.listProjectIdsForStep as jest.Mock).mockResolvedValue(['proj_a', 'proj_b']);

    await runAssembler(BASE_DEPS, 'win_test');

    expect(fleetAgent.allocate).toHaveBeenCalledTimes(1);
    expect(fleetAgent.allocate).toHaveBeenCalledWith(
      expect.anything(),
      'win_test',
      expect.objectContaining({ seq: 6, workers: 2 }),
    );
    expect(fleetAgent.release).toHaveBeenCalledTimes(1);
    // release() must come after every project's runStep(), not interleaved.
    const releaseOrder = (fleetAgent.release as jest.Mock).mock.invocationCallOrder[0];
    const lastRunStepOrder = (generatorAgent.runStep as jest.Mock).mock.invocationCallOrder.slice(-1)[0];
    expect(releaseOrder).toBeGreaterThan(lastRunStepOrder);

    expect(generatorAgent.runStep).toHaveBeenCalledTimes(2);
    expect(generatorAgent.runStep).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'win_test',
      expect.objectContaining({ seq: 6 }),
      2,
      'proj_a',
    );
    expect(generatorAgent.runStep).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'win_test',
      expect.objectContaining({ seq: 6 }),
      2,
      'proj_b',
    );
  });

  it('drives one project through EVERY tail step before starting the next project (project-major, not stage-major)', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([
      dbStep(6, 'merge', 'n6252hm01qz0xh'),
      dbStep(8, 'concat', 'n6252hm01qz0xh'),
    ]);
    (jobsRepo.listProjectIdsForStep as jest.Mock).mockResolvedValue(['proj_a', 'proj_b']);

    await runAssembler(BASE_DEPS, 'win_test');

    const calls = (generatorAgent.runStep as jest.Mock).mock.calls.map((c) => [c[2].seq, c[4]]);
    expect(calls).toEqual([
      [6, 'proj_a'],
      [8, 'proj_a'],
      [6, 'proj_b'],
      [8, 'proj_b'],
    ]);
  });

  it('marks every intermediate tail step \'complete\' directly (not via release()) so the NEXT step\'s own updateStepStatus(\'running\') does not collide on steps_one_live_per_cohort — real bug found live 2026-09-12, first time a 2+-step tail ran automatically', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([
      dbStep(6, 'merge', 'n6252hm01qz0xh'),
      dbStep(8, 'concat', 'n6252hm01qz0xh'),
    ]);
    (jobsRepo.listProjectIdsForStep as jest.Mock).mockResolvedValue(['proj_a']);

    await runAssembler(BASE_DEPS, 'win_test');

    // seq 6 (not lastStep) gets a direct 'complete' — NOT release(), which
    // would also drain postprod-lite and defeat the tail collapse.
    expect(stepsRepo.updateStepStatus).toHaveBeenCalledWith(
      expect.anything(),
      'win_test',
      6,
      'complete',
      expect.objectContaining({ finishedAt: expect.any(Date) }),
    );
    // seq 8 (lastStep) is NOT touched here — release() (mocked, asserted
    // elsewhere) is solely responsible for it.
    expect(stepsRepo.updateStepStatus).not.toHaveBeenCalledWith(expect.anything(), 'win_test', 8, expect.anything(), expect.anything());
    expect(stepsRepo.updateStepStatus).toHaveBeenCalledTimes(1);
  });

  it('propagates a runStep() failure without calling release() — the driver (orchestrator.ts) owns the emergency-drain backstop', async () => {
    (stepsRepo.listSteps as jest.Mock).mockResolvedValue([dbStep(6, 'merge', 'n6252hm01qz0xh')]);
    (jobsRepo.listProjectIdsForStep as jest.Mock).mockResolvedValue(['proj_a']);
    (generatorAgent.runStep as jest.Mock).mockRejectedValue(new Error('runpod down'));

    await expect(runAssembler(BASE_DEPS, 'win_test')).rejects.toThrow('runpod down');

    expect(fleetAgent.allocate).toHaveBeenCalledTimes(1);
    expect(fleetAgent.release).not.toHaveBeenCalled();
  });
});
