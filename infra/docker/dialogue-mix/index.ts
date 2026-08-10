import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * QM dialogue-mix ECS task — the QM-owned fallback for the two pieces of
 * new audio/video work storystudio-dialogue-qm-sfn-handoff.md's §3.4/§7.7
 * recommend living "inside the existing finalize Fargate task." `e2e-finalize`
 * runs on the `storystudio-e2e` ECS cluster and isn't part of this repo (only
 * referenced by ARN from pipeline-stack.ts) — the doc names this dedicated-
 * task fallback explicitly for exactly that case (§3.4).
 *
 * Two unrelated ffmpeg recipes selected by `payload.mode`, packaged as one
 * task (one ECR repo/task-def/CodeBuild pipeline) since both are simple,
 * infrequent, single-purpose ffmpeg jobs — same reasoning concat-and-trim
 * already uses for its own trimSilence on/off branch:
 *
 *  - "pip-composite" (Dialogue Basic, CompositeNarratorOverlay state): PiP the
 *    narrator segment track over the silent Wan2 scene track. Recipe
 *    validated against real assets 2026-08-08 (§7.8) — fps-normalize both
 *    tracks (Wan2 is 16fps, InfiniteTalk 25fps, §4.4/§7.6.5), rounded-rect
 *    alpha mask + drop shadow via geq/boxblur (note: `a(X,Y)` is not a valid
 *    geq function — the mask below samples r(X,Y)/g(X,Y)/b(X,Y) and computes
 *    alpha directly, never referencing a source alpha plane), two overlay
 *    calls (shadow then PiP). Composite audio = narrator track only (§4.6 —
 *    Wan2's scene track has no audio at all, so there's nothing to mix here).
 *  - "ambience-mix" (Dialogue Premium, MixAmbienceBeds state — new, not named
 *    in the doc's flow diagram but required because Premium's per-scene
 *    ambience beds are a second audio layer the e2e-finalize contract has no
 *    field for): acrossfade consecutive per-scene beds into one continuous
 *    bed (§7.11.3 — a butt-join produces an audible near-silence dip), then
 *    amix it under the concatenated shot audio at ~-28dB (§7.7) with
 *    normalize=0 (§7.8 step 6 — without it every input attenuates by 1/n).
 */

type Payload = PipCompositePayload | AmbienceMixPayload;

interface NarratorOverlayConfig {
  mode: 'pip' | 'cutaway' | 'split';
  corner: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  widthPct: number;
  marginPct: number;
  cornerRadiusPx: number;
  dropShadow: boolean;
  fadeFrames: number;
  cutawayOpenSeconds: number;
}

interface PipCompositePayload {
  mode: 'pip-composite';
  sceneTrackUrl: string;
  narratorTrackUrl: string;
  narratorOverlay: NarratorOverlayConfig;
  /** Interior segment-cut timestamps (seconds, within the narrator track's
   * own timeline) — everywhere the narrator clip's identity/framing can pop
   * between segments. Excludes 0 and the end (those get the plain start/end
   * fade). A brief alpha dip at each smooths the cut (§3.4's fadeFrames). */
  segmentBoundariesSeconds: number[];
  aspectRatio: string;
  outputKey: string;
  audioOutputKey: string;
}

interface AmbienceMixPayload {
  mode: 'ambience-mix';
  /** Concatenated shot audio track (dialogue+narration+SFX already mixed
   * per-shot at QMMixShotAudio). */
  mainAudioUrl: string;
  /** Ordered by sceneNumber. Each bed should already cover its scene's Σ
   * shot duration plus a little extra (§7.11.3: "budget an extra `d` seconds
   * of bed length on the incoming scene so there is material to fade in
   * from") — this task does not pad/loop beds itself. */
  ambienceBeds: { sceneNumber: number; audioUrl: string }[];
  crossfadeSeconds: number;
  /** Linear gain applied to the merged bed before mixing — §7.7's ~-28dB
   * default is volume≈0.04. */
  ambienceVolume: number;
  outputKey: string;
}

const BUCKET = process.env.OUTPUT_BUCKET!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const s3 = new S3Client({ region: REGION });

// Same table as concat-and-trim/index.ts — duplicated rather than shared
// across separate docker builds (matches that task's own convention).
const ASPECT_RATIOS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1088 },
  '9:16': { width: 1008, height: 1792 },
  '1:1': { width: 1088, height: 1088 },
};
const TARGET_FPS = 25; // RunComfy's own output fps (§7.6.4/§7.6.5) — the composite's common fps.

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

