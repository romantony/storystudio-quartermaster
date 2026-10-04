/** LTX-2.3 / Comfy contract (2026-10-04): schema + validation, plan, builders, graph, client. */
import { RequestSchema, validateRequest, PlanValidationError } from '../src/agents/planner';
import { compilePlan } from '../src/assets/plan';
import { buildAssetRows } from '../src/assets/submit';
import { buildComfyVideoInput, ltxDurationS } from '../src/steps/builders/comfy-video';
import { buildComfyLastInput } from '../src/steps/builders/comfy-last';
import { ASSET_SPECS } from '../src/assets/kinds';
import { assertOpenWeightGraph, buildGraph, runGraph, type ComfyGraph } from '../src/comfy/client';
import { buildDialogueAudioInput, dialogueClipS } from '../src/steps/builders/dialogue-audio';
import { buildCharRefInput } from '../src/steps/builders/char-ref';
import { buildImageInput } from '../src/steps/builders/image';
import { buildImageEditInput } from '../src/steps/builders/image-edit';
import { toResolvedDeps } from '../src/assets/plan';
import { compositeCharacterRefs } from '../src/assets/char-ref-composite';
import { padDialogueAudio } from '../src/assets/dialogue-audio-pad';
import { manifestFrame } from '../src/assets/compiler';
import type { AssetRow } from '../src/db/repo/assets';
import type { BuildContext } from '../src/steps/builders/types';

const frame = (id: string, over: Record<string, unknown> = {}) => ({
  frameId: id, imagePrompt: 'a lighthouse', narration: 'one', durationS: 6,
  motionPrompt: 'Slow push in. Sound: waves. No speech, no music.', shotKind: 'i2v', ...over,
});
const req = (frames: unknown[], extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) => ({
  requestId: 'r1', projectId: 'p1', source: 'mcp', tier: 'narration-premium', product: 'documentary', language: 'en',
  aspectRatio: '16:9', resolution: '1920x1080', callbackUrl: 'https://x.example/cb',
  options: { motionEngine: 'ltx', sfx: false, promptHarness: 'off', ...opts }, frames, ...extra,
});
const REF = 'https://r2.example/keeper.png';
const chars = [{ id: 'keeper', description: 'an old keeper', referenceImageUrl: REF }];

describe('ltx request validation', () => {
  it('accepts i2v + flf with characters', () => {
    const r = validateRequest(req([
      frame('f1', { characters: ['keeper'] }),
      frame('f2', { shotKind: 'flf', lastFrameEdit: 'the lamp is lit', stateLocks: ['lighthouse:dark→lit'], negativePrompt: 'text', cameraMove: 'dolly_in', audioMode: 'sfx-under-narration', soundCues: ['waves'] }),
    ], { characters: chars }));
    expect(r.req.options.motionEngine).toBe('ltx');
  });
  it.each([
    ['missing shotKind', [frame('f1', { shotKind: undefined })], /shotKind is required/],
    ['flf without lastFrameEdit', [frame('f1', { shotKind: 'flf' })], /needs lastFrameEdit/],
    ['i2v with lastFrameEdit', [frame('f1', { lastFrameEdit: 'x' })], /only valid for 'flf'/],
    ['ia2v without dialogue', [frame('f1', { shotKind: 'ia2v', narration: undefined })], /needs dialogue/],
    ['unknown character', [frame('f1', { characters: ['ghost'] })], /unknown character/],
    ['no motionPrompt', [frame('f1', { motionPrompt: undefined })], /motionPrompt is required/],
  ])('rejects %s', (_n, frames, msg) => {
    expect(() => validateRequest(req(frames as unknown[], { characters: chars }))).toThrow(PlanValidationError);
    expect(() => validateRequest(req(frames as unknown[], { characters: chars }))).toThrow(msg);
  });
  it('rejects 3 characters in a frame (schema)', () => {
    expect(RequestSchema.safeParse(req([frame('f1', { characters: ['a', 'b', 'c'] })])).success).toBe(false);
  });
  it('does not apply LTX rules to wan2 requests', () => {
    expect(() => validateRequest(req([frame('f1', { shotKind: undefined })], {}, { motionEngine: 'wan2' }))).not.toThrow();
  });
});

