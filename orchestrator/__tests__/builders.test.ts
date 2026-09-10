/**
 * Payload builder tests (impl plan §9 — "one pure function per step, one
 * test each"). No I/O, no DB, no clock — a fixed BuildContext in, a plain
 * object out.
 */
import { buildImageInput } from '../src/steps/builders/image';
import { buildTtsInput } from '../src/steps/builders/tts';
import { buildI2vInput } from '../src/steps/builders/i2v';
import type { BuildContext, FrameJobInput } from '../src/steps/builders/types';

const baseJob: FrameJobInput = {
  frameId: 'f_001',
  imagePrompt: 'wide shot, harbour at dawn, fog on the water',
  narration: 'The harbour wakes before the town does.',
  durationS: 5.2,
  motionPrompt: 'slow push in',
  aspectRatio: '9:16',
  language: 'English',
};

function ctx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    job: baseJob,
    resolvedDeps: {},
    projectId: 'proj_8812',
    frameId: 'f_001',
    ...overrides,
  };
}

describe('buildImageInput (step 1)', () => {
  it('builds a qwen t2i request with attribution', () => {
    expect(buildImageInput(ctx())).toEqual({
      model: 'qwen',
      prompt: baseJob.imagePrompt,
      aspect_ratio: '9:16',
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
  });

  it('defaults aspect_ratio to 16:9 when the request omits one', () => {
    const out = buildImageInput(ctx({ job: { ...baseJob, aspectRatio: undefined } }));
    expect(out.aspect_ratio).toBe('16:9');
  });
});

describe('buildTtsInput (step 2)', () => {
  it('builds a Kokoro request, defaulting voice and lang_code', () => {
    expect(buildTtsInput(ctx())).toEqual({
      mode: 'tts',
      engine: 'kokoro',
      text: baseJob.narration,
      voice: 'am_michael',
      speed: 1.0,
      lang_code: 'a',
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
  });

  it('an explicit empty-string voiceId falls through to the default (|| not ??)', () => {
    const out = buildTtsInput(ctx({ job: { ...baseJob, voiceId: '' } }));
    expect(out.voice).toBe('am_michael');
  });

  it('resolves lang_code from language, case-insensitively', () => {
    const out = buildTtsInput(ctx({ job: { ...baseJob, language: 'hindi' } }));
    expect(out.lang_code).toBe('h');
  });
});

describe('buildI2vInput (step 3)', () => {
  it('reads the resolved step-1 image URL and clamps/ceils duration', () => {
    const out = buildI2vInput(
      ctx({ resolvedDeps: { 1: { url: 'https://pub.example/f_001.png' } }, job: { ...baseJob, durationS: 5.2 } }),
    );
    expect(out).toEqual({
      image: 'https://pub.example/f_001.png',
      prompt: 'slow push in',
      resolution: '480p',
      duration_s: 6, // ceil(5.2), not round
      sample_steps: 4,
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
  });

  it('clamps duration_s into [3,7]', () => {
    const deps = { resolvedDeps: { 1: { url: 'https://pub.example/x.png' } } };
    expect(buildI2vInput(ctx({ ...deps, job: { ...baseJob, durationS: 1.2 } })).duration_s).toBe(3);
    expect(buildI2vInput(ctx({ ...deps, job: { ...baseJob, durationS: 20 } })).duration_s).toBe(7);
  });

  it('throws when step 1 has no resolved image URL', () => {
    expect(() => buildI2vInput(ctx({ resolvedDeps: {} }))).toThrow(/no resolved image URL/);
  });
});
