import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * QM-orchestrator-fallback — the hosted fallbacks for the orchestrator tail's two
 * optional audio layers (infra/lib/orchestrator-tail.ts). The state machine only
 * comes here after the RunPod BGM-S2T job for that layer failed, timed out, came
 * back without a url, or RunPod could not be reached. Only if this ALSO fails is
 * the layer dropped.
 *
 *   transcribe   captions: OpenAI, synchronous. Downloads the assembled audio,
 *                downmixes to 16 kHz mono (well under OpenAI's 25 MB upload cap),
 *                splits anything longer than CHUNK_MAX_S at a quiet point, and per
 *                chunk calls
 *                  gpt-transcribe  the TEXT (the better transcript, but it
 *                                  returns json|text only: no timestamps), and
 *                  whisper-1       verbose_json word timestamps,
 *                then aligns gpt-transcribe's words onto whisper's timings. Writes
 *                a one-word-per-cue SRT (what BGM-S2T's `words_per_group: 1`
 *                produces) to S3 -> { status: 'COMPLETED', srtUrl }.
 *   bgm-submit   BGM: Suno on KIE (`ai-music-api/generate`), instrumental,
 *                -> { taskId }.
 *   bgm-status   -> { status: 'IN_PROGRESS' } | { status: 'FAILED', error }
 *                 | { status: 'COMPLETED', audioUrl }. KIE's audio links expire,
 *                so a finished track is re-hosted in S3 first.
 *
 * Measured 2026-11-01: gpt-transcribe rejects verbose_json/srt ("Use 'json' or
 * 'text'"); whisper-1 returns words. A 45 s Suno V6 instrumental took ~22 s and
 * 12 KIE credits, and returns two tracks.
 */

export const OPENAI_BASE = process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1';
export const KIE_BASE = process.env.KIE_API_BASE ?? 'https://api.kie.ai/api/v1/jobs';
export const TEXT_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-transcribe';
export const TIMING_MODEL = 'whisper-1';
export const SUNO_MODEL = process.env.SUNO_MODEL ?? 'V6';

/** 16 kHz mono s16 = 32 kB/s: 600 s is 19.2 MB, under OpenAI's 25 MB cap. */
export const TARGET_RATE = 16_000;
export const CHUNK_MAX_S = 600;
/** Where in a chunk's last seconds the quietest cut point is searched for. */
const CUT_SEARCH_S = 15;
/** KIE's `duration` range for V5_5/V6 custom mode. Finalize loops the track. */
export const SUNO_MIN_S = 10;
export const SUNO_MAX_S = 360;
/** Below this share of gpt-transcribe words matched, its text and whisper's
 * disagree too much to borrow timings: whisper's own words are used. */
export const MIN_MATCH_RATIO = 0.3;

const PREFIX = /^projects\/[A-Za-z0-9._\-/]+\/$/;
const TASK_ID = /^[A-Za-z0-9_-]{8,80}$/;

export interface TranscribeEvent { action: 'transcribe'; audioUrl: string; language?: string; outputPrefix: string }
export interface BgmSubmitEvent { action: 'bgm-submit'; prompt: string; durationS?: number }
export interface BgmStatusEvent { action: 'bgm-status'; taskId: string; durationS?: number; outputPrefix: string }
export type FallbackEvent = TranscribeEvent | BgmSubmitEvent | BgmStatusEvent;

export interface FallbackDeps {
  getSecret(which: 'openai' | 'kie'): Promise<string>;
  fetchImpl: typeof fetch;
  putObject(key: string, body: Uint8Array, contentType: string): Promise<string>;
  log?: (msg: string) => void;
}

export interface Word { word: string; start: number; end: number }

// ── audio ─────────────────────────────────────────────────────────────────

export interface Pcm { rate: number; samples: Int16Array }

/** Parse a PCM WAV (s16, any rate/channels, incl. WAVE_FORMAT_EXTENSIBLE) and
 * downmix + resample it to 16 kHz mono. Box-average decimation: crude, but the
 * averaging is its own low-pass, and this is speech for an ASR model. */
export function wavTo16kMono(buf: Uint8Array): Pcm {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  let dataOff = -1;
  let dataLen = 0;
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      let format = dv.getUint16(o + 8, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(o + 32, true);
      fmt = { format, channels: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    } else if (id === 'data') {
      dataOff = o + 8;
      // ffmpeg writes 0xFFFFFFFF/0 for a streamed header: take the rest of the file.
      dataLen = size === 0 || size === 0xffffffff || dataOff + size > buf.length ? buf.length - dataOff : size;
      break;
    }
    o += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV has no fmt/data chunk');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit)`);
  const ch = fmt.channels;
  const frames = Math.floor(dataLen / (2 * ch));
  const ratio = fmt.rate / TARGET_RATE;
  const outLen = Math.floor(frames / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let f = a; f < b && f < frames; f++) {
      for (let c = 0; c < ch; c++) sum += dv.getInt16(dataOff + (f * ch + c) * 2, true);
      n += ch;
    }
    out[i] = n ? Math.max(-32768, Math.min(32767, Math.round(sum / n))) : 0;
  }
  return { rate: TARGET_RATE, samples: out };
}

/** Chunk boundaries (sample indices), each chunk <= maxS, cut at the quietest
 * 100 ms window in the last CUT_SEARCH_S seconds before the limit. */
export function chunkBounds(pcm: Pcm, maxS = CHUNK_MAX_S): Array<[number, number]> {
  const max = maxS * pcm.rate;
  const win = Math.round(pcm.rate / 10);
  const total = pcm.samples.length;
  const out: Array<[number, number]> = [];
  let start = 0;
  while (total - start > max) {
    const hi = start + max;
    const lo = Math.max(start + win, hi - CUT_SEARCH_S * pcm.rate);
    let best = hi;
    let bestE = Infinity;
    for (let w = lo; w + win <= hi; w += win) {
      let e = 0;
      for (let k = w; k < w + win; k++) e += Math.abs(pcm.samples[k]);
      if (e < bestE) {
        bestE = e;
        best = w + Math.floor(win / 2);
      }
    }
    out.push([start, best]);
    start = best;
  }
  out.push([start, total]);
  return out;
}

export function encodeWav(samples: Int16Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(bytes.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (bytes[o + i] = c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}

// ── alignment ─────────────────────────────────────────────────────────────

/** Letters (incl. combining marks, so Devanagari survives) and digits only. */
export function norm(w: string): string {
  return w.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

/**
 * Put gpt-transcribe's words (the text shown) on whisper's timings. LCS on the
 * normalised words gives anchors; each run of unmatched text words between two
 * anchors is spread evenly over the span whisper's unmatched words cover there,
 * or over the gap between the anchors when whisper heard nothing in it.
 * Returns whisper's own words when the two disagree too much (< MIN_MATCH_RATIO).
 */
export function alignWords(text: string, timed: Word[]): { words: Word[]; matchRatio: number } {
  const tokens = text.split(/\s+/).filter((t) => norm(t));
  const tw = timed.filter((w) => norm(w.word));
  if (!tokens.length) return { words: tw, matchRatio: 0 };
  if (!tw.length) return { words: [], matchRatio: 0 };
  const a = tokens.map(norm);
  const b = tw.map((w) => norm(w.word));
  const n = a.length;
  const m = b.length;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++;
    else j++;
  }
  const matchRatio = pairs.length / n;
  if (matchRatio < MIN_MATCH_RATIO) return { words: tw, matchRatio };

  const out: Word[] = new Array(n);
  for (const [i, j] of pairs) out[i] = { word: tokens[i], start: tw[j].start, end: tw[j].end };
  // Walk the gaps: (-1,-1) .. pairs .. (n,m).
  const anchors: Array<[number, number]> = [[-1, -1], ...pairs, [n, m]];
  const audioEnd = tw[m - 1].end;
  for (let k = 0; k + 1 < anchors.length; k++) {
    const [i0, j0] = anchors[k];
    const [i1, j1] = anchors[k + 1];
    const count = i1 - i0 - 1;
    if (count <= 0) continue;
    let s: number;
    let e: number;
    if (j1 - j0 - 1 > 0) {
      s = tw[j0 + 1].start;
      e = tw[j1 - 1].end;
    } else {
      s = j0 >= 0 ? tw[j0].end : 0;
      e = j1 < m ? tw[j1].start : audioEnd;
    }
    if (e < s) e = s;
    const step = (e - s) / count;
    for (let q = 0; q < count; q++) out[i0 + 1 + q] = { word: tokens[i0 + 1 + q], start: s + q * step, end: s + (q + 1) * step };
  }
  return { words: out, matchRatio };
}

function ts(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (v: number, l = 2) => String(v).padStart(l, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** One word per cue, monotonic, never zero-length. */
export function toSrt(words: Word[]): string {
  let last = 0;
  return words
    .map((w, i) => {
      const start = Math.max(last, w.start);
      const end = Math.max(start + 0.05, w.end);
      last = end;
      return `${i + 1}\n${ts(start)} --> ${ts(end)}\n${w.word.trim()}\n`;
    })
    .join('\n');
}

// ── OpenAI ────────────────────────────────────────────────────────────────

/** ISO-639-1 from e.g. 'en', 'pt-BR', 'hi_IN'; undefined lets the model detect. */
export function isoLanguage(lang: string | undefined): string | undefined {
  const m = String(lang ?? '').trim().toLowerCase().match(/^([a-z]{2})(?:[-_].*)?$/);
  return m ? m[1] : undefined;
}

async function withRetry<T>(what: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!(err as { retryable?: boolean }).retryable || i === attempts) break;
      await new Promise((r) => setTimeout(r, 2_000 * 2 ** (i - 1)));
    }
  }
  throw new Error(`${what}: ${last instanceof Error ? last.message : String(last)}`);
}

class HttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

async function openaiTranscribe(deps: FallbackDeps, key: string, wav: Uint8Array, model: string, language: string | undefined, timed: boolean): Promise<any> {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  if (language) form.append('language', language);
  if (timed) {
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
  } else {
    form.append('response_format', 'json');
  }
  const res = await deps.fetchImpl(`${OPENAI_BASE}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`${model} HTTP ${res.status} ${text.slice(0, 300)}`, res.status === 429 || res.status >= 500);
  return JSON.parse(text);
}

async function transcribeChunk(deps: FallbackDeps, key: string, wav: Uint8Array, language: string | undefined, offset: number): Promise<{ words: Word[]; matchRatio: number | null }> {
  const [textR, timedR] = await Promise.allSettled([
    withRetry(TEXT_MODEL, () => openaiTranscribe(deps, key, wav, TEXT_MODEL, language, false)),
    withRetry(TIMING_MODEL, () => openaiTranscribe(deps, key, wav, TIMING_MODEL, language, true)),
  ]);
  // Without timings there are no captions: the text alone cannot be placed.
  if (timedR.status === 'rejected') throw timedR.reason;
  const timed: Word[] = (timedR.value?.words ?? [])
    .filter((w: any) => typeof w?.word === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w: any) => ({ word: String(w.word), start: Number(w.start), end: Number(w.end) }));
  let words = timed;
  let matchRatio: number | null = null;
  if (textR.status === 'fulfilled' && typeof textR.value?.text === 'string') {
    ({ words, matchRatio } = alignWords(textR.value.text, timed));
  } else if (textR.status === 'rejected') {
    deps.log?.(`${TEXT_MODEL} failed, using ${TIMING_MODEL}'s words: ${(textR.reason as Error)?.message}`);
  }
  return { words: words.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset })), matchRatio };
}

