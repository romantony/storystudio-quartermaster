import { handler } from '../src/handlers/build-turn-tracks';

const voiceBank = [
  { characterId: 'rashid', characterName: 'Rashid', voiceId: 'en-us-doc-m', voiceCloneArtifactUrl: 'https://x/rashid.pt', voiceLanguage: 'English', voiceInstruct: 'low, calm' },
  { characterId: 'layla', characterName: 'Layla', voiceId: 'en-us-f', voiceCloneArtifactUrl: 'https://x/layla.pt', voiceLanguage: 'English', voiceInstruct: 'hushed' },
];

describe('build-turn-tracks — monologue', () => {
  it('joins all lines (single implicit speaker) into one mono turn', async () => {
    const result = await handler({
      kind: 'monologue',
      dialogueLines: [
        { lineIndex: 0, characterId: 'rashid', characterName: 'Rashid', text: 'This place shouldn\'t exist.' },
        { lineIndex: 1, characterId: 'rashid', characterName: 'Rashid', text: 'Neither should this.' },
      ],
      voiceBank,
    });
    expect(result.mono?.text).toBe('This place shouldn\'t exist. Neither should this.');
    expect(result.mono?.voiceId).toBe('en-us-doc-m');
    expect(result.left).toBeUndefined();
    expect(result.right).toBeUndefined();
  });

  it('respects lineIndex order even if lines arrive out of order', async () => {
    const result = await handler({
      kind: 'monologue',
      dialogueLines: [
        { lineIndex: 1, characterId: 'rashid', characterName: 'Rashid', text: 'second' },
        { lineIndex: 0, characterId: 'rashid', characterName: 'Rashid', text: 'first' },
      ],
      voiceBank,
    });
    expect(result.mono?.text).toBe('first second');
  });
});

describe('build-turn-tracks — dialogue', () => {
  it('groups by speakerSlot into left/right turns, each in lineIndex order', async () => {
    const result = await handler({
      kind: 'dialogue',
      dialogueLines: [
        { lineIndex: 0, characterId: 'rashid', characterName: 'Rashid', speakerSlot: 'left', text: 'This place shouldn\'t exist.' },
        { lineIndex: 1, characterId: 'layla', characterName: 'Layla', speakerSlot: 'right', text: 'Neither should this.' },
      ],
      voiceBank,
    });
    expect(result.left?.text).toBe('This place shouldn\'t exist.');
    expect(result.left?.voiceId).toBe('en-us-doc-m');
    expect(result.right?.text).toBe('Neither should this.');
    expect(result.right?.voiceId).toBe('en-us-f');
  });

  it('joins multiple consecutive same-speaker lines into one turn each', async () => {
    const result = await handler({
      kind: 'dialogue',
      dialogueLines: [
        { lineIndex: 0, characterId: 'rashid', characterName: 'Rashid', speakerSlot: 'left', text: 'a' },
        { lineIndex: 1, characterId: 'rashid', characterName: 'Rashid', speakerSlot: 'left', text: 'b' },
        { lineIndex: 2, characterId: 'layla', characterName: 'Layla', speakerSlot: 'right', text: 'c' },
      ],
      voiceBank,
    });
    expect(result.left?.text).toBe('a b');
    expect(result.right?.text).toBe('c');
  });

  it('throws if a required speaker slot is missing', async () => {
    await expect(handler({
      kind: 'dialogue',
      dialogueLines: [{ lineIndex: 0, characterId: 'rashid', characterName: 'Rashid', speakerSlot: 'left', text: 'a' }],
      voiceBank,
    })).rejects.toThrow(/left and a right/);
  });

  it('throws on an unknown characterId (contract violation, fail loud)', async () => {
    await expect(handler({
      kind: 'dialogue',
      dialogueLines: [
        { lineIndex: 0, characterId: 'ghost', characterName: 'Ghost', speakerSlot: 'left', text: 'a' },
        { lineIndex: 1, characterId: 'layla', characterName: 'Layla', speakerSlot: 'right', text: 'b' },
      ],
      voiceBank,
    })).rejects.toThrow(/no voiceBank entry/);
  });
});

describe('build-turn-tracks — empty input', () => {
  it('throws rather than silently producing an empty turn', async () => {
    await expect(handler({ kind: 'monologue', dialogueLines: [], voiceBank })).rejects.toThrow(/empty/);
  });
});
