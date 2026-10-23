/** Seedance 2 Mini on KIE (Dialogue Premium, 2026-10-23): schema, validation, plan, builder, manifest, transport. */
import { RequestSchema, validateRequest, PlanValidationError } from '../src/agents/planner';
import { compilePlan, toResolvedDeps } from '../src/assets/plan';
import { buildAssetRows } from '../src/assets/submit';
import { manifestFrame } from '../src/assets/compiler';
import { ASSET_SPECS } from '../src/assets/kinds';
import { buildSeedanceVideoInput } from '../src/steps/builders/seedance-video';
import { buildImageEditInput } from '../src/steps/builders/image-edit';
import { buildTtsInput } from '../src/steps/builders/tts';
import { buildSeedanceInput, clampSeedanceDuration, runSeedance, seedanceAspect } from '../src/kie/seedance';
import type { AssetRow } from '../src/db/repo/assets';
import type { BuildContext } from '../src/steps/builders/types';

const PROMPT =
  'Two-shot, slow push in. MARA (warm alto) says: "We never agreed to this." JONAH (low, tired baritone) answers: "You never asked."';
const frame = (id: string, over: Record<string, unknown> = {}) => ({
  frameId: id, imagePrompt: 'a kitchen at night, two people at a table', durationS: 8,
  motionPrompt: PROMPT, audioMode: 'sfx-only', spoken: true, characters: ['mara', 'jonah'], ...over,
});
const chars = [
  { id: 'mara', description: 'a woman', referenceImageUrl: 'https://r2.example/mara.png' },
  { id: 'jonah', description: 'a man', referenceImageUrl: 'https://r2.example/jonah.png' },
];
const req = (frames: unknown[], extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => ({
  requestId: 'r1', projectId: 'p1', source: 'mcp', tier: 'dialogue-premium', product: 'dialogue', language: 'en',
  aspectRatio: '16:9', resolution: '1920x1080', callbackUrl: 'https://x.example/cb', bgmPrompt: 'soft piano',
  options: { motionEngine: 'seedance', promptHarness: 'off', bgm: true, burnCaptions: true, ...opts },
  frames, characters: chars, ...extra,
});

describe('seedance request validation', () => {
  it('accepts two speakers in one frame', () => {
    const r = validateRequest(req([frame('f1'), frame('f2', { spoken: false, characters: ['mara'] })]));
    expect(r.req.options.motionEngine).toBe('seedance');
  });
  it.each([
    ['no motionPrompt', frame('f1', { motionPrompt: undefined }), {}, /motionPrompt/],
    ['too short a clip', frame('f1', { durationS: 3 }), {}, /outside Seedance/],
    ['too long a clip', frame('f1', { durationS: 16 }), {}, /outside Seedance/],
    ['not sfx-only', frame('f1', { audioMode: 'clip' }), {}, /sfx-only/],
    ['narration present', frame('f1', { narration: 'hello' }), {}, /no narration/],
    ['dialogue field present', frame('f1', { dialogue: { speaker: 'mara', line: 'hi' } }), {}, /no dialogue field/],
    ['unknown character', frame('f1', { characters: ['ghost'] }), {}, /unknown character/],
    ['three characters in a frame', frame('f1', { characters: ['mara', 'jonah', 'x'] }), {}, /./],
    ['removeSilence on', frame('f1'), { removeSilence: true }, /removeSilence/],
    ['sfx on', frame('f1'), { sfx: true }, /sfx/],
  ])('rejects %s', (_n, f, opts, msg) => {
    let err: unknown;
    try { validateRequest(req([f], {}, opts as Record<string, unknown>)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(msg);
  });
  it('is a PlanValidationError, not a crash', () => {
    expect(() => validateRequest(req([frame('f1', { durationS: 2 })]))).toThrow(PlanValidationError);
  });
});

describe('seedance plan', () => {
  const r = RequestSchema.parse(req([frame('f1'), frame('f2', { characters: ['jonah'], spoken: false })]));
  const p = compilePlan(r);
  it('image -> seedance-video, with characters edited from their sheets', () => {
    expect(p.motionKind).toBe('seedance-video');
    expect(p.imageKind).toBe('qwen-edit');
    expect(p.requires['seedance-video']).toContain('qwen-edit');
    expect(p.requires['qwen-edit']).toEqual(['qwen-image-gen', 'char-ref']);
    expect(p.frameKinds).not.toContain('comfy-video');
    expect(p.frameKinds).not.toContain('wan2-i2v');
    expect(p.frameKinds).not.toContain('dialogue-audio');
  });
  it('tail: captions + bgm on, silence removal off', () => {
    expect(p.tail).toMatchObject({ burnCaptions: true, bgm: true, removeSilence: false });
  });
  it('without characters it is text-to-image', () => {
    const q = compilePlan(RequestSchema.parse(req([frame('f1', { characters: undefined })], { characters: undefined })));
    expect(q.imageKind).toBe('qwen-image-gen');
    expect(q.frameKinds).not.toContain('char-ref');
  });
  it('registers a kie row per frame and carries spoken + the prompt onto it', () => {
    expect(ASSET_SPECS['seedance-video']).toMatchObject({ provider: 'lambda', table: 'asset_seedance_video', produces: 'video', scope: 'frame' });
    const rows = buildAssetRows(r, p);
    const row = rows.find((x) => x.kind === 'seedance-video' && x.frameId === 'f1')!;
    expect(row.endpointId).toBe('lambda:kie-seedance2mini');
    expect(row.input).toMatchObject({ motionPrompt: PROMPT, spoken: true, durationS: 8, characters: ['mara', 'jonah'] });
    expect((row.input as { characterRefs?: string[] }).characterRefs).toEqual(['https://r2.example/mara.png', 'https://r2.example/jonah.png']);
  });
  it('TTS passes through for a seedance frame (no narration)', () => {
    const row = buildAssetRows(r, p).find((x) => x.kind === 'tts' && x.frameId === 'f1')!;
    const out = buildTtsInput({ job: row.input, resolvedDeps: {}, projectId: 'p1', frameId: 'f1' } as unknown as BuildContext) as { __passthroughUrl?: string };
    expect(out.__passthroughUrl).toMatch(/^skip:/);
  });
  it('the edit still is built from the character composite', () => {
    const row = buildAssetRows(r, p).find((x) => x.kind === 'qwen-edit' && x.frameId === 'f1')!;
    const out = buildImageEditInput({
      job: row.input, resolvedDeps: toResolvedDeps({ 'qwen-image-gen': { url: 'https://r2.example/t2i.png' }, 'char-ref': { url: 'https://r2.example/comp.png' } }),
      projectId: 'p1', frameId: 'f1',
    } as unknown as BuildContext);
    expect(JSON.stringify(out)).toContain('comp.png');
  });
});

describe('seedance builder', () => {
  const ctx = (job: Record<string, unknown>, deps: BuildContext['resolvedDeps']): BuildContext =>
    ({ job: { frameId: 'f1', imagePrompt: 'x', durationS: 8, aspectRatio: '9:16', motionPrompt: PROMPT, ...job }, resolvedDeps: deps, projectId: 'p1', frameId: 'f1' }) as unknown as BuildContext;
  it('first frame is the edit still, prompt is the whole motionPrompt, length is the caller\'s', () => {
    expect(buildSeedanceVideoInput(ctx({}, { 0: { url: 'https://r2.example/still.png' } }))).toEqual({
      firstFrameUrl: 'https://r2.example/still.png', prompt: PROMPT, durationS: 8, aspectRatio: '9:16', projectId: 'p1', frameId: 'f1',
    });
  });
  it('clamps to KIE\'s 4-15 s', () => {
    expect(buildSeedanceVideoInput(ctx({ durationS: 30 }, { 1: { url: 'u' } })).durationS).toBe(15);
    expect(buildSeedanceVideoInput(ctx({ durationS: 1 }, { 1: { url: 'u' } })).durationS).toBe(4);
  });
  it('refuses a frame with no still or no prompt', () => {
    expect(() => buildSeedanceVideoInput(ctx({}, {}))).toThrow(/no resolved image/);
    expect(() => buildSeedanceVideoInput(ctx({ motionPrompt: undefined }, { 1: { url: 'u' } }))).toThrow(/no motionPrompt/);
  });
});

describe('seedance manifest', () => {
  const row = (kind: string, url: string) => ({ id: 1, projectId: 'p1', seq: 0, frameId: 'f1', kind, status: 'complete', assetUrl: url, durationS: null, input: {} }) as unknown as AssetRow;
  const r = RequestSchema.parse(req([frame('f1'), frame('f2', { spoken: false })]));
  const plan = compilePlan(r);
  it('a spoken frame is clipAudioOnly + clipAudioSpoken, with no narration audio', () => {
    const m = manifestFrame(plan, { frameId: 'f1', seq: 0, rows: [row('tts', 'skip:none'), row('seedance-video', 'http://clip.mp4')] }, r);
    expect(m).toMatchObject({ clipAudioOnly: true, clipAudioSpoken: true, videoUrl: 'http://clip.mp4', durationS: 8 });
    expect(m.audioUrl).toBeUndefined();
  });
  it('a silent frame is clipAudioOnly without clipAudioSpoken', () => {
    const m = manifestFrame(plan, { frameId: 'f2', seq: 1, rows: [row('tts', 'skip:none'), row('seedance-video', 'http://clip2.mp4')] }, r);
    expect(m).toMatchObject({ clipAudioOnly: true });
    expect(m).not.toHaveProperty('clipAudioSpoken');
  });
});

describe('KIE transport', () => {
  const json = (b: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(b) });
  it('builds the createTask body', () => {
    expect(buildSeedanceInput({ prompt: 'p', firstFrameUrl: 'u', durationS: 7.4, aspectRatio: '9:16' })).toEqual({
      model: 'bytedance/seedance-2-mini',
      input: { prompt: 'p', first_frame_url: 'u', generate_audio: true, resolution: '720p', aspect_ratio: '9:16', duration: 7, nsfw_checker: false },
    });
  });
  it('maps aspects and durations', () => {
    expect(seedanceAspect('9 : 16')).toBe('9:16');
    expect(seedanceAspect('5:4')).toBe('16:9');
    expect(clampSeedanceDuration(99)).toBe(15);
  });
  it('create -> poll -> result url', async () => {
    const urls: string[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method ?? 'GET'} ${url}`);
      if (String(url).endsWith('/createTask')) return json({ code: 200, data: { taskId: 't1' } });
      polls += 1;
      return polls < 2
        ? json({ code: 200, data: { state: 'waiting' } })
        : json({ code: 200, data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://kie/v.mp4'] }), costTime: 1234 } });
    }) as unknown as typeof fetch;
    const seen: string[] = [];
    const out = await runSeedance({ apiKey: 'k', fetchImpl, sleepImpl: async () => undefined }, { prompt: 'p', firstFrameUrl: 'u', durationS: 8, aspectRatio: '16:9' }, async (id) => { seen.push(id); });
    expect(out).toEqual({ taskId: 't1', videoUrl: 'https://kie/v.mp4', costTimeMs: 1234 });
    expect(seen).toEqual(['t1']);
    expect(urls[0]).toBe('POST https://api.kie.ai/api/v1/jobs/createTask');
    expect(urls[1]).toContain('recordInfo?taskId=t1');
  });
  it('surfaces a failed task', async () => {
    const fetchImpl = (async (url: string) =>
      String(url).endsWith('/createTask') ? json({ code: 200, data: { taskId: 't2' } }) : json({ code: 200, data: { state: 'fail', failCode: '501', failMsg: 'content policy' } })) as unknown as typeof fetch;
    await expect(runSeedance({ apiKey: 'k', fetchImpl, sleepImpl: async () => undefined }, { prompt: 'p', firstFrameUrl: 'u', durationS: 8, aspectRatio: '16:9' }))
      .rejects.toThrow(/failed \[501\]: content policy/);
  });
  it('retries a 429 on createTask, not a 400', async () => {
    let n = 0;
    const flaky = (async () => { n += 1; return n === 1 ? json({ msg: 'slow down' }, 429) : json({ code: 200, data: { taskId: 't3' } }); }) as unknown as typeof fetch;
    const { createSeedanceTask } = await import('../src/kie/seedance');
    await expect(createSeedanceTask({ apiKey: 'k', fetchImpl: flaky, sleepImpl: async () => undefined }, { prompt: 'p', firstFrameUrl: 'u', durationS: 8, aspectRatio: '16:9' })).resolves.toBe('t3');
    n = 10;
    const bad = (async () => json({ msg: 'bad input' }, 400)) as unknown as typeof fetch;
    await expect(createSeedanceTask({ apiKey: 'k', fetchImpl: bad, sleepImpl: async () => undefined }, { prompt: 'p', firstFrameUrl: 'u', durationS: 8, aspectRatio: '16:9' })).rejects.toThrow(/HTTP 400/);
  });
  it('gives up when the task never finishes', async () => {
    const fetchImpl = (async (url: string) =>
      String(url).endsWith('/createTask') ? json({ code: 200, data: { taskId: 't4' } }) : json({ code: 200, data: { state: 'waiting' } })) as unknown as typeof fetch;
    await expect(runSeedance({ apiKey: 'k', fetchImpl, sleepImpl: async () => undefined, pollIntervalMs: 10, maxWaitMs: 30 }, { prompt: 'p', firstFrameUrl: 'u', durationS: 8, aspectRatio: '16:9' }))
      .rejects.toThrow(/did not finish/);
  });
});

// ── Dialogue Premium: narration (Qwen TTS + LTX-2.3) mixed with spoken Seedance frames ──────────
const NARRATION = 'The kitchen had been quiet for three years.';
const LTX_PROMPT = 'Slow push in on an empty kitchen table. Sound: a refrigerator hum, a distant clock ticking. No speech, no music.';
const narr = (id: string, over: Record<string, unknown> = {}) => ({
  frameId: id, imagePrompt: 'an empty kitchen at dawn', durationS: 6, motionPrompt: LTX_PROMPT,
  engine: 'ltx', shotKind: 'i2v', audioMode: 'sfx-under-narration', narration: NARRATION, ...over,
});
const mixedReq = (frames: unknown[], extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
  req(frames, { cloneArtifactUrl: 'https://r2.example/narrator.pt', voiceLanguage: 'English', ...extra }, { voiceEngine: 'qwen', ...opts });

describe('mixed narration + spoken request', () => {
  const frames = [narr('n1', { characters: undefined }), frame('f2'), narr('n3', { characters: undefined }), frame('f4', { spoken: false, characters: ['mara'] })];

  it('accepts narration (engine ltx) beside spoken seedance frames', () => {
    expect(() => validateRequest(mixedReq(frames))).not.toThrow();
  });
  it.each([
    ['narration without a narrator voice', [narr('n1'), frame('f2')], { cloneArtifactUrl: undefined }, {}, /narrator voice/],
    ['narration without the qwen voice engine', [narr('n1'), frame('f2')], {}, { voiceEngine: 'kokoro' }, /voiceEngine/],
    ['narration that is not an i2v shot', [narr('n1', { shotKind: 'flf' }), frame('f2')], {}, {}, /shotKind 'i2v'/],
    ['narration with no narration text', [narr('n1', { narration: undefined }), frame('f2')], {}, {}, /needs narration/],
    ['narration marked sfx-only', [narr('n1', { audioMode: 'sfx-only' }), frame('f2')], {}, {}, /sfx-under-narration/],
    ['narration marked spoken', [narr('n1', { spoken: true }), frame('f2')], {}, {}, /voiced by TTS/],
  ])('rejects %s', (_n, f, extra, opts, msg) => {
    let err: unknown;
    try { validateRequest(mixedReq(f as unknown[], extra as Record<string, unknown>, opts as Record<string, unknown>)); } catch (e) { err = e; }
    expect(String((err as Error)?.message)).toMatch(msg as RegExp);
  });
  it('does not apply the 4-15 s Seedance range to a narration frame (LTX sizes it from the TTS)', () => {
    expect(() => validateRequest(mixedReq([narr('n1', { durationS: 3 }), frame('f2')]))).not.toThrow();
  });

  const r = RequestSchema.parse(mixedReq(frames));
  const p = compilePlan(r);
  it('plans both clip kinds; only the narration kind waits for TTS', () => {
    expect(p.motionKinds).toEqual(['seedance-video', 'comfy-video']);
    expect(p.requires['seedance-video']).not.toContain('tts');
    expect(p.requires['comfy-video']).toEqual(expect.arrayContaining(['tts']));
    expect(p.frameKinds).not.toContain('mmaudio');
    expect(p.frameKinds).not.toContain('dialogue-audio');
  });
  it('a request that is all narration plans only LTX; all spoken only Seedance', () => {
    expect(compilePlan(RequestSchema.parse(mixedReq([narr('n1'), narr('n2')]))).motionKinds).toEqual(['comfy-video']);
    expect(compilePlan(RequestSchema.parse(req([frame('f1'), frame('f2')]))).motionKinds).toEqual(['seedance-video']);
  });
  it('each frame row records its engine', () => {
    const rows = buildAssetRows(r, p);
    const engineOf = (frameId: string) => (rows.find((x) => x.kind === 'tts' && x.frameId === frameId)!.input as { engine?: string }).engine;
    expect(engineOf('n1')).toBe('ltx');
    expect(engineOf('f2')).toBe('seedance');
  });
  const jobFor = (frameId: string) => buildAssetRows(r, p).find((x) => x.kind === 'tts' && x.frameId === frameId)!.input;
  const ctx = (job: unknown, deps: BuildContext['resolvedDeps']) => ({ job, resolvedDeps: deps, projectId: 'p1', frameId: 'x' }) as unknown as BuildContext;
  const { buildComfyVideoInput } = jest.requireActual('../src/steps/builders/comfy-video') as typeof import('../src/steps/builders/comfy-video');

  it('narration: TTS runs, the LTX clip is sized to it, the Seedance row passes through', () => {
    const job = jobFor('n1');
    const tts = buildTtsInput(ctx(job, {})) as { __passthroughUrl?: string };
    expect(tts.__passthroughUrl).toBeUndefined();
    const comfy = buildComfyVideoInput(ctx(job, { 1: { url: 'https://r2.example/s.png' }, 2: { url: 'https://r2.example/n.wav', durationS: 7 } })) as { workflow: string; durationS: number; prompt: string };
    expect(comfy).toMatchObject({ workflow: 'ltx23_i2v', prompt: LTX_PROMPT });
    expect(comfy.durationS).toBeGreaterThanOrEqual(5);
    expect(comfy.durationS).toBeLessThanOrEqual(10);
    expect((buildSeedanceVideoInput(ctx(job, { 1: { url: 'u' } })) as { __passthroughUrl?: string }).__passthroughUrl).toBe('skip:ltx');
  });
  it('spoken: no TTS, the LTX row passes through, the Seedance row runs', () => {
    const job = jobFor('f2');
    expect((buildTtsInput(ctx(job, {})) as { __passthroughUrl?: string }).__passthroughUrl).toMatch(/^skip:/);
    expect((buildComfyVideoInput(ctx(job, { 1: { url: 'u' } })) as { __passthroughUrl?: string }).__passthroughUrl).toBe('skip:seedance');
    expect(buildSeedanceVideoInput(ctx(job, { 1: { url: 'https://r2.example/s.png' } }))).toMatchObject({ firstFrameUrl: 'https://r2.example/s.png', durationS: 8 });
  });

  const row = (frameId: string, kind: string, url: string, durationS: number | null = null) =>
    ({ id: 1, projectId: 'p1', seq: 0, frameId, kind, status: 'complete', assetUrl: url, durationS, input: {} }) as unknown as AssetRow;
  it('manifest: a narration frame has the TTS audio and the LTX clip (its sound under the voice)', () => {
    const m = manifestFrame(p, { frameId: 'n1', seq: 0, rows: [row('n1', 'tts', 'http://n.wav', 7), row('n1', 'comfy-video', 'http://ltx.mp4'), row('n1', 'seedance-video', 'skip:ltx')] }, r);
    expect(m).toMatchObject({ audioUrl: 'http://n.wav', videoUrl: 'http://ltx.mp4', sfxFromVideo: true, durationS: 7, narration: NARRATION });
    expect(m).not.toHaveProperty('clipAudioOnly');
  });
  it('manifest: a spoken frame in the same plan is clip-audio only, from the Seedance clip', () => {
    const m = manifestFrame(p, { frameId: 'f2', seq: 1, rows: [row('f2', 'tts', 'skip:none'), row('f2', 'comfy-video', 'skip:seedance'), row('f2', 'seedance-video', 'http://sd.mp4')] }, r);
    expect(m).toMatchObject({ clipAudioOnly: true, clipAudioSpoken: true, videoUrl: 'http://sd.mp4' });
    expect(m).not.toHaveProperty('audioUrl');
    expect(m).not.toHaveProperty('sfxFromVideo');
  });
});