async function download(deps: FallbackDeps, url: string, what: string): Promise<Uint8Array> {
  if (!/^https:\/\//.test(url)) throw new Error(`${what}: not an https url: ${url.slice(0, 120)}`);
  const res = await deps.fetchImpl(url);
  if (!res.ok) throw new HttpError(`${what} download HTTP ${res.status}`, res.status >= 500);
  return new Uint8Array(await res.arrayBuffer());
}

async function transcribe(deps: FallbackDeps, ev: TranscribeEvent): Promise<Record<string, unknown>> {
  if (!PREFIX.test(ev.outputPrefix ?? '')) throw new Error(`invalid outputPrefix ${JSON.stringify(ev.outputPrefix)}`);
  const key = await deps.getSecret('openai');
  const language = isoLanguage(ev.language);
  const raw = await withRetry('assembled audio', () => download(deps, ev.audioUrl, 'assembled audio'));
  const pcm = wavTo16kMono(raw);
  const bounds = chunkBounds(pcm);
  deps.log?.(`transcribe: ${(pcm.samples.length / pcm.rate).toFixed(1)}s in ${bounds.length} chunk(s), language=${language ?? 'auto'}`);
  const results = await Promise.all(
    bounds.map(([s, e]) => transcribeChunk(deps, key, encodeWav(pcm.samples.subarray(s, e), pcm.rate), language, s / pcm.rate)),
  );
  const words = results.flatMap((r) => r.words);
  if (!words.length) throw new Error('transcription returned no words');
  const ratios = results.map((r) => (r.matchRatio === null ? 'n/a' : r.matchRatio.toFixed(2)));
  deps.log?.(`transcribe: ${words.length} words, ${TEXT_MODEL}/${TIMING_MODEL} match ratio per chunk ${ratios.join(',')}`);
  const srtUrl = await deps.putObject(`${ev.outputPrefix}captions-fallback.srt`, new TextEncoder().encode(toSrt(words)), 'application/x-subrip');
  return { status: 'COMPLETED', srtUrl, words: words.length, provider: 'openai' };
}

// ── KIE Suno ──────────────────────────────────────────────────────────────

export function clampSunoDuration(d: unknown): number {
  const n = Number(d);
  return Math.min(SUNO_MAX_S, Math.max(SUNO_MIN_S, Math.ceil(Number.isFinite(n) && n > 0 ? n : 60)));
}

export function buildSunoRequest(prompt: string, durationS: unknown): Record<string, unknown> {
  return {
    model: 'ai-music-api/generate',
    input: {
      custom_mode: true,
      instrumental: true,
      model: SUNO_MODEL,
      title: 'Background score',
      style: prompt.slice(0, 1000),
      negative_tags: 'vocals, singing, lyrics, choir',
      duration: clampSunoDuration(durationS),
    },
  };
}

async function kie(deps: FallbackDeps, key: string, url: string, init: RequestInit, what: string): Promise<any> {
  const res = await deps.fetchImpl(url, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`, res.status === 429 || res.status >= 500);
  const body = JSON.parse(text);
  // KIE answers HTTP 200 for failures too; `code` is the real status.
  if (body?.code !== 200) throw new HttpError(`${what}: code ${body?.code} ${body?.msg ?? ''}`, body?.code === 429 || body?.code >= 500);
  return body;
}

interface Track { audio_url?: string; duration?: number }

/** The shortest track that covers the video (fewest loops, least cut), else the longest. */
export function pickTrack(tracks: Track[], targetS: number): Track | undefined {
  const ok = tracks.filter((t) => typeof t.audio_url === 'string' && /^https?:\/\//.test(t.audio_url));
  const covering = ok.filter((t) => (t.duration ?? 0) >= targetS).sort((x, y) => (x.duration ?? 0) - (y.duration ?? 0));
  if (covering.length) return covering[0];
  return ok.sort((x, y) => (y.duration ?? 0) - (x.duration ?? 0))[0];
}

function tracksOf(data: any): Track[] {
  const fromResponse = data?.response?.data;
  if (Array.isArray(fromResponse)) return fromResponse;
  try {
    const parsed = JSON.parse(String(data?.resultJson ?? '{}'));
    if (Array.isArray(parsed?.data)) return parsed.data;
  } catch {
    /* fall through */
  }
  return [];
}

async function bgmSubmit(deps: FallbackDeps, ev: BgmSubmitEvent): Promise<Record<string, unknown>> {
  const prompt = String(ev.prompt ?? '').trim();
  if (!prompt) throw new Error('bgm-submit: empty prompt');
  const key = await deps.getSecret('kie');
  const body = await withRetry('suno createTask', () =>
    kie(deps, key, `${KIE_BASE}/createTask`, { method: 'POST', body: JSON.stringify(buildSunoRequest(prompt, ev.durationS)) }, 'suno createTask'),
  );
  const taskId = body?.data?.taskId;
  if (!taskId) throw new Error('suno createTask: no taskId in response');
  return { taskId: String(taskId) };
}

async function bgmStatus(deps: FallbackDeps, ev: BgmStatusEvent): Promise<Record<string, unknown>> {
  if (!TASK_ID.test(ev.taskId ?? '')) throw new Error(`invalid taskId ${JSON.stringify(ev.taskId)}`);
  if (!PREFIX.test(ev.outputPrefix ?? '')) throw new Error(`invalid outputPrefix ${JSON.stringify(ev.outputPrefix)}`);
  const key = await deps.getSecret('kie');
  let data: any;
  try {
    data = (await kie(deps, key, `${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(ev.taskId)}`, { method: 'GET' }, 'suno recordInfo')).data;
  } catch (err) {
    // A transient poll failure must not drop a task that is already paid for.
    if ((err as HttpError).retryable) return { status: 'IN_PROGRESS' };
    throw err;
  }
  if (data?.state === 'fail') return { status: 'FAILED', error: `suno [${data.failCode ?? '?'}] ${data.failMsg ?? 'failed'}`.slice(0, 500) };
  if (data?.state !== 'success') return { status: 'IN_PROGRESS' };
  const track = pickTrack(tracksOf(data), Number(ev.durationS) || 0);
  if (!track?.audio_url) return { status: 'FAILED', error: 'suno succeeded with no audio url' };
  const bytes = await withRetry('suno track', () => download(deps, track.audio_url as string, 'suno track'));
  if (bytes.length < 1024) return { status: 'FAILED', error: `suno track is only ${bytes.length} bytes` };
  const audioUrl = await deps.putObject(`${ev.outputPrefix}bgm-fallback.mp3`, bytes, 'audio/mpeg');
  return { status: 'COMPLETED', audioUrl, durationS: track.duration ?? null, provider: 'kie-suno' };
}

// ── handler ───────────────────────────────────────────────────────────────

export function makeHandler(deps: FallbackDeps) {
  return async (event: FallbackEvent): Promise<Record<string, unknown>> => {
    switch (event?.action) {
      case 'transcribe':
        return transcribe(deps, event);
      case 'bgm-submit':
        return bgmSubmit(deps, event);
      case 'bgm-status':
        return bgmStatus(deps, event);
      default:
        throw new Error(`unknown action ${JSON.stringify((event as { action?: unknown })?.action)}`);
    }
  };
}

const sm = new SecretsManagerClient({});
const s3 = new S3Client({});
const secrets: Partial<Record<'openai' | 'kie', string>> = {};

async function getSecret(which: 'openai' | 'kie'): Promise<string> {
  if (secrets[which]) return secrets[which] as string;
  const arn = which === 'openai' ? process.env.OPENAI_API_KEY_ARN : process.env.KIE_API_KEY_ARN;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn! }));
  secrets[which] = (r.SecretString ?? '').trim();
  return secrets[which] as string;
}

async function putObject(key: string, body: Uint8Array, contentType: string): Promise<string> {
  const bucket = process.env.OUTPUT_BUCKET!;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  return `https://${bucket}.s3.${process.env.AWS_REGION ?? 'us-east-1'}.amazonaws.com/${key}`;
}

export const handler = makeHandler({ getSecret, fetchImpl: (...a) => fetch(...a), putObject, log: (m) => console.log(`[fallback] ${m}`) });
