/**
 * runBatchWindow() (agents/batch-window.ts, 2026-09-16) — the
 * ORCH_SCHEDULING_MODE=batch window-close trigger. Mocks plan()/driveCohort()
 * and the outbox repo entirely so this only exercises the trigger's own
 * sequencing/isolation logic: mode gate, cutoff selection, sequential
 * planning with a pinned timestamp, per-row failure isolation, and driving
 * the resulting cohort exactly once.
 */
import { runBatchWindow } from '../src/agents/batch-window';
import * as outboxRepo from '../src/db/repo/request-outbox';
import * as plannerAgent from '../src/agents/planner';
import * as orchestratorAgent from '../src/agents/orchestrator';

jest.mock('../src/db/repo/request-outbox');
jest.mock('../src/agents/planner', () => ({
  ...jest.requireActual('../src/agents/planner'),
  plan: jest.fn(),
}));
jest.mock('../src/agents/orchestrator', () => ({
  ...jest.requireActual('../src/agents/orchestrator'),
  driveCohort: jest.fn(),
}));

function outboxRow(overrides: Partial<outboxRepo.OutboxRow> = {}): outboxRepo.OutboxRow {
  return {
    id: 1,
    requestId: 'req_1',
    projectId: 'proj_1',
    payload: { hello: 'world' },
    status: 'queued',
    cohortId: null,
    error: null,
    receivedAt: new Date('2026-09-16T05:30:00Z'),
    plannedAt: null,
    ...overrides,
  };
}

const DEPS = {
  pool: {} as unknown as import('pg').Pool,
  runpod: {} as unknown as import('../src/runpod/client').RunpodClient,
  publicBaseUrl: 'https://vps.example',
};

beforeEach(() => {
  jest.clearAllMocks();
  (outboxRepo.markOutboxPlanned as jest.Mock).mockResolvedValue(undefined);
  (outboxRepo.markOutboxRejected as jest.Mock).mockResolvedValue(undefined);
  (orchestratorAgent.driveCohort as jest.Mock).mockResolvedValue(undefined);
});

describe('runBatchWindow', () => {
  it("is a no-op in 'project' mode (the default) — never touches the outbox at all", async () => {
    await runBatchWindow({ ...DEPS, cfg: { schedulingMode: 'project' } as never }, new Date('2026-09-16T06:00:00Z'));
    expect(outboxRepo.listEligibleOutbox).not.toHaveBeenCalled();
  });

  it('does nothing when nothing is eligible before the cutoff', async () => {
    (outboxRepo.listEligibleOutbox as jest.Mock).mockResolvedValue([]);
    await runBatchWindow(
      { ...DEPS, cfg: { schedulingMode: 'batch', windowCutoffMinutes: 15 } as never },
      new Date('2026-09-16T06:00:00Z'),
    );
    expect(plannerAgent.plan).not.toHaveBeenCalled();
    expect(orchestratorAgent.driveCohort).not.toHaveBeenCalled();
  });

  it('passes cutoff = at - windowCutoffMinutes to listEligibleOutbox', async () => {
    (outboxRepo.listEligibleOutbox as jest.Mock).mockResolvedValue([]);
    const at = new Date('2026-09-16T06:00:00Z');
    await runBatchWindow({ ...DEPS, cfg: { schedulingMode: 'batch', windowCutoffMinutes: 15 } as never }, at);
    expect((outboxRepo.listEligibleOutbox as jest.Mock).mock.calls[0][1]).toEqual(new Date('2026-09-16T05:45:00Z'));
  });

  it('plans every eligible row SEQUENTIALLY with the identical pinned timestamp (at - 1ms), marks each planned, then drives the cohort exactly once', async () => {
    const rows = [outboxRow({ id: 1, requestId: 'req_a' }), outboxRow({ id: 2, requestId: 'req_b' })];
    (outboxRepo.listEligibleOutbox as jest.Mock).mockResolvedValue(rows);
    (plannerAgent.plan as jest.Mock)
      .mockResolvedValueOnce({ cohortId: 'win_2026_09_16_00', requestId: 'req_a' })
      .mockResolvedValueOnce({ cohortId: 'win_2026_09_16_00', requestId: 'req_b' });

    const at = new Date('2026-09-16T06:00:00Z');
    await runBatchWindow({ ...DEPS, cfg: { schedulingMode: 'batch', windowCutoffMinutes: 15 } as never }, at);

    expect(plannerAgent.plan).toHaveBeenCalledTimes(2);
    const expectedAt = new Date(at.getTime() - 1);
    expect((plannerAgent.plan as jest.Mock).mock.calls[0][2]).toBe(rows[0].payload);
    expect((plannerAgent.plan as jest.Mock).mock.calls[0][3]).toEqual(expectedAt);
    expect((plannerAgent.plan as jest.Mock).mock.calls[1][3]).toEqual(expectedAt); // same timestamp for every row
    expect(outboxRepo.markOutboxPlanned).toHaveBeenCalledWith(DEPS.pool, 1, 'win_2026_09_16_00');
    expect(outboxRepo.markOutboxPlanned).toHaveBeenCalledWith(DEPS.pool, 2, 'win_2026_09_16_00');
    expect(orchestratorAgent.driveCohort).toHaveBeenCalledTimes(1);
    expect(orchestratorAgent.driveCohort).toHaveBeenCalledWith(expect.anything(), 'win_2026_09_16_00');
  });

  it('one row failing to plan does not stop the rest of the batch — marks it rejected and continues', async () => {
    const rows = [outboxRow({ id: 1, requestId: 'req_a' }), outboxRow({ id: 2, requestId: 'req_b' })];
    (outboxRepo.listEligibleOutbox as jest.Mock).mockResolvedValue(rows);
    (plannerAgent.plan as jest.Mock)
      .mockRejectedValueOnce(new Error('cohort not joinable'))
      .mockResolvedValueOnce({ cohortId: 'win_2026_09_16_00', requestId: 'req_b' });

    await runBatchWindow(
      { ...DEPS, cfg: { schedulingMode: 'batch', windowCutoffMinutes: 15 } as never },
      new Date('2026-09-16T06:00:00Z'),
    );

    expect(outboxRepo.markOutboxRejected).toHaveBeenCalledWith(DEPS.pool, 1, 'cohort not joinable');
    expect(outboxRepo.markOutboxPlanned).toHaveBeenCalledWith(DEPS.pool, 2, 'win_2026_09_16_00');
    // still drives the cohort the surviving row landed in
    expect(orchestratorAgent.driveCohort).toHaveBeenCalledWith(expect.anything(), 'win_2026_09_16_00');
  });

  it('never calls driveCohort when every row in the batch was rejected', async () => {
    const rows = [outboxRow({ id: 1 })];
    (outboxRepo.listEligibleOutbox as jest.Mock).mockResolvedValue(rows);
    (plannerAgent.plan as jest.Mock).mockRejectedValueOnce(new Error('boom'));

    await runBatchWindow(
      { ...DEPS, cfg: { schedulingMode: 'batch', windowCutoffMinutes: 15 } as never },
      new Date('2026-09-16T06:00:00Z'),
    );

    expect(orchestratorAgent.driveCohort).not.toHaveBeenCalled();
  });
});
