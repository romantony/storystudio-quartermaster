/**
 * runpodOutUrl() key-priority tests — real incident, 2026-09-12: step 11
 * (burn captions)'s output carries BOTH `srt` and `video`, and the original
 * key order picked `srt`, silently resolving the wrong asset for step 12
 * (bgm-overlay) to consume. No test existed for this function before that.
 */
import { runpodOutUrl } from '../src/runpod/output';

describe('runpodOutUrl', () => {
  it('prefers video over srt when an output carries both — step 11 (caption)\'s real shape', () => {
    const captionOutput = {
      mode: 'caption',
      srt: 'https://pub.example/output.srt',
      transcript: 'hello world',
      video: 'https://pub.example/output_caption.mp4',
      word_count: 2,
    };
    expect(runpodOutUrl(captionOutput)).toBe('https://pub.example/output_caption.mp4');
  });

  it('prefers video over audio when an output carries both — step 15 (MMAudio, return_video)\'s real shape', () => {
    const mmaudioOutput = {
      mode: 'v2a',
      audio_key: 'storystudio/sfx/p_f01_mmaudio_v2a.mp3',
      audio_url: 'https://pub.example/sfx/p_f01_mmaudio_v2a.mp3',
      video_key: 'storystudio/video/p_f01_mmaudio_v2a_video.mp4',
      video_url: 'https://pub.example/video/p_f01_mmaudio_v2a_video.mp4',
      duration_s: 5.04,
    };
    expect(runpodOutUrl(mmaudioOutput)).toBe('https://pub.example/video/p_f01_mmaudio_v2a_video.mp4');
  });

  it('still resolves a standalone srt output (no video present) — step 9/transcribe-shaped', () => {
    const transcribeOutput = { text: 'hello', chunks: [], srt: 'https://pub.example/output.srt' };
    expect(runpodOutUrl(transcribeOutput)).toBe('https://pub.example/output.srt');
  });

  it('resolves the usual single-field outputs unchanged', () => {
    expect(runpodOutUrl({ image_url: 'https://pub.example/x.png' })).toBe('https://pub.example/x.png');
    expect(runpodOutUrl({ audio: 'https://pub.example/x.wav' })).toBe('https://pub.example/x.wav');
    expect(runpodOutUrl({ video: 'https://pub.example/x.mp4' })).toBe('https://pub.example/x.mp4');
    expect(runpodOutUrl({ video_url: 'https://pub.example/x.mp4' })).toBe('https://pub.example/x.mp4');
  });

  it('digs through nested/array shapes and returns undefined when nothing resolves', () => {
    expect(runpodOutUrl([{ image: 'https://pub.example/x.png' }])).toBe('https://pub.example/x.png');
    expect(runpodOutUrl({ error: 'boom' })).toBeUndefined();
    expect(runpodOutUrl(undefined)).toBeUndefined();
  });
});
