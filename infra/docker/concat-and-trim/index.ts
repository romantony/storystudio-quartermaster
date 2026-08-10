import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * QM concat-and-trim ECS task — replaces two things that used to be separate
 * hops through S3/R2 for the same file:
 *   1. Per-frame video concat (previously the external, storystudio-unified-
 *      owned `E2E-video-concat-premium` Lambda — ported here faithfully from
 *      its actually-deployed source, confirmed by reading it directly this
 *      session).
 *   2. Post-concat silence removal (previously `QM-remove-silence`, a
 *      Lambda that failed systematically on large projects — 12/12 real
 *      attempts failed on a 69-frame project, split between
 *      Runtime.OutOfMemory at its 2048MB ceiling and States.Timeout at
 *      600s. Fargate has neither ceiling).
 *
 * Runs as an ECS Fargate task (`ecs:runTask.sync`), not a Lambda — no
 * result is read back by the caller. The SFN constructs the final
 * videoUrl/audioUrl deterministically from the outputKey/audioOutputKey it
 * already passed in (same pattern `finalizeLocalizedBranch`'s
 * `outputKeyExpr` already uses); this task's only job is to write to
 * exactly those keys and exit 0, or exit non-zero on failure.
 */

interface FrameVideo {
  videoUrl: string;
  frameNumber: number;
}

interface Payload {
  videos: FrameVideo[];
  aspectRatio: string;
  outputKey: string;
  audioOutputKey: string;
  /** false for the plain non-fourLang path (concat only, matches today's
   * behavior exactly); true for fourLang branches (concat, then trim —
   * collapses what used to be two separate Lambda round-trips). */
  trimSilence: boolean;
}

const BUCKET = process.env.OUTPUT_BUCKET!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const s3 = new S3Client({ region: REGION });

// ── Dimension table — ported verbatim from storystudio-unified's
// DimensionManager (infrastructure/lambda/layers/e2e-common/python/e2e/modules/dimensions.py).
// Only 9:16/16:9 are ever sent by QM-New in practice; the full table is
// kept for parity with the source it replaces.
const ASPECT_RATIOS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1088 },
  '9:16': { width: 1008, height: 1792 },
  '1:1': { width: 1088, height: 1088 },
  '4:3': { width: 1024, height: 768 },
  '4:5': { width: 1024, height: 1280 },
  '21:9': { width: 2016, height: 864 },
};

// ── Concat tuning — ported from the external Lambda's constants.
const PARALLEL_THRESHOLD = 40;
const BATCH_SIZE = 10;
const MAX_BATCH_WORKERS = 2;
const TARGET_FPS = 30;

// ── Silence-trim tuning — ported verbatim from remove-silence.ts.
const NOISE_DB = Number(process.env.SILENCE_NOISE_DB ?? -35);
const MIN_SILENCE_S = Number(process.env.SILENCE_MIN_DURATION_S ?? 0.4);
const SILENCE_PAD_S = Number(process.env.SILENCE_PAD_S ?? 0.13);
const MIN_KEEP_S = 0.3;

function run(args: string[], timeoutMs?: number): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 256, timeout: timeoutMs });
  if (r.error) throw r.error;
  return { stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '', status: r.status ?? 1 };
}

