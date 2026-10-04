/**
 * `dialogue-audio` payload builder — a dialogue frame's spoken line, padded for
 * lip-sync (2026-10-04). The ia2v workflows take an audio track EXACTLY as long
 * as the clip, with `leadS` of silence before the lips move (the 10-04 test used
 * 0.4 s). The same padded track is what the tail lays over the clip, so it is
 * the frame's audio from here on. Narration frames pass the TTS straight through.
 */
import { LTX_DIALOGUE_ACTION_S, LTX_MAX_S, LTX_MIN_S } from './comfy-video';
import { SKIP_URL_PREFIX, type BuildContext, type PayloadBuilder } from './types';

const TTS_STEP_SEQ = 2;
export const DEFAULT_LEAD_S = 0.4;

/** Clip length for a spoken line: min(10, max(5, lead + speech + actionS)), whole
 * seconds. The speech is never squeezed: a line that cannot fit is refused. */
export function dialogueClipS(speechS: number, leadS: number, actionS: number = LTX_DIALOGUE_ACTION_S): number {
  if (leadS + speechS > LTX_MAX_S - 0.3) {
    throw new Error(`dialogue line is ${speechS.toFixed(1)}s (+${leadS}s lead): too long for a ${LTX_MAX_S}s clip — split the line`);
  }
  return Math.min(LTX_MAX_S, Math.max(LTX_MIN_S, Math.ceil(leadS + speechS + actionS)));
}

export const buildDialogueAudioInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  // An action frame (sfx-only) has no TTS and no line: nothing to pad.
  if (ctx.job.audioMode === 'sfx-only') return { __passthroughUrl: `${SKIP_URL_PREFIX}none` };
  const tts = ctx.resolvedDeps[TTS_STEP_SEQ];
  if (!tts?.url) throw new Error(`dialogue-audio builder: no TTS url for frame ${ctx.frameId ?? '(none)'}`);
  if (!ctx.job.dialogue) return { __passthroughUrl: tts.url };
  if (!(typeof tts.durationS === 'number' && tts.durationS > 0)) {
    throw new Error(`dialogue-audio builder: no TTS duration for frame ${ctx.frameId ?? '(none)'}`);
  }
  const leadS = ctx.job.dialogue.leadS ?? DEFAULT_LEAD_S;
  return {
    ttsUrl: tts.url,
    leadS,
    durationS: dialogueClipS(tts.durationS, leadS, ctx.job.actionS),
    projectId: ctx.projectId,
    frameId: ctx.frameId ?? ctx.job.frameId,
  };
};