describe('ltx plan', () => {
  it('i2v only: comfy-video in Wan2 place, no comfy-last, no mmaudio even with sfx', () => {
    const p = compilePlan(RequestSchema.parse(req([frame('f1')], {}, { sfx: true })));
    expect(p.motionKind).toBe('comfy-video');
    expect(p.frameKinds).not.toContain('comfy-last');
    expect(p.frameKinds).not.toContain('mmaudio');
    expect(p.requires['comfy-video']).toEqual(['qwen-image-gen', 'tts']);
  });
  it('flf frame adds comfy-last upstream of comfy-video', () => {
    const r = RequestSchema.parse(req([frame('f1'), frame('f2', { shotKind: 'flf', lastFrameEdit: 'lit' })]));
    const p = compilePlan(r);
    expect(p.requires['comfy-last']).toEqual(['qwen-image-gen']);
    expect(p.requires['comfy-video']).toContain('comfy-last');
    const rows = buildAssetRows(r, p);
    expect(rows.filter((x) => x.kind === 'comfy-last')).toHaveLength(2);
    expect(rows.find((x) => x.kind === 'comfy-video' && x.frameId === 'f2')?.input).toMatchObject({ shotKind: 'flf', lastFrameEdit: 'lit' });
  });
  it('comfy kinds are registered and never QA-gated', () => {
    expect(ASSET_SPECS['comfy-video'].provider).toBe('lambda');
    expect(ASSET_SPECS['comfy-video'].gate).toBeNull();
    expect(ASSET_SPECS['comfy-last'].gate).toBeNull();
  });
});

const ctx = (job: Record<string, unknown>, deps: BuildContext['resolvedDeps']): BuildContext =>
  ({ job: { frameId: 'f1', imagePrompt: 'x', narration: 'n', durationS: 6, aspectRatio: '9:16', ...job }, resolvedDeps: deps, projectId: 'p1', frameId: 'f1' }) as BuildContext;

describe('ltx builders', () => {
  it('duration = real TTS + 1s tail, clamped 5..10', () => {
    // min(10, max(5, lead 0.4 + tts + actionS)), whole seconds; actionS defaults to 2
    expect(ltxDurationS(1.0, 6)).toBe(5);
    expect(ltxDurationS(6.2, 4)).toBe(9);
    expect(ltxDurationS(6.2, 4, 5)).toBe(10);
    expect(ltxDurationS(12, 4)).toBe(10);
    expect(ltxDurationS(undefined, 7)).toBe(7);
  });
  it('i2v payload', () => {
    const p = buildComfyVideoInput(ctx({ shotKind: 'i2v', motionPrompt: 'm', negativePrompt: 'n' }, { 1: { url: 'http://i' }, 2: { url: 'http://a', durationS: 6.2 } }));
    expect(p).toMatchObject({ workflow: 'ltx23_i2v', firstImageUrl: 'http://i', durationS: 9, portrait: true, negativePrompt: 'n' });
  });
  it('flf needs a distinct last frame', () => {
    const job = { shotKind: 'flf', motionPrompt: 'm', lastFrameEdit: 'e' };
    expect(() => buildComfyVideoInput(ctx(job, { 1: { url: 'http://i' }, 2: { url: 'http://a', durationS: 3 } }))).toThrow(/distinct last frame/);
    expect(() => buildComfyVideoInput(ctx(job, { 1: { url: 'http://i' }, 2: { url: 'http://a', durationS: 3 }, 17: { url: 'http://i' } }))).toThrow(/distinct last frame/);
    expect(buildComfyVideoInput(ctx(job, { 1: { url: 'http://i' }, 2: { url: 'http://a', durationS: 3 }, 17: { url: 'http://l' } }))).toMatchObject({ workflow: 'ltx23_flf2v', lastImageUrl: 'http://l' });
  });
  it('comfy-last: edit for flf, passthrough otherwise', () => {
    expect(buildComfyLastInput(ctx({ shotKind: 'flf', lastFrameEdit: 'lit' }, { 1: { url: 'http://i' } }))).toMatchObject({ image_url: 'http://i', prompt: 'lit' });
    expect(buildComfyLastInput(ctx({ shotKind: 'i2v' }, { 1: { url: 'http://i' } }))).toEqual({ __passthroughUrl: 'http://i' });
  });
});

