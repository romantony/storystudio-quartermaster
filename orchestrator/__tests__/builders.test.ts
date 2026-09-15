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
import { buildRemoveSilenceInput } from '../src/steps/builders/remove-silence';
import { buildUpscaleInput } from '../src/steps/builders/upscale';
import { buildUpscaleFrameInput } from '../src/steps/builders/upscale-frame';
import { buildSfxInput } from '../src/steps/builders/sfx';
import { buildCaptionInput } from '../src/steps/builders/caption';
import { buildBgmInput } from '../src/steps/builders/bgm';
import { buildBgmOverlayInput } from '../src/steps/builders/bgm-overlay';
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

  it('Qwen branch prefers cloneArtifactUrl over speaker/instruct design mode when both are present', () => {
    const out = buildTtsInput(
      ctx({
        job: {
          ...baseJob,
          voiceEngine: 'qwen',
          cloneArtifactUrl: 'https://pub.example/voice-clones/en-us-doc-f.pt',
          voiceSpeaker: 'Ryan',
          voiceInstruct: 'ignored once a clone artifact is present',
        },
      }),
    );
    expect(out).toEqual({
      mode: 'tts',
      engine: 'qwen',
      text: baseJob.narration,
      language: 'English',
      clone_artifact_url: 'https://pub.example/voice-clones/en-us-doc-f.pt',
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
    expect(out.speaker).toBeUndefined();
    expect(out.instruct).toBeUndefined();
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

  it('sizes duration_s off tts\'s ACTUAL generated audio length, not the caller\'s estimated durationS — real incident, 2026-09-12: the estimate was clipping narration', () => {
    const out = buildI2vInput(
      ctx({
        resolvedDeps: { 1: { url: 'https://pub.example/t2i.png' }, 2: { url: 'https://pub.example/f_001.wav', durationS: 6.4 } },
        job: { ...baseJob, durationS: 3 }, // caller's estimate — must be ignored in favor of durationS above
      }),
    );
    expect(out.duration_s).toBe(7); // ceil(6.4), clamped into [3,7]
  });

  it('falls back to the caller\'s durationS when tts has no resolved durationS (defensive; should not happen once step 2 is a real dependency)', () => {
    const out = buildI2vInput(
      ctx({
        resolvedDeps: { 1: { url: 'https://pub.example/t2i.png' } },
        job: { ...baseJob, durationS: 4.1 },
      }),
    );
    expect(out.duration_s).toBe(5); // ceil(4.1) — unchanged pre-existing behavior
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

  it('prefers step 14\'s upscaled clip over step 3\'s when upscale was planned', () => {
    const out = buildMergeInput(
      ctx({
        job: { ...baseJob, upscaleFrames: true },
        resolvedDeps: { ...deps.resolvedDeps, 14: { url: 'https://pub.example/f_001_1080p.mp4' } },
      }),
    );
    expect(out.video_url).toBe('https://pub.example/f_001_1080p.mp4');
  });

  it('throws instead of falling back to the 480p clip when upscale was planned but this frame\'s upscale failed', () => {
    expect(() => buildMergeInput(ctx({ job: { ...baseJob, upscaleFrames: true }, ...deps }))).toThrow(
      /upscale was planned but no resolved upscaled video URL/,
    );
  });
});

describe('buildMergeInput with step 15 (per-frame MMAudio SFX)', () => {
  const base = { 2: { url: 'https://pub.example/f_001.wav' }, 3: { url: 'https://pub.example/f_001.mp4' } };

  it('uses MMAudio\'s mp4 as the video and flags sfx_from_video — the full image/tts/i2v/upscale/sfx/merge chain', () => {
    const out = buildMergeInput(
      ctx({
        job: { ...baseJob, upscaleFrames: true, sfx: true },
        resolvedDeps: {
          ...base,
          14: { url: 'https://pub.example/f_001_up.mp4' },
          15: { url: 'https://pub.example/f_001_mmaudio_v2a_video.mp4' },
        },
      }),
    );
    expect(out).toEqual({
      mode: 'merge',
      video_url: 'https://pub.example/f_001_mmaudio_v2a_video.mp4',
      audio_url: 'https://pub.example/f_001.wav',
      sfx_from_video: true,
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
    expect(out).not.toHaveProperty('sfx_url');
  });

  it('omits sfx_from_video and keeps the step 14/3 clip when sfx was not planned', () => {
    const out = buildMergeInput(ctx({ resolvedDeps: { ...base, 15: { url: 'https://pub.example/stray.mp4' } } }));
    expect(out).not.toHaveProperty('sfx_from_video');
    expect(out.video_url).toBe('https://pub.example/f_001.mp4');
  });

  it('throws when sfx was planned but this frame\'s SFX job failed', () => {
    expect(() => buildMergeInput(ctx({ job: { ...baseJob, sfx: true }, resolvedDeps: base }))).toThrow(
      /sfx was planned but no resolved sfx video URL/,
    );
  });

  it('throws when the SFX output resolved to an audio-only file (MMAudio returned no mp4)', () => {
    expect(() =>
      buildMergeInput(ctx({ job: { ...baseJob, sfx: true }, resolvedDeps: { ...base, 15: { url: 'https://pub.example/f_001_sfx.mp3' } } })),
    ).toThrow(/audio-only/);
  });
});

describe('buildSfxInput (step 15, MMAudio v2a)', () => {
  it('runs v2a on the upscaled clip with return_video, steered by the frame\'s audioPrompt, with music/speech negated', () => {
    const out = buildSfxInput(
      ctx({
        job: { ...baseJob, upscaleFrames: true, audioPrompt: '  gulls, lapping water, distant foghorn  ' },
        resolvedDeps: { 3: { url: 'https://pub.example/f_001.mp4' }, 14: { url: 'https://pub.example/f_001_up.mp4' } },
      }),
    );
    expect(out).toEqual({
      mode: 'v2a',
      video_url: 'https://pub.example/f_001_up.mp4',
      prompt: 'gulls, lapping water, distant foghorn',
      negative_prompt: 'music, speech, voice, singing',
      return_video: true,
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
  });

  it('builds the prompt from imagePrompt, never motionPrompt, when no audioPrompt is given', () => {
    const out = buildSfxInput(ctx({ resolvedDeps: { 3: { url: 'https://pub.example/f_001.mp4' } } }));
    expect(out.prompt).toBe('ambient environmental sound and sound effects of the scene: wide shot, harbour at dawn, fog on the water');
    expect(out.prompt).not.toContain('slow push in');
  });

  it('falls back to step 3\'s clip when upscale was not planned', () => {
    const out = buildSfxInput(ctx({ resolvedDeps: { 3: { url: 'https://pub.example/f_001.mp4' } } }));
    expect(out.video_url).toBe('https://pub.example/f_001.mp4');
  });

  it('throws when upscale was planned but that frame\'s upscale failed', () => {
    expect(() =>
      buildSfxInput(ctx({ job: { ...baseJob, upscaleFrames: true }, resolvedDeps: { 3: { url: 'https://pub.example/f_001.mp4' } } })),
    ).toThrow(/upscale was planned/);
  });
});

describe('buildUpscaleFrameInput (step 14, per-frame DreamX refiner)', () => {
  it('upscales step 3\'s clip at the refiner\'s max sr_scale 2.25', () => {
    expect(buildUpscaleFrameInput(ctx({ resolvedDeps: { 3: { url: 'https://pub.example/f_001.mp4' } } }))).toEqual({
      video_url: 'https://pub.example/f_001.mp4',
      sr_scale: 2.25,
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
  });

  it('never sends target_height — Wan2 "480p" is really 464p, so 1080 would be 2.328x and rejected (real incident, 2026-09-14)', () => {
    const out = buildUpscaleFrameInput(ctx({ resolvedDeps: { 3: { url: 'https://pub.example/f_001.mp4' } } }));
    expect(out).not.toHaveProperty('target_height');
  });

  it('throws when the animation video URL is unresolved', () => {
    expect(() => buildUpscaleFrameInput(ctx())).toThrow(/no resolved animation video URL/);
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

  it('prefers step 7 (remove-silence) over step 6 (merge) when both are resolved', () => {
    const out = buildConcatInput(
      projectCtx({
        6: ['https://pub.example/f_001_merge.mp4', 'https://pub.example/f_002_merge.mp4'],
        7: ['https://pub.example/f_001_trimmed.mp4', 'https://pub.example/f_002_trimmed.mp4'],
      }),
    );
    expect(out.video_urls).toEqual(['https://pub.example/f_001_trimmed.mp4', 'https://pub.example/f_002_trimmed.mp4']);
  });

  it('falls back to step 6 (merge) when remove-silence did not run (step 7 empty/absent)', () => {
    const urls = ['https://pub.example/f_001_merge.mp4', 'https://pub.example/f_002_merge.mp4'];
    expect(buildConcatInput(projectCtx({ 6: urls, 7: [] })).video_urls).toEqual(urls);
    expect(buildConcatInput(projectCtx({ 6: urls })).video_urls).toEqual(urls);
  });
});

describe('buildRemoveSilenceInput (step 7, per-frame — sits between merge and concat)', () => {
  it('builds a remove_silence request from the resolved step-6 merge output', () => {
    const out = buildRemoveSilenceInput(ctx({ resolvedDeps: { 6: { url: 'https://pub.example/f_001_merge.mp4' } } }));
    expect(out).toEqual({
      mode: 'remove_silence',
      video_url: 'https://pub.example/f_001_merge.mp4',
      project_id: 'proj_8812',
      frame_id: 'f_001',
    });
  });

  it('throws when step 6 has no resolved output', () => {
    expect(() => buildRemoveSilenceInput(ctx({ resolvedDeps: {} }))).toThrow(/no resolved merge video URL/);
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

  describe('script-timed chunks (no Whisper)', () => {
    const narrations = [
      { frameId: 'f1', narration: 'Maya Rao was quiet.' },
      { frameId: 'f2', narration: 'Nobody noticed.' },
      { frameId: 'f3', narration: 'Then the wall opened.' },
    ];
    const withDetails = (details: BuildContext['perFrameDetails'], job: Partial<FrameJobInput> = {}): BuildContext => ({
      ...projectCtx({ 8: ['https://pub.example/concat.mp4'] }),
      job: { ...baseJob, narrations, ...job },
      perFrameDetails: details,
    });

    it('times each frame\'s words across its trimmed clip, offset by the clips before it', () => {
      const out = buildCaptionInput(
        withDetails({
          7: [
            { frameId: 'f1', url: 'https://pub.example/f1_trim.mp4', durationS: 2.0 },
            { frameId: 'f2', url: 'https://pub.example/f2_trim.mp4', durationS: 1.5 },
            { frameId: 'f3', url: 'https://pub.example/f3_trim.mp4', durationS: 3.0 },
          ],
          6: [
            { frameId: 'f1', url: 'https://pub.example/f1_merge.mp4', durationS: 2.5 },
            { frameId: 'f2', url: 'https://pub.example/f2_merge.mp4', durationS: 2.0 },
            { frameId: 'f3', url: 'https://pub.example/f3_merge.mp4', durationS: 3.5 },
          ],
        }),
      );
      const chunks = out.chunks as Array<{ text: string; timestamp: [number, number] }>;
      expect(chunks.map((c) => c.text)).toEqual(['Maya', 'Rao', 'was', 'quiet.', 'Nobody', 'noticed.', 'Then', 'the', 'wall', 'opened.']);
      // f1: weights 5,4,4,7 of 20 over 2.0s
      expect(chunks.slice(0, 4).map((c) => c.timestamp)).toEqual([[0, 0.5], [0.5, 0.9], [0.9, 1.3], [1.3, 2]]);
      expect(chunks[4].timestamp[0]).toBe(2); // f2 starts where f1's trimmed clip ends
      expect(chunks[6].timestamp[0]).toBe(3.5); // f3 after 2.0 + 1.5
      expect(chunks[9].timestamp[1]).toBe(6.5);
    });

    it('skips a failed frame exactly like concat does, and uses merge durations when remove-silence did not run', () => {
      const out = buildCaptionInput(
        withDetails({
          6: [
            { frameId: 'f1', url: 'https://pub.example/f1_merge.mp4', durationS: 2.5 },
            { frameId: 'f2', url: undefined, durationS: undefined },
            { frameId: 'f3', url: 'https://pub.example/f3_merge.mp4', durationS: 3.5 },
          ],
        }),
      );
      const chunks = out.chunks as Array<{ text: string; timestamp: [number, number] }>;
      expect(chunks.map((c) => c.text)).not.toContain('Nobody');
      expect(chunks.find((c) => c.text === 'Then')!.timestamp[0]).toBe(2.5);
    });

    it('falls back to Whisper (no chunks) when a joined clip has no duration or no narration', () => {
      const noDuration = buildCaptionInput(
        withDetails({ 7: [{ frameId: 'f1', url: 'https://pub.example/f1_trim.mp4', durationS: undefined }] }),
      );
      expect(noDuration).not.toHaveProperty('chunks');
      const noNarration = buildCaptionInput(
        withDetails({ 7: [{ frameId: 'f9', url: 'https://pub.example/f9_trim.mp4', durationS: 2 }] }),
      );
      expect(noNarration).not.toHaveProperty('chunks');
      expect(buildCaptionInput(projectCtx({ 8: ['https://pub.example/concat.mp4'] }))).not.toHaveProperty('chunks');
    });
  });
});

describe('buildBgmInput (step 5, bgm generation — reads ctx.job, not ctx.perFrameOutputs)', () => {
  const bgmCtx = (job: Partial<FrameJobInput>): BuildContext => ({
    job: { ...baseJob, ...job },
    resolvedDeps: {},
    projectId: 'proj_8812',
    frameId: null,
  });

  it('builds a bgm request from bgmPrompt/totalDurationS', () => {
    const out = bgmCtx({ bgmPrompt: 'cinematic orchestral, warm and reflective, no vocals', totalDurationS: 45 });
    expect(buildBgmInput(out)).toEqual({
      mode: 'bgm',
      prompt: 'cinematic orchestral, warm and reflective, no vocals',
      duration_s: 45,
      steps: 20,
      guidance: 7.0,
      project_id: 'proj_8812',
    });
  });

  it('caps duration_s at 120s — ACE-Step does not reliably generate longer', () => {
    const out = buildBgmInput(bgmCtx({ bgmPrompt: 'p', totalDurationS: 300 }));
    expect(out.duration_s).toBe(120);
  });

  it('defaults totalDurationS to 30s when absent', () => {
    const out = buildBgmInput(bgmCtx({ bgmPrompt: 'p', totalDurationS: undefined }));
    expect(out.duration_s).toBe(30);
  });

  it('throws when bgmPrompt is missing', () => {
    expect(() => buildBgmInput(bgmCtx({ bgmPrompt: undefined }))).toThrow(/no bgmPrompt/);
  });
});

describe('buildBgmOverlayInput (step 12, last in the tail — prefers caption, then upscale, then concat, plus the bgm track)', () => {
  const projectCtx = (perFrameOutputs?: Record<number, string[]>): BuildContext => ({
    job: baseJob,
    resolvedDeps: {},
    perFrameOutputs,
    projectId: 'proj_8812',
    frameId: null,
  });

  it('prefers step 11 (caption) when 11, 10, and 8 are all resolved', () => {
    const out = buildBgmOverlayInput(
      projectCtx({
        8: ['https://pub.example/concat.mp4'],
        10: ['https://pub.example/upscale.mp4'],
        11: ['https://pub.example/caption.mp4'],
        5: ['https://pub.example/bgm.wav'],
      }),
    );
    expect(out).toEqual({
      mode: 'mix_bgm',
      video_url: 'https://pub.example/caption.mp4',
      bgm_url: 'https://pub.example/bgm.wav',
      bgm_volume: 0.15,
      project_id: 'proj_8812',
    });
  });

  it('falls back to step 10 then step 8 when later steps did not run', () => {
    expect(buildBgmOverlayInput(projectCtx({ 8: ['https://pub.example/concat.mp4'], 5: ['https://pub.example/bgm.wav'] })).video_url).toBe(
      'https://pub.example/concat.mp4',
    );
    expect(
      buildBgmOverlayInput(
        projectCtx({ 8: ['https://pub.example/concat.mp4'], 10: ['https://pub.example/upscale.mp4'], 5: ['https://pub.example/bgm.wav'] }),
      ).video_url,
    ).toBe('https://pub.example/upscale.mp4');
  });

  it('throws when no video source resolved', () => {
    expect(() => buildBgmOverlayInput(projectCtx({ 5: ['https://pub.example/bgm.wav'] }))).toThrow(/no resolved video URL/);
  });

  it('throws when the bgm track is unresolved', () => {
    expect(() => buildBgmOverlayInput(projectCtx({ 8: ['https://pub.example/concat.mp4'] }))).toThrow(/no resolved bgm track URL/);
  });
});