async function fetchPayload(): Promise<Payload> {
  const key = process.env.PAYLOAD_S3_KEY!;
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = await res.Body!.transformToString();
  return JSON.parse(body);
}

async function upload(localPath: string, key: string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: fs.readFileSync(localPath), ContentType: contentType }));
}

// ── Rounded-rect alpha mask, as a geq alpha expression over a stream's own
// per-frame W/H. Operates on r(X,Y)/g(X,Y)/b(X,Y) (the source's own RGB
// planes) — never `a(X,Y)`, which is not a valid geq source function (the
// documented trap, §7.8 step 4). Validated against a real render 2026-08:
// corner pixels alpha=0, center/edge-mid alpha=255.
function roundedRectAlphaExpr(r: number): string {
  return (
    `if(`
    + `lt(X,${r})*lt(Y,${r})*gt(pow(${r}-X,2)+pow(${r}-Y,2),pow(${r},2))`
    + `+gt(X,W-${r})*lt(Y,${r})*gt(pow(X-(W-${r}),2)+pow(${r}-Y,2),pow(${r},2))`
    + `+lt(X,${r})*gt(Y,H-${r})*gt(pow(${r}-X,2)+pow(Y-(H-${r}),2),pow(${r},2))`
    + `+gt(X,W-${r})*gt(Y,H-${r})*gt(pow(X-(W-${r}),2)+pow(Y-(H-${r}),2),pow(${r},2))`
    + `,0,255)`
  );
}

function cornerXY(corner: NarratorOverlayConfig['corner'], marginExpr: string): { x: string; y: string } {
  switch (corner) {
    case 'bottom-left': return { x: marginExpr, y: `H-h-${marginExpr}` };
    case 'top-right': return { x: `W-w-${marginExpr}`, y: marginExpr };
    case 'top-left': return { x: marginExpr, y: marginExpr };
    case 'bottom-right':
    default: return { x: `W-w-${marginExpr}`, y: `H-h-${marginExpr}` };
  }
}

/** Clamps a geq sub-expression to [0,1] — the building block for every ramp
 * below (each ramp is linear and only meaningful inside its own window; outside
 * it, clamping holds it at the flat 0 or 1 it reaches at the window edge). */
function clip01(expr: string): string {
  return `min(max(${expr},0),1)`;
}

/** Single alpha-multiplier expression (a geq `T`-based value in [0,1]) that
 * fades in at the start, out at the end, and dips to 0 and back at each
 * interior segment boundary (smooths the identity/framing pop between
 * separately-generated narrator segments, §3.4).
 *
 * This *must* be one multiplicative expression evaluated per-frame, not a
 * chain of ffmpeg `fade` filter instances (the original approach here,
 * fade=out then fade=in per boundary): ffmpeg's alpha fade is multiplicative
 * on whatever alpha the frame already carries, so once a `fade=out` drives
 * alpha to 0 and holds it there past its own window, no downstream
 * `fade=in` can ever recover it (0 × any ramp factor is still 0) — that
 * bug silently blanked the PiP for the *entire* clip on every project with
 * more than one narrator segment (confirmed 2026-08-10 against a real
 * execution's assets: composite.mp4 had zero visible frames of the PiP).
 * Each ramp below is instead computed fresh from absolute time `T`, so nothing
 * upstream can zero out a later window. */
function fadeFactorExpr(fadeSeconds: number, totalDuration: number, interiorBoundaries: number[]): string {
  const factors = [
    clip01(`T/${fadeSeconds.toFixed(3)}`),
    clip01(`(${totalDuration.toFixed(3)}-T)/${fadeSeconds.toFixed(3)}`),
  ];
  const half = fadeSeconds / 2;
  for (const t of interiorBoundaries) {
    factors.push(clip01(`abs(T-${t.toFixed(3)})/${half.toFixed(3)}`));
  }
  return factors.join('*');
}

