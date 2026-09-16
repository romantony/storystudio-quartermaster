/**
 * agents/rework.ts — admin-triggered targeted rework (2026-09-16).
 * validateRework() is the fast, awaited-by-the-route validation (must throw
 * ReworkError for every "can't rework this" case, never proceed); driveRework()
 * is the long-running splice/re-finalize (mocks plan()/driveCohort()/the
 * runpod client/deliverCallback(), covers correct frame splicing and the
 * abort-on-still-failing-frame path per the impl plan's Verification section).
 */
import type { Pool } from 'pg';
import { getProject, updateProjectResult } from '../src/db/repo/projects';
import { plan } from '../src/agents/planner';
import { driveCohort } from '../src/agents/orchestrator';
import { deliverCallback } from '../src/result/callback';
import { validateRework, driveRework, ReworkError, type ReworkDeps, type PreparedRework } from '../src/agents/rework';
import type { QmResult } from '../src/result/assemble';

jest.mock('../src/db/repo/projects');
jest.mock('../src/agents/planner');
jest.mock('../src/agents/orchestrator');
jest.mock('../src/result/callback');

const mockGetProject = getProject as jest.MockedFunction<typeof getProject>;
const mockUpdateProjectResult = updateProjectResult as jest.MockedFunction<typeof updateProjectResult>;
const mockPlan = plan as jest.MockedFunction<typeof plan>;
const mockDriveCohort = driveCohort as jest.MockedFunction<typeof driveCohort>;
const mockDeliverCallback = deliverCallback as jest.MockedFunction<typeof deliverCallback>;

function baseResult(frames: QmResult['assets']['frames']): QmResult {
  return {
    requestId: 'req_p1',
    projectId: 'p1',
    cohortId: 'c1',
    status: 'partial',
    createdAt: '2026-09-16T00:00:00Z',
    finishedAt: '2026-09-16T00:05:00Z',
    project: null,
    assets: { final: null, frames, shorts: [] },
    steps: [],
    quality: { gated: 0, passedFirstAttempt: 0, reworked: 0, acceptedMarginal: 0, escalatedRung: 0 },
    metrics: { queuedMs: null, runMs: null, gpuCostUsd: null },
    errors: [],
  } as unknown as QmResult;
}

function frame(frameId: string, status: 'completed' | 'failed', mergedClipUrl: string | null) {
  return {
    index: 0,
    frameId,
    status,
    qualityFlagged: false,
    imageUrl: null,
    narrationAudioUrl: null,
    narrationDurationS: null,
    clipUrl: null,
    mergedClipUrl,
  };
}

function project(overrides: Partial<Awaited<ReturnType<typeof getProject>>> = {}) {
  return {
    id: 'p1',
    cohortId: 'c1',
    requestId: 'req_p1',
    tier: 'basic',
    language: 'en',
    status: 'partial',
    request: {
      requestId: 'req_p1',
      projectId: 'p1',
      options: {},
      frames: [{ frameId: 'f1' }, { frameId: 'f2' }],
    },
    result: baseResult([frame('f1', 'completed', 'https://x/f1.mp4'), frame('f2', 'failed', null)]),
    callbackUrl: 'https://storystudio.example/callback',
    ...overrides,
  } as Awaited<ReturnType<typeof getProject>>;
}

const pool = { query: jest.fn(async () => ({ rows: [] })) } as unknown as Pool;
const deps: ReworkDeps = { pool, runpod: { run: jest.fn(), status: jest.fn() } as never, cfg: {} as never, publicBaseUrl: 'https://orch.example' };

function poolWithFailedFrames(frameIds: string[]) {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("status = 'failed' AND frame_id IS NOT NULL")) {
        return { rows: frameIds.map((frame_id) => ({ frame_id })) };
      }
      if (sql.includes('FROM projects WHERE id LIKE')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    }),
  } as unknown as Pool;
}

beforeEach(() => jest.clearAllMocks());

describe('validateRework', () => {
  it('throws when the project does not exist', async () => {
    mockGetProject.mockResolvedValue(undefined);
    await expect(validateRework({ ...deps, pool: poolWithFailedFrames(['f2']) }, 'p1')).rejects.toThrow(ReworkError);
  });

  it('throws when the project is not partial/failed', async () => {
    mockGetProject.mockResolvedValue(project({ status: 'completed' }));
    await expect(validateRework({ ...deps, pool: poolWithFailedFrames(['f2']) }, 'p1')).rejects.toThrow(/not partial\/failed/);
  });

  it('throws when the project has no stored result to patch', async () => {
    mockGetProject.mockResolvedValue(project({ result: null }));
    await expect(validateRework({ ...deps, pool: poolWithFailedFrames(['f2']) }, 'p1')).rejects.toThrow(/no stored result/);
  });

  it('throws when there are no failed frames to rework', async () => {
    mockGetProject.mockResolvedValue(project());
    await expect(validateRework({ ...deps, pool: poolWithFailedFrames([]) }, 'p1')).rejects.toThrow(/no failed frames/);
  });

  it('throws when a failed frame id is missing from the stored request', async () => {
    mockGetProject.mockResolvedValue(project());
    await expect(validateRework({ ...deps, pool: poolWithFailedFrames(['f2', 'ghost']) }, 'p1')).rejects.toThrow(/not found in the stored request/);
  });

  it('builds a repair request scoped to only the failed frames, with an incrementing repairId', async () => {
    mockGetProject.mockResolvedValue(project());
    const p = poolWithFailedFrames(['f2']);
    const prepared = await validateRework({ ...deps, pool: p }, 'p1');
    expect(prepared.repairId).toBe('p1__repair1');
    expect(prepared.repairRequest.projectId).toBe('p1__repair1');
    expect(prepared.repairRequest.frames).toEqual([{ frameId: 'f2' }]);
    expect(prepared.failedFrameIds).toEqual(new Set(['f2']));
  });
});

