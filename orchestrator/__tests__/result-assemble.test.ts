/**
 * buildResult() — spec §9.6 result from DB facts (impl plan §6.7, M5).
 * Fixtures mirror the real 2026-09-15 cohort shape: bulk 0/2/3/14/15, tail
 * 6 -> 7 -> 8 (concat is the leaf even though 14/15 have higher seqs).
 */
import { buildResult, leafSeq, MAX_ERRORS, type ResultFacts } from '../src/result/assemble';

const T0 = new Date('2026-09-15T02:45:52Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

type Job = ResultFacts['jobs'][number];
let nextId = 1;
function job(stepSeq: number, frameId: string | null, output: unknown, over: Partial<Job> = {}): Job {
  return {
    id: nextId++,
    stepSeq,
    frameId,
    status: 'complete',
    qualityStatus: null,
    triedRungs: [],
    submittedAt: at(stepSeq * 10),
    completedAt: at(stepSeq * 10 + 5),
    output,
    error: null,
    ...over,
  };
}

function facts(jobs: Job[], over: Partial<ResultFacts> = {}): ResultFacts {
  return {
    project: { id: 'proj_1', requestId: 'req_1', cohortId: 'win_2026_09_15_00', createdAt: T0 },
    steps: [...new Set(jobs.map((j) => j.stepSeq))].map((seq) => ({
      seq,
      name: `s${seq}`,
      warmAt: at(seq * 10 + 2),
      startedAt: at(seq * 10),
      finishedAt: at(seq * 10 + 9),
    })),
    jobs,
    verdicts: [],
    gpuCostUsd: 0.192135,
    warmCostUsd: null,
    ...over,
  };
}

const frames = ['f01', 'f02', 'f03'];
function fullChain(): Job[] {
  nextId = 1;
  return [
    ...frames.map((f) => job(0, f, { image_url: `https://r2/${f}.png` })),
    ...frames.map((f) => job(2, f, { audio: `https://r2/${f}.wav`, duration_s: 3.4 })),
    ...frames.map((f) => job(3, f, { video_url: `https://r2/${f}_i2v.mp4` })),
    ...frames.map((f) => job(14, f, { video_url: `https://r2/${f}_up.mp4`, width: 1856, height: 1056 })),
    ...frames.map((f) => job(15, f, { audio_url: `https://r2/${f}.mp3`, video_url: `https://r2/${f}_mm.mp4` })),
    ...frames.map((f) => job(6, f, { video: `https://r2/${f}_merge.mp4` })),
    ...frames.map((f) => job(7, f, { video: `https://r2/${f}_trim.mp4` })),
    job(8, null, { mode: 'concat', video: 'https://r2/concat.mp4', duration_s: 10.06 }),
  ];
}

describe('leafSeq', () => {
  it('picks the highest project-scope step, not max(seq) — 14/15 run before merge', () => {
    expect(leafSeq([0, 2, 3, 14, 15, 6, 7, 8])).toBe(8);
  });
  it('falls back to the highest bulk step when the project has no tail', () => {
    expect(leafSeq([1, 2, 3])).toBe(3);
    expect(leafSeq([])).toBeUndefined();
  });
});

describe('buildResult', () => {
  it('completed: full chain, final asset from the leaf with DreamX resolution, per-step counts, metrics', () => {
    const r = buildResult(facts(fullChain()));
    expect(r.status).toBe('completed');
    expect(r).toMatchObject({ requestId: 'req_1', projectId: 'proj_1', cohortId: 'win_2026_09_15_00', errors: [] });
    expect(r.assets).toMatchObject({
      final: { url: 'https://r2/concat.mp4', durationS: 10.06, bytes: null, resolution: '1856x1056' },
      shorts: [],
    });
    expect(r.assets.frames).toHaveLength(3);
    // bulk steps first in seq order (14/15 before the tail), then the tail
    expect(r.steps.map((s) => s.seq)).toEqual([0, 2, 3, 14, 15, 6, 7, 8]);
    expect(r.steps.find((s) => s.seq === 14)).toMatchObject({ total: 3, completed: 3, failed: 0, warmMs: 2000, runMs: 5000 });
    expect(r.metrics).toEqual({
      queuedMs: 0,
      runMs: 155_000, // first submit (step 0 at +0s) -> last completion (step 15 at +155s)
      gpuCostUsd: 0.192135,
      qualityCostUsd: null,
      warmCostUsd: null,
    });
  });

  it('partial: the concat delivered but one frame failed upstream', () => {
    const jobs = fullChain();
    const f02merge = jobs.find((j) => j.stepSeq === 6 && j.frameId === 'f02')!;
    Object.assign(f02merge, { status: 'failed', output: null, error: { status: 'FAILED', error: 'ffmpeg error: no audio' } });
    const f02trim = jobs.find((j) => j.stepSeq === 7 && j.frameId === 'f02')!;
    Object.assign(f02trim, { status: 'failed', output: null, error: 'merge builder: no resolved clip' });
    const r = buildResult(facts(jobs));
    expect(r.status).toBe('partial');
    expect(r.assets.final?.url).toBe('https://r2/concat.mp4');
    expect(r.errors).toEqual([
      { frameId: 'f02', step: 6, agent: 'generator', reason: 'ffmpeg error: no audio', triedRungs: [] },
      { frameId: 'f02', step: 7, agent: 'generator', reason: 'merge builder: no resolved clip', triedRungs: [] },
    ]);
  });

  it('failed: the leaf never delivered (stalled at animation), with not_run / in_flight errors', () => {
    const jobs = fullChain();
    for (const j of jobs) {
      if (j.stepSeq === 3 && j.frameId === 'f01') Object.assign(j, { status: 'submitted', output: null, completedAt: null });
      else if (![0, 2, 3].includes(j.stepSeq)) Object.assign(j, { status: 'planned', output: null, submittedAt: null, completedAt: null });
    }
    const r = buildResult(facts(jobs));
    expect(r.status).toBe('failed');
    expect(r.assets.final).toBeNull();
    expect(r.errors[0]).toEqual({ frameId: 'f01', step: 3, agent: 'orchestrator', reason: 'in_flight_at_stop', triedRungs: [] });
    expect(r.errors.filter((e) => e.reason === 'not_run')).toHaveLength(13); // 3x(14,15,6,7) + concat
  });

  it('a quality-failed leaf is not delivered', () => {
    nextId = 1;
    const jobs = [job(1, 'f1', { image_url: 'https://r2/a.png' }, { qualityStatus: 'fail' })];
    const r = buildResult(facts(jobs));
    expect(r.status).toBe('failed');
    expect(r.errors).toEqual([{ frameId: 'f1', step: 1, agent: 'quality', reason: 'quality_attempts_exhausted', triedRungs: [] }]);
  });

  it('reports subtitles (caption srt, burned in) and bgm assets when those steps ran', () => {
    const jobs = fullChain();
    nextId = 100;
    jobs.push(job(5, null, { mode: 'bgm', audio: 'https://r2/bed.mp3' }));
    jobs.push(job(11, null, { srt: 'https://r2/final.srt', video: 'https://r2/captioned.mp4' }));
    jobs.push(job(12, null, { video: 'https://r2/final.mp4', duration_s: 10.06 }));
    const r = buildResult(facts(jobs));
    expect(r.assets.final?.url).toBe('https://r2/final.mp4');
    expect(r.assets.subtitles).toEqual({ url: 'https://r2/final.srt', burnedIn: true });
    expect(r.assets.bgm).toEqual({ url: 'https://r2/bed.mp3' });
  });

  it('quality{} counts from the verdict trail', () => {
    nextId = 1;
    const a = job(1, 'f1', { image_url: 'https://r2/1.png' }, { qualityStatus: 'pass' });
    const b = job(1, 'f2', { image_url: 'https://r2/2.png' }, { qualityStatus: 'pass' });
    const c = job(1, 'f3', { image_url: 'https://r2/3.png' }, { qualityStatus: 'fail' });
    const d = job(3, 'f1', { video_url: 'https://r2/1.mp4' });
    const r = buildResult(
      facts([a, b, c, d], {
        verdicts: [
          { jobId: a.id, attempt: 1, verdict: 'PASS', action: 'none', costUsd: 0.002 },
          { jobId: b.id, attempt: 1, verdict: 'FAIL', action: 'rework', costUsd: 0.002 },
          { jobId: b.id, attempt: 2, verdict: 'PASS', action: 'none', costUsd: 0.002 },
          { jobId: c.id, attempt: 1, verdict: 'FAIL', action: 'rework', costUsd: 0.002 },
          { jobId: c.id, attempt: 2, verdict: 'FAIL', action: 'rework', costUsd: 0.002 },
          { jobId: d.id, attempt: 1, verdict: 'GATED', action: 'skipped_gated', costUsd: null },
        ],
      }),
    );
    expect(r.quality).toEqual({ gated: 3, passedFirstAttempt: 1, reworked: 2, acceptedMarginal: 1, escalatedRung: 0 });
    expect(r.metrics.qualityCostUsd).toBe(0.01);
  });

  it('caps errors[] and reports errorsTotal', () => {
    nextId = 1;
    const jobs = Array.from({ length: MAX_ERRORS + 25 }, (_, i) =>
      job(3, `f${i}`, null, { status: 'planned', submittedAt: null, completedAt: null }),
    );
    const r = buildResult(facts(jobs));
    expect(r.errors).toHaveLength(MAX_ERRORS);
    expect(r.errorsTotal).toBe(MAX_ERRORS + 25);
  });
});

describe('buildResult — frames[] and project metadata (StoryStudio contract, 2026-09-15)', () => {
  const request = {
    tier: 'narration-premium',
    product: 'documentary',
    language: 'en',
    aspectRatio: '16:9',
    resolution: '1920x1080',
    options: { upscale: true, sfx: true, removeSilence: true },
    // Deliberately NOT in job order, to prove frames[] follows the request.
    frames: [{ frameId: 'f02' }, { frameId: 'f01' }, { frameId: 'f03' }],
  };
  const finishedAt = new Date('2026-09-15T03:19:00Z');

  it('lists every frame in request order with image, narration, clip and merged-clip URLs', () => {
    const base = facts(fullChain());
    const r = buildResult({ ...base, project: { ...base.project, request }, finishedAt });
    expect(r.assets.frames.map((fr) => fr.frameId)).toEqual(['f02', 'f01', 'f03']);
    expect(r.assets.frames[1]).toEqual({
      index: 1,
      frameId: 'f01',
      status: 'completed',
      qualityFlagged: false,
      imageUrl: 'https://r2/f01.png',
      narrationAudioUrl: 'https://r2/f01.wav',
      narrationDurationS: 3.4,
      clipUrl: 'https://r2/f01_up.mp4', // DreamX output preferred over the raw i2v clip
      mergedClipUrl: 'https://r2/f01_trim.mp4', // remove-silence output preferred over merge
    });
  });

  it('echoes project metadata and timestamps', () => {
    const base = facts(fullChain());
    const r = buildResult({ ...base, project: { ...base.project, request }, finishedAt });
    expect(r.project).toEqual({
      tier: 'narration-premium',
      product: 'documentary',
      language: 'en',
      aspectRatio: '16:9',
      resolution: '1920x1080',
      frameCount: 3,
      options: { upscale: true, sfx: true, removeSilence: true },
    });
    expect(r.createdAt).toBe(T0.toISOString());
    expect(r.finishedAt).toBe(finishedAt.toISOString());
  });

  it('falls back to the raw clip / merge output, and marks a frame failed when any of its jobs failed', () => {
    nextId = 1;
    const jobs = [
      job(1, 'f01', { image_url: 'https://r2/f01.png' }),
      job(2, 'f01', { audio: 'https://r2/f01.wav' }),
      job(3, 'f01', { video_url: 'https://r2/f01_i2v.mp4' }),
      job(6, 'f01', { video: 'https://r2/f01_merge.mp4' }),
      job(1, 'f02', { image_url: 'https://r2/f02.png' }),
      job(2, 'f02', { audio: 'https://r2/f02.wav' }),
      job(3, 'f02', null, { status: 'failed', error: { error: 'CUDA OOM' } }),
      job(6, 'f02', null, { status: 'planned', submittedAt: null, completedAt: null }),
      job(8, null, { video: 'https://r2/concat.mp4' }),
    ];
    const r = buildResult(facts(jobs));
    expect(r.project).toBeNull(); // no stored request
    expect(r.assets.frames[0]).toMatchObject({ frameId: 'f01', status: 'completed', clipUrl: 'https://r2/f01_i2v.mp4', mergedClipUrl: 'https://r2/f01_merge.mp4' });
    expect(r.assets.frames[1]).toMatchObject({ frameId: 'f02', status: 'failed', imageUrl: 'https://r2/f02.png', clipUrl: null, mergedClipUrl: null });
  });
});