function ffprobeJson(input: string): any {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], { maxBuffer: 1024 * 1024 * 64 });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr?.toString()}`);
  return JSON.parse(r.stdout.toString());
}

function hasAudioStream(input: string): boolean {
  try {
    const data = ffprobeJson(input);
    return (data.streams || []).some((s: any) => s.codec_type === 'audio');
  } catch {
    // Conservative fallback, matching the source: assume video-only rather
    // than risk a filter-graph error from a wrongly-assumed audio stream.
    return false;
  }
}

function durationSeconds(input: string): number {
  try {
    const data = ffprobeJson(input);
    return Math.max(0.01, Number(data.format?.duration || 0));
  } catch {
    return 0.01;
  }
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

/** Fetches this run's payload from S3 (PAYLOAD_S3_KEY) rather than reading it
 * out of an env var — ecs:runTask's ContainerOverrides has a hard 8192-byte
 * limit, which the inline-JSON per-frame video array used to blow past at
 * large frame counts (confirmed failing at 69 frames). The SFN uploads the
 * JSON here first and passes only the (short) key. */
async function fetchPayload(): Promise<Payload> {
  const key = process.env.PAYLOAD_S3_KEY!;
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = await res.Body!.transformToString();
  return JSON.parse(body);
}

async function upload(localPath: string, key: string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fs.readFileSync(localPath),
    ContentType: contentType,
  }));
}

// ── Concat: per-clip normalize (scale+pad+fps+format, audio aformat or
// synthesized silence) via one filter_complex, same as
// concat_premium_audio_safe() in the Lambda this replaces.
function concatNormalize(videoPaths: string[], outputPath: string, aspectRatio: string, preset: string): void {
  const { width, height } = ASPECT_RATIOS[aspectRatio] ?? ASPECT_RATIOS['9:16'];
  const n = videoPaths.length;
  const audioPresent = videoPaths.map(hasAudioStream);

  const inputs: string[] = [];
  videoPaths.forEach(p => inputs.push('-i', p));

  const filterParts: string[] = [];
  const concatInputs: string[] = [];
  for (let i = 0; i < n; i++) {
    filterParts.push(`[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${TARGET_FPS},format=yuv420p[v${i}]`);
    concatInputs.push(`[v${i}]`);
    if (audioPresent[i]) {
      filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
    } else {
      const dur = durationSeconds(videoPaths[i]);
      filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${dur},asetpts=N/SR/TB[a${i}]`);
    }
    concatInputs.push(`[a${i}]`);
  }
  filterParts.push(`${concatInputs.join('')}concat=n=${n}:v=1:a=1[outv][outa]`);

  const args = [
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', preset, '-crf', '23',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
    '-movflags', '+faststart',
    '-y', outputPath,
  ];
  const { status, stderr } = run(args, 15 * 60_000);
  if (status !== 0) throw new Error(`concat filter_complex failed: ${stderr.slice(-1500)}`);
}

function streamCopyConcat(inputPaths: string[], outputPath: string): void {
  const listPath = outputPath + '.list.txt';
  fs.writeFileSync(listPath, inputPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    const { status, stderr } = run(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-y', outputPath], 5 * 60_000);
    if (status !== 0) throw new Error(`stream-copy concat failed: ${stderr.slice(-1500)}`);
  } finally {
    fs.rmSync(listPath, { force: true });
  }
}

function extractAudioWav(input: string, outputPath: string): void {
  const { status, stderr } = run(['-i', input, '-vn', '-ar', '48000', '-ac', '2', '-y', outputPath], 10 * 60_000);
  if (status !== 0) throw new Error(`audio extraction failed: ${stderr.slice(-1500)}`);
}

/** Concats all frame clips into one normalized video, returns
 * {videoPath, audioPath}. Batches >40-frame projects (10/batch, up to 2
 * concurrent workers via child processes is unnecessary here — Fargate's
 * generous CPU/memory means running batches sequentially is still far
 * faster than Lambda's failure mode, and avoids the complexity of
 * orchestrating concurrent ffmpeg children — same batching SHAPE as the
 * source for very large projects, simplified to sequential since we're no
 * longer fighting a 2GB/10-minute ceiling). */
async function concatAllFrames(videos: FrameVideo[], aspectRatio: string, workDir: string): Promise<{ videoPath: string; audioPath: string }> {
  const sorted = [...videos].filter(v => v.videoUrl).sort((a, b) => a.frameNumber - b.frameNumber);
  if (sorted.length === 0) throw new Error('No videos with a non-empty videoUrl provided for concatenation');

  const localPaths: string[] = [];
  for (const v of sorted) {
    const dest = path.join(workDir, `frame_${v.frameNumber}.mp4`);
    await download(v.videoUrl, dest);
    localPaths.push(dest);
  }

  const finalVideoPath = path.join(workDir, 'concatenated.mp4');
  const finalAudioPath = path.join(workDir, 'concatenated-audio.wav');

  if (sorted.length <= PARALLEL_THRESHOLD) {
    concatNormalize(localPaths, finalVideoPath, aspectRatio, 'fast');
  } else {
    const batchDir = path.join(workDir, 'batches');
    fs.mkdirSync(batchDir, { recursive: true });
    const batchPaths: string[] = [];
    for (let i = 0; i < localPaths.length; i += BATCH_SIZE) {
      const batch = localPaths.slice(i, i + BATCH_SIZE);
      const batchOut = path.join(batchDir, `batch_${String(i / BATCH_SIZE).padStart(4, '0')}.mp4`);
      concatNormalize(batch, batchOut, aspectRatio, 'ultrafast');
      batchPaths.push(batchOut);
      // Free disk as we go — matches the source's per-batch input cleanup.
      batch.forEach(p => fs.rmSync(p, { force: true }));
    }
    streamCopyConcat(batchPaths, finalVideoPath);
    batchPaths.forEach(p => fs.rmSync(p, { force: true }));
  }

  extractAudioWav(finalVideoPath, finalAudioPath);
  return { videoPath: finalVideoPath, audioPath: finalAudioPath };
}

// ── Silence trim — ported verbatim from remove-silence.ts's algorithm
// (validated 2026-07-27 against real production videos, including the
// concat-filter-not-demuxer fix for PTS corruption and the MIN_KEEP_S=0.3
// fix for zero-video-stream tail segments).

function parseDurationFromStderr(stderr: string): number {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 0;
  const [, h, mnt, s] = m;
  return Number(h) * 3600 + Number(mnt) * 60 + Number(s);
}

function detectSilence(input: string): { duration: number; silences: [number, number][] } {
  const { stderr } = run(['-i', input, '-af', `silencedetect=noise=${NOISE_DB}dB:d=${MIN_SILENCE_S}`, '-f', 'null', '-'], 5 * 60_000);
  const duration = parseDurationFromStderr(stderr);
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => Number(m[1]));
  const n = Math.min(starts.length, ends.length);
  const silences: [number, number][] = [];
  for (let i = 0; i < n; i++) silences.push([starts[i], ends[i]]);
  return { duration, silences };
}

