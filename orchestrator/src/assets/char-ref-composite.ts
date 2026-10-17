/**
 * Two character references side by side on one 16:9 grey canvas -> a single edit
 * source (same layout as the 2026-10-04 Clockmaker test's `composite`): each
 * reference's centre square, scaled to 832 px, centred in its half of 1664x928.
 *
 * `padCharacterRef` (2026-10-17, refs2 frames): ONE reference, whole and
 * uncropped, centred on a grey canvas of the frame's aspect. Qwen edit keeps
 * its source's aspect, so this is what makes a refs2 reference 16:9 rather
 * than square. Grey, never black: black padding carried into the video in the
 * first LTX reference-sheet test.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const COMPOSITE_FILTER =
  '[0:v]crop=min(iw\\,ih):min(iw\\,ih),scale=832:832[a];[1:v]crop=min(iw\\,ih):min(iw\\,ih),scale=832:832[b];' +
  '[a][b]hstack=inputs=2,pad=1664:928:0:48:color=0xC8C8C8[o]';

export async function compositeCharacterRefs(
  refs: string[],
  fetchImpl: typeof fetch = fetch,
  run: (args: string[]) => Promise<void> = ffmpeg,
): Promise<Buffer> {
  if (refs.length !== 2) throw new Error(`char-ref composite needs exactly 2 references, got ${refs.length}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'cref-'));
  try {
    const files: string[] = [];
    for (const [i, url] of refs.entries()) {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`char-ref: GET ${url} -> HTTP ${res.status}`);
      const f = path.join(dir, `ref${i}`);
      await writeFile(f, Buffer.from(await res.arrayBuffer()));
      files.push(f);
    }
    const out = path.join(dir, 'out.png');
    await run(['-y', '-loglevel', 'error', '-i', files[0], '-i', files[1], '-filter_complex', COMPOSITE_FILTER, '-map', '[o]', '-frames:v', '1', out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function padFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0xC8C8C8,setsar=1`;
}

export async function padCharacterRef(
  ref: string,
  [width, height]: [number, number],
  fetchImpl: typeof fetch = fetch,
  run: (args: string[]) => Promise<void> = ffmpeg,
): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cref-'));
  try {
    const res = await fetchImpl(ref);
    if (!res.ok) throw new Error(`char-ref: GET ${ref} -> HTTP ${res.status}`);
    const src = path.join(dir, 'ref');
    await writeFile(src, Buffer.from(await res.arrayBuffer()));
    const out = path.join(dir, 'out.png');
    await run(['-y', '-loglevel', 'error', '-i', src, '-vf', padFilter(width, height), '-frames:v', '1', out]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 60_000 }, (err, _o, stderr) => (err ? reject(new Error(`ffmpeg: ${String(stderr).slice(0, 300) || err.message}`)) : resolve()));
  });
}
