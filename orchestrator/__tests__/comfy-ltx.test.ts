/** LTX-2.3 / Comfy contract (2026-10-04): schema + validation, plan, builders, graph, client. */
import { RequestSchema, validateRequest, PlanValidationError } from '../src/agents/planner';
import { compilePlan } from '../src/assets/plan';
import { buildAssetRows } from '../src/assets/submit';
import { buildComfyVideoInput, ltxDurationS } from '../src/steps/builders/comfy-video';
import { buildComfyLastInput } from '../src/steps/builders/comfy-last';
import { ASSET_SPECS } from '../src/assets/kinds';
import { assertOpenWeightGraph, buildGraph, runGraph, type ComfyGraph } from '../src/comfy/client';
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
const chars = [{ id: 'keeper', sheetPrompt: 'grey sheet', description: 'an old keeper' }];

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
    ['dialogue kind', [frame('f1', { shotKind: 'ia2v' })], /not supported yet/],
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
    expect(ltxDurationS(2.1, 6)).toBe(5);
    expect(ltxDurationS(6.2, 4)).toBe(8);
    expect(ltxDurationS(12, 4)).toBe(10);
    expect(ltxDurationS(undefined, 7)).toBe(7);
  });
  it('i2v payload', () => {
    const p = buildComfyVideoInput(ctx({ shotKind: 'i2v', motionPrompt: 'm', negativePrompt: 'n' }, { 1: { url: 'http://i' }, 2: { url: 'http://a', durationS: 6.2 } }));
    expect(p).toMatchObject({ workflow: 'ltx23_i2v', firstImageUrl: 'http://i', durationS: 8, portrait: true, negativePrompt: 'n' });
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
