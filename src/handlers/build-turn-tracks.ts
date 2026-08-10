/**
 * QM-build-turn-tracks — Dialogue Premium only
 * (storystudio-dialogue-qm-sfn-handoff.md §7.4/§7.5/§7.9.2). Pure text/data
 * transform, no ffmpeg, no network — turns a shot's `dialogueLines[]` into
 * one TTS call's worth of text PER TURN rather than per line:
 *
 *   "Generate one TTS call per turn, not per line — join that speaker's
 *   consecutive lines into a single text... half the calls, 12% shorter
 *   audio, better prosody, and no hosting step." (§7.4 step 1, measured §7.9.2)
 *
 * `kind:"monologue"` shots have every line spoken by the same character (no
 * `speakerSlot`) -> one turn. `kind:"dialogue"` shots guarantee (§7.5,
 * enforced by StoryStudio's planner, not re-validated here): at most two
 * distinct `speakerSlot` values, all of `left`'s lines before all of
 * `right`'s in `lineIndex` order, first speaker always `left` -> two turns.
 *
 * v1 simplification (matches the doc's stated default): always one call per
 * turn, no per-line emotion/delivery split. "Fall back to per-line only when
 * a shot genuinely needs different emotion/delivery within one turn" is a
 * documented but unbuilt edge case.
 */

export interface DialogueLine {
  lineIndex: number;
  characterId: string;
  characterName: string;
  speakerSlot?: 'left' | 'right';
  text: string;
  emotion?: string;
  delivery?: string;
  pauseAfterSeconds?: number;
}

export interface VoiceBankEntry {
  characterId: string;
  characterName: string;
  voiceId: string;
  voiceCloneArtifactUrl?: string;
  voiceLanguage?: string;
  voiceInstruct?: string;
}

export interface TurnTrack {
  text: string;
  characterId: string;
  characterName: string;
  voiceId: string;
  voiceCloneArtifactUrl?: string;
  voiceLanguage?: string;
  voiceInstruct?: string;
}

interface BuildTurnTracksEvent {
  kind: 'monologue' | 'dialogue';
  dialogueLines: DialogueLine[];
  voiceBank: VoiceBankEntry[];
}

interface BuildTurnTracksResult {
  mono?: TurnTrack;
  left?: TurnTrack;
  right?: TurnTrack;
}

function resolveVoice(characterId: string, voiceBank: VoiceBankEntry[]): VoiceBankEntry {
  const entry = voiceBank.find(v => v.characterId === characterId);
  if (!entry) throw new Error(`build-turn-tracks: no voiceBank entry for characterId=${characterId}`);
  return entry;
}

function buildTurn(lines: DialogueLine[], voiceBank: VoiceBankEntry[]): TurnTrack {
  const ordered = [...lines].sort((a, b) => a.lineIndex - b.lineIndex);
  const text = ordered.map(l => l.text).join(' ');
  const voice = resolveVoice(ordered[0].characterId, voiceBank);
  return {
    text,
    characterId: voice.characterId,
    characterName: voice.characterName,
    voiceId: voice.voiceId,
    voiceCloneArtifactUrl: voice.voiceCloneArtifactUrl,
    voiceLanguage: voice.voiceLanguage,
    voiceInstruct: voice.voiceInstruct,
  };
}

export const handler = async (event: BuildTurnTracksEvent): Promise<BuildTurnTracksResult> => {
  const { kind, dialogueLines, voiceBank } = event;
  if (dialogueLines.length === 0) {
    throw new Error(`build-turn-tracks: dialogueLines is empty for kind=${kind}`);
  }

  if (kind === 'monologue') {
    return { mono: buildTurn(dialogueLines, voiceBank) };
  }

  const left = dialogueLines.filter(l => l.speakerSlot === 'left');
  const right = dialogueLines.filter(l => l.speakerSlot === 'right');
  if (left.length === 0 || right.length === 0) {
    throw new Error('build-turn-tracks: kind="dialogue" requires both a left and a right speakerSlot line');
  }

  return { left: buildTurn(left, voiceBank), right: buildTurn(right, voiceBank) };
};
