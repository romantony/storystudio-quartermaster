/**
 * The orchestrator's assembly tail on ECS — entrypoint `node tail.js`, run by
 * the `E2E-VideoGenerationPipeline-Orchestrator` state machine on the existing
 * `qm-concat-and-trim` task definition (the SFN overrides the container's
 * command; same image, same cluster, same IAM, nothing new to provision).
 *
 * Two modes, picked by TAIL_MODE, each a separate ECS run so the state machine
 * can call RunPod for captions and BGM between them:
 *
 *   assemble   per frame: [Ken Burns a still] -> mux narration (+SFX);
 *              project:   concat -> [remove silence] -> A/V parity check.
 *              Writes video.mp4, audio.wav, meta.json (+ each frame's clip).
 *   finalize   upscale -> unsharp -> burn captions -> overlay BGM.
 *              Writes final.mp4 and result.json.
 *
 * Input is one small JSON in PAYLOAD_JSON — a manifest URL plus a few scalars,
 * far under ECS's 8192-byte ContainerOverrides limit (the reason the legacy
 * path uploads its payload to S3 first). The manifest itself is fetched from
 * its public R2 URL: no credentials needed to read it or the clips it names.
 *
 * ecs:runTask.sync returns nothing, so every result is written to S3 at a key
 * the state machine already knows, and read back there.
 *
 * The legacy entrypoint (index.ts, `node index.js`) is untouched and still
 * serves the AWS live-path pipelines; this file only imports its helpers.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  BUCKET,
  s3,
  run,
  download,
  upload,
  hasAudioStream,
  concatLocalClips,
  trimSilenceFromVideo,
} from './index';
import {
  assertManifest,
  assertAvParity,
  buildFinalizeArgs,
  buildFinalizeFilter,
  createTiktokAss,
  DEFAULT_BGM_VOLUME,
  DEFAULT_SFX_VOLUME,
  evenDims,
  kenBurnsArgs,
  mergeArgs,
  parseLoudness,
  parseResolution,
  s3Url,
  sfxNormalizeGainDb,
  stillDurationS,
  type AssembleMeta,
  type FinalizeResult,
  type ManifestFrame,
  type TailManifest,
} from './tail-core';

const FONTS_DIR = process.env.FONTS_DIR ?? '/opt/fonts';
const TAG = '[orchestrator-tail]';

interface AssemblePayload {
  manifestUrl: string;
  aspectRatio: string;
  /** S3 key prefix this execution writes under, e.g. `projects/<id>/tail/`. */
  outputPrefix: string;
  removeSilence: boolean;
}

interface FinalizePayload {
  manifestUrl: string;
  videoUrl: string;
  /** Word-level captions (SRT) from BGM-S2T. Empty = no captions. */
  srtUrl?: string;
  /** Generated music. Empty = no BGM. */
  bgmUrl?: string;
  aspectRatio: string;
  targetResolution: string;
  outputKey: string;
  resultKey: string;
}

// ── small helpers ─────────────────────────────────────────────────────────

function ff(args: string[], what: string, timeoutMs = 15 * 60_000): void {
  const { status, stderr } = run(args, timeoutMs);
  if (status !== 0) throw new Error(`${what} failed: ${stderr.slice(-1500)}`);
}

function probe(input: string, entries: string, stream?: string): string {
  const args = ['-v', 'error', ...(stream ? ['-select_streams', stream] : []), '-show_entries', entries, '-of', 'default=noprint_wrappers=1:nokey=1', input];
  const r = spawnSync('ffprobe', args, { maxBuffer: 1024 * 1024 * 16 });
  return r.stdout?.toString().trim() ?? '';
}

function formatDuration(input: string): number {
  return Number(probe(input, 'format=duration')) || 0;
}

/** One stream's own duration, not the container's: the two diverge exactly when
 * concat/mix desync video from audio, which is what the parity check catches. */
