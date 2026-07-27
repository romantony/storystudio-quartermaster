import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * QM-remove-silence — post-concat silence removal for a language's finished
 * narration video/audio (2026-07-27 decision: cut silence out entirely,
 * leaving a small ~130ms pad on each edge, rather than just capping long
 * pauses — see qm-4lang-fullvideo-perframe memory for the underlying
 * complaint this addresses, "a video with a lot of pauses between each
 * frame"). Distinct from — and NOT a substitute for — the still-unfixed
 * per-clip TTS silence trimming drafted in flux4B-Wan2/handler.py: that fix
 * is stuck behind a separate, untracked-repo deploy process, so this runs
 * post-concat in infrastructure QM fully owns and controls instead.
 *
 * Algorithm (validated locally against a real project's hi/concatenated.mp4
 * before being ported here — see scratchpad remove_silence2.py): (1)
 * ffmpeg's `silencedetect` filter finds every silence run >= MIN_SILENCE_S
 * at NOISE_DB; (2) invert those into "keep" intervals, each shrunk by
 * SILENCE_PAD_S on both edges so cuts aren't jarring hard jumps; (3) cut
 * each keep interval to its own small file via `-ss/-to` (fast, avoids one
 * giant multi-branch filter_complex graph, which OOM-killed the Lambda-sized
 * container in local testing — 32 trim+concat branches on one input proved
 * too memory-hungry); (4) join them back with the concat DEMUXER (`-c copy`,
 * no re-encode, fast and low-memory) rather than the concat FILTER.
 *
 * `hasVideo:false` (Premium's fourLang localized voiceover, a whole-script
 * translated audio file with no paired video — see localizationStates())
 * skips the video trim/re-encode entirely and only cuts the audio track.
 */

interface RemoveSilenceEvent {
  mediaUrl: string;
  hasVideo: boolean;
  /** S3 key for the trimmed video (hasVideo:true) or trimmed audio (hasVideo:false). */
  outputKey: string;
  /** S3 key for the trimmed standalone audio track, extracted alongside the
   * trimmed video — only used when hasVideo:true. Downstream (transcribe,
   * finalize) reads video and audio as two separate URLs even though the
   * video already has audio embedded (see concatFourLangBranch's
   * {videoUrl,audioUrl} shape), so both must be cut from the identical
   * keep-segment list to stay in sync — extracting audio from the ALREADY-
   * trimmed video (not re-deriving it independently) guarantees that. */
  audioOutputKey?: string;
}

interface RemoveSilenceResult {
  trimmedVideoUrl: string;
  trimmedAudioUrl: string;
  originalDurationS: number;
  trimmedDurationS: number;
  silenceRemovedS: number;
}

const FFMPEG = require('@ffmpeg-installer/ffmpeg').path as string;
const BUCKET = process.env.OUTPUT_BUCKET!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const NOISE_DB = Number(process.env.SILENCE_NOISE_DB ?? -35);
const MIN_SILENCE_S = Number(process.env.SILENCE_MIN_DURATION_S ?? 0.4);
const SILENCE_PAD_S = Number(process.env.SILENCE_PAD_S ?? 0.13);
// 0.05s was too permissive — found live 2026-07-27 against a real
// storyaistudio.app final_video.mp4: a 0.113s tail keep-segment encoded with
// NO video stream at all (only audio survived from such a short -ss/-to cut),
// which broke the downstream concat entirely. 0.3s stays comfortably above
// one GOP at 30fps.
const MIN_KEEP_S = 0.3;

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

/** Parses ffmpeg's own `Duration: HH:MM:SS.ms` stderr line — avoids bundling
 * a second (ffprobe) binary just to read one number. */
function parseDurationFromStderr(stderr: string): number {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 0;
  const [, h, mnt, s] = m;
  return Number(h) * 3600 + Number(mnt) * 60 + Number(s);
}

function detectSilence(input: string): { duration: number; silences: [number, number][] } {
  const { stderr } = run(['-i', input, '-af', `silencedetect=noise=${NOISE_DB}dB:d=${MIN_SILENCE_S}`, '-f', 'null', '-']);
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

/** Cuts each keep-interval to its own small file, then rejoins them with the
 * concat FILTER over multiple `-i` inputs (NOT the concat demuxer's `-c
 * copy` join) — found live 2026-07-27 against a real storyaistudio.app
 * final_video.mp4 that the demuxer path silently corrupts duration/
 * timestamps (a 123.9s input came back as a bogus 261s output, with all 22
 * individual segments' own durations summing correctly to ~83s). The concat
 * FILTER decodes+re-encodes once at the join, which is what actually fixes
 * the PTS handling; it stays cheap here because inputs are already the small
 * per-segment files, not the original whole clip (that whole-clip-in-one-
 * filter-graph approach was tried first and OOM-killed the container). */
function cutAndConcat(input: string, keep: [number, number][], hasVideo: boolean, workDir: string, outPath: string): void {
  // Audio-only output (hasVideo:false, and the standalone track extracted
  // separately when hasVideo:true) is always PCM WAV, never AAC — found live
  // 2026-07-27: RunPod's Whisper worker loads audio via soundfile/libsndfile,
  // which doesn't support M4A/AAC at all ("Soundfile is either not in the
  // correct format or is malformed"). Every one of a real project's 4
  // TranscribeAudioFourLang languages failed this way once transcribe started
  // reading this Lambda's trimmed output instead of the original
  // (WAV-format) concat audio. WAV is universally readable, at the cost of a
  // larger file — fine at these durations (whole-project narration audio,
  // not raw video).
  const segFiles: string[] = [];
  keep.forEach(([s, e], i) => {
    const segPath = path.join(workDir, `seg${String(i).padStart(3, '0')}.${hasVideo ? 'mp4' : 'wav'}`);
    const args = ['-y', '-ss', s.toFixed(3), '-to', e.toFixed(3), '-i', input];
    if (hasVideo) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k');
    else args.push('-vn', '-c:a', 'pcm_s16le');
    args.push(segPath);
    const { status, stderr } = run(args);
    if (status !== 0) throw new Error(`ffmpeg segment ${i} (${s}-${e}) failed: ${stderr.slice(-1500)}`);
    segFiles.push(segPath);
  });

  const args: string[] = ['-y'];
  segFiles.forEach(f => args.push('-i', f));
  const n = segFiles.length;
  const filter = hasVideo
    ? `${segFiles.map((_, i) => `[${i}:v][${i}:a]`).join('')}concat=n=${n}:v=1:a=1[outv][outa]`
    : `${segFiles.map((_, i) => `[${i}:a]`).join('')}concat=n=${n}:v=0:a=1[outa]`;
  args.push('-filter_complex', filter);
  if (hasVideo) args.push('-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k');
  else args.push('-map', '[outa]', '-c:a', 'pcm_s16le');
  args.push(outPath);

  const { status, stderr } = run(args);
  if (status !== 0) throw new Error(`ffmpeg concat failed: ${stderr.slice(-1500)}`);
}

async function upload(localPath: string, key: string, contentType: string): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fs.readFileSync(localPath),
    ContentType: contentType,
  }));
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

