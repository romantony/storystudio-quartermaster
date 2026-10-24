/** Tail-only requests (`motionEngine: 'ready'`, 2026-10-24): the caller generated every clip, the orchestrator only assembles. */
import { RequestSchema, validateRequest, PlanValidationError } from '../src/agents/planner';
import { compilePlan, expectedAssetCount } from '../src/assets/plan';
import { buildAssetRows } from '../src/assets/submit';
import { classifyProjectAssets, manifestFrame } from '../src/assets/compiler';
import { buildAssetResult } from '../src/assets/result';

const frame = (id: string, over: Record<string, unknown> = {}) => ({
  frameId: id, imagePrompt: 'two people on a night train', durationS: 8, audioMode: 'sfx-only', spoken: true,
  clipUrl: `https://r2.example/clips/${id}.mp4`, ...over,
});
const req = (frames: unknown[], opts: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  requestId: 'r1', projectId: 'p1', source: 'mcp', tier: 'dialogue-premium', product: 'dialogue', language: 'en',
  aspectRatio: '16:9', resolution: '1920x1080', callbackUrl: 'https://x.example/cb', bgmPrompt: 'soft piano',
  options: { motionEngine: 'ready', promptHarness: 'off', bgm: true, burnCaptions: true, ...opts }, frames, ...extra,
});
const two = [frame('f1'), frame('f2', { spoken: false })];

describe('ready request validation', () => {
  it('accepts finished clips', () => {
    expect(validateRequest(req(two)).req.options.motionEngine).toBe('ready');
  });
  it.each([
    ['no clipUrl', [frame('f1', { clipUrl: undefined }), frame('f2')], {}, /clipUrl is required/],
    ['one frame', [frame('f1')], {}, /at least two frames/],
    ['audioMode clip', [frame('f1', { audioMode: 'clip' }), frame('f2')], {}, /sfx-only/],
    ['narration without audioUrl', [frame('f1', { audioMode: 'sfx-under-narration', spoken: false }), frame('f2')], {}, /needs audioUrl/],
    ['audioUrl on a clip-audio frame', [frame('f1', { audioUrl: 'https://r2.example/v.wav', spoken: false }), frame('f2')], {}, /only for audioMode 'sfx-under-narration'/],
    ['narrated frame marked spoken', [frame('f1', { audioMode: 'sfx-under-narration', audioUrl: 'https://r2.example/v.wav' }), frame('f2')], {}, /voiced by audioUrl/],
    ['dialogue field', [frame('f1', { dialogue: { speaker: 'a', line: 'hi' } }), frame('f2')], {}, /no dialogue field/],
    ['removeSilence', two, { removeSilence: true }, /removeSilence/],
    ['sfx', two, { sfx: true }, /sfx/],
    ['textOverlay', two, { textOverlay: true }, /textOverlay/],
  ])('rejects %s', (_n, frames, opts, msg) => {
    expect(() => validateRequest(req(frames, opts as Record<string, unknown>))).toThrow(msg);
    expect(() => validateRequest(req(frames, opts as Record<string, unknown>))).toThrow(PlanValidationError);
  });
  it('clipUrl is rejected on any other engine', () => {
    expect(() => validateRequest(req(two, { motionEngine: 'wan2' }))).toThrow(/only accepted with motionEngine 'ready'/);
  });
  it('audioUrl is rejected on any other engine', () => {
    const narrated = [frame('f1', { clipUrl: undefined, audioUrl: 'https://r2.example/v.wav', audioMode: 'sfx-under-narration', spoken: false }), frame('f2', { clipUrl: undefined })];
    expect(() => validateRequest(req(narrated, { motionEngine: 'wan2' }))).toThrow(/audioUrl is only accepted/);
  });
  it('accepts a narrated clip alongside spoken and silent ones', () => {
    const mixed = [frame('f1'), frame('f2', { audioMode: 'sfx-under-narration', audioUrl: 'https://r2.example/v.wav', spoken: false, narration: 'It began in winter.' }), frame('f3', { spoken: false })];
    expect(validateRequest(req(mixed)).req.frames).toHaveLength(3);
  });
});

describe('ready plan', () => {
  const r = RequestSchema.parse(req(two));
  const p = compilePlan(r);
  it('has the tail and nothing else, QA-exempt', () => {
    expect(p.kinds).toEqual(['sfn-tail']);
    expect(p.frameKinds).toEqual([]);
    expect(p.motionKind).toBeNull();
    expect(p.qaExempt).toBe(true);
    expect(p.tail).toMatchObject({ burnCaptions: true, bgm: true, removeSilence: false });
    expect(expectedAssetCount(p)).toBe(1);
  });
  it('writes one blocked project row and no frame rows', () => {
    const rows = buildAssetRows(r, p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'sfn-tail', frameId: '*', initialStatus: 'blocked' });
  });
  it('every frame is ready on the first tick', () => {
    const s = classifyProjectAssets(p, two.map((f, seq) => ({ frameId: f.frameId, seq })), [], Date.now(), () => 1);
    expect(s.generated).toBe(true);
    expect(s.readyFrames.map((f) => f.frameId)).toEqual(['f1', 'f2']);
    expect(s.droppedFrames).toEqual([]);
  });
  it('manifest frames are the caller clips, clip audio only, speech flagged', () => {
    const f1 = manifestFrame(p, { frameId: 'f1', seq: 0, rows: [] }, r);
    expect(f1).toMatchObject({ frameId: 'f1', videoUrl: 'https://r2.example/clips/f1.mp4', clipAudioOnly: true, clipAudioSpoken: true, durationS: 8 });
    expect(f1.audioUrl).toBeUndefined();
    const f2 = manifestFrame(p, { frameId: 'f2', seq: 1, rows: [] }, r);
    expect(f2.clipAudioOnly).toBe(true);
    expect(f2.clipAudioSpoken).toBeUndefined();
  });
  it('a narrated frame carries the narrator track over the clip, its own sound under the voice', () => {
    const r2 = RequestSchema.parse(req([frame('f1'), frame('f2', { audioMode: 'sfx-under-narration', audioUrl: 'https://r2.example/v.wav', spoken: false, narration: 'It began in winter.' })]));
    const n = manifestFrame(compilePlan(r2), { frameId: 'f2', seq: 1, rows: [] }, r2);
    expect(n).toMatchObject({ videoUrl: 'https://r2.example/clips/f2.mp4', audioUrl: 'https://r2.example/v.wav', sfxFromVideo: true, narration: 'It began in winter.' });
    expect(n.clipAudioOnly).toBeUndefined();
    expect(n.clipAudioSpoken).toBeUndefined();
  });
  it('the result reports each frame completed with its clip', () => {
    const res = buildAssetResult({
      project: { id: 'p1', requestId: 'r1', createdAt: new Date(), request: r }, plan: p, rows: [], status: 'completed',
      finalUrl: 'https://x/final.mp4', finalDurationS: 16, gpuCostUsd: 0, startedAt: new Date(),
    });
    expect(res.assets.frames.map((f) => [f.frameId, f.status, f.clipUrl])).toEqual([
      ['f1', 'completed', 'https://r2.example/clips/f1.mp4'],
      ['f2', 'completed', 'https://r2.example/clips/f2.mp4'],
    ]);
  });
});
