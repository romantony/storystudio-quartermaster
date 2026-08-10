import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { download, getDuration, run, uploadFile, FFMPEG } from '../shared/ffmpeg-io';

/** Action shots (Wan2) are silent — no `0:a` stream to `apad`. Probe rather
 * than assume, same defensive posture as concat-and-trim's hasAudioStream(). */
function hasAudioStream(input: string): boolean {
  const r = spawnSync(FFMPEG, ['-i', input], { maxBuffer: 1024 * 1024 * 16 });
  return /Stream .* Audio:/.test(r.stderr?.toString() ?? '');
}

/**
 * QM-append-tail-beat — Dialogue Premium only, `kind:"monologue"`/`"dialogue"`
 * shots with `tailBeatSeconds > 0` (storystudio-dialogue-qm-sfn-handoff.md
 * §7.3): "Authored hold after this shot's last line... `0` for a hard cut,
 * `0.5-2.0` to let a line land. Filled by the ambience bed, so it is a beat,
 * not dead air." A frozen-last-frame hold (ffmpeg `tpad`) is the RIGHT tool
 * here — unlike reconcile-segment-timing.ts's scene-clip extension (which
 * explicitly must NOT freeze-frame, because it's covering a motion scene),
 * this is an intentionally authored directorial pause on a shot that has
 * already finished its line.
 */

interface AppendTailBeatEvent {
  videoUrl: string;
  tailBeatSeconds: number;
  outputKey: string;
}

interface AppendTailBeatResult {
  cdnUrl: string;
  durationS: number;
}

export const handler = async (event: AppendTailBeatEvent): Promise<AppendTailBeatResult> => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailbeat-'));
  const inputPath = path.join(workDir, 'input.mp4');
  const outputPath = path.join(workDir, 'output.mp4');

  try {
    await download(event.videoUrl, inputPath);

    const hasAudio = hasAudioStream(inputPath);
    const args = hasAudio
      ? [
        '-y', '-i', inputPath,
        '-vf', `tpad=stop_mode=clone:stop_duration=${event.tailBeatSeconds.toFixed(3)}`,
        '-af', `apad=pad_dur=${event.tailBeatSeconds.toFixed(3)}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k',
        outputPath,
      ]
      : [
        '-y', '-i', inputPath,
        '-vf', `tpad=stop_mode=clone:stop_duration=${event.tailBeatSeconds.toFixed(3)}`,
        '-an', '-c:v', 'libx264', '-preset', 'veryfast',
        outputPath,
      ];
    const { status, stderr } = run(args);
    if (status !== 0) throw new Error(`ffmpeg tail-beat append failed: ${stderr.slice(-1500)}`);

    const finalDuration = getDuration(outputPath);
    const url = await uploadFile(outputPath, event.outputKey, 'video/mp4');

    return { cdnUrl: url, durationS: finalDuration };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};
