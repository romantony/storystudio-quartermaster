/**
 * Pure logic for the orchestrator assembly tail (tail.ts). No I/O, no ffmpeg,
 * no AWS — so every decision that decides whether a video is right (what the
 * merge filter is, how a still is animated, what the captions look like, how
 * the BGM is mixed, when A/V drift is too much) is unit-testable.
 *
 * Everything here is a PORT of an already-validated recipe, not a redesign:
 *   - merge / SFX loudness normalisation / Ken Burns / A/V parity — from
 *     flux4B-Wan2's postprod-lite-v2 handler (_merge_local, _sfx_normalize_
 *     gain_db, _make_vf, _assert_av_duration_parity), live-tested 2026-09-20.
 *   - TikTok-style word-highlight ASS captions, the upscale -> unsharp -> ass
 *     filter order and the resolution maths — from storystudio-unified's
 *     E2E-finalize-video-premium, which this tail replaces (that task cannot be
 *     used: it demands a StoryStudio JWT and reports to StoryStudio's Convex).
 *
 * One deliberate difference from finalize: the BGM is mixed at a FLAT volume
 * with fades and NO sidechain ducking (the 2026-08-13 Audio Mix Levels spec —
 * Voice 100% / SFX 22% / BGM 20%, no duck); finalize's local copy still carries
 * the older ducked 0.5 mix.
 */

// ── the manifest (mirror of orchestrator/src/assets/manifest.ts, v3) ──────

export interface ManifestFrame {
  frameId: string;
  seq: number;
  videoUrl?: string;
  imageUrl?: string;
  /** Required unless `clipAudioOnly`. */
  audioUrl?: string;
  /** LTX action frame (audioMode 'sfx-only'): nobody speaks; the clip's own
   * audio is the frame's audio, at full level (no narration mux). */
  clipAudioOnly?: boolean;
  durationS: number | null;
  narration: string;
  sfxFromVideo?: boolean;
  animate?: { effect: string; fps: number };
}

export interface TailManifest {
  version: number;
  projectId: string;
  fps: number;
  project: { aspectRatio: string; language: string; frameCount: number };
  frames: ManifestFrame[];
  droppedFrames: Array<{ frameId: string; reason: string }>;
  steps: { removeSilence: boolean; burnCaptions: boolean };
  bgm?: { prompt: string; volume: number };
  /** Which per-frame generators ran. `overlay` = Remotion on-screen text was
   * rendered onto the clips; burned captions must keep clear of it. */
  chain?: { overlay?: boolean };
}

export const SUPPORTED_MANIFEST_VERSION = 3;

export function assertManifest(m: unknown): asserts m is TailManifest {
  const x = m as Partial<TailManifest> | null;
  if (!x || typeof x !== 'object') throw new Error('manifest is not an object');
  if (x.version !== SUPPORTED_MANIFEST_VERSION) {
    throw new Error(`manifest version ${String(x.version)} is not supported (this tail reads v${SUPPORTED_MANIFEST_VERSION})`);
  }
  if (!Array.isArray(x.frames) || x.frames.length < 1) throw new Error('manifest has no frames');
  for (const f of x.frames) {
    if (!f.audioUrl && !f.clipAudioOnly) throw new Error(`frame ${f.frameId}: audioUrl is required`);
    if (f.clipAudioOnly && !f.videoUrl) throw new Error(`frame ${f.frameId}: clipAudioOnly needs a videoUrl`);
    if (!f.videoUrl && !f.imageUrl) throw new Error(`frame ${f.frameId}: needs a videoUrl (generated clip) or an imageUrl (to animate)`);
  }
}

// ── per-frame merge ───────────────────────────────────────────────────────

export const DEFAULT_SFX_VOLUME = 0.22;
export const SFX_MAX_GAIN_DB = 30.0; // don't lift a near-silent track into audible noise
export const SFX_PEAK_CEILING_DBFS = -1.0; // post-gain, post-sfx_volume sample peak limit

export interface Loudness {
  /** Integrated loudness, LUFS. */
  i: number;
  /** Sample peak, dBFS. */
  peak: number;
}

/** Parses ffmpeg's `ebur128=peak=sample:framelog=verbose` summary. null when
 * unmeasurable (silence) — a bare 0.0 LUFS would otherwise read as valid. */