function computeKeepSegments(duration: number, silences: [number, number][]): [number, number][] {
  const keep: [number, number][] = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    const cutStart = Math.min(s + SILENCE_PAD_S, e);
    const cutEnd = Math.max(e - SILENCE_PAD_S, cutStart);
    if (cutStart > cursor + MIN_KEEP_S) keep.push([cursor, cutStart]);
    cursor = Math.max(cursor, cutEnd);
  }
  if (duration - cursor > MIN_KEEP_S) keep.push([cursor, duration]);
  return keep;
}

function trimCutAndConcat(input: string, keep: [number, number][], workDir: string, outPath: string): void {
  const segFiles: string[] = [];
  keep.forEach(([s, e], i) => {
    const segPath = path.join(workDir, `seg${String(i).padStart(3, '0')}.mp4`);
    const { status, stderr } = run(['-y', '-ss', s.toFixed(3), '-to', e.toFixed(3), '-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', segPath], 5 * 60_000);
    if (status !== 0) throw new Error(`trim segment ${i} (${s}-${e}) failed: ${stderr.slice(-1500)}`);
    segFiles.push(segPath);
  });

  const args: string[] = ['-y'];
  segFiles.forEach(f => args.push('-i', f));
  const n = segFiles.length;
  const filter = `${segFiles.map((_, i) => `[${i}:v][${i}:a]`).join('')}concat=n=${n}:v=1:a=1[outv][outa]`;
  args.push('-filter_complex', filter, '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', outPath);

  const { status, stderr } = run(args, 15 * 60_000);
  if (status !== 0) throw new Error(`trim concat failed: ${stderr.slice(-1500)}`);
}

/** Trims dead-air silence out of the concatenated video, returns the final
 * {videoPath, audioPath} — mutates nothing, produces new files in workDir. */
function trimSilenceFromVideo(inputVideoPath: string, workDir: string): { videoPath: string; audioPath: string } {
  const outputPath = path.join(workDir, 'trimmed.mp4');
  const { duration, silences } = detectSilence(inputVideoPath);
  if (silences.length === 0 || duration === 0) {
    fs.copyFileSync(inputVideoPath, outputPath);
  } else {
    const keep = computeKeepSegments(duration, silences);
    trimCutAndConcat(inputVideoPath, keep, workDir, outputPath);
  }
  const audioPath = path.join(workDir, 'trimmed-audio.wav');
  extractAudioWav(outputPath, audioPath);
  return { videoPath: outputPath, audioPath };
}

async function main(): Promise<void> {
  const payload: Payload = await fetchPayload();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-trim-'));

  try {
    console.log(`[concat-and-trim] ${payload.videos.length} frames, aspectRatio=${payload.aspectRatio}, trimSilence=${payload.trimSilence}`);

    let { videoPath, audioPath } = await concatAllFrames(payload.videos, payload.aspectRatio, workDir);
    console.log(`[concat-and-trim] concat done: ${videoPath}`);

    if (payload.trimSilence) {
      ({ videoPath, audioPath } = trimSilenceFromVideo(videoPath, workDir));
      console.log(`[concat-and-trim] trim done: ${videoPath}`);
    }

    await upload(videoPath, payload.outputKey, 'video/mp4');
    await upload(audioPath, payload.audioOutputKey, 'audio/wav');
    console.log(`[concat-and-trim] uploaded to ${payload.outputKey} / ${payload.audioOutputKey}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => { console.error('[concat-and-trim] FAILED', err); process.exit(1); },
);
