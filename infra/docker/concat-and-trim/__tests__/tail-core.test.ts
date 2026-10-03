/**
 * Pure-logic tests for the orchestrator assembly tail. Each of these is a port
 * of a recipe that was validated live elsewhere, so the tests pin the properties
 * that made it correct (filter order, peak ceilings, parity limits, ASS shape).
 */
import {
  assertAvParity,
  assertManifest,
  buildFinalizeArgs,
  buildFinalizeFilter,
  createTiktokAss,
  escapeFfmpegFilterPath,
  evenDims,
  formatAssTime,
  hexToAssColor,
  kenBurnsArgs,
  kenBurnsFilter,
  mergeArgs,
  parseLoudness,
  parseResolution,
  parseSrtEntries,
  s3Url,
  sfxNormalizeGainDb,
  stillDurationS,
} from '../tail-core';

describe('assertManifest', () => {
  const frame = { frameId: 'f1', seq: 0, videoUrl: 'https://cdn/a.mp4', audioUrl: 'https://cdn/a.wav', durationS: 5, narration: 'n' };
  const ok = { version: 3, projectId: 'p', fps: 16, project: { aspectRatio: '9:16', language: 'en', frameCount: 1 }, frames: [frame], droppedFrames: [], steps: { removeSilence: false, burnCaptions: false } };

  it('accepts a v3 manifest', () => {
    expect(() => assertManifest(ok)).not.toThrow();
  });

  it('refuses another version rather than guessing at its shape', () => {
    expect(() => assertManifest({ ...ok, version: 2 })).toThrow(/version 2 is not supported/);
  });

  it('refuses a frame with no narration — a silent scene is never shipped', () => {
    expect(() => assertManifest({ ...ok, frames: [{ ...frame, audioUrl: '' }] })).toThrow(/audioUrl is required/);
  });

  it('refuses a frame with neither a clip nor a still', () => {
    expect(() => assertManifest({ ...ok, frames: [{ ...frame, videoUrl: undefined }] })).toThrow(/videoUrl.*imageUrl/);
  });

  it('refuses an empty manifest', () => {
    expect(() => assertManifest({ ...ok, frames: [] })).toThrow(/no frames/);
  });
});

describe('SFX loudness normalisation', () => {
  it('parses an ebur128 summary', () => {
    const stderr = 'noise\n  Summary:\n\n  Integrated loudness:\n    I:         -23.4 LUFS\n    Threshold: -33.5 LUFS\n\n  Sample peak:\n    Peak:       -3.1 dBFS\n';
    expect(parseLoudness(stderr)).toEqual({ i: -23.4, peak: -3.1 });
  });

  it('treats silence as unmeasurable, not as a valid 0.0 LUFS', () => {
    expect(parseLoudness('Summary:\n I: -inf LUFS\n Peak: -inf dBFS')).toBeNull();
    expect(parseLoudness('Summary:\n I: -70.0 LUFS\n Peak: -60 dBFS')).toBeNull();
    expect(parseLoudness('no summary at all')).toBeNull();
  });

  it('raises a quiet SFX to the narration\u2019s level, but never past the peak ceiling', () => {
    // 10 dB quieter than the narration, plenty of peak room: +10 dB.
    expect(sfxNormalizeGainDb({ i: -20, peak: -2 }, { i: -30, peak: -30 }, 0.22)).toBe(10);
    // A 20 dB gap would want +20, but a SFX peaking at 0 dBFS (-13.15 dB after
    // the 0.22 volume) only has 12.15 dB of room before the -1 dBFS ceiling.
    expect(sfxNormalizeGainDb({ i: -20, peak: -2 }, { i: -40, peak: 0 }, 0.22)).toBe(12.15);
  });

  it('caps the gain so a near-silent track is not lifted into audible noise', () => {
    expect(sfxNormalizeGainDb({ i: -10, peak: 0 }, { i: -60, peak: -90 }, 1.0)).toBe(30);
  });

  it('does nothing when either side is unmeasurable', () => {
    expect(sfxNormalizeGainDb(null, { i: -30, peak: -10 }, 0.22)).toBe(0);
    expect(sfxNormalizeGainDb({ i: -20, peak: -2 }, null, 0.22)).toBe(0);
  });
});

describe('mergeArgs', () => {
  it('muxes narration onto the clip with the video stream-copied', () => {
    const a = mergeArgs('v.mp4', 'a.wav', 'o.mp4');
    expect(a).toEqual(expect.arrayContaining(['-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-shortest']));
    expect(a[a.length - 1]).toBe('o.mp4');
  });

  it('pads the SFX and resamples to 44.1k so amix cannot double the narration or low-pass the SFX', () => {
    const a = mergeArgs('v.mp4', 'a.wav', 'o.mp4', { path: 's.wav', gainDb: 6, volume: 0.22 });
    const filter = a[a.indexOf('-filter_complex') + 1];
    expect(filter).toContain('apad');
    expect(filter).toContain('dropout_transition=0');
    expect(filter).toContain('aresample=44100');
    // 2 * 0.22 * 10^(6/20)
    expect(filter).toContain(`volume=${(2 * 0.22 * 10 ** (6 / 20)).toFixed(6)}`);
    expect(a).toEqual(expect.arrayContaining(['-ar', '44100']));
  });
});