export function parseLoudness(stderr: string): Loudness | null {
  const summary = stderr.split('Summary:').pop() ?? '';
  const i = summary.match(/I:\s*(-?[\d.]+|-inf)\s*LUFS/);
  const pk = summary.match(/Peak:\s*(-?[\d.]+|-inf)\s*dBFS/);
  if (!i || !pk || i[1].includes('inf') || Number(i[1]) <= -69.0) return null;
  return { i: Number(i[1]), peak: pk[1].includes('inf') ? -120.0 : Number(pk[1]) };
}

/** How many dB to move the SFX so it sits at the same loudness as the
 * narration, never past the peak ceiling or the max-gain cap. */
export function sfxNormalizeGainDb(narr: Loudness | null, sfx: Loudness | null, sfxVolume: number): number {
  if (!narr || !sfx) return 0.0;
  const gain = narr.i - sfx.i;
  const volDb = sfxVolume > 0 ? 20 * Math.log10(sfxVolume) : -120.0;
  const peakRoom = SFX_PEAK_CEILING_DBFS - (sfx.peak + volDb);
  return Math.round(Math.min(gain, SFX_MAX_GAIN_DB, peakRoom) * 100) / 100;
}

/** Narration (+ optional SFX) muxed onto a silent clip. Video is stream-copied. */
export function mergeArgs(
  vid: string,
  aud: string,
  out: string,
  sfx?: { path: string; gainDb: number; volume: number },
): string[] {
  if (!sfx) {
    return [
      '-y', '-i', vid, '-i', aud,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-movflags', '+faststart', out,
    ];
  }
  const linear = 2.0 * sfx.volume * 10 ** (sfx.gainDb / 20);
  // apad: amix re-normalises when an input ends, so an SFX track shorter than
  // the narration would double the narration's volume for the rest of the clip.
  // 44.1 kHz out: amix otherwise follows the narration's rate (24 kHz TTS),
  // low-passing the SFX at 12 kHz (live finding 2026-09-15).
  const filter =
    `[1:a]volume=2.0[narr];[2:a]volume=${linear.toFixed(6)},apad[sfx];` +
    `[narr][sfx]amix=inputs=2:duration=first:dropout_transition=0,aresample=44100[a]`;
  return [
    '-y', '-i', vid, '-i', aud, '-i', sfx.path,
    '-filter_complex', filter,
    '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-shortest', '-movflags', '+faststart', out,
  ];
}

/** An action frame: the clip's own audio, re-encoded to the same AAC the other
 * frames use so the concat is uniform, video stream-copied. */
export function clipAudioArgs(vid: string, out: string): string[] {
  return [
    '-y', '-i', vid,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart', out,
  ];
}

// ── Ken Burns (a still with no motion model) ──────────────────────────────

export function kenBurnsFilter(effect: string, width: number, height: number, frames: number, fps: number): string {
  const sw = width * 2;
  const sh = height * 2;
  const s = `${width}x${height}`;
  const N = frames;
  const pre = `scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh}`;
  const tail = `d=${N}:s=${s}:fps=${fps},format=yuv420p`;
  switch (effect) {
    case 'zoom_in':
      return `${pre},zoompan=z='1+on/${N}*0.5':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${tail}`;
    case 'zoom_out':
      return `${pre},zoompan=z='1.5-on/${N}*0.5':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${tail}`;
    case 'pan_left':
      return `${pre},zoompan=z='1.3':x='on/${N}*(iw-iw/zoom)':y='ih/2-(ih/zoom/2)':${tail}`;
    case 'pan_right':
      return `${pre},zoompan=z='1.3':x='(iw-iw/zoom)-(on/${N}*(iw-iw/zoom))':y='ih/2-(ih/zoom/2)':${tail}`;
    default:
      return (
        `${pre},zoompan=z='1+on/${N}*0.4':x='iw/2-(iw/zoom/2)+on/${N}*${Math.trunc(sw * 0.03)}':` +
        `y='ih/2-(ih/zoom/2)+on/${N}*${Math.trunc(sh * 0.02)}':${tail}`
      );
  }
}

/** The clip's length is the narration's REAL length, never the caller's
 * estimate: the merge uses `-shortest`, so an under-estimate silently clips the
 * voice-over (the 2026-09-15 finding behind i2v sizing, same reason here). */
export function stillDurationS(audioS: number, requestedS: number | null | undefined): number {
  return Math.max(audioS, requestedS ?? audioS ?? 5.0, 0.1);
}