function streamDuration(input: string, stream: 'v:0' | 'a:0'): number {
  const first = probe(input, 'stream=duration', stream).split('\n')[0];
  const n = Number(first);
  return Number.isFinite(n) && n > 0 ? n : formatDuration(input);
}

function videoSize(input: string): { width: number; height: number } {
  const [w, h] = probe(input, 'stream=width,height', 'v:0').split('\n').map(Number);
  return { width: w || 0, height: h || 0 };
}

function loudness(input: string) {
  const { status, stderr } = run(['-hide_banner', '-nostats', '-i', input, '-af', 'ebur128=peak=sample:framelog=verbose', '-f', 'null', '-'], 5 * 60_000);
  if (status !== 0) {
    console.warn(`${TAG} ebur128 failed on ${input}, skipping SFX normalisation`);
    return null;
  }
  return parseLoudness(stderr);
}

async function putJson(key: string, value: unknown): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(value), ContentType: 'application/json' }));
}

async function readJsonUrl<T>(url: string, dir: string): Promise<T> {
  const dest = path.join(dir, `json-${path.basename(new URL(url).pathname)}`);
  await download(url, dest);
  return JSON.parse(fs.readFileSync(dest, 'utf8')) as T;
}

function payloadFromEnv<T>(): T {
  const raw = process.env.PAYLOAD_JSON;
  if (!raw) throw new Error('PAYLOAD_JSON is not set');
  return JSON.parse(raw) as T;
}

// ── assemble ──────────────────────────────────────────────────────────────

/** One frame, start to finish, on local disk. Throws on anything that would
 * silently drop or corrupt the frame; the caller decides what to do. */
async function prepareFrame(frame: ManifestFrame, defaultFps: number, workDir: string): Promise<{ clipPath: string; durationS: number }> {
  const id = frame.frameId;
  const audPath = path.join(workDir, `${id}.aud`);
  await download(frame.audioUrl, audPath);
  const audioS = formatDuration(audPath);
  if (audioS <= 0) throw new Error(`frame ${id}: narration audio is empty or unreadable`);

  let vidPath: string;
  if (frame.videoUrl) {
    vidPath = path.join(workDir, `${id}.src.mp4`);
    await download(frame.videoUrl, vidPath);
  } else {
    // No motion model: Ken Burns the still. Sized to the narration's REAL
    // length so the voice-over is never clipped.
    const imgPath = path.join(workDir, `${id}.img`);
    await download(frame.imageUrl as string, imgPath);
    const imgSize = videoSize(imgPath);
    const { width, height } = evenDims(imgSize.width, imgSize.height);
    if (!width || !height) throw new Error(`frame ${id}: could not read the still's dimensions`);
    vidPath = path.join(workDir, `${id}.kb.mp4`);
    const fps = frame.animate?.fps ?? defaultFps;
    ff(kenBurnsArgs(imgPath, vidPath, frame.animate?.effect ?? 'zoom_in', width, height, stillDurationS(audioS, frame.durationS), fps), `frame ${id} Ken Burns`);
    fs.rmSync(imgPath, { force: true });
  }

  const merged = path.join(workDir, `${id}.merged.mp4`);
  if (frame.sfxFromVideo) {
    // The clip's own audio track IS the SFX layer (MMAudio returns the clip with
    // SFX muxed in): lift it off, level it against the narration, mix under it.
    if (!hasAudioStream(vidPath)) throw new Error(`frame ${id}: sfx was planned but the clip has no audio track`);
    const sfxPath = path.join(workDir, `${id}.sfx.wav`);
    ff(['-y', '-i', vidPath, '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', sfxPath], `frame ${id} SFX extract`);
    const gainDb = sfxNormalizeGainDb(loudness(audPath), loudness(sfxPath), DEFAULT_SFX_VOLUME);
    ff(mergeArgs(vidPath, audPath, merged, { path: sfxPath, gainDb, volume: DEFAULT_SFX_VOLUME }), `frame ${id} merge`);
    fs.rmSync(sfxPath, { force: true });
  } else {
    ff(mergeArgs(vidPath, audPath, merged), `frame ${id} merge`);
  }
  fs.rmSync(vidPath, { force: true });
  fs.rmSync(audPath, { force: true });

  const durationS = formatDuration(merged);
  if (durationS <= 0) throw new Error(`frame ${id}: merged clip has no duration`);
  return { clipPath: merged, durationS };
}