describe('comfy graph + client', () => {
  const base = { prompt: 'P', negativePrompt: 'NEG', width: 1280, height: 720, fps: 25, durationS: 8, seed: 7, firstImage: 'a.png' };
  it('patches the i2v node map', () => {
    const g = buildGraph({ ...base, workflow: 'ltx23_i2v' });
    expect(g['269'].inputs.image).toBe('a.png');
    expect(g['320:319'].inputs.value).toBe('P');
    expect(g['320:301'].inputs.value).toBe(8);
    expect(g['320:276'].inputs.noise_seed).toBe(7);
    expect(String(g['320:313'].inputs.text)).toContain('NEG');
  });
  it('patches the flf2v node map', () => {
    const g = buildGraph({ ...base, workflow: 'ltx23_flf2v', lastImage: 'b.png' });
    expect(g['39'].inputs.image).toBe('b.png');
    expect(g['129:128'].inputs.text).toBe('P');
    expect(String(g['129:112'].inputs.text)).toContain('NEG');
    expect(() => buildGraph({ ...base, workflow: 'ltx23_flf2v' })).toThrow(/lastImage/);
  });
  it('refuses a partner/API node', () => {
    const g: ComfyGraph = { '1': { class_type: 'MinimaxVideoNode', inputs: {} } };
    expect(() => assertOpenWeightGraph(g)).toThrow(/non-allow-listed/);
  });
  it('runGraph: submit -> poll -> job -> view', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      const u = String(url);
      const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => '' });
      if (u.endsWith('/api/prompt')) return json({ prompt_id: 'abc' });
      if (u.includes('/status')) return json({ status: calls.filter((c) => c.includes('/status')).length > 1 ? 'completed' : 'running' });
      if (u.includes('/api/jobs/')) return json({ preview_output: { filename: 'v.mp4', subfolder: 'video', type: 'output' } });
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }) as unknown as typeof fetch;
    const seen: string[] = [];
    const r = await runGraph({ apiKey: 'k', fetchImpl, sleepImpl: async () => undefined }, buildGraph({ ...base, workflow: 'ltx23_i2v' }), async (id) => { seen.push(id); });
    expect(seen).toEqual(['abc']);
    expect(r.bytes.length).toBe(3);
    expect(calls.some((c) => c.includes('filename=v.mp4') && c.includes('subfolder=video'))).toBe(true);
  });
  it('runGraph surfaces a failed job', async () => {
    const fetchImpl = (async (url: string) => {
      const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
      return String(url).endsWith('/api/prompt') ? json({ prompt_id: 'x' }) : json({ status: 'failed', error: 'boom' });
    }) as unknown as typeof fetch;
    await expect(runGraph({ apiKey: 'k', fetchImpl, sleepImpl: async () => undefined }, buildGraph({ ...base, workflow: 'ltx23_i2v' }))).rejects.toThrow(/failed.*boom/);
  });
});

const dframe = (id: string, over: Record<string, unknown> = {}) => ({
  ...frame(id, { shotKind: 'ia2v', narration: undefined }),
  dialogue: { speaker: 'keeper', line: 'The light must never go out.', delivery: 'gravelly, calm' },
  audioMode: 'clip', characters: ['keeper'], soundCues: ['wind', 'waves'], ...over,
});
const voices = [
  { id: 'keeper', description: 'd', voice: { voiceId: 'am_michael', instruct: 'gravel voice' }, referenceImageUrl: REF },
  { id: 'girl', description: 'd2', voice: { voiceId: 'af_bella' }, referenceImageUrl: 'https://r2.example/girl.png' },
];

