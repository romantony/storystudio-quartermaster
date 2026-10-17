/** Stills and clips at exactly the project's frame size (2026-10-17). */
import { conformClip, conformFilter, conformStill, stillSize } from '../src/assets/conform-media';

const fetchOk = (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) })) as unknown as typeof fetch;

describe('conform still', () => {
  it('sizes by project aspect; other aspects are left alone', () => {
    expect(stillSize('16:9')).toEqual([1280, 720]);
    expect(stillSize('9 : 16')).toEqual([720, 1280]);
    expect(stillSize('1:1')).toBeNull();
    expect(stillSize(undefined)).toBeNull();
  });
  it('covers then centre-crops — never pads (no bars into the video)', () => {
    expect(conformFilter(1280, 720)).toBe('scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1');
  });
  it('re-encodes a qwen-sized still (1376x768) to 1280x720', async () => {
    let args: string[] = [];
    const out = await conformStill('https://cdn/s.png', [1280, 720], {
      fetchImpl: fetchOk, probe: async () => '1376,768\n',
      ffmpeg: async (a) => { args = a; await require('node:fs/promises').writeFile(a[a.length - 1], 'png'); },
    });
    expect(out?.toString()).toBe('png');
    expect(args.join(' ')).toContain(conformFilter(1280, 720));
  });
  it('returns null (no re-upload) when the still is already the size', async () => {
    const ffmpeg = jest.fn();
    expect(await conformStill('https://cdn/s.png', [720, 1280], { fetchImpl: fetchOk, probe: async () => '720,1280', ffmpeg })).toBeNull();
    expect(ffmpeg).not.toHaveBeenCalled();
  });
  it('throws on a still it cannot fetch', async () => {
    const f = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(conformStill('https://cdn/gone.png', [1280, 720], { fetchImpl: f })).rejects.toThrow(/HTTP 404/);
  });
  it('re-encodes an LTX 1280x704 clip to 1280x720, copying its audio', async () => {
    let args: string[] = [];
    const out = await conformClip(Buffer.from('mp4'), [1280, 720], {
      probe: async () => '1280,704',
      ffmpeg: async (a) => { args = a; await require('node:fs/promises').writeFile(a[a.length - 1], 'conformed'); },
    });
    expect(out?.toString()).toBe('conformed');
    const s = args.join(' ');
    expect(s).toContain(`-vf ${conformFilter(1280, 720)},format=yuv420p`);
    expect(s).toContain('-map 0:a? -vf');
    expect(s).toContain('-c:a copy');
  });
  it('leaves a clip that is already the size untouched', async () => {
    const ffmpeg = jest.fn();
    expect(await conformClip(Buffer.from('mp4'), [720, 1280], { probe: async () => '720,1280', ffmpeg })).toBeNull();
    expect(ffmpeg).not.toHaveBeenCalled();
  });
});