async function runPipComposite(payload: PipCompositePayload, workDir: string): Promise<void> {
  const { width: W, height: H } = ASPECT_RATIOS[payload.aspectRatio] ?? ASPECT_RATIOS['9:16'];
  const scenePath = path.join(workDir, 'scene.mp4');
  const narratorPath = path.join(workDir, 'narrator.mp4');
  await Promise.all([download(payload.sceneTrackUrl, scenePath), download(payload.narratorTrackUrl, narratorPath)]);

  const narratorDuration = durationSeconds(narratorPath);
  const cfg = payload.narratorOverlay;
  const pipW = Math.max(2, Math.round((W * cfg.widthPct) / 2) * 2); // even width
  const marginPx = (W * cfg.marginPct).toFixed(2);
  const fadeSeconds = cfg.fadeFrames / TARGET_FPS;
  const outputPath = path.join(workDir, 'composite.mp4');

  // scene: normalize to canvas + common fps (§4.4 — Wan2 is 16fps, never
  // assume 30). narrator: alpha-masked + faded PiP inset, split for a soft
  // drop shadow (lutrgb blacken + 50% alpha + boxblur, offset 6px — §7.8
  // step 4, cheaper and more robust than a second geq pass).
  const sceneFilter = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${TARGET_FPS},format=yuv420p[scene]`;

  let narratorFilter: string;
  let overlayFilter: string;

  if (cfg.mode === 'split') {
    // Narrator and scene side by side — vertical split for 16:9, horizontal
    // for 9:16. Unvalidated against a live asset (only 'pip' was, §7.8) —
    // implemented to the wire contract's stated shape.
    const vertical = W >= H;
    const halfW = vertical ? Math.floor(W / 2) : W;
    const halfH = vertical ? H : Math.floor(H / 2);
    narratorFilter = `[1:v]scale=${halfW}:${halfH}:force_original_aspect_ratio=increase,crop=${halfW}:${halfH},fps=${TARGET_FPS},format=yuv420p[narr]`;
    const sceneHalfFilter = `[scene]scale=${halfW}:${halfH}:force_original_aspect_ratio=increase,crop=${halfW}:${halfH}[scenehalf]`;
    overlayFilter = vertical
      ? `${sceneHalfFilter};[scenehalf][narr]hstack=inputs=2[outv]`
      : `${sceneHalfFilter};[scenehalf][narr]vstack=inputs=2[outv]`;
  } else {
    const rMask = roundedRectAlphaExpr(cfg.cornerRadiusPx);
    const fadeFactor = fadeFactorExpr(fadeSeconds, narratorDuration, payload.segmentBoundariesSeconds);
    const alphaExpr = `(${rMask})*(${fadeFactor})`;
    narratorFilter = cfg.dropShadow
      ? `[1:v]scale=${pipW}:-2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alphaExpr}'[pipmasked];`
        + `[pipmasked]split=2[pipshadowsrc][pipmain];`
        + `[pipshadowsrc]lutrgb=r=0:g=0:b=0,colorchannelmixer=aa=0.5,boxblur=8:1[pipshadow]`
      : `[1:v]scale=${pipW}:-2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alphaExpr}'[pipmain]`;

    const { x, y } = cornerXY(cfg.corner, marginPx);
    if (cfg.mode === 'cutaway') {
      // Full-frame for cutawayOpenSeconds, then shrinks to the normal PiP
      // inset. Unvalidated against a live asset (only 'pip' was, §7.8).
      const openWindow = `between(t,0,${cfg.cutawayOpenSeconds})`;
      const pipWindow = `gte(t,${cfg.cutawayOpenSeconds})`;
      const fullFrameFilter = `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${TARGET_FPS},format=yuv420p[pipfull]`;
      overlayFilter = cfg.dropShadow
        ? `${narratorFilter};${fullFrameFilter};`
          + `[scene][pipshadow]overlay=x=${x}+6:y=${y}+6:enable='${pipWindow}':format=auto[withshadow];`
          + `[withshadow][pipmain]overlay=x=${x}:y=${y}:enable='${pipWindow}':format=auto[withpip];`
          + `[withpip][pipfull]overlay=x=0:y=0:enable='${openWindow}':format=auto[outv]`
        : `${narratorFilter};${fullFrameFilter};`
          + `[scene][pipmain]overlay=x=${x}:y=${y}:enable='${pipWindow}':format=auto[withpip];`
          + `[withpip][pipfull]overlay=x=0:y=0:enable='${openWindow}':format=auto[outv]`;
    } else {
      overlayFilter = cfg.dropShadow
        ? `${narratorFilter};`
          + `[scene][pipshadow]overlay=x=${x}+6:y=${y}+6:format=auto[withshadow];`
          + `[withshadow][pipmain]overlay=x=${x}:y=${y}:format=auto[outv]`
        : `${narratorFilter};[scene][pipmain]overlay=x=${x}:y=${y}:format=auto[outv]`;
    }
  }

  const filterComplex = cfg.mode === 'split' ? `${sceneFilter};${overlayFilter}` : `${sceneFilter};${overlayFilter}`;

  // Audio = narrator track only (§4.6 — Wan2's scene track has no audio at
  // all, so there is nothing else to mix at this stage; project BGM is
  // still overlaid/ducked later, unchanged, at the existing finalize call).
  const { status, stderr } = run([
    '-y', '-i', scenePath, '-i', narratorPath,
    '-filter_complex', filterComplex,
    '-map', '[outv]', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '192k',
    '-t', narratorDuration.toFixed(3),
    '-movflags', '+faststart',
    outputPath,
  ], 20 * 60_000);
  if (status !== 0) throw new Error(`pip-composite ffmpeg failed: ${stderr.slice(-2000)}`);

  const audioPath = path.join(workDir, 'composite-audio.wav');
  const { status: astatus, stderr: astderr } = run(['-y', '-i', outputPath, '-vn', '-ar', '48000', '-ac', '2', audioPath], 5 * 60_000);
  if (astatus !== 0) throw new Error(`composite audio extraction failed: ${astderr.slice(-1500)}`);

  await upload(outputPath, payload.outputKey, 'video/mp4');
  await upload(audioPath, payload.audioOutputKey, 'audio/wav');
}

