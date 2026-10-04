/**
 * Pads a dialogue line for the ia2v workflows (same ffmpeg recipe as the
 * 2026-10-04 Clockmaker test's `pad_to`): `leadS` of silence first, then the
 * line, then silence to exactly `durationS`, as 48 kHz stereo WAV. The image's
 * ffmpeg is already there for the local QA tier (src/quality/local.ts).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function padDialogueAudio(
  ttsUrl: string,
  leadS: number,
  durationS: number,
  fetchImpl: typeof fetch = fetch,
  run: (args: string[]) => Promise<void> = ffmpeg,
): Promise<Buffer> {
  const res = await fetchImpl(ttsUrl);
  if (!res.ok) throw new Error(`dialogue-audio: GET ${ttsUrl} -> HTTP ${res.status}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'dlg-'));
  try {
    const inp = path.join(dir, 'in.wav');
    const out = path.join(dir, 'out.wav');
    await writeFile(inp, Buffer.from(await res.arrayBuffer()));
    const ms = Math.round(leadS * 1000);
    await run(['-y', '-loglevel', 'error', '-i', inp, '-af', `adelay=${ms}|${ms},apad,atrim=0:${durationS}`, '-ar', '48000', '-ac', '2', out]);
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
