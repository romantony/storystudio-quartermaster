/**
 * Step 2 (tts) payload builder. Ported from src/adapters/runpod.ts's `tts`
 * case (~line 143) — both engines target the same `flux-tts-s2t`/
 * `rnqxi6c0mlq517` endpoint, selected per-request via `ctx.job.voiceEngine`
 * (options.voiceEngine, default 'kokoro'; see agents/planner.ts).
 *
 * Ported runpod.ts's `clone_artifact_url` fast path (2026-09-12) — the
 * orchestrator now has a source for it: StoryStudio resolves its own
 * voice_id (see /home/roman-antony/qwen-voice-clone/docs/voice-catalog.json)
 * to a precomputed .pt artifact URL and sends it as the request-level
 * `cloneArtifactUrl` (agents/planner.ts). Per
 * runpod/qwen-voice-clone-stepfunction-request.md, a clone_artifact_url
 * request omits instruct/speaker entirely — the artifact already encodes
 * the cloned voice's identity and style. Still no `voice_url`+
 * `voice_transcript` slow path (no reference-clip source in the §9.1
 * request shape) — falls through to speaker/instruct design mode when
 * cloneArtifactUrl is absent, same as before.
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
    if (ctx.job.cloneArtifactUrl) {
      return {
        mode: 'tts',
        engine: 'qwen',
        text: ctx.job.narration,
        language: ctx.job.voiceLanguage || 'English',
        clone_artifact_url: ctx.job.cloneArtifactUrl,
        ...attribution,
      };
    }
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
