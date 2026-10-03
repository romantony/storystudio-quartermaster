/**
 * QM-animate — one frame's Ken Burns clip, rendered on Lambda (2026-10-03).
 *
 * Narration-basic has no motion model: the still is animated with a Ken Burns
 * move. That used to happen inside the SFN tail's ECS `assemble` task, AFTER
 * Remotion would have needed a clip to draw its on-screen text onto — so a
 * basic explainer/educational project either lost its overlay or had to fall
 * back to Wan2. Rendering the move here, per frame and during generation,
 * gives Remotion a real clip and lets every frame animate in parallel.
 *
 * The legacy route (QM-generate `operation:'animate'` -> the flux-tts-s2t pod's
 * `animate` mode) is gone: that endpoint became the audio pool on 2026-09-20
 * and now answers "Invalid mode 'animate'".
 *
 * The move itself is `kenBurnsArgs` from the tail (concat-and-trim/tail-core.ts),
 * imported, not copied — the look is the one already verified live on
 * qm-e2e-animate-20261003-01.
 *
 * Input:  { imageUrl, durationS, effect?, fps?, projectId, frameId }
 * Output: { videoUrl, durationS, width, height, effect, fps }
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { evenDims, kenBurnsArgs, s3Url } from '../concat-and-trim/tail-core';

export interface AnimateEvent {
  imageUrl: string;
  /** The narration's REAL length (TTS-reported), not the script estimate. */
  durationS: number;
  effect?: string;
  fps?: number;
  projectId: string;
  frameId: string;
}

export interface AnimateResult {
  videoUrl: string;
  durationS: number;
  width: number;
  height: number;
  effect: string;
  fps: number;
}

export const EFFECTS = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right'] as const;
const DEFAULT_FPS = 16;
const BUCKET = process.env.OUTPUT_BUCKET ?? 'qm-remove-silence-output';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

/**
 * The clip must never be shorter than the narration: the tail merges with
 * `-shortest`, so a short clip silently clips the voice-over. `kenBurnsArgs`
 * truncates `durationS * fps` to whole frames, which undershot by up to one
 * frame (seen live: 37ms of narration lost). Padding by a frame makes its
 * truncation land on the ceiling.
 */
export function clipDurationS(narrationS: number, fps: number): number {
  return Math.ceil(narrationS * fps) / fps + 1 / fps;
}

export function validate(e: Partial<AnimateEvent>): asserts e is AnimateEvent {
  if (!e.imageUrl || !/^https?:\/\//.test(e.imageUrl)) throw new Error('imageUrl (http/https) is required');
  if (typeof e.durationS !== 'number' || !(e.durationS > 0) || e.durationS > 120) {
    throw new Error(`durationS must be a number in (0, 120], got ${String(e.durationS)}`);
  }
  if (!e.projectId || !e.frameId) throw new Error('projectId and frameId are required');
  if (e.effect !== undefined && !(EFFECTS as readonly string[]).includes(e.effect)) {
    throw new Error(`effect must be one of ${EFFECTS.join(', ')}, got ${e.effect}`);
  }
}

function sh(bin: string, args: string[], what: string): string {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 240_000 });
  if (r.status !== 0) throw new Error(`${what} failed (${r.status ?? r.signal}): ${(r.stderr || r.error?.message || '').slice(-1200)}`);
  return r.stdout;
}

function probeSize(file: string): { width: number; height: number } {
  const out = sh(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], 'ffprobe size').trim();
  const [w, h] = out.split('x').map(Number);
  return { width: w || 0, height: h || 0 };
}

function probeDuration(file: string): number {
  return Number(sh(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 'ffprobe duration').trim()) || 0;
}

/** Render one Ken Burns clip to `outPath`. Pure apart from ffmpeg — the unit
 * the local real-ffmpeg test drives. */
export function renderKenBurns(imgPath: string, outPath: string, effect: string, narrationS: number, fps: number): AnimateResult & { localPath: string } {
  const src = probeSize(imgPath);
  const { width, height } = evenDims(src.width, src.height);
  if (!width || !height) throw new Error(`could not read the still's dimensions (${src.width}x${src.height})`);
  sh(FFMPEG, kenBurnsArgs(imgPath, outPath, effect, width, height, clipDurationS(narrationS, fps), fps), 'ffmpeg Ken Burns');
  const durationS = probeDuration(outPath);
  if (durationS < narrationS) throw new Error(`clip is ${durationS}s, shorter than the ${narrationS}s narration`);
  return { videoUrl: '', localPath: outPath, durationS, width, height, effect, fps };
}

const s3 = new S3Client({ region: REGION });

export const handler = async (event: Partial<AnimateEvent>): Promise<AnimateResult> => {
  validate(event);
  const effect = event.effect ?? 'zoom_in';
  const fps = event.fps ?? DEFAULT_FPS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-'));
  try {
    const img = path.join(dir, 'still');
    const res = await fetch(event.imageUrl);
    if (!res.ok) throw new Error(`image download failed: HTTP ${res.status} ${event.imageUrl}`);
    fs.writeFileSync(img, Buffer.from(await res.arrayBuffer()));

    const out = path.join(dir, 'clip.mp4');
    const r = renderKenBurns(img, out, effect, event.durationS, fps);

    const key = `projects/${event.projectId}/animate/${event.frameId}.mp4`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: fs.readFileSync(out), ContentType: 'video/mp4' }));
    const result: AnimateResult = { videoUrl: s3Url(BUCKET, key, REGION), durationS: r.durationS, width: r.width, height: r.height, effect, fps };
    console.log(JSON.stringify({ msg: 'animated', projectId: event.projectId, frameId: event.frameId, ...result }));
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