export function kenBurnsArgs(img: string, out: string, effect: string, width: number, height: number, durationS: number, fps: number): string[] {
  const frames = Math.max(1, Math.trunc(durationS * fps));
  return [
    '-y', '-r', String(fps), '-loop', '1', '-i', img,
    '-vf', kenBurnsFilter(effect, width, height, frames, fps),
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
    '-movflags', '+faststart', out,
  ];
}

/** Even dimensions: yuv420p cannot encode an odd width or height. */
export function evenDims(w: number, h: number): { width: number; height: number } {
  return { width: Math.floor(w / 2) * 2, height: Math.floor(h / 2) * 2 };
}

// ── assembled-video checks ────────────────────────────────────────────────

/** docs/qm-orchestrator-three-project-run-analysis-2026-09-19.md §4.2: nothing
 * gated the assembled video, so a concat/mix bug that stretched the video 6%
 * against a correct audio track shipped as "successful". Fail loudly instead. */
export function assertAvParity(videoS: number, audioS: number, maxDriftS = 1.0): void {
  const drift = Math.abs(videoS - audioS);
  if (drift > maxDriftS) {
    throw new Error(
      `A/V duration mismatch after assembly: video=${videoS.toFixed(2)}s audio=${audioS.toFixed(2)}s ` +
        `(drift ${drift.toFixed(2)}s > ${maxDriftS}s) — refusing to deliver a desynced video`,
    );
  }
}

// ── finalize: resolution ──────────────────────────────────────────────────

/** "1080p" + "9:16" -> 1080x1920 (the short edge is the number). "1920x1080"
 * is taken literally. Always even. */
export function parseResolution(resolution: string, aspectRatio: string): { width: number; height: number } {
  const parts = aspectRatio.split(':');
  if (parts.length !== 2) throw new Error(`Invalid aspectRatio format: ${aspectRatio}`);
  const rw = Number(parts[0]);
  const rh = Number(parts[1]);
  if (!(rw > 0) || !(rh > 0)) throw new Error(`Invalid aspectRatio value: ${aspectRatio}`);
  const ratio = rw / rh;

  let raw = resolution.trim().toLowerCase();
  let width: number;
  let height: number;
  if (raw.includes('x')) {
    const xs = raw.split('x');
    if (xs.length !== 2 || !/^\d+$/.test(xs[0]) || !/^\d+$/.test(xs[1])) throw new Error(`Invalid targetResolution format: ${resolution}`);
    width = Number(xs[0]);
    height = Number(xs[1]);
  } else {
    if (raw.endsWith('p')) raw = raw.slice(0, -1);
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`Invalid targetResolution format: ${resolution}`);
    const short = Number(raw);
    if (ratio >= 1.0) {
      height = short;
      width = Math.round(height * ratio);
    } else {
      width = short;
      height = Math.round(width / ratio);
    }
  }
  if (width <= 0 || height <= 0) throw new Error(`Invalid computed resolution: ${width}x${height}`);
  if (width % 2 !== 0) width += 1;
  if (height % 2 !== 0) height += 1;
  return { width, height };
}

// ── finalize: TikTok-style captions (ported from E2E-finalize-video-premium) ─

const TIKTOK_REF_WIDTH = 1080;
const TIKTOK_REF_HEIGHT = 1920;
const TIKTOK_BASE_FONT_SIZE = 92;
const TIKTOK_BASE_STROKE_WIDTH = 8;
const TIKTOK_MARGIN_V = 260;
/**
 * Bottom margin when the project carries a Remotion text overlay. The overlay
 * owns three bands (StoryStudio `getAnchorBoxStyle`): top 8%..~18%, center
 * ~40..60%, lower-third bottom 10%..~22%. The default 260 (13.5%) puts the
 * captions inside the lower-third band and they collide (seen live
 * 2026-10-03, qm-e2e-remotion-20261003-02). 500 (26%) ends them at 74% of the
 * height, so even a two-line cue sits in the free band between center and
 * lower-third.
 */
const TIKTOK_MARGIN_V_ABOVE_OVERLAY = 500;
const TIKTOK_MARGIN_L = 96;
const TIKTOK_MARGIN_R = 180;
export const TIKTOK_MAX_WORDS_PER_CUE = 4;
const TIKTOK_FONT_SIZE = 72;
const TIKTOK_HIGHLIGHT_COLOR = '#FFD400';
const TIKTOK_PRIMARY_COLOR = '#FFFFFF';
const TIKTOK_OUTLINE_COLOR = '#000000';