describe('Ken Burns', () => {
  it('builds a different motion for each effect and a sensible default', () => {
    const filters = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'something-else'].map((e) => kenBurnsFilter(e, 832, 464, 80, 16));
    expect(new Set(filters).size).toBe(5);
    for (const f of filters) {
      expect(f).toContain('scale=1664:928'); // 2x supersample before zoompan
      expect(f).toContain('s=832x464');
      expect(f).toContain('d=80');
      expect(f).toContain('format=yuv420p');
    }
  });

  it('sizes the clip to the narration\u2019s real length, never under it', () => {
    expect(stillDurationS(6.4, 5)).toBe(6.4);
    expect(stillDurationS(3, 5)).toBe(5);
    expect(stillDurationS(4, null)).toBe(4);
  });

  it('emits the frame count from duration x fps', () => {
    const a = kenBurnsArgs('i.png', 'o.mp4', 'zoom_in', 832, 464, 5, 16);
    expect(a[a.indexOf('-frames:v') + 1]).toBe('80');
  });

  it('rounds odd dimensions down to even, which yuv420p requires', () => {
    expect(evenDims(833, 465)).toEqual({ width: 832, height: 464 });
  });
});

describe('assertAvParity', () => {
  it('passes within a second and fails loudly beyond it', () => {
    expect(() => assertAvParity(60, 60.8)).not.toThrow();
    expect(() => assertAvParity(63.8, 60)).toThrow(/A\/V duration mismatch.*drift 3\.80s/);
  });
});

describe('parseResolution', () => {
  it('takes the short edge for "1080p"', () => {
    expect(parseResolution('1080p', '9:16')).toEqual({ width: 1080, height: 1920 });
    expect(parseResolution('1080p', '16:9')).toEqual({ width: 1920, height: 1080 });
    expect(parseResolution('720', '1:1')).toEqual({ width: 720, height: 720 });
  });

  it('takes WxH literally and forces even dimensions', () => {
    expect(parseResolution('1921x1081', '16:9')).toEqual({ width: 1922, height: 1082 });
  });

  it('rejects nonsense', () => {
    expect(() => parseResolution('fhd', '9:16')).toThrow(/Invalid targetResolution/);
    expect(() => parseResolution('1080p', '916')).toThrow(/Invalid aspectRatio/);
    expect(() => parseResolution('1080p', '0:16')).toThrow(/Invalid aspectRatio/);
  });
});

describe('captions', () => {
  const srt = '1\n00:00:00,000 --> 00:00:01,200\nMaya had always\n\n2\n00:00:01,200 --> 00:00:02,400\nbeen the quiet\n\n';

  it('parses SRT cues into seconds', () => {
    expect(parseSrtEntries(srt)).toEqual([
      { start: 0, end: 1.2, text: 'Maya had always' },
      { start: 1.2, end: 2.4, text: 'been the quiet' },
    ]);
  });

  it('skips a malformed block instead of failing the whole file', () => {
    expect(parseSrtEntries('garbage\n\n1\n00:00:00,000 --> 00:00:01,000\nok\n')).toHaveLength(1);
  });

  it('converts hex to the ASS BGR colour order', () => {
    expect(hexToAssColor('#FFD400')).toBe('&H0000D4FF');
    expect(hexToAssColor('bad')).toBe('&H00FFFFFF');
  });

  it('formats ASS times as h:mm:ss.cc', () => {
    expect(formatAssTime(3725.5)).toBe('1:02:05.50');
  });

  it('writes one Dialogue line per word, highlighting each word in turn within its cue', () => {
    const ass = createTiktokAss(srt, 1080, 1920);
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(lines).toHaveLength(6); // 3 words x 2 cues
    expect(lines[0]).toContain('{\\c&H0000D4FF}MAYA{\\c&H00FFFFFF} HAD ALWAYS');
    expect(lines[1]).toContain('MAYA {\\c&H0000D4FF}HAD{\\c&H00FFFFFF} ALWAYS');
    // The cue's words tile its interval with no gap and no overlap (centisecond
    // times are floored, as in the finalize task this is ported from).
    expect(lines[0]).toContain('0:00:00.00,0:00:00.40');
    expect(lines[1]).toContain('0:00:00.40,0:00:00.80');
    expect(lines[2]).toContain('0:00:00.80,0:00:01.19');
  });

  it('wraps a long cue onto a second line after four words', () => {
    const ass = createTiktokAss('1\n00:00:00,000 --> 00:00:02,000\none two three four five six\n', 1080, 1920);
    expect(ass).toContain('FOUR');
    expect(ass.split('\n').find((l) => l.startsWith('Dialogue:'))).toContain('\\N');
  });

  it('scales margins to the video size and sets the script resolution', () => {
    const big = createTiktokAss(srt, 1080, 1920);
    const small = createTiktokAss(srt, 540, 960);
    expect(big).toContain('PlayResX: 1080');
    expect(small).toContain('PlayResY: 960');
    expect(big).toContain(',96,180,260,1'); // reference margins
    expect(small).toContain(',48,90,130,1');
  });

  it('lifts captions above a Remotion overlay\'s lower-third, scaled the same way', () => {
    expect(createTiktokAss(srt, 1080, 1920, 'above-overlay')).toContain(',96,180,500,1');
    expect(createTiktokAss(srt, 1920, 1080, 'above-overlay')).toContain(',171,320,281,1');
    expect(createTiktokAss(srt, 1080, 1920, 'bottom')).toContain(',96,180,260,1');
  });

  it('escapes ASS control characters in the text', () => {
    const ass = createTiktokAss('1\n00:00:00,000 --> 00:00:01,000\na{b}c\n', 1080, 1920);
    expect(ass).toContain('A\\{B\\}C');
  });

  it('produces no Dialogue lines for an SRT with no cues', () => {
    expect(createTiktokAss('', 1080, 1920)).not.toContain('Dialogue:');
  });
});