describe('driveRework', () => {
  function prepared(overrides: Partial<PreparedRework> = {}): PreparedRework {
    return {
      projectId: 'p1',
      originalRequest: { requestId: 'req_p1', projectId: 'p1', options: {}, frames: [{ frameId: 'f1' }, { frameId: 'f2' }] } as never,
      originalResult: baseResult([frame('f1', 'completed', 'https://x/f1.mp4'), frame('f2', 'failed', null)]),
      originalCallbackUrl: 'https://storystudio.example/callback',
      originalRequestId: 'req_p1',
      failedFrameIds: new Set(['f2']),
      repairId: 'p1__repair1',
      repairRequest: { requestId: 'req_p1__repair1', projectId: 'p1__repair1', options: {}, frames: [{ frameId: 'f2' }] } as never,
      ...overrides,
    };
  }

  function stubRunpod(finalUrl: string) {
    const run = jest.fn(async () => ({ id: 'job1', status: 'COMPLETED', output: { url: finalUrl } }));
    return { run, status: jest.fn() } as never;
  }

  it('splices the repaired frame into the original result and leaves the already-successful frame untouched', async () => {
    mockPlan.mockResolvedValue({ cohortId: 'c2' } as never);
    mockDriveCohort.mockResolvedValue(undefined);
    mockGetProject.mockResolvedValue(
      project({
        id: 'p1__repair1',
        result: baseResult([frame('f2', 'completed', 'https://x/f2-fixed.mp4')]),
      }),
    );
    mockDeliverCallback.mockResolvedValue({ outcome: 'delivered', attempts: [] });

    const runpod = stubRunpod('https://x/final.mp4');
    await driveRework({ ...deps, runpod }, prepared());

    expect(mockPlan).toHaveBeenCalledWith(deps.pool, deps.cfg, prepared().repairRequest);
    expect(mockDriveCohort).toHaveBeenCalledWith(expect.objectContaining({ pool: deps.pool }), 'c2');

    expect(mockUpdateProjectResult).toHaveBeenCalledTimes(1);
    const [, id, { result, status }] = mockUpdateProjectResult.mock.calls[0];
    expect(id).toBe('p1');
    expect(status).toBe('completed');
    const patched = result as QmResult;
    expect(patched.assets.frames.map((f) => [f.frameId, f.mergedClipUrl])).toEqual([
      ['f1', 'https://x/f1.mp4'],
      ['f2', 'https://x/f2-fixed.mp4'],
    ]);
    expect(patched.assets.final?.url).toBe('https://x/final.mp4');

    expect(mockDeliverCallback).toHaveBeenCalledTimes(1);
    expect(mockDeliverCallback.mock.calls[0][0]).toMatchObject({ url: 'https://storystudio.example/callback', requestId: 'req_p1' });
  });

  it('aborts without patching the project when the repaired frame is still failed', async () => {
    mockPlan.mockResolvedValue({ cohortId: 'c2' } as never);
    mockDriveCohort.mockResolvedValue(undefined);
    mockGetProject.mockResolvedValue(
      project({
        id: 'p1__repair1',
        result: baseResult([frame('f2', 'failed', null)]),
      }),
    );

    const runpod = stubRunpod('https://x/final.mp4');
    await expect(driveRework({ ...deps, runpod }, prepared())).rejects.toThrow(/still failed after repair/);
    expect(mockUpdateProjectResult).not.toHaveBeenCalled();
    expect(mockDeliverCallback).not.toHaveBeenCalled();
  });

  it('throws when the repair project never produced a result at all', async () => {
    mockPlan.mockResolvedValue({ cohortId: 'c2' } as never);
    mockDriveCohort.mockResolvedValue(undefined);
    mockGetProject.mockResolvedValue(project({ id: 'p1__repair1', result: null }));

    const runpod = stubRunpod('https://x/final.mp4');
    await expect(driveRework({ ...deps, runpod }, prepared())).rejects.toThrow(/never produced a result/);
    expect(mockUpdateProjectResult).not.toHaveBeenCalled();
  });

  it('skips the callback when the original project has none', async () => {
    mockPlan.mockResolvedValue({ cohortId: 'c2' } as never);
    mockDriveCohort.mockResolvedValue(undefined);
    mockGetProject.mockResolvedValue(project({ id: 'p1__repair1', result: baseResult([frame('f2', 'completed', 'https://x/f2-fixed.mp4')]) }));

    const runpod = stubRunpod('https://x/final.mp4');
    await driveRework({ ...deps, runpod }, prepared({ originalCallbackUrl: null }));

    expect(mockUpdateProjectResult).toHaveBeenCalledTimes(1);
    expect(mockDeliverCallback).not.toHaveBeenCalled();
  });
});
