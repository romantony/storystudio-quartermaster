jest.mock('../src/shared/ffmpeg-io', () => ({
  download: jest.fn().mockResolvedValue(undefined),
  run: jest.fn().mockReturnValue({ stdout: '', stderr: '', status: 0 }),
  getDuration: jest.fn().mockReturnValue(0), // forces retarget() to fall back to targetSeconds
  uploadFile: jest.fn().mockImplementation((_path: string, key: string) => Promise.resolve(`https://cdn/${key}`)),
}));

import * as ffmpegIo from '../src/shared/ffmpeg-io';
import { handler } from '../src/handlers/reconcile-segment-timing';

const run = ffmpegIo.run as jest.Mock;

function scene(frameId: string, frameNumber: number, segmentIndex: number, duration: number, isSegmentLastFrame = false) {
  return { frameId, frameNumber, segmentIndex, videoUrl: `https://x/${frameId}.mp4`, duration, isSegmentLastFrame };
}

beforeEach(() => run.mockClear());

describe('reconcile-segment-timing — no-op', () => {
  it('leaves clips untouched when residual is under the 0.05s threshold', async () => {
    const sceneResults = [scene('f1', 1, 0, 3.02), scene('f2', 2, 0, 3.01, true)];
    const result = await handler({
      sceneResults, segmentResults: [{ segmentIndex: 0, actualDurationSeconds: 6.03 }], outputKeyPrefix: 'x',
    });
    expect(result.sceneResults).toEqual(sceneResults);
    expect(run).not.toHaveBeenCalled();
    expect(result.residualsBySegment[0]).toBeCloseTo(0, 5);
  });
});

describe('reconcile-segment-timing — trim', () => {
  it('trims the isSegmentLastFrame clip with a plain -t/-c copy cut when actual < planned', async () => {
    const sceneResults = [scene('f1', 1, 0, 3.0625), scene('f2', 2, 0, 5.0625, true)];
    const result = await handler({
      sceneResults, segmentResults: [{ segmentIndex: 0, actualDurationSeconds: 6.0 }], outputKeyPrefix: 'x',
    });
    expect(run).toHaveBeenCalledTimes(1);
    const args: string[] = run.mock.calls[0][0];
    expect(args).toContain('-c');
    expect(args).toContain('copy');
    const tIdx = args.indexOf('-t');
    // D_scenes=8.125, residual=6.0-8.125=-2.125, target=5.0625+(-2.125)=2.9375
    expect(Number(args[tIdx + 1])).toBeCloseTo(2.9375, 2);
    const corrected = result.sceneResults.find(c => c.frameId === 'f2')!;
    expect(corrected.duration).toBeCloseTo(2.9375, 3); // getDuration mocked to 0 -> falls back to the raw (non-toFixed) target
    expect(result.sceneResults.find(c => c.frameId === 'f1')!.duration).toBe(3.0625); // untouched
  });
});

describe('reconcile-segment-timing — extend', () => {
  it('extends the isSegmentLastFrame clip via stream_loop (not freeze-frame) when actual > planned', async () => {
    const sceneResults = [scene('f1', 1, 0, 3.0), scene('f2', 2, 0, 3.0, true)];
    const result = await handler({
      sceneResults, segmentResults: [{ segmentIndex: 0, actualDurationSeconds: 7.0 }], outputKeyPrefix: 'x',
    });
    const args: string[] = run.mock.calls[0][0];
    expect(args).toContain('-stream_loop');
    expect(args).toContain('-an'); // silent scene clips
    expect(args).not.toContain('copy');
    const tIdx = args.indexOf('-t');
    expect(Number(args[tIdx + 1])).toBeCloseTo(4.0, 3); // 3.0 + (7.0 - 6.0)
    expect(result.sceneResults.find(c => c.frameId === 'f2')!.duration).toBe(4.0);
  });

  it('distributes an overrun exceeding one whole scene across the LAST TWO clips, capped at ~2x original', async () => {
    // Segment has 3 clips of 3s each (9s total); actual came back at 20s —
    // residual (11s) exceeds the last clip's own duration (3s), so it must
    // split across the last two clips rather than stretching one to 14s.
    const sceneResults = [
      scene('f1', 1, 0, 3.0),
      scene('f2', 2, 0, 3.0),
      scene('f3', 3, 0, 3.0, true),
    ];
    const result = await handler({
      sceneResults, segmentResults: [{ segmentIndex: 0, actualDurationSeconds: 20.0 }], outputKeyPrefix: 'x',
    });
    expect(run).toHaveBeenCalledTimes(2); // f2 AND f3 both retargeted
    const f2 = result.sceneResults.find(c => c.frameId === 'f2')!;
    const f3 = result.sceneResults.find(c => c.frameId === 'f3')!;
    // Each extension capped at min(half=5.5, ownDuration=3.0) -> +3.0 each -> 6.0 each
    expect(f2.duration).toBe(6.0);
    expect(f3.duration).toBe(6.0);
    expect(result.sceneResults.find(c => c.frameId === 'f1')!.duration).toBe(3.0); // untouched
  });
});

describe('reconcile-segment-timing — multi-segment grouping', () => {
  it('reconciles each segment independently by segmentIndex (no JSONPath filter available in ASL, so this grouping happens here)', async () => {
    const sceneResults = [
      scene('a1', 1, 0, 3.0, true),   // segment 0: needs trim
      scene('b1', 2, 1, 3.0, true),   // segment 1: no-op
    ];
    const result = await handler({
      sceneResults,
      segmentResults: [
        { segmentIndex: 0, actualDurationSeconds: 2.0 },
        { segmentIndex: 1, actualDurationSeconds: 3.0 },
      ],
      outputKeyPrefix: 'x',
    });
    expect(result.sceneResults.find(c => c.frameId === 'a1')!.duration).toBe(2.0);
    expect(result.sceneResults.find(c => c.frameId === 'b1')!.duration).toBe(3.0); // untouched
  });

  it('throws if a segment has no isSegmentLastFrame clip (contract violation)', async () => {
    const sceneResults = [scene('a1', 1, 0, 3.0, false)];
    await expect(handler({
      sceneResults, segmentResults: [{ segmentIndex: 0, actualDurationSeconds: 5.0 }], outputKeyPrefix: 'x',
    })).rejects.toThrow(/no clip with isSegmentLastFrame/);
  });
});

describe('reconcile-segment-timing — segmentBoundariesSeconds', () => {
  it('returns cumulative end-times of every segment EXCEPT the last, in segmentIndex order', async () => {
    const sceneResults = [
      scene('a1', 1, 0, 10.0, true),
      scene('b1', 2, 1, 8.0, true),
      scene('c1', 3, 2, 5.0, true),
    ];
    const result = await handler({
      sceneResults,
      segmentResults: [
        { segmentIndex: 0, actualDurationSeconds: 10.0 },
        { segmentIndex: 1, actualDurationSeconds: 8.0 },
        { segmentIndex: 2, actualDurationSeconds: 5.0 },
      ],
      outputKeyPrefix: 'x',
    });
    expect(result.segmentBoundariesSeconds).toEqual([10.0, 18.0]); // not the 3rd (last) segment's end
  });
});
