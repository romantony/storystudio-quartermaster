import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * QM-merge — audio+video mux for the narration-basic per-frame pipeline
 * (video.narrationBasic.merge / video.narrationPremium.merge alias),
 * replacing the RunPod flux-tts-s2t pod's `run_merge()`. Merge is pure
 * ffmpeg muxing (no model inference) — it was only ever on the GPU pod for
 * convenience, and moving it here removes it entirely from the shared
 * 6-worker pool it used to compete with image/TTS/animate for (found live
 * 2026-07-27: merge x4-per-frame was one of the two biggest concurrent
 * fan-outs against that pool, alongside TTS x4, and a real contributor to
 * that day's execution timeouts).
 *
 * Also finally fixes the long-flagged "Bug #6" padding gap: RunPod's
 * `run_merge()` hardcoded ffmpeg's `-shortest` flag, which always trims to
 * the SHORTER of video/audio — wrong for fourLang, where a language whose
 * TTS came in shorter than the frame's shared max-across-4-languages video
 * needs its AUDIO padded with trailing silence, not the video trimmed. That
 * fix was blocked for months behind flux4B-Wan2's untracked-repo deploy
 * friction; owning merge here removes that blocker entirely.
 *
 * Single ffmpeg invocation handles both cases uniformly via `apad`'s
 * `whole_dur` option (pads audio with silence up to a target duration,
 * no-op if audio is already >= that duration) combined with an output `-t`
 * cap: `durationS` present -> target = durationS (pad shorter audio, matches
 * fourLangMergeBranch's frame-shared-max-duration use); `durationS` absent
 * -> target = min(videoDuration, audioDuration), reproducing the legacy
 * `-shortest` trim-to-shorter behavior other (non-fourLang) callers rely on.
 */

interface MergeEvent {
  videoUrl: string;
  audioUrl: string;
  /** Target duration in seconds. Present (fourLang per-frame): pad shorter
   * audio with trailing silence to reach it. Absent: trim to the shorter of
   * video/audio (legacy -shortest behavior). */
  durationS?: number;
  outputKey: string;
}

interface MergeResult {
  cdnUrl: string;
  durationS: number;
}

const FFMPEG = require('@ffmpeg-installer/ffmpeg').path as string;
const BUCKET = process.env.OUTPUT_BUCKET!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const s3 = new S3Client({ region: REGION });

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(FFMPEG, args, { maxBuffer: 1024 * 1024 * 128 });
  if (r.error) throw r.error;
  return { stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '', status: r.status ?? 1 };
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(dest);
    client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: ${url} -> HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', reject);
  });
}

function parseDurationFromStderr(stderr: string): number {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 0;
  const [, h, mnt, s] = m;
  return Number(h) * 3600 + Number(mnt) * 60 + Number(s);
}

function getDuration(input: string): number {
  const { stderr } = run(['-i', input, '-f', 'null', '-']);
  return parseDurationFromStderr(stderr);
}

/** `@ffmpeg-installer/ffmpeg`'s bundled static binary is an old build (2018,
 * libavfilter 7.46) whose `apad` filter predates the `whole_dur`/`pad_dur`
 * options (seconds-based) — found live 2026-07-27 smoke-testing against
 * real production media, both trim and pad cases: `Option 'whole_dur' not
 * found`. Only `pad_len`/`whole_len` (SAMPLE-count based) exist in this
 * build, so a sample rate has to be parsed out of ffmpeg's own stderr. */
function getSampleRate(stderr: string): number {
  const m = stderr.match(/(\d+)\s*Hz/);
  return m ? Number(m[1]) : 48000;
}

export const handler = async (event: MergeEvent): Promise<MergeResult> => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  const videoPath = path.join(workDir, 'video.mp4');
  const audioPath = path.join(workDir, 'audio.in');
  const outputPath = path.join(workDir, 'output.mp4');

  try {
    await Promise.all([download(event.videoUrl, videoPath), download(event.audioUrl, audioPath)]);

    const videoDuration = getDuration(videoPath);
    const audioProbe = run(['-i', audioPath, '-f', 'null', '-']);
    const audioDuration = parseDurationFromStderr(audioProbe.stderr);
    const sampleRate = getSampleRate(audioProbe.stderr);
    const target = event.durationS ?? Math.min(videoDuration, audioDuration);

    // Always pad by a fixed, generous sample count (a full minute of
    // silence) rather than computing the exact gap — the `-t target` output
    // cap below trims it to the exact right length either way, so this
    // works uniformly for both the pad case (audio shorter than target) and
    // the trim case (audio already >= target, where the padding is simply
    // never reached before the cutoff).
    const padLenSamples = sampleRate * 60;
    const filter = `[1:a]apad=pad_len=${padLenSamples}[aout]`;
    const { status, stderr } = run([
      '-y', '-i', videoPath, '-i', audioPath,
      '-filter_complex', filter,
      '-map', '0:v:0', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
      '-t', target.toFixed(3),
      outputPath,
    ]);
    if (status !== 0) throw new Error(`ffmpeg merge failed: ${stderr.slice(-1500)}`);

    const finalDuration = getDuration(outputPath) || target;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: event.outputKey,
      Body: fs.readFileSync(outputPath),
      ContentType: 'video/mp4',
    }));

    return {
      cdnUrl: `https://${BUCKET}.s3.${REGION}.amazonaws.com/${event.outputKey}`,
      durationS: finalDuration,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};
