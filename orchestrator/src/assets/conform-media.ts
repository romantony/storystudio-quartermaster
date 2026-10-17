/**
 * Every generated still AND clip at EXACTLY the project's frame size
 * (2026-10-17): 1280x720 for 16:9, 720x1280 for 9:16 — what the LTX graphs
 * render at. The tail upscales from there to the delivery resolution.
 *
 * The generators size their own output close to, never exactly at, the
 * project's aspect: Qwen-Image-Edit keeps its source's aspect at ~1 MP
 * (1376x768 from a 16:9 canvas), LTX-2.3 rounds 720 down to 704, MiniMax H3
 * renders 864x480, Wan2 its 480p profile. The tail's concat then letterboxed
 * each one. Conformed here, in process, when the asset arrives, rather than in
 * each worker or graph: one rule for every generator, and no worker image
 * rebuild (those pull diffusers HEAD).
 *
 * Scale to COVER, then centre-crop — never pad: outputs are already near the
 * right aspect (char-ref pads sheets onto the frame's canvas), so the crop is
 * a few pixels, and padding would put bars into the video.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The exact frame size for a project aspect, or null for an aspect this
 * rule does not cover (left as the worker made it). */
export function stillSize(aspectRatio: string | undefined): [number, number] | null {
  const a = (aspectRatio ?? '').replace(/\s/g, '');
  if (a === '16:9') return [1280, 720];
  if (a === '9:16') return [720, 1280];
  return null;
}

export function conformFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
}

export interface ConformTools {
  fetchImpl?: typeof fetch;
  /** ffprobe -> "W,H". */
  probe?: (file: string) => Promise<string>;
  ffmpeg?: (args: string[]) => Promise<void>;
}

/** The still at `url` resized to `size`, or null when it already is that size. */
export async function conformStill(url: string, [width, height]: [number, number], tools: ConformTools = {}): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'still-'));
  try {
    const res = await (tools.fetchImpl ?? fetch)(url);
    if (!res.ok) throw new Error(`conform still: GET ${url} -> HTTP ${res.status}`);
    const src = path.join(dir, 'src');
    await writeFile(src, Buffer.from(await res.arrayBuffer()));
    const [w, h] = (await (tools.probe ?? ffprobe)(src)).trim().split(',').map(Number);
    if (w === width && h === height) return null;
    const out = path.join(dir, 'out.png');
    await (tools.ffmpeg ?? ffmpeg)(['-y', '-loglevel', 'error', '-i', src, '-vf', conformFilter(width, height), '-frames:v', '1', out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A generated clip re-encoded to `size` (audio copied untouched), or null
 * when it already is that size. */
export async function conformClip(bytes: Buffer, [width, height]: [number, number], tools: ConformTools = {}): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'clip-'));
  try {
    const src = path.join(dir, 'src.mp4');
    await writeFile(src, bytes);
    const [w, h] = (await (tools.probe ?? ffprobe)(src)).trim().split(',').map(Number);
    if (w === width && h === height) return null;
    const out = path.join(dir, 'out.mp4');
    await (tools.ffmpeg ?? ffmpeg)([
      '-y', '-loglevel', 'error', '-i', src,
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', `${conformFilter(width, height)},format=yuv420p`,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-c:a', 'copy',
      '-movflags', '+faststart', out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fetch a provider's clip and conform it (see conformClip). */
export async function conformClipUrl(url: string, size: [number, number], tools: ConformTools = {}): Promise<Buffer | null> {
  const res = await (tools.fetchImpl ?? fetch)(url);
  if (!res.ok) throw new Error(`conform clip: GET ${url} -> HTTP ${res.status}`);
  return conformClip(Buffer.from(await res.arrayBuffer()), size, tools);
}

function ffprobe(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { timeout: 30_000 }, (err, out, stderr) =>
      err ? reject(new Error(`ffprobe: ${String(stderr).slice(0, 300) || err.message}`)) : resolve(String(out)),
    );
  });
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(new Error(`ffmpeg: ${String(stderr).slice(0, 300) || err.message}`)) : resolve()));
  });
}