describe('dialogue validation', () => {
  it('accepts a mixed narration + dialogue project (ia2v and flf_ia2v)', () => {
    const r = validateRequest(req([
      frame('f1'), dframe('f2'),
      dframe('f3', { shotKind: 'flf_ia2v', lastFrameEdit: 'she turns to the sea' }),
    ], { characters: voices }));
    expect(r.req.frames[1].dialogue?.speaker).toBe('keeper');
  });
  it.each([
    ['unknown speaker', [dframe('f1', { dialogue: { speaker: 'ghost', line: 'x' } })], /unknown speaker/],
    ['speaker not in frame characters', [dframe('f1', { characters: ['girl'] })], /not among the frame's characters/],
    ['speaker with no characters list', [dframe('f1', { characters: undefined })], /not among the frame's characters/],
    ['dialogue + narration', [dframe('f1', { narration: 'also narrated' })], /no narration/],
    ['dialogue on i2v', [frame('f1', { dialogue: { speaker: 'keeper', line: 'x' } })], /only valid for ia2v/],
    ['narration shot without narration', [frame('f1', { narration: undefined })], /narration is required/],
    ['flf_ia2v without lastFrameEdit', [dframe('f1', { shotKind: 'flf_ia2v' })], /needs lastFrameEdit/],
    ['ia2v with lastFrameEdit', [dframe('f1', { lastFrameEdit: 'x' })], /only valid for/],
  ])('rejects %s', (_n, frames, msg) => {
    expect(() => validateRequest(req(frames as unknown[], { characters: voices }))).toThrow(msg);
  });
  it('characters need a referenceImageUrl and take no sheetPrompt', () => {
    expect(RequestSchema.safeParse(req([frame('f1')], { characters: [{ id: 'keeper', description: 'd' }] })).success).toBe(false);
    expect(RequestSchema.safeParse(req([frame('f1')], { characters: [{ id: 'keeper', description: 'd', referenceImageUrl: REF, sheetPrompt: 'x' }] })).success).toBe(false);
    expect(RequestSchema.safeParse(req([frame('f1')], { characters: chars })).success).toBe(true);
  });
  it('two speakers need a voice each', () => {
    const novoice = [{ id: 'keeper', description: 'd', referenceImageUrl: REF }, voices[1]];
    const frames = [dframe('f1'), dframe('f2', { characters: ['girl'], dialogue: { speaker: 'girl', line: 'hi' } })];
    expect(() => validateRequest(req(frames, { characters: novoice }))).toThrow(/has no voice/);
    expect(() => validateRequest(req(frames, { characters: voices }))).not.toThrow();
  });
});

describe('dialogue plan + rows', () => {
  const r = RequestSchema.parse(req([frame('f1'), dframe('f2', { shotKind: 'flf_ia2v', lastFrameEdit: 'turns' })], { characters: voices }));
  const p = compilePlan(r);
  it('adds dialogue-audio and comfy-last; never mmaudio (LTX makes its own ambience)', () => {
    expect(p.frameKinds).toEqual(expect.arrayContaining(['dialogue-audio', 'comfy-last', 'comfy-video']));
    expect(p.frameKinds).not.toContain('mmaudio');
    expect(p.requires['dialogue-audio']).toEqual(['tts']);
    expect(p.requires['comfy-video']).toEqual(expect.arrayContaining(['dialogue-audio', 'comfy-last']));
  });
  it('no dialogue => no dialogue-audio', () => {
    const q = compilePlan(RequestSchema.parse(req([frame('f1')])));
    expect(q.frameKinds).not.toContain('dialogue-audio');
  });
  it("tts row speaks the line in the character's voice with delivery", () => {
    const rows = buildAssetRows(r, p);
    const tts = rows.find((x) => x.kind === 'tts' && x.frameId === 'f2')!.input as Record<string, unknown>;
    expect(tts).toMatchObject({ narration: 'The light must never go out.', voiceId: 'am_michael', voiceInstruct: 'gravel voice. gravelly, calm' });
    const n = rows.find((x) => x.kind === 'tts' && x.frameId === 'f1')!.input as Record<string, unknown>;
    expect(n.voiceId).toBeUndefined();
  });
});

describe('dialogue builders', () => {
  it('clip length = lead + speech + 1s, 5..10; refuses a line that cannot fit', () => {
    expect(dialogueClipS(2, 0.4)).toBe(5);
    expect(dialogueClipS(5.2, 0.4)).toBe(7);
    expect(dialogueClipS(5.2, 0.4, 3)).toBe(9);
    expect(dialogueClipS(5.2, 0.4, 6)).toBe(10); // action squeezed at the cap, never the speech
    expect(() => dialogueClipS(9.5, 0.4)).toThrow(/split the line/);
  });
  it('dialogue-audio: pads dialogue, passes narration through', () => {
    const deps = { 2: { url: 'http://t.wav', durationS: 5.2 } };
    expect(buildDialogueAudioInput(ctx({ dialogue: { speaker: 'k', line: 'x', leadS: 0.5 } }, deps))).toMatchObject({ ttsUrl: 'http://t.wav', leadS: 0.5, durationS: 7 });
    expect(buildDialogueAudioInput(ctx({ shotKind: 'i2v' }, deps))).toEqual({ __passthroughUrl: 'http://t.wav' });
  });
  it('comfy-video ia2v / flf_ia2v take the padded audio and its length', () => {
    const base = { 1: { url: 'http://i' }, 2: { url: 'http://t', durationS: 4 }, 18: { url: 'http://pad.wav', durationS: 6 } };
    expect(buildComfyVideoInput(ctx({ shotKind: 'ia2v', motionPrompt: 'm', dialogue: { speaker: 'k', line: 'x' } }, base)))
      .toMatchObject({ workflow: 'ltx23_ia2v', audioUrl: 'http://pad.wav', durationS: 6 });
    expect(buildComfyVideoInput(ctx({ shotKind: 'flf_ia2v', motionPrompt: 'm', dialogue: { speaker: 'k', line: 'x' } }, { ...base, 17: { url: 'http://l' } })))
      .toMatchObject({ workflow: 'ltx23_flf_ia2v', lastImageUrl: 'http://l', durationS: 6 });
    expect(() => buildComfyVideoInput(ctx({ shotKind: 'ia2v', motionPrompt: 'm' }, { 1: { url: 'http://i' } }))).toThrow(/padded dialogue audio/);
  });
});

describe('dialogue graphs', () => {
  const base = { prompt: 'P', negativePrompt: 'NEG', width: 1280, height: 720, fps: 25, durationS: 6, seed: 9, firstImage: 'a.png', audio: 'line.wav' };
  it('patches ia2v', () => {
    const g = buildGraph({ ...base, workflow: 'ltx23_ia2v' });
    expect(g['276'].inputs.audio).toBe('line.wav');
    expect(g['340:331'].inputs.value).toBe(6);
    expect(g['340:319'].inputs.value).toBe('P');
    expect(String(g['340:314'].inputs.text)).toContain('NEG');
    expect(() => buildGraph({ ...base, audio: undefined, workflow: 'ltx23_ia2v' })).toThrow(/needs audio/);
  });
  it('patches flf_ia2v', () => {
    const g = buildGraph({ ...base, workflow: 'ltx23_flf_ia2v', lastImage: 'b.png' });
    expect(g['276'].inputs.audio).toBe('line.wav');
    expect(g['39'].inputs.image).toBe('b.png');
    expect(g['129:200'].inputs.value).toBe(6);
    expect(g['129:102'].inputs.value).toBe(6);
  });
});

describe('dialogue audio pad + manifest', () => {
  it('runs the lead/apad/trim recipe at 48k stereo', async () => {
    let args: string[] = [];
    const fetchImpl = (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) })) as unknown as typeof fetch;
    await expect(padDialogueAudio('http://t.wav', 0.4, 6, fetchImpl, async (a) => { args = a; })).rejects.toThrow(); // no out.wav from the fake runner
    expect(args.join(' ')).toContain('adelay=400|400,apad,atrim=0:6');
    expect(args.join(' ')).toContain('-ar 48000 -ac 2');
  });
  it('manifest uses the padded audio + the spoken line, and the clip carries SFX', () => {
    const r = RequestSchema.parse(req([dframe('f2')], { characters: voices }));
    const plan = compilePlan(r);
    const row = (kind: string, url: string, durationS: number | null = null) =>
      ({ id: 1, projectId: 'p1', seq: 0, frameId: 'f2', kind, status: 'complete', assetUrl: url, durationS, input: {} }) as unknown as AssetRow;
    const m = manifestFrame(plan, { frameId: 'f2', seq: 0, rows: [row('tts', 'http://raw.wav', 3), row('dialogue-audio', 'http://pad.wav', 6), row('comfy-video', 'http://clip.mp4')] }, r);
    expect(m).toMatchObject({ audioUrl: 'http://pad.wav', durationS: 6, videoUrl: 'http://clip.mp4', narration: 'The light must never go out.', sfxFromVideo: true });
  });
});

