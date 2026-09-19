/**
 * Local quality checks — no model, no external API, no GPU (2026-09-19).
 *
 * Answering "can we run the QA agent locally?": the *semantic* half cannot.
 * Judging whether an image shows what the prompt asked for needs a
 * vision-language model, the VPS has no GPU, and there is no self-hosted VLM
 * in the fleet — so that tier stays a Replicate call (quality/rubric.ts +
 * quality/replicate.ts, reused unchanged) and is opt-in.
 *
 * The *structural* half can, entirely, and it is worth more than it sounds.
 * Every defect class below is one this pipeline has actually shipped:
 *
 *   FROZEN            a Wan2 clip with no motion in it at all — the
 *                     "frozen camera" failures of 2026-08-14/15, which the
 *                     step-count and prompt experiments never fixed.
 *   DEGENERATE        a blank, black or near-uniform frame. This is what a
 *                     "successful" job with nothing behind it looks like
 *                     (41/163 shots, 2026-08-17).
 *   ASPECT_MISMATCH   9:16 asked for, 16:9 delivered — the crop bug still
 *                     open in docs/TODO.md's 2026-09-18 section.
 *   DURATION_MISMATCH a clip that does not match its narration, which merge's
 *                     `-shortest` then silently truncates.
 *   TRUNCATED         a file too small to be the asset it claims to be.
 *
 * None of them needs to understand the picture, and none of them costs a
 * cent. They run on every gated asset; the VLM tier runs on top when it is
 * configured.
 *
 * Mechanism: ffmpeg decodes a tiny greyscale/RGB thumbnail strip to raw bytes
 * on stdout, and the statistics are computed here. That keeps the only
 * external dependency a pipe — no log scraping, no image library — and makes
 * the scoring itself a pure function over a Buffer, which is what the tests
 * exercise.
 */
import { spawn } from 'node:child_process';
import type { Issue } from './rubric';

export interface LocalCheckResult {
  /** 0-10, same scale as the VLM rubric's weighted score. */
  score: number;
  issues: Issue[];
  /** What was measured, for the verdict record. */
  facts: Record<string, number | string | null>;
}

/** An issue the caller should NOT rework on: regenerating cannot fix it. */
export const NON_REWORKABLE: ReadonlySet<string> = new Set(['ASPECT_MISMATCH', 'UNREACHABLE']);

/** How much each priority costs on the 0-10 scale. P0 alone fails a gate. */
const PENALTY: Record<string, number> = { P0: 10, P1: 3.5, P2: 1.5, P3: 0.5 };

export function scoreLocal(issues: Issue[]): number {
  const penalty = issues.reduce((sum, i) => sum + (PENALTY[i.priority] ?? 1), 0);
  return Math.max(0, Math.min(10, 10 - penalty));
}

// ── ffmpeg transport ──────────────────────────────────────────────────────

export interface FfmpegTransport {
  /** Runs ffmpeg with `args` and resolves its stdout. Injectable for tests. */
  run(args: string[], timeoutMs: number): Promise<Buffer>;
  /** Runs ffprobe with `args` and resolves its stdout as text. */
  probe(args: string[], timeoutMs: number): Promise<string>;
  ffmpegPath?: string;
  ffprobePath?: string;
}

