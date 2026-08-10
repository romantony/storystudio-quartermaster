import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * Shared ffmpeg-in-Lambda scaffolding — download/run/probe/upload helpers,
 * factored out of merge.ts (the first handler to do this, 2026-07-27) so
 * trim-clip.ts and reconcile-segment-timing.ts (Dialogue Basic/Premium,
 * storystudio-dialogue-qm-sfn-handoff.md) don't each reimplement the same
 * spawnSync/download/S3-upload boilerplate a third and fourth time.
 */

export const FFMPEG = require('@ffmpeg-installer/ffmpeg').path as string;
const BUCKET = process.env.OUTPUT_BUCKET!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const s3 = new S3Client({ region: REGION });

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

export function run(args: string[]): RunResult {
  const r = spawnSync(FFMPEG, args, { maxBuffer: 1024 * 1024 * 128 });
  if (r.error) throw r.error;
  return { stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '', status: r.status ?? 1 };
}

export function download(url: string, dest: string): Promise<void> {
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

export function parseDurationFromStderr(stderr: string): number {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 0;
  const [, h, mnt, s] = m;
  return Number(h) * 3600 + Number(mnt) * 60 + Number(s);
}

export function getDuration(input: string): number {
  const { stderr } = run(['-i', input, '-f', 'null', '-']);
  return parseDurationFromStderr(stderr);
}

/** `@ffmpeg-installer/ffmpeg`'s bundled static binary is an old build (2018,
 * libavfilter 7.46) whose `apad` filter predates the `whole_dur`/`pad_dur`
 * options (seconds-based) — only `pad_len`/`whole_len` (SAMPLE-count based)
 * exist, so a sample rate has to be parsed out of ffmpeg's own stderr
 * (merge.ts, found live 2026-07-27). */
export function getSampleRate(stderr: string): number {
  const m = stderr.match(/(\d+)\s*Hz/);
  return m ? Number(m[1]) : 48000;
}

export function cdnUrl(key: string): string {
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}

export async function uploadFile(localPath: string, key: string, contentType: string): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fs.readFileSync(localPath),
    ContentType: contentType,
  }));
  return cdnUrl(key);
}