describe('character references', () => {
  const two = [frame('f1', { characters: ['keeper', 'girl'] }), frame('f2', { characters: ['keeper'] }), frame('f3')];
  const r = RequestSchema.parse(req(two, { characters: voices }));
  const p = compilePlan(r);
  it('plans char-ref -> t2i -> edit, with qwen-edit as the still', () => {
    expect(p.imageKind).toBe('qwen-edit');
    expect(p.requires['char-ref']).toEqual([]);
    expect(p.requires['qwen-image-gen']).toEqual(['char-ref']);
    expect(p.requires['qwen-edit']).toEqual(['qwen-image-gen', 'char-ref']);
    expect(p.requires['comfy-video']).toContain('qwen-edit');
  });
  it('no characters => the old t2i-only plan', () => {
    const q = compilePlan(RequestSchema.parse(req([frame('f1')])));
    expect(q.imageKind).toBe('qwen-image-gen');
    expect(q.frameKinds).not.toContain('char-ref');
  });
  it('rows carry the ordered reference urls', () => {
    const rows = buildAssetRows(r, p);
    const refs = (id: string) => (rows.find((x) => x.kind === 'char-ref' && x.frameId === id)!.input as { characterRefs: string[] }).characterRefs;
    expect(refs('f1')).toEqual([REF, 'https://r2.example/girl.png']);
    expect(refs('f2')).toEqual([REF]);
    expect(refs('f3')).toEqual([]);
  });
  it('char-ref: skip / passthrough / composite', () => {
    const c = (characterRefs: string[]) => buildCharRefInput(ctx({ characterRefs }, {}));
    expect(c([])).toEqual({ __passthroughUrl: 'skip:none' });
    expect(c(['http://a'])).toEqual({ __passthroughUrl: 'http://a' });
    expect(c(['http://a', 'http://b'])).toMatchObject({ refs: ['http://a', 'http://b'] });
  });
  it('t2i skips frames that have characters; edit edits the reference or passes the t2i still', () => {
    expect(buildImageInput(ctx({ characterRefs: ['http://a'] }, {}))).toEqual({ __passthroughUrl: 'skip:char' });
    expect(buildImageInput(ctx({ characterRefs: [] }, {}))).toMatchObject({ model: 'qwen' });
    expect(buildImageEditInput(ctx({ characterRefs: ['http://a'], imagePrompt: 'scene' }, { 19: { url: 'http://comp' } }))).toMatchObject({ image_url: 'http://comp', prompt: 'scene' });
    expect(buildImageEditInput(ctx({ characterRefs: [] }, { 1: { url: 'http://t2i' } }))).toEqual({ __passthroughUrl: 'http://t2i' });
    expect(() => buildImageEditInput(ctx({ characterRefs: ['http://a'] }, {}))).toThrow(/no character reference/);
  });
  it('a skip: url is invisible to downstream builders', () => {
    expect(toResolvedDeps({ 'qwen-image-gen': { url: 'skip:char' }, 'qwen-edit': { url: 'http://still' } })).toEqual({ 0: { url: 'http://still', durationS: undefined } });
  });
  it('composite needs exactly two refs and runs the crop/hstack recipe', async () => {
    await expect(compositeCharacterRefs(['http://a'])).rejects.toThrow(/exactly 2/);
    let args: string[] = [];
    const f = (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(2) })) as unknown as typeof fetch;
    await expect(compositeCharacterRefs(['http://a', 'http://b'], f, async (a) => { args = a; })).rejects.toThrow();
    expect(args.join(' ')).toContain('hstack=inputs=2,pad=1664:928');
  });
});