function exec(bin: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      // Bounded: ffmpeg is chatty and a long clip would otherwise buffer MBs
      // of progress lines for an error message we truncate anyway.
      if (err.length < 4000) err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited ${code}: ${err.slice(-600)}`));
    });
  });
}

export const defaultFfmpeg: FfmpegTransport = {
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
  run(args, timeoutMs) {
    return exec(this.ffmpegPath as string, args, timeoutMs);
  },
  async probe(args, timeoutMs) {
    return (await exec(this.ffprobePath as string, args, timeoutMs)).toString();
  },
};

// ── pure statistics over the decoded thumbnails ───────────────────────────

/** Population standard deviation of a byte buffer, 0-255. A near-zero value
 * means every pixel is the same — blank, black or solid. */
export function stddev(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let sum = 0;
  for (const b of buf) sum += b;
  const mean = sum / buf.length;
  let variance = 0;
  for (const b of buf) variance += (b - mean) ** 2;
  return Math.sqrt(variance / buf.length);
}

/**
 * Mean absolute difference between consecutive frames of a raw greyscale
 * strip, 0-255. This is the motion-energy measure: a frozen clip sits near 0
 * however pretty each individual frame is.
 */
export function meanFrameDelta(buf: Buffer, frameBytes: number): number {
  const frames = Math.floor(buf.length / frameBytes);
  if (frames < 2) return 0;
  let total = 0;
  for (let f = 1; f < frames; f += 1) {
    let diff = 0;
    const a = f * frameBytes;
    const b = (f - 1) * frameBytes;
    for (let i = 0; i < frameBytes; i += 1) diff += Math.abs(buf[a + i] - buf[b + i]);
    total += diff / frameBytes;
  }
  return total / (frames - 1);
}

/** Parses "WxH" or "1080x1920" into a ratio, or null. */
export function aspectOf(spec: string | undefined): number | null {
  if (!spec) return null;
  const wh = /^(\d+)\s*[x:]\s*(\d+)$/.exec(spec.trim());
  if (!wh) return null;
  const w = Number(wh[1]);
  const h = Number(wh[2]);
  return h > 0 ? w / h : null;
}

// ── thresholds ────────────────────────────────────────────────────────────

export interface LocalThresholds {
  /** Below this stddev the frame is treated as blank/solid. */
  minStddev: number;
  /** Below this mean inter-frame delta the clip is treated as frozen. */
  minFrameDelta: number;
  /** Fractional aspect-ratio tolerance (0.02 = 2%). */
  aspectTolerance: number;
  /** A clip may differ from its expected duration by this fraction, or 1s. */
  durationTolerance: number;
  minBytes: number;
  timeoutMs: number;
}

export const DEFAULT_LOCAL_THRESHOLDS: LocalThresholds = {
  // A real generated frame sits well above this; a solid colour sits at 0 and
  // a subtle gradient in the low single digits.
  minStddev: 4,
  // Measured on real Wan2 output: a moving clip is >2 here even for a slow
  // push-in; a genuinely frozen one is <0.5. 1.0 leaves room for both.
  minFrameDelta: 1.0,
  aspectTolerance: 0.04,
  durationTolerance: 0.3,
  minBytes: 4096,
  timeoutMs: 120_000,
};

// ── the checks ────────────────────────────────────────────────────────────

/** ffprobe's `-show_streams` for the first video stream. */
export interface ProbeFacts {
  width: number | null;
  height: number | null;
  durationS: number | null;
}

export function parseProbe(json: string): ProbeFacts {
  try {
    const parsed = JSON.parse(json) as {
      streams?: Array<{ width?: number; height?: number; duration?: string }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    const duration = Number(stream?.duration ?? parsed.format?.duration);
    return {
      width: typeof stream?.width === 'number' ? stream.width : null,
      height: typeof stream?.height === 'number' ? stream.height : null,
      durationS: Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  } catch {
    return { width: null, height: null, durationS: null };
  }
}

function issue(category: string, priority: Issue['priority'], description: string, evidence?: Record<string, unknown>): Issue {
  return { category, priority, description, ...(evidence ? { evidence } : {}) };
}

function checkAspect(
  facts: ProbeFacts,
  expected: number | null,
  t: LocalThresholds,
  issues: Issue[],
): void {
  if (!expected || !facts.width || !facts.height) return;
  const actual = facts.width / facts.height;
  const drift = Math.abs(actual - expected) / expected;
  if (drift > t.aspectTolerance) {
    issues.push(
      issue(
        'ASPECT_MISMATCH',
        'P1',
        `delivered ${facts.width}x${facts.height} (${actual.toFixed(3)}) against a requested ratio of ${expected.toFixed(3)}`,
        { width: facts.width, height: facts.height, drift: Number(drift.toFixed(3)) },
      ),
    );
  }
}

export interface LocalImageExpectation {
  aspectRatio?: string;
}

/**
 * Decodes the image to a 32x32 RGB thumbnail and judges it. ffmpeg does the
 * decoding (it reads PNG/JPEG/WebP alike, and is already required for the
 * video path) and every decision is made here on the raw bytes.
 */
export async function checkImageLocally(
  ff: FfmpegTransport,
  url: string,
  expect: LocalImageExpectation,
  t: LocalThresholds = DEFAULT_LOCAL_THRESHOLDS,
): Promise<LocalCheckResult> {
  const issues: Issue[] = [];
  const facts: LocalCheckResult['facts'] = {};

  let probe: ProbeFacts = { width: null, height: null, durationS: null };
  try {
    probe = parseProbe(
      await ff.probe(
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', url],
        t.timeoutMs,
      ),
    );
  } catch (err) {
    issues.push(issue('UNREACHABLE', 'P0', `could not read the image: ${(err as Error).message.slice(0, 200)}`));
    return { score: scoreLocal(issues), issues, facts };
  }
  facts.width = probe.width;
  facts.height = probe.height;

  if (!probe.width || !probe.height) {
    issues.push(issue('TRUNCATED', 'P0', 'the file has no decodable video stream'));
    return { score: scoreLocal(issues), issues, facts };
  }

  checkAspect(probe, aspectOf(expect.aspectRatio), t, issues);

  try {
    const raw = await ff.run(
      ['-v', 'error', '-i', url, '-vf', 'scale=32:32', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      t.timeoutMs,
    );
    const sd = stddev(raw);
    facts.stddev = Number(sd.toFixed(2));
    if (raw.length < 32 * 32 * 3) {
      issues.push(issue('TRUNCATED', 'P0', 'the image decoded to fewer pixels than one frame'));
    } else if (sd < t.minStddev) {
      issues.push(
        issue('DEGENERATE', 'P0', `the frame is effectively blank (pixel stddev ${sd.toFixed(2)} < ${t.minStddev})`, { stddev: sd }),
      );
    }
  } catch (err) {
    issues.push(issue('UNREACHABLE', 'P0', `could not decode the image: ${(err as Error).message.slice(0, 200)}`));
  }

  return { score: scoreLocal(issues), issues, facts };
}

export interface LocalVideoExpectation {
  aspectRatio?: string;
  /** The narration's real length, when TTS has reported it. */
  durationS?: number;
}

/**
 * Probes the clip, then decodes a 4fps 32x32 greyscale strip and measures how
 * much actually moves in it. Catches the frozen-clip and blank-clip classes
 * without any model.
 */
export async function checkVideoLocally(
  ff: FfmpegTransport,
  url: string,
  expect: LocalVideoExpectation,
  t: LocalThresholds = DEFAULT_LOCAL_THRESHOLDS,
): Promise<LocalCheckResult> {
  const issues: Issue[] = [];
  const facts: LocalCheckResult['facts'] = {};

  let probe: ProbeFacts;
  try {
    probe = parseProbe(
      await ff.probe(
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration', '-show_entries', 'format=duration', '-of', 'json', url],
        t.timeoutMs,
      ),
    );
  } catch (err) {
    issues.push(issue('UNREACHABLE', 'P0', `could not read the clip: ${(err as Error).message.slice(0, 200)}`));
    return { score: scoreLocal(issues), issues, facts };
  }
  facts.width = probe.width;
  facts.height = probe.height;
  facts.durationS = probe.durationS;

  if (!probe.width || !probe.height || !probe.durationS) {
    issues.push(issue('TRUNCATED', 'P0', 'the clip has no decodable video stream or no duration'));
    return { score: scoreLocal(issues), issues, facts };
  }

  checkAspect(probe, aspectOf(expect.aspectRatio), t, issues);

  if (expect.durationS && expect.durationS > 0) {
    const allowed = Math.max(1, expect.durationS * t.durationTolerance);
    const drift = Math.abs(probe.durationS - expect.durationS);
    if (drift > allowed) {
      issues.push(
        issue(
          'DURATION_MISMATCH',
          'P1',
          `clip is ${probe.durationS.toFixed(2)}s against ${expect.durationS.toFixed(2)}s of narration`,
          { clipS: probe.durationS, narrationS: expect.durationS },
        ),
      );
    }
  }

  const FRAME_BYTES = 32 * 32;
  try {
    const raw = await ff.run(
      ['-v', 'error', '-i', url, '-vf', 'fps=4,scale=32:32', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
      t.timeoutMs,
    );
    const frames = Math.floor(raw.length / FRAME_BYTES);
    facts.sampledFrames = frames;
    const sd = stddev(raw);
    facts.stddev = Number(sd.toFixed(2));

    if (frames < 2) {
      issues.push(issue('TRUNCATED', 'P0', `only ${frames} frame(s) decoded from the clip`));
    } else if (sd < t.minStddev) {
      issues.push(issue('DEGENERATE', 'P0', `the clip is effectively blank (pixel stddev ${sd.toFixed(2)})`, { stddev: sd }));
    } else {
      const delta = meanFrameDelta(raw, FRAME_BYTES);
      facts.frameDelta = Number(delta.toFixed(3));
      if (delta < t.minFrameDelta) {
        issues.push(
          issue('FROZEN', 'P0', `nothing moves in the clip (mean frame delta ${delta.toFixed(3)} < ${t.minFrameDelta})`, {
            frameDelta: delta,
          }),
        );
      }
    }
  } catch (err) {
    issues.push(issue('UNREACHABLE', 'P0', `could not decode the clip: ${(err as Error).message.slice(0, 200)}`));
  }

  return { score: scoreLocal(issues), issues, facts };
}

/**
 * What to do about a set of issues. Structural defects are not prompt
 * problems — a frozen or blank sample is a sampling problem, and re-writing
 * the prompt to fix it is the cargo-cult move this pipeline already learned
 * to avoid (docs/qm-video-conformity-prompt-testing.md). Stepping the seed
 * is the correct measure there; a prompt rewrite is for what a VLM saw.
 */
export type Correction = 'reseed' | 'rewrite' | 'none';

export function correctionFor(issues: Issue[]): Correction {
  const reworkable = issues.filter((i) => !NON_REWORKABLE.has(i.category));
  if (reworkable.length === 0) return 'none';
  const structural = new Set(['FROZEN', 'DEGENERATE', 'TRUNCATED', 'DURATION_MISMATCH']);
  return reworkable.every((i) => structural.has(i.category)) ? 'reseed' : 'rewrite';
}
