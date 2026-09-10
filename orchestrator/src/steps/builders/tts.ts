/**
 * Step 2 (tts) payload builder. Ported from src/adapters/runpod.ts's `tts`
 * Kokoro-engine branch (~line 187) — targets `flux-tts-s2t`/`rnqxi6c0mlq517`.
 * M2 scope: Kokoro only (default engine), no Qwen3-TTS voice-clone path yet.
 */
import type { BuildContext, PayloadBuilder } from './types';

const KOKORO_LANG_CODE: Record<string, string> = {
  english: 'a',
  spanish: 'e',
  'portuguese (brazil)': 'p',
  hindi: 'h',
};

export const buildTtsInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const attribution: Record<string, unknown> = { project_id: ctx.projectId };
  if (ctx.frameId) attribution.frame_id = ctx.frameId;
  return {
    mode: 'tts',
    engine: 'kokoro',
    text: ctx.job.narration,
    // `||` not `??`, matching runpod.ts's own fix note: an explicit '' from
    // a caller must fall through to the default, not be treated as "set".
    voice: ctx.job.voiceId || 'am_michael',
    speed: 1.0,
    lang_code: KOKORO_LANG_CODE[(ctx.job.language ?? '').toLowerCase()] ?? 'a',
    ...attribution,
  };
};
