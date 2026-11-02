/**
 * Google Gemini TTS — the hosted fallback for the RunPod `tts` kind (2026-11-02).
 *
 * A `tts` row whose RunPod attempt failed or timed out (Kokoro or Qwen on the
 * `flux-tts-s2t` endpoint) is retried here instead of on RunPod
 * (assets/agent.ts `usesGeminiTts`). The RunPod payload is translated, not
 * rebuilt: its text is spoken as-is, and its voice is mapped to a Gemini
 * prebuilt voice of the same gender (Kokoro `af_*`/`am_*`, Qwen speaker names,
 * or a female hint in a Qwen `instruct`). A cloned voice cannot be reproduced,
 * so a clone request falls back to the default (male) narrator.
 *
 * Measured 2026-11-02 against gemini-3.8-flash-lite-tts: `generateContent`
 * returns ONE inlineData part, `audio/wav` (PCM s16le 24 kHz mono, already a
 * complete RIFF file), 11.2 s of speech in ~3.8 s. Older TTS models returned
 * raw `audio/L16;rate=24000`, so that is wrapped in a WAV header here too.
 */

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_TTS_DEFAULT_MODEL = 'gemini-3.8-flash-lite-tts';
export const GEMINI_TTS_TIMEOUT_MS = 120_000;

export interface GeminiTransport {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface GeminiVoices {
  male: string;
  female: string;
}

/** Qwen3-TTS preset speakers that are female; every other name is male. */
const QWEN_FEMALE = new Set(['vivian', 'serena', 'ono_anna', 'sohee']);

export type VoiceGender = 'male' | 'female';

/** The gender of the voice a RunPod tts payload asked for. */
export function ttsPayloadGender(payload: Record<string, unknown>): VoiceGender {
  if (payload.engine === 'qwen') {
    const speaker = String(payload.speaker ?? '').toLowerCase();
    if (QWEN_FEMALE.has(speaker)) return 'female';
    if (/\b(female|woman|girl|lady|she)\b/i.test(String(payload.instruct ?? ''))) return 'female';
    return 'male';
  }
  // Kokoro ids are <lang><gender>_<name>: af_heart, bf_emma, am_michael, hm_omega...
  const voice = String(payload.voice ?? '');
  return /^[a-z]f_/.test(voice) ? 'female' : 'male';
}

export interface GeminiTtsRequest {
  text: string;
  voice: string;
  gender: VoiceGender;
}

export function geminiTtsRequestFromRunpod(payload: Record<string, unknown>, voices: GeminiVoices): GeminiTtsRequest {
  const text = String(payload.text ?? '').trim();
  if (!text) throw new Error('gemini tts: the payload has no text');
  const gender = ttsPayloadGender(payload);
  return { text, voice: voices[gender], gender };
}

export class GeminiError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

/** A PCM s16 mono buffer as a RIFF/WAVE file. */
export function pcmToWav(pcm: Buffer, rate: number, bits = 16): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = bits / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Seconds of audio in a PCM WAV, from its fmt byte rate and data chunk size. */
export function wavDurationS(wav: Buffer): number {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('gemini tts: response is not a RIFF/WAVE file');
  }
  let byteRate = 0;
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = wav.readUInt32LE(off + 16);
    if (id === 'data') {
      if (!byteRate) break;
      // Streamed WAVs can carry a 0 / 0xFFFFFFFF placeholder size: use what is actually there.
      const len = size === 0 || size === 0xffffffff || off + 8 + size > wav.length ? wav.length - off - 8 : size;
      return Math.round((len / byteRate) * 1000) / 1000;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('gemini tts: WAV has no fmt/data chunk');
}

export interface GeminiTtsResult {
  wav: Buffer;
  durationS: number;
  mimeType: string;
  audioTokens: number | null;
}

/** One generateContent call (retrying 429/5xx/network), returned as a WAV. */
export async function runGeminiTts(t: GeminiTransport, req: GeminiTtsRequest): Promise<GeminiTtsResult> {
  const fetchImpl = t.fetchImpl ?? fetch;
  const sleep = t.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const model = t.model || GEMINI_TTS_DEFAULT_MODEL;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: `## Transcript:\n${req.text}` }] }],
    generationConfig: {
      temperature: 1,
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice } } },
    },
  });

  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': t.apiKey, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(GEMINI_TTS_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new GeminiError(`${model} HTTP ${res.status}: ${text.slice(0, 300)}`, res.status === 429 || res.status >= 500);
      }
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new GeminiError(`${model}: response is not JSON: ${text.slice(0, 200)}`, true);
      }
      const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
      const audio = parts.map((p) => p?.inlineData).filter((d) => d?.data);
      if (!audio.length) {
        const finish = json?.candidates?.[0]?.finishReason ?? json?.promptFeedback?.blockReason ?? 'none';
        throw new GeminiError(`${model}: no audio in response (finish=${finish})`, finish === 'OTHER');
      }
      const mimeType = String(audio[0].mimeType ?? '');
      const bytes = Buffer.concat(audio.map((d) => Buffer.from(String(d.data), 'base64')));
      let wav: Buffer;
      if (/wav/i.test(mimeType) || bytes.toString('ascii', 0, 4) === 'RIFF') {
        wav = bytes;
      } else {
        const rate = Number(mimeType.match(/rate=(\d+)/i)?.[1] ?? 24_000);
        const bits = Number(mimeType.match(/audio\/L(\d+)/i)?.[1] ?? 16);
        wav = pcmToWav(bytes, rate, bits);
      }
      const durationS = wavDurationS(wav);
      if (durationS <= 0) throw new GeminiError(`${model}: empty audio`, true);
      const tokens = json?.usageMetadata?.candidatesTokenCount;
      return { wav, durationS, mimeType, audioTokens: typeof tokens === 'number' ? tokens : null };
    } catch (err) {
      last = err;
      const retryable = err instanceof GeminiError ? err.retryable : true; // network / abort
      if (!retryable || attempt === 3) throw err;
      await sleep(2_000 * 2 ** (attempt - 1));
    }
  }
  throw last;
}