async function runAmbienceMix(payload: AmbienceMixPayload, workDir: string): Promise<void> {
  const mainPath = path.join(workDir, 'main-audio.in');
  await download(payload.mainAudioUrl, mainPath);
  const mainDuration = durationSeconds(mainPath);

  const sorted = [...payload.ambienceBeds].sort((a, b) => a.sceneNumber - b.sceneNumber);
  const bedPaths: string[] = [];
  for (const bed of sorted) {
    const dest = path.join(workDir, `bed_${bed.sceneNumber}.in`);
    await download(bed.audioUrl, dest);
    bedPaths.push(dest);
  }

  const outputPath = path.join(workDir, 'mixed.wav');

  if (bedPaths.length === 0) {
    // No ambience beds at all (e.g. every shot's ambiencePrompt was empty) —
    // pass the main track through unchanged rather than failing.
    fs.copyFileSync(mainPath, outputPath);
  } else {
    // acrossfade consecutive beds into one continuous bed spanning the
    // whole film (§7.11.3 — a butt-join produces an audible near-silence
    // dip at scene boundaries; acrossfade overlaps tail/head material
    // instead), then amix it under the main track at ~-28dB, normalize=0
    // (§7.8 step 6 — without it every input attenuates by 1/n and the
    // voice drops ~10dB).
    let bedFilter: string;
    let bedLabel: string;
    if (bedPaths.length === 1) {
      bedFilter = '';
      bedLabel = '0:a';
    } else {
      const clauses: string[] = [];
      let prevLabel = '0:a';
      for (let i = 1; i < bedPaths.length; i++) {
        const outLabel = i === bedPaths.length - 1 ? 'bed' : `bedstep${i}`;
        clauses.push(`[${prevLabel}][${i}:a]acrossfade=d=${payload.crossfadeSeconds}:c1=tri:c2=tri[${outLabel}]`);
        prevLabel = outLabel;
      }
      bedFilter = clauses.join(';');
      bedLabel = 'bed';
    }

    const bedInputs = bedPaths.flatMap(p => ['-i', p]);
    const mixFilter = bedFilter
      ? `${bedFilter};[${bedLabel}]volume=${payload.ambienceVolume}[bedq];[${bedPaths.length}:a][bedq]amix=inputs=2:duration=first:normalize=0[outa]`
      : `[0:a]volume=${payload.ambienceVolume}[bedq];[${bedPaths.length}:a][bedq]amix=inputs=2:duration=first:normalize=0[outa]`;

    const { status, stderr } = run([
      '-y', ...bedInputs, '-i', mainPath,
      '-filter_complex', mixFilter,
      '-map', '[outa]',
      '-t', mainDuration.toFixed(3),
      outputPath,
    ], 15 * 60_000);
    if (status !== 0) throw new Error(`ambience-mix ffmpeg failed: ${stderr.slice(-2000)}`);
  }

  await upload(outputPath, payload.outputKey, 'audio/wav');
}

async function main(): Promise<void> {
  const payload = await fetchPayload();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-mix-'));

  try {
    console.log(`[dialogue-mix] mode=${payload.mode}`);
    if (payload.mode === 'pip-composite') {
      await runPipComposite(payload, workDir);
    } else {
      await runAmbienceMix(payload, workDir);
    }
    console.log('[dialogue-mix] done');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => { console.error('[dialogue-mix] FAILED', err); process.exit(1); },
);
