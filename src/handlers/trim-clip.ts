import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { download, getDuration, run, uploadFile } from '../shared/ffmpeg-io';

/**
 * QM-trim-clip — plain `-t <target> -c copy` trim, no re-encode, no silence
 * detection. Two Dialogue Premium/Basic use cases
 * (storystudio-dialogue-qm-sfn-handoff.md):
 *
 *  - `TrimToTrackLength` (Premium, per `kind:"dialogue"` shot): RunComfy
 *    `fast/multi` always appends a fixed +1.00s trailing pad (§7.4/§7.6.4,
 *    verified live on 4/4 real calls) — trim to `left_duration+right_duration`,
 *    a length already known at BuildTurnTracks time, not detected.
 *  - The trim leg of `ReconcileSegmentTiming` (Basic, reconcile-segment-
 *    timing.ts) delegates here when a segment's TTS came in shorter than its
 *    planned scenes (residual < 0, §4.5).
 *
 * Deliberately NOT `silencedetect`-based (§7.6.6: that tool solves a
 * different problem — per-frame accumulated dead air — and using it here
 * would risk crushing an authored pause).
 */

interface TrimClipEvent {
  videoUrl: string;
  targetDurationSeconds: number;
  outputKey: string;
}

interface TrimClipResult {
  cdnUrl: string;
  durationS: number;
}

export const handler = async (event: TrimClipEvent): Promise<TrimClipResult> => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-'));
  const inputPath = path.join(workDir, 'input.mp4');
  const outputPath = path.join(workDir, 'output.mp4');

  try {
    await download(event.videoUrl, inputPath);

    const { status, stderr } = run([
      '-y', '-i', inputPath,
      '-t', event.targetDurationSeconds.toFixed(3),
      '-c', 'copy',
      outputPath,
    ]);
    if (status !== 0) throw new Error(`ffmpeg trim failed: ${stderr.slice(-1500)}`);

    const finalDuration = getDuration(outputPath) || event.targetDurationSeconds;
    const url = await uploadFile(outputPath, event.outputKey, 'video/mp4');

    return { cdnUrl: url, durationS: finalDuration };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};
