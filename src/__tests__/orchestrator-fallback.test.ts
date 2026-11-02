import {
  alignWords,
  buildSunoRequest,
  chunkBounds,
  clampSunoDuration,
  encodeWav,
  isoLanguage,
  makeHandler,
  pickTrack,
  toSrt,
  wavTo16kMono,
  type FallbackDeps,
} from '../handlers/orchestrator-fallback';

function wav48kStereo(seconds: number, amp = (i: number) => Math.round(8000 * Math.sin(i / 10))): Uint8Array {
  const frames = 48_000 * seconds;
  const bytes = new Uint8Array(44 + frames * 4);
  const dv = new DataView(bytes.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (bytes[o + i] = c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + frames * 4, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, 48_000, true); dv.setUint32(28, 192_000, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, frames * 4, true);
  for (let f = 0; f < frames; f++) {
    dv.setInt16(44 + f * 4, amp(f), true);
    dv.setInt16(46 + f * 4, amp(f), true);
  }
  return bytes;
}

describe('audio', () => {
  it('downmixes 48 kHz stereo to 16 kHz mono at the same duration', () => {
    const pcm = wavTo16kMono(wav48kStereo(2));
    expect(pcm.rate).toBe(16_000);
    expect(pcm.samples.length).toBe(32_000);
  });

  it('accepts ffmpeg’s streamed header (data size 0xFFFFFFFF)', () => {
    const b = wav48kStereo(1);
    new DataView(b.buffer).setUint32(40, 0xffffffff, true);
    expect(wavTo16kMono(b).samples.length).toBe(16_000);
  });

  it('rejects what it cannot decode rather than sending garbage', () => {
    expect(() => wavTo16kMono(new Uint8Array(100))).toThrow(/RIFF/);
  });

  it('round-trips through encodeWav', () => {
    const s = new Int16Array([1, -2, 3, 32767]);
    expect(Array.from(wavTo16kMono(encodeWav(s, 16_000)).samples)).toEqual([1, -2, 3, 32767]);
  });

  it('keeps short audio in one chunk and cuts long audio at the quiet point', () => {
    expect(chunkBounds({ rate: 16_000, samples: new Int16Array(16_000 * 30) })).toEqual([[0, 480_000]]);
    // 25 s of loud audio with a silent window at 18.0-18.2 s, chunked at 20 s.
    const rate = 16_000;
    const samples = new Int16Array(rate * 25).map((_, i) => (i >= 18 * rate && i < 18.2 * rate ? 0 : 5000));
    const b = chunkBounds({ rate, samples }, 20);
    expect(b).toHaveLength(2);
    expect(b[0][1] / rate).toBeGreaterThanOrEqual(18);
    expect(b[0][1] / rate).toBeLessThan(18.2);
    expect(b[1]).toEqual([b[0][1], samples.length]);
  });
});

describe('alignment', () => {
  const timed = [
    { word: '40', start: 0, end: 0.5 },
    { word: 'years', start: 0.5, end: 0.8 },
    { word: 'of', start: 0.8, end: 1.1 },
    { word: 'evenings', start: 1.1, end: 1.4 },
    { word: 'and', start: 2.0, end: 2.2 },
  ];

  it('keeps the text model’s words and punctuation on whisper’s timings, interpolating the unmatched', () => {
    const { words, matchRatio } = alignWords('Forty years of evenings, and', timed);
    expect(words.map((w) => w.word)).toEqual(['Forty', 'years', 'of', 'evenings,', 'and']);
    expect(words[0]).toEqual({ word: 'Forty', start: 0, end: 0.5 }); // took '40''s slot
    expect(words[3]).toEqual({ word: 'evenings,', start: 1.1, end: 1.4 });
    expect(matchRatio).toBeCloseTo(0.8);
  });

  it('spreads extra text words across the gap between anchors', () => {
    const { words } = alignWords('years of the evenings', timed.slice(1, 4));
    expect(words[2].start).toBeGreaterThanOrEqual(1.1 - 1e-9);
    expect(words[2].end).toBeLessThanOrEqual(1.1 + 1e-9);
  });

  it('uses whisper’s own words when the two transcripts disagree', () => {
    const { words } = alignWords('completely different text here now', timed);
    expect(words.map((w) => w.word)).toEqual(timed.map((w) => w.word));
  });

  it('keeps Devanagari intact through normalisation', () => {
    const t = [{ word: 'नमस्ते', start: 0, end: 1 }, { word: 'दुनिया', start: 1, end: 2 }];
    expect(alignWords('नमस्ते दुनिया।', t).words).toEqual([{ word: 'नमस्ते', start: 0, end: 1 }, { word: 'दुनिया।', start: 1, end: 2 }]);
  });

  it('writes a one-word-per-cue SRT that never goes backwards or has zero length', () => {
    const srt = toSrt([{ word: 'a', start: 1, end: 1 }, { word: 'b', start: 0.5, end: 2 }]);
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:01,050\na\n\n2\n00:00:01,050 --> 00:00:02,000\nb\n');
  });

  it('maps project languages to ISO-639-1', () => {
    expect(isoLanguage('pt-BR')).toBe('pt');
    expect(isoLanguage('hi')).toBe('hi');
    expect(isoLanguage('')).toBeUndefined();
    expect(isoLanguage('english')).toBeUndefined();
  });
});

describe('suno', () => {
  it('asks for an instrumental in custom mode, the prompt as style, duration clamped', () => {
    expect(buildSunoRequest('soft piano', 37.4)).toEqual({
      model: 'ai-music-api/generate',
      input: { custom_mode: true, instrumental: true, model: 'V6', title: 'Background score', style: 'soft piano', negative_tags: 'vocals, singing, lyrics, choir', duration: 38 },
    });
    expect(clampSunoDuration(3)).toBe(10);
    expect(clampSunoDuration(1800)).toBe(360);
    expect(clampSunoDuration(undefined)).toBe(60);
  });

  it('picks the shortest track that covers the video, else the longest', () => {
    const t = [{ audio_url: 'https://a', duration: 47.9 }, { audio_url: 'https://b', duration: 44.5 }];
    expect(pickTrack(t, 40)?.audio_url).toBe('https://b');
    expect(pickTrack(t, 46)?.audio_url).toBe('https://a');
    expect(pickTrack(t, 100)?.audio_url).toBe('https://a');
    expect(pickTrack([{ duration: 50 }], 10)).toBeUndefined();
  });
});

describe('handler', () => {
  function deps(responses: Array<[RegExp, () => Response]>): FallbackDeps & { puts: Array<{ key: string; size: number }> } {
    const puts: Array<{ key: string; size: number }> = [];
    return {
      puts,
      getSecret: async () => 'k',
      fetchImpl: (async (url: string) => {
        const hit = responses.find(([re]) => re.test(String(url)));
        if (!hit) throw new Error(`unexpected fetch ${url}`);
        return hit[1]();
      }) as unknown as typeof fetch,
      putObject: async (key, body) => {
        puts.push({ key, size: body.length });
        return `https://bucket/${key}`;
      },
    };
  }
  const json = (b: unknown) => () => new Response(JSON.stringify(b), { status: 200 });

  it('bgm-status re-hosts the finished track and reports COMPLETED', async () => {
    const d = deps([
      [/recordInfo/, json({ code: 200, data: { state: 'success', response: { data: [{ audio_url: 'https://tmp/x.mp3', duration: 50 }] } } })],
      [/tmp\/x\.mp3/, () => new Response(new Uint8Array(4096), { status: 200 })],
    ]);
    const r = await makeHandler(d)({ action: 'bgm-status', taskId: 'abcdef1234', durationS: 40, outputPrefix: 'projects/p1/tail/' });
    expect(r).toMatchObject({ status: 'COMPLETED', audioUrl: 'https://bucket/projects/p1/tail/bgm-fallback.mp3' });
    expect(d.puts).toEqual([{ key: 'projects/p1/tail/bgm-fallback.mp3', size: 4096 }]);
  });

  it('bgm-status keeps polling through a transient KIE error, and reports a task failure as FAILED', async () => {
    const h1 = makeHandler(deps([[/recordInfo/, () => new Response('bad gateway', { status: 502 })]]));
    expect(await h1({ action: 'bgm-status', taskId: 'abcdef1234', outputPrefix: 'projects/p1/tail/' })).toEqual({ status: 'IN_PROGRESS' });
    const h2 = makeHandler(deps([[/recordInfo/, json({ code: 200, data: { state: 'fail', failCode: 400, failMsg: 'sensitive' } })]]));
    expect(await h2({ action: 'bgm-status', taskId: 'abcdef1234', outputPrefix: 'projects/p1/tail/' })).toEqual({ status: 'FAILED', error: 'suno [400] sensitive' });
  });

  it('refuses to write outside a project prefix', async () => {
    const h = makeHandler(deps([]));
    await expect(h({ action: 'bgm-status', taskId: 'abcdef1234', outputPrefix: '../etc/' })).rejects.toThrow(/outputPrefix/);
  });

  it('transcribe: text from gpt-transcribe, timings from whisper-1, SRT written under the prefix', async () => {
    const audio = wav48kStereo(1);
    const seen: string[] = [];
    const d = deps([
      [/audio-file/, () => new Response(audio, { status: 200 })],
      [/audio\/transcriptions/, () => new Response('', { status: 500 })],
    ]);
    d.fetchImpl = (async (url: string, init?: RequestInit) => {
      if (/audio-file/.test(url)) return new Response(audio, { status: 200 });
      const model = (init!.body as FormData).get('model') as string;
      seen.push(model);
      if (model === 'gpt-transcribe') return new Response(JSON.stringify({ text: 'Hello, world.' }), { status: 200 });
      return new Response(JSON.stringify({ words: [{ word: 'hello', start: 0.1, end: 0.4 }, { word: 'world', start: 0.5, end: 0.9 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await makeHandler(d)({ action: 'transcribe', audioUrl: 'https://bucket/audio-file.wav', language: 'en', outputPrefix: 'projects/p1/tail/' });
    expect(r).toMatchObject({ status: 'COMPLETED', srtUrl: 'https://bucket/projects/p1/tail/captions-fallback.srt', words: 2 });
    expect(seen.sort()).toEqual(['gpt-transcribe', 'whisper-1']);
  });
});