export const handler = async (event: RemoveSilenceEvent): Promise<RemoveSilenceResult> => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-'));
  // Input extension is just a local temp filename — ffmpeg sniffs real
  // content regardless, so a mismatch here (e.g. actual input being WAV)
  // never breaks reading it. Only the OUTPUT audio format matters (see
  // cutAndConcat's header comment on why it's always WAV, never AAC).
  const inputExt = event.hasVideo ? 'mp4' : 'wav';
  const inputPath = path.join(workDir, `input.${inputExt}`);
  const outputPath = path.join(workDir, `output.${inputExt}`);

  try {
    await download(event.mediaUrl, inputPath);

    const { duration, silences } = detectSilence(inputPath);
    if (silences.length === 0 || duration === 0) {
      if (event.hasVideo) {
        // Nothing to trim (or duration unreadable) — upload the input as-is
        // rather than failing the whole language over a no-op.
        fs.copyFileSync(inputPath, outputPath);
      } else {
        // Audio-only passthrough must still GUARANTEE WAV output (not just
        // copy whatever format the input happened to be) — re-encode rather
        // than raw-copy, same reasoning as cutAndConcat's WAV-only policy.
        const { status, stderr } = run(['-y', '-i', inputPath, '-c:a', 'pcm_s16le', outputPath]);
        if (status !== 0) throw new Error(`ffmpeg passthrough re-encode failed: ${stderr.slice(-1500)}`);
      }
    } else {
      const keep = computeKeepSegments(duration, silences);
      cutAndConcat(inputPath, keep, event.hasVideo, workDir, outputPath);
    }

    const { duration: trimmedDuration } = detectSilence(outputPath);

    let trimmedVideoUrl = '';
    let trimmedAudioUrl = '';
    if (event.hasVideo) {
      trimmedVideoUrl = await upload(outputPath, event.outputKey, 'video/mp4');
      const audioPath = path.join(workDir, 'audio.wav');
      const { status, stderr } = run(['-y', '-i', outputPath, '-vn', '-c:a', 'pcm_s16le', audioPath]);
      if (status !== 0) throw new Error(`audio extraction failed: ${stderr.slice(-1500)}`);
      trimmedAudioUrl = await upload(audioPath, event.audioOutputKey ?? event.outputKey.replace(/\.mp4$/, '.wav'), 'audio/wav');
    } else {
      trimmedAudioUrl = await upload(outputPath, event.outputKey, 'audio/wav');
    }

    return {
      trimmedVideoUrl,
      trimmedAudioUrl,
      originalDurationS: duration,
      trimmedDurationS: trimmedDuration || duration,
      silenceRemovedS: Math.max(0, duration - (trimmedDuration || duration)),
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};