export function hexToAssColor(hex: string, alpha = 0): string {
  const c = hex.replace(/^#+/, '');
  if (c.length !== 6) return '&H00FFFFFF';
  const r = c.slice(0, 2);
  const g = c.slice(2, 4);
  const b = c.slice(4, 6);
  const a = alpha.toString(16).toUpperCase().padStart(2, '0');
  return `&H${a}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
}

export function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export interface SrtEntry {
  start: number;
  end: number;
  text: string;
}

export function parseSrtEntries(srt: string): SrtEntry[] {
  const entries: SrtEntry[] = [];
  for (const block of srt.trim().split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/).map((l) => l.replace(/^\ufeff/, '')).filter((l) => l.trim());
    if (lines.length < 3) continue;
    const m = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!m) continue;
    const [sh, sm, ss, sms, eh, em, es, ems] = m.slice(1).map(Number);
    entries.push({
      start: sh * 3600 + sm * 60 + ss + sms / 1000,
      end: eh * 3600 + em * 60 + es + ems / 1000,
      text: lines.slice(2).join(' '),
    });
  }
  return entries;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function renderHighlightedText(words: string[], highlightIdx: number): string {
  const primary = hexToAssColor(TIKTOK_PRIMARY_COLOR);
  const highlight = hexToAssColor(TIKTOK_HIGHLIGHT_COLOR);
  const rendered = words.map((w, idx) => {
    const token = escapeAssText(w.toUpperCase());
    return idx === highlightIdx ? `{\\c${highlight}}${token}{\\c${primary}}` : token;
  });
  if (rendered.length <= TIKTOK_MAX_WORDS_PER_CUE) return rendered.join(' ');
  const first = rendered.slice(0, TIKTOK_MAX_WORDS_PER_CUE).join(' ');
  const second = rendered.slice(TIKTOK_MAX_WORDS_PER_CUE).join(' ');
  return `${first}\\N${second}`;
}

export type CaptionPlacement = 'bottom' | 'above-overlay';

/** One Dialogue line per word, each highlighted in turn across its cue.
 * `above-overlay` lifts the captions clear of a Remotion lower-third. */
export function createTiktokAss(srt: string, videoWidth: number, videoHeight: number, placement: CaptionPlacement = 'bottom'): string {
  const entries = parseSrtEntries(srt);
  const primary = hexToAssColor(TIKTOK_PRIMARY_COLOR);
  const outline = hexToAssColor(TIKTOK_OUTLINE_COLOR);
  const xScale = Math.max(0.1, videoWidth / TIKTOK_REF_WIDTH);
  const yScale = Math.max(0.1, videoHeight / TIKTOK_REF_HEIGHT);
  const marginL = Math.max(0, Math.round(TIKTOK_MARGIN_L * xScale));
  const marginR = Math.max(0, Math.round(TIKTOK_MARGIN_R * xScale));
  const refMarginV = placement === 'above-overlay' ? TIKTOK_MARGIN_V_ABOVE_OVERLAY : TIKTOK_MARGIN_V;
  const marginV = Math.max(0, Math.round(refMarginV * yScale));
  const stroke = Math.max(2, Math.round(TIKTOK_BASE_STROKE_WIDTH * (TIKTOK_FONT_SIZE / TIKTOK_BASE_FONT_SIZE)));
  const shadow = 1;

  let ass = `[Script Info]
Title: StoryStudio TikTok Captions
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Montserrat,${TIKTOK_FONT_SIZE},${primary},${primary},${outline},&H00000000,-1,0,0,0,100,100,0,0,1,${stroke},${shadow},2,${marginL},${marginR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (const entry of entries) {
    const words = entry.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const duration = Math.max(0.05, entry.end - entry.start);
    const seg = duration / Math.max(1, words.length);
    for (let idx = 0; idx < words.length; idx++) {
      const ws = entry.start + idx * seg;
      const we = idx === words.length - 1 ? entry.end : Math.min(entry.end, entry.start + (idx + 1) * seg);
      ass += `Dialogue: 0,${formatAssTime(ws)},${formatAssTime(we)},Default,,0,0,0,,${renderHighlightedText(words, idx)}\n`;
    }
  }
  return ass;
}

// ── finalize: filter chain ────────────────────────────────────────────────

export function escapeFfmpegFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export const BGM_FADE_IN_S = 0.5;
export const BGM_FADE_OUT_S = 1.0;
export const DEFAULT_BGM_VOLUME = 0.15;

export interface FinalizeFilterInput {
  inputWidth: number;
  inputHeight: number;
  targetWidth: number;
  targetHeight: number;
  captionsPath?: string;
  bgmPath?: string;
  /** Flat BGM gain (manifest.bgm.volume). */
  bgmVolume: number;
  videoDuration: number;
  inputHasAudio: boolean;
  fontsDir: string;
}

/**
 * scale -> unsharp -> ass -> audio mix, in that order. The lanczos upscale
 * softens fine detail, and burning captions straight onto a soft image is what
 * made them look smudged; the unsharp pass restores edge contrast BEFORE the
 * captions are composited so the glyphs stay crisp and are not themselves
 * sharpened. Do not reorder without re-validating that fix.
 */
export function buildFinalizeFilter(i: FinalizeFilterInput): string {
  const filters: string[] = [];
  const needsScale = i.inputWidth !== i.targetWidth || i.inputHeight !== i.targetHeight;
  const scale = `scale=${i.targetWidth}:${i.targetHeight}:flags=lanczos,unsharp=5:5:0.8:5:5:0.0`;

  if (needsScale && i.captionsPath) {
    filters.push(`[0:v]${scale}[vscaled]`);
    filters.push(`[vscaled]ass='${escapeFfmpegFilterPath(i.captionsPath)}':fontsdir=${i.fontsDir}[v]`);
  } else if (needsScale) {
    filters.push(`[0:v]${scale}[v]`);
  } else if (i.captionsPath) {
    filters.push(`[0:v]ass='${escapeFfmpegFilterPath(i.captionsPath)}':fontsdir=${i.fontsDir}[v]`);
  }

  if (i.bgmPath) {
    const fadeOutStart = Math.max(0, i.videoDuration - BGM_FADE_OUT_S);
    const bgm = `[1:a]aformat=channel_layouts=stereo,volume=${i.bgmVolume},afade=t=in:st=0:d=${BGM_FADE_IN_S},afade=t=out:st=${fadeOutStart}:d=${BGM_FADE_OUT_S}`;
    if (i.inputHasAudio) {
      filters.push(`${bgm}[bgmfade]`);
      filters.push('[0:a]aformat=channel_layouts=stereo[voice]');
      // normalize=0: amix would otherwise scale each input by 1/N, halving the
      // narration. Voice stays at 100%, BGM at its own flat volume.
      filters.push('[voice][bgmfade]amix=inputs=2:duration=first:normalize=0[aout]');
    } else {
      filters.push(`${bgm}[aout]`);
    }
  } else if (i.inputHasAudio) {
    filters.push('[0:a]anull[aout]');
  }
  return filters.join(';');
}

export function buildFinalizeArgs(o: {
  videoPath: string;
  bgmPath?: string;
  filterComplex: string;
  outputPath: string;
  videoDuration: number;
  inputHasAudio: boolean;
}): string[] {
  const args: string[] = ['-y', '-loglevel', 'verbose', '-i', o.videoPath];
  // -stream_loop: BGM is generated short (ACE-Step is reliable to ~120s) and
  // looped under the whole video, with the fade-out landing on the last second.
  if (o.bgmPath) args.push('-stream_loop', '-1', '-i', o.bgmPath);
  if (o.filterComplex) args.push('-filter_complex', o.filterComplex);
  args.push('-map', o.filterComplex.includes('[v]') ? '[v]' : '0:v:0');
  if (o.filterComplex.includes('[aout]')) args.push('-map', '[aout]');
  else if (o.inputHasAudio) args.push('-map', '0:a:0');
  args.push(
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-t', String(o.videoDuration),
    '-movflags', '+faststart',
    o.outputPath,
  );
  return args;
}

// ── addressing ────────────────────────────────────────────────────────────

export function s3Url(bucket: string, key: string, region = 'us-east-1'): string {
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

export interface AssembleMeta {
  videoKey: string;
  audioKey: string;
  videoUrl: string;
  audioUrl: string;
  durationSec: number;
  width: number;
  height: number;
  frames: Array<{ frameId: string; url: string; durationS: number }>;
  droppedFrames: Array<{ frameId: string; reason: string }>;
}

export interface FinalizeResult {
  videoUrl: string;
  durationSec: number;
  width: number;
  height: number;
  captions: boolean;
  bgm: boolean;
}
