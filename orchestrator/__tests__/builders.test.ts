/**
 * Payload builder tests (impl plan §9 — "one pure function per step, one
 * test each"). No I/O, no DB, no clock — a fixed BuildContext in, a plain
 * object out.
 */
import { buildImageInput } from '../src/steps/builders/image';
import { buildImageEditInput } from '../src/steps/builders/image-edit';
import { buildTtsInput } from '../src/steps/builders/tts';
import { buildI2vInput } from '../src/steps/builders/i2v';
import { buildMergeInput } from '../src/steps/builders/merge';
import { buildConcatInput } from '../src/steps/builders/concat';
import { buildUpscaleInput } from '../src/steps/builders/upscale';
import { buildCaptionInput } from '../src/steps/builders/caption';
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

describe('buildImageEditInput (step 0, Narration Premium reference-image flow)', () => {
  it('builds a qwen-image-edit request with no model field', () => {
    const out = buildImageEditInput(ctx({ job: { ...baseJob, referenceImageUrl: 'https://cdn.example/ref.png' } }));
    expect(out).toEqual({
      image_url: 'https://cdn.example/ref.png',
      prompt: baseJob.imagePrompt,
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
    expect(out.model).toBeUndefined();
  });

  it('throws when referenceImageUrl is missing', () => {
    expect(() => buildImageEditInput(ctx())).toThrow(/no referenceImageUrl/);
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

  it('routes to Qwen voice-design when voiceEngine is qwen, defaulting speaker/instruct/language', () => {
    const out = buildTtsInput(ctx({ job: { ...baseJob, voiceEngine: 'qwen' } }));
    expect(out).toEqual({
      mode: 'tts',
      engine: 'qwen',
      text: baseJob.narration,
      language: 'English',
      instruct: '',
      speaker: 'Ryan',
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
  });

  it('Qwen branch uses the supplied speaker/instruct/language, empty speaker falling through to default', () => {
    const out = buildTtsInput(
      ctx({
        job: {
          ...baseJob,
          voiceEngine: 'qwen',
          voiceSpeaker: '',
          voiceInstruct: 'calm, warm documentary narrator',
          voiceLanguage: 'English',
        },
      }),
    );
    expect(out.speaker).toBe('Ryan');
    expect(out.instruct).toBe('calm, warm documentary narrator');
    expect(out.language).toBe('English');
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

  it('throws when neither step 0 nor step 1 has a resolved image URL', () => {
    expect(() => buildI2vInput(ctx({ resolvedDeps: {} }))).toThrow(/no resolved image URL/);
  });

  it('prefers step 0 (image-i2i) over step 1 when both happen to be resolved', () => {
    const out = buildI2vInput(
      ctx({ resolvedDeps: { 0: { url: 'https://pub.example/edited.png' }, 1: { url: 'https://pub.example/t2i.png' } } }),
    );
    expect(out.image).toBe('https://pub.example/edited.png');
  });

  it('falls back to step 1 when step 0 is not resolved (Basic tier, unchanged behavior)', () => {
    const out = buildI2vInput(ctx({ resolvedDeps: { 1: { url: 'https://pub.example/t2i.png' } } }));
    expect(out.image).toBe('https://pub.example/t2i.png');
  });
});

describe('buildMergeInput (step 6)', () => {
  const deps = { resolvedDeps: { 2: { url: 'https://pub.example/f_001.wav' }, 3: { url: 'https://pub.example/f_001.mp4' } } };

  it('includes mode:"merge" — postprod-lite 400s "Invalid mode \'None\'" without it (real incident, 2026-09-12)', () => {
    expect(buildMergeInput(ctx(deps))).toEqual({
      mode: 'merge',
      video_url: 'https://pub.example/f_001.mp4',
      audio_url: 'https://pub.example/f_001.wav',
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
  });

  it('throws when the tts audio URL is unresolved', () => {
    expect(() => buildMergeInput(ctx({ resolvedDeps: { 3: { url: 'https://pub.example/f_001.mp4' } } }))).toThrow(
      /no resolved tts audio URL/,
    );
  });

  it('throws when the animation video URL is unresolved', () => {
    expect(() => buildMergeInput(ctx({ resolvedDeps: { 2: { url: 'https://pub.example/f_001.wav' } } }))).toThrow(
      /no resolved animation video URL/,
    );
  });
});

describe('buildConcatInput (step 8, singleJobPerProject — project-scoped, no single frame)', () => {
  const projectCtx = (perFrameOutputs?: Record<number, string[]>): BuildContext => ({
    job: baseJob,
    resolvedDeps: {},
    perFrameOutputs,
    projectId: 'proj_8812',
    frameId: null,
  });

  it('builds a concat request from every frame\'s step-6 output, in order, with no frame_id', () => {
    const urls = ['https://pub.example/f_001_merge.mp4', 'https://pub.example/f_002_merge.mp4', 'https://pub.example/f_003_merge.mp4'];
    const out = buildConcatInput(projectCtx({ 6: urls }));
    expect(out).toEqual({
      mode: 'concat',
      video_urls: urls,
      project_id: 'proj_8812',
    });
    expect(out.frame_id).toBeUndefined();
  });

  it('throws when fewer than 2 clips are resolved (postprod-lite requires video_urls >= 2)', () => {
    expect(() => buildConcatInput(projectCtx({ 6: ['https://pub.example/f_001_merge.mp4'] }))).toThrow(
      /need at least 2 merged clips/,
    );
  });

  it('throws when perFrameOutputs is entirely absent', () => {
    expect(() => buildConcatInput(projectCtx(undefined))).toThrow(/need at least 2 merged clips/);
  });
});

describe('buildUpscaleInput (step 10, singleJobPerProject depending on ANOTHER singleJobPerProject step)', () => {
  const projectCtx = (perFrameOutputs?: Record<number, string[]>): BuildContext => ({
    job: baseJob,
    resolvedDeps: {},
    perFrameOutputs,
    projectId: 'proj_8812',
    frameId: null,
  });

  it('builds an upscale request from step 8\'s one concat output, defaulting target_height to 1080', () => {
    const out = buildUpscaleInput(projectCtx({ 8: ['https://pub.example/proj_8812_concat.mp4'] }));
    expect(out).toEqual({
      mode: 'upscale',
      video_url: 'https://pub.example/proj_8812_concat.mp4',
      target_height: 1080,
      project_id: 'proj_8812',
    });
  });

  it('throws when step 8\'s output is unresolved', () => {
    expect(() => buildUpscaleInput(projectCtx(undefined))).toThrow(/no resolved concat video URL/);
    expect(() => buildUpscaleInput(projectCtx({ 8: [] }))).toThrow(/no resolved concat video URL/);
  });
});

describe('buildCaptionInput (step 11, TikTok-style burn captions — prefers step 10, falls back to step 8)', () => {
  const projectCtx = (perFrameOutputs?: Record<number, string[]>): BuildContext => ({
    job: baseJob,
    resolvedDeps: {},
    perFrameOutputs,
    projectId: 'proj_8812',
    frameId: null,
  });

  const tiktokParams = { words_per_group: 3, font_size: 64, highlight_color: 'yellow', position: 'bottom' };

  it('prefers step 10 (upscale) when both 8 and 10 are resolved', () => {
    const out = buildCaptionInput(
      projectCtx({ 8: ['https://pub.example/proj_8812_concat.mp4'], 10: ['https://pub.example/proj_8812_upscale.mp4'] }),
    );
    expect(out).toEqual({
      mode: 'caption',
      video_url: 'https://pub.example/proj_8812_upscale.mp4',
      project_id: 'proj_8812',
      ...tiktokParams,
    });
  });

  it('falls back to step 8 (concat) when upscale did not run', () => {
    const out = buildCaptionInput(projectCtx({ 8: ['https://pub.example/proj_8812_concat.mp4'] }));
    expect(out.video_url).toBe('https://pub.example/proj_8812_concat.mp4');
  });

  it('throws when neither step 10 nor step 8 is resolved', () => {
    expect(() => buildCaptionInput(projectCtx(undefined))).toThrow(/no resolved video URL/);
  });
});