describe('action frames (sfx-only) + dialogue-basic tier', () => {
  const aframe = (id: string, over: Record<string, unknown> = {}) => ({
    ...frame(id, { shotKind: 'flf', narration: undefined }),
    audioMode: 'sfx-only', actionS: 7, durationS: 7, lastFrameEdit: 'the dragon lands', lastFramePrompt: 'full last frame', shotType: 'primary', characters: ['keeper'], ...over,
  });
  const r = RequestSchema.parse({ ...req([frame('f1'), aframe('f2')], { characters: chars }), tier: 'dialogue-basic', product: 'dialogue', options: { motionEngine: 'ltx', sfx: true, voiceEngine: 'qwen', promptHarness: 'off' } });
  it('dialogue-basic tier + motionEngine ltx validates; sfx:true never plans MMAudio', () => {
    expect(() => validateRequest(r)).not.toThrow();
    const p = compilePlan(r);
    expect(p.motionKind).toBe('comfy-video');
    expect(p.frameKinds).not.toContain('mmaudio');
  });
  it.each([
    ['narration on an action frame', aframe('f1', { narration: 'x' }), /no narration/],
    ['dialogue on an action frame', aframe('f1', { dialogue: { speaker: 'keeper', line: 'x' } }), /no dialogue/],
    ['non-flf action frame', aframe('f1', { shotKind: 'i2v', lastFrameEdit: undefined }), /always shotKind 'flf'/],
    ['no actionS', aframe('f1', { actionS: undefined }), /needs actionS/],
    ['no lastFrameEdit', aframe('f1', { lastFrameEdit: undefined }), /needs lastFrameEdit/],
  ])('rejects %s', (_n, f, msg) => {
    expect(() => validateRequest(req([f], { characters: chars }))).toThrow(msg);
  });
  it('tts + dialogue-audio skip an action frame; duration = actionS', async () => {
    const { buildTtsInput } = await import('../src/steps/builders/tts');
    const j = { audioMode: 'sfx-only', actionS: 7, shotKind: 'flf', motionPrompt: 'm', lastFrameEdit: 'e' };
    expect(buildTtsInput(ctx(j, {}))).toEqual({ __passthroughUrl: 'skip:none' });
    expect(buildDialogueAudioInput(ctx(j, {}))).toEqual({ __passthroughUrl: 'skip:none' });
    expect(buildComfyVideoInput(ctx(j, { 1: { url: 'http://i' }, 17: { url: 'http://l' } }))).toMatchObject({ workflow: 'ltx23_flf2v', durationS: 7 });
  });
  it('manifest: action frame has no audioUrl and is clipAudioOnly', () => {
    const plan = compilePlan(r);
    const row = (kind: string, url: string) => ({ id: 1, projectId: 'p1', seq: 1, frameId: 'f2', kind, status: 'complete', assetUrl: url, durationS: null, input: {} }) as unknown as AssetRow;
    const m = manifestFrame(plan, { frameId: 'f2', seq: 1, rows: [row('tts', 'skip:none'), row('comfy-video', 'http://clip.mp4')] }, r);
    expect(m).toMatchObject({ clipAudioOnly: true, videoUrl: 'http://clip.mp4', durationS: 7, narration: '' });
    expect(m.audioUrl).toBeUndefined();
  });
  it('carries lastFramePrompt / shotType / actionS onto the rows', () => {
    const rows = buildAssetRows(r, compilePlan(r));
    expect(rows.find((x) => x.kind === 'comfy-video' && x.frameId === 'f2')!.input).toMatchObject({ lastFramePrompt: 'full last frame', shotType: 'primary', actionS: 7 });
  });
});