describe('buildFinalizeFilter', () => {
  const base = { inputWidth: 1008, inputHeight: 1792, targetWidth: 1080, targetHeight: 1920, videoDuration: 40, inputHasAudio: true, fontsDir: '/opt/fonts', bgmVolume: 0.15 };

  it('scales, THEN sharpens, THEN burns captions — in that order', () => {
    const f = buildFinalizeFilter({ ...base, captionsPath: '/tmp/c.ass' });
    const scale = f.indexOf('scale=1080:1920:flags=lanczos');
    const unsharp = f.indexOf('unsharp=5:5:0.8:5:5:0.0');
    const ass = f.indexOf("ass='/tmp/c.ass'");
    expect(scale).toBeGreaterThanOrEqual(0);
    expect(unsharp).toBeGreaterThan(scale);
    expect(ass).toBeGreaterThan(unsharp);
    expect(f).toContain('fontsdir=/opt/fonts');
  });

  it('skips the scale entirely when the video is already at target', () => {
    const f = buildFinalizeFilter({ ...base, inputWidth: 1080, inputHeight: 1920, captionsPath: '/tmp/c.ass' });
    expect(f).not.toContain('scale=');
    expect(f).toContain("[0:v]ass='/tmp/c.ass'");
  });

  it('mixes the BGM at its own flat volume under a 100% voice, with fades and NO ducking', () => {
    const f = buildFinalizeFilter({ ...base, bgmPath: '/tmp/b.mp3' });
    expect(f).toContain('volume=0.15');
    expect(f).toContain('afade=t=in:st=0:d=0.5');
    expect(f).toContain('afade=t=out:st=39:d=1'); // last second
    expect(f).toContain('amix=inputs=2:duration=first:normalize=0');
    expect(f).not.toContain('sidechaincompress');
  });

  it('uses the BGM alone when the video has no audio', () => {
    const f = buildFinalizeFilter({ ...base, inputHasAudio: false, bgmPath: '/tmp/b.mp3' });
    expect(f).toContain('[aout]');
    expect(f).not.toContain('amix');
  });

  it('passes the audio through untouched when there is no BGM', () => {
    expect(buildFinalizeFilter({ ...base })).toContain('[0:a]anull[aout]');
  });

  it('escapes the caption path for the filter graph', () => {
    expect(escapeFfmpegFilterPath("C:\\x\\it's.ass")).toBe("C\\:/x/it\\'s.ass");
  });
});

describe('buildFinalizeArgs', () => {
  it('loops the BGM under the whole video and bounds the output to the video\u2019s own length', () => {
    const a = buildFinalizeArgs({ videoPath: 'v.mp4', bgmPath: 'b.mp3', filterComplex: '[0:v]null[v];[aout]', outputPath: 'o.mp4', videoDuration: 40, inputHasAudio: true });
    expect(a).toEqual(expect.arrayContaining(['-stream_loop', '-1', '-i', 'b.mp3', '-shortest', '-t', '40']));
    expect(a).toEqual(expect.arrayContaining(['-map', '[v]', '-map', '[aout]']));
  });

  it('maps the source streams when there is no filter graph', () => {
    const a = buildFinalizeArgs({ videoPath: 'v.mp4', filterComplex: '', outputPath: 'o.mp4', videoDuration: 5, inputHasAudio: true });
    expect(a).not.toContain('-filter_complex');
    expect(a).toEqual(expect.arrayContaining(['-map', '0:v:0', '-map', '0:a:0']));
  });
});

describe('s3Url', () => {
  it('builds the virtual-hosted URL the rest of the pipeline already uses', () => {
    expect(s3Url('qm-bucket', 'projects/p/tail/video.mp4')).toBe('https://qm-bucket.s3.us-east-1.amazonaws.com/projects/p/tail/video.mp4');
  });
});
