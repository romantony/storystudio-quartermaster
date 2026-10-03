/**
 * QM-animate against the real local ffmpeg/ffprobe — the same binaries the
 * tail's e2e test uses. No AWS: `renderKenBurns` is the whole render path; the
 * handler only adds the download and the S3 upload around it.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clipDurationS, EFFECTS, renderKenBurns, validate } from '../handler';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animate-test-'));
const still = path.join(dir, 'still.png');

beforeAll(() => {
  // A portrait still at an odd height, so evenDims has something to do.
  const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=384x673', '-frames:v', '1', still]);
  if (r.status !== 0) throw new Error(`could not make the test still: ${r.stderr}`);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('clipDurationS', () => {
  it('always covers the narration, even when it is not a whole number of frames', () => {
    for (const n of [3.06, 3.92, 4.3, 4.53, 5]) {
      const frames = Math.trunc(clipDurationS(n, 16) * 16); // what kenBurnsArgs renders
      expect(frames / 16).toBeGreaterThanOrEqual(n);
    }
  });
});

describe('renderKenBurns (real ffmpeg)', () => {
  it.each(EFFECTS)('%s renders a clip no shorter than the narration, at the still\'s even size', (effect) => {
    const out = path.join(dir, `${effect}.mp4`);
    const r = renderKenBurns(still, out, effect, 1.53, 16);
    expect(r.width).toBe(384);
    expect(r.height).toBe(672);
    expect(r.durationS).toBeGreaterThanOrEqual(1.53);
    expect(r.durationS).toBeLessThan(1.53 + 0.2);
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
  });

  it('actually moves: the first and last frames differ', () => {
    const out = path.join(dir, 'move.mp4');
    renderKenBurns(still, out, 'zoom_in', 1.5, 16);
    const frame = (sel: string, file: string) =>
      spawnSync('ffmpeg', ['-v', 'error', '-y', ...sel.split(' '), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', file]);
    const a = path.join(dir, 'a.raw');
    const b = path.join(dir, 'b.raw');
    frame('-ss 0', a);
    frame('-sseof -0.1', b);
    expect(Buffer.compare(fs.readFileSync(a), fs.readFileSync(b))).not.toBe(0);
  });
});

describe('validate', () => {
  const ok = { imageUrl: 'https://cdn/x.png', durationS: 4, projectId: 'p', frameId: 'f' };
  it('accepts a well-formed event', () => expect(() => validate(ok)).not.toThrow());
  it('rejects a missing or non-positive duration', () => {
    expect(() => validate({ ...ok, durationS: 0 })).toThrow(/durationS/);
    expect(() => validate({ ...ok, durationS: undefined })).toThrow(/durationS/);
  });
  it('rejects an unknown effect and a non-http image', () => {
    expect(() => validate({ ...ok, effect: 'spin' })).toThrow(/effect/);
    expect(() => validate({ ...ok, imageUrl: 'file:///etc/passwd' })).toThrow(/imageUrl/);
  });
});