export async function assemble(): Promise<void> {
  const p = payloadFromEnv<AssemblePayload>();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-assemble-'));
  try {
    const manifest = await readJsonUrl<TailManifest>(p.manifestUrl, workDir);
    assertManifest(manifest);
    const frames = [...manifest.frames].sort((a, b) => a.seq - b.seq);
    console.log(`${TAG} assemble ${manifest.projectId}: ${frames.length} frames (${manifest.droppedFrames.length} dropped upstream), aspect=${p.aspectRatio}, removeSilence=${p.removeSilence}`);

    const clips: string[] = [];
    const hosted: AssembleMeta['frames'] = [];
    const dropped = [...manifest.droppedFrames];
    for (const frame of frames) {
      try {
        const { clipPath, durationS } = await prepareFrame(frame, manifest.fps, workDir);
        // Each frame's finished clip is the project's durable per-frame
        // artifact: a rework of one frame starts from it, and it is what the
        // §9.6 result calls mergedClipUrl. Uploaded BEFORE concat, which
        // deletes its inputs on the batched path.
        const key = `${p.outputPrefix}frames/${frame.frameId}.mp4`;
        await upload(clipPath, key, 'video/mp4');
        hosted.push({ frameId: frame.frameId, url: s3Url(BUCKET, key), durationS: Math.round(durationS * 100) / 100 });
        clips.push(clipPath);
      } catch (err) {
        // A frame that cannot be built drops out (the project finishes
        // `partial`) rather than failing every other frame's work.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`${TAG} frame ${frame.frameId} dropped: ${reason}`);
        dropped.push({ frameId: frame.frameId, reason });
      }
    }
    // concat needs two clips; below that there is nothing to assemble.
    if (clips.length < 2) throw new Error(`fewer than two frames survived assembly (${clips.length}); dropped: ${JSON.stringify(dropped)}`);

    let { videoPath, audioPath } = await concatLocalClips(clips, p.aspectRatio, workDir);
    console.log(`${TAG} concat done`);
    if (p.removeSilence) {
      ({ videoPath, audioPath } = trimSilenceFromVideo(videoPath, workDir));
      console.log(`${TAG} silence removed`);
    }

    const videoS = streamDuration(videoPath, 'v:0');
    const audioS = streamDuration(videoPath, 'a:0');
    assertAvParity(videoS, audioS);
    const { width, height } = videoSize(videoPath);

    const videoKey = `${p.outputPrefix}video.mp4`;
    const audioKey = `${p.outputPrefix}audio.wav`;
    await upload(videoPath, videoKey, 'video/mp4');
    await upload(audioPath, audioKey, 'audio/wav');

    const meta: AssembleMeta = {
      videoKey,
      audioKey,
      videoUrl: s3Url(BUCKET, videoKey),
      audioUrl: s3Url(BUCKET, audioKey),
      durationSec: Math.round(Math.max(videoS, audioS) * 100) / 100,
      width,
      height,
      frames: hosted,
      droppedFrames: dropped,
    };
    await putJson(`${p.outputPrefix}meta.json`, meta);
    console.log(`${TAG} assemble done: ${meta.durationSec}s ${width}x${height}, ${hosted.length} frames`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ── finalize ──────────────────────────────────────────────────────────────

export async function finalize(): Promise<void> {
  const p = payloadFromEnv<FinalizePayload>();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-finalize-'));
  try {
    const manifest = await readJsonUrl<TailManifest>(p.manifestUrl, workDir);
    const bgmVolume = manifest.bgm?.volume ?? DEFAULT_BGM_VOLUME;

    const videoPath = path.join(workDir, 'in.mp4');
    await download(p.videoUrl, videoPath);
    if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size < 1024) throw new Error('assembled video download failed or is too small');

    const { width: targetWidth, height: targetHeight } = parseResolution(p.targetResolution, p.aspectRatio);
    const { width: inputWidth, height: inputHeight } = videoSize(videoPath);
    const videoDuration = formatDuration(videoPath);
    const inputHasAudio = hasAudioStream(videoPath);

    // Captions and BGM both degrade gracefully, like every other optional layer:
    // a failed download means a video without them, not no video.
    let captionsPath: string | undefined;
    if (p.srtUrl) {
      try {
        const srtPath = path.join(workDir, 'captions.srt');
        await download(p.srtUrl, srtPath);
        const ass = createTiktokAss(fs.readFileSync(srtPath, 'utf8'), targetWidth, targetHeight);
        if (ass.includes('Dialogue:')) {
          captionsPath = path.join(workDir, 'captions.ass');
          fs.writeFileSync(captionsPath, ass, 'utf8');
        } else {
          console.warn(`${TAG} captions SRT had no usable cues, continuing without captions`);
        }
      } catch (err) {
        console.warn(`${TAG} captions unavailable, continuing without: ${err instanceof Error ? err.message : err}`);
      }
    }
    let bgmPath: string | undefined;
    if (p.bgmUrl) {
      try {
        const dest = path.join(workDir, 'bgm.mp3');
        await download(p.bgmUrl, dest);
        if (fs.statSync(dest).size > 512) bgmPath = dest;
        else console.warn(`${TAG} BGM file too small, continuing without BGM`);
      } catch (err) {
        console.warn(`${TAG} BGM unavailable, continuing without: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!inputHasAudio && !bgmPath) throw new Error('input video has no audio and there is no BGM — refusing to deliver a silent video');

    console.log(`${TAG} finalize: ${inputWidth}x${inputHeight} -> ${targetWidth}x${targetHeight}, ${videoDuration.toFixed(1)}s, captions=${!!captionsPath}, bgm=${!!bgmPath}@${bgmVolume}`);

    const outputPath = path.join(workDir, 'out.mp4');
    const filterComplex = buildFinalizeFilter({
      inputWidth, inputHeight, targetWidth, targetHeight,
      captionsPath, bgmPath, bgmVolume, videoDuration, inputHasAudio, fontsDir: FONTS_DIR,
    });
    ff(buildFinalizeArgs({ videoPath, bgmPath, filterComplex, outputPath, videoDuration, inputHasAudio }), 'finalize encode', 60 * 60_000);
    if (!fs.existsSync(outputPath)) throw new Error('finalize produced no output file');

    assertAvParity(streamDuration(outputPath, 'v:0'), streamDuration(outputPath, 'a:0'));
    const outSize = videoSize(outputPath);

    await upload(outputPath, p.outputKey, 'video/mp4');
    const result: FinalizeResult = {
      videoUrl: s3Url(BUCKET, p.outputKey),
      durationSec: Math.round(formatDuration(outputPath) * 100) / 100,
      width: outSize.width,
      height: outSize.height,
      captions: !!captionsPath,
      bgm: !!bgmPath,
    };
    await putJson(p.resultKey, result);
    console.log(`${TAG} finalize done: ${result.videoUrl} ${result.durationSec}s ${result.width}x${result.height}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ── entrypoint ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = process.env.TAIL_MODE;
  if (mode === 'assemble') return assemble();
  if (mode === 'finalize') return finalize();
  throw new Error(`TAIL_MODE must be 'assemble' or 'finalize', got ${JSON.stringify(mode)}`);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(`${TAG} FAILED`, err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
