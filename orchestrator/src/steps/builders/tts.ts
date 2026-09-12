/**
 * Step 2 (tts) payload builder. Ported from src/adapters/runpod.ts's `tts`
 * case (~line 143) — both engines target the same `flux-tts-s2t`/
 * `rnqxi6c0mlq517` endpoint, selected per-request via `ctx.job.voiceEngine`
 * (options.voiceEngine, default 'kokoro'; see agents/planner.ts).
 *
 * The Qwen branch here is voice-*design* only (speaker/instruct/language) —
 * runpod.ts's real 3-way priority also supports a `clone_artifact_url` fast
 * path and a `voice_url`+`voice_transcript` slow path for actual voice
 * cloning from a reference clip, neither of which the orchestrator has a
 * source for yet (no prior clone artifact, no reference audio in the §9.1
 * request shape) — not built here, deliberately.
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

  if (ctx.job.voiceEngine === 'qwen') {
    return {
      mode: 'tts',
      engine: 'qwen',
      text: ctx.job.narration,
      language: ctx.job.voiceLanguage || 'English',
      instruct: ctx.job.voiceInstruct ?? '',
      // `||` not `??`, same convention as Kokoro's voice below.
      speaker: ctx.job.voiceSpeaker || 'Ryan',
      ...attribution,
    };
  }

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
