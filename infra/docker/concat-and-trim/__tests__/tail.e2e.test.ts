/**
 * End-to-end test of the orchestrator tail's two ECS modes — REAL ffmpeg on
 * synthetic media, a local HTTP server standing in for R2 (the manifest and
 * every clip are fetched by public URL, exactly as in production), and S3
 * replaced by an in-memory map so nothing leaves the machine.
 *
 * What this proves that the string-builder unit tests cannot: that the filter
 * graphs actually run (zoompan, amix with apad, ass + fontsdir, stream_loop),
 * that a Ken Burns still, an SFX-carrying clip and a plain clip all concat into
 * one video, that silence removal and the A/V parity gate hold on the result,
 * and that finalize really upscales to 1080p and really burns captions.
 *
 * Skipped when ffmpeg is not installed.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

const store = new Map<string, Buffer>();

jest.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand {
    constructor(public input: { Key: string; Body: Buffer }) {}
  }
  class GetObjectCommand {
    constructor(public input: { Key: string }) {}
  }
  class S3Client {
    async send(cmd: { input: { Key: string; Body: Buffer } }): Promise<Record<string, never>> {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const s = (global as unknown as { __tailStore: Map<string, Buffer> }).__tailStore;
      if (cmd instanceof PutObjectCommand) s.set(cmd.input.Key, Buffer.from(cmd.input.Body));
      return {};
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand };
});
(global as unknown as { __tailStore: Map<string, Buffer> }).__tailStore = store;

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;
const maybeDescribe = HAVE_FFMPEG ? describe : describe.skip;

function ff(...args: string[]): void {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${r.stderr?.toString()}`);
}

function probe(file: string, entries: string, stream?: string): string {
  const r = spawnSync('ffprobe', ['-v', 'error', ...(stream ? ['-select_streams', stream] : []), '-show_entries', entries, '-of', 'default=noprint_wrappers=1:nokey=1', file]);
  return r.stdout.toString().trim();
}

function fontsDir(): string {
  const r = spawnSync('fc-list', [':family=Montserrat', 'file']);
  const first = r.stdout?.toString().split('\n')[0] ?? '';
  const file = first.split(':')[0];
  return file ? path.dirname(file) : '/usr/share/fonts';
}

maybeDescribe('orchestrator tail (real ffmpeg)', () => {
  jest.setTimeout(300_000);

  let root: string;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-e2e-'));
    const f = (n: string) => path.join(root, n);

    // Two silent Wan2-sized clips, one clip carrying an SFX track, one still.
    ff('-f', 'lavfi', '-i', 'color=c=blue:s=832x464:r=16:d=3', '-pix_fmt', 'yuv420p', f('a.mp4'));
    ff('-f', 'lavfi', '-i', 'color=c=red:s=832x464:r=16:d=3', '-pix_fmt', 'yuv420p', f('b.mp4'));
    ff('-f', 'lavfi', '-i', 'color=c=green:s=832x464:r=16:d=3', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=3', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('sfx.mp4'));
    ff('-f', 'lavfi', '-i', 'color=c=yellow:s=640x360', '-frames:v', '1', f('still.png'));

    // 3s of narration: tone, a 1s hole, tone — the hole is what silence removal cuts.
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-filter_complex', '[0:a]aresample=24000[a];[1:a]atrim=duration=1[s];[2:a]aresample=24000[b];[a][s][b]concat=n=3:v=0:a=1[o]', '-map', '[o]', f('narr.wav'));
    ff('-f', 'lavfi', '-i', 'sine=frequency=220:duration=5', f('bgm.mp3'));

    fs.writeFileSync(f('captions.srt'), '1\n00:00:00,000 --> 00:00:01,500\nMaya had always\n\n2\n00:00:01,500 --> 00:00:03,000\nbeen the quiet\n\n');

    fs.writeFileSync(f('manifest.json'), JSON.stringify({
      version: 3, projectId: 'e2e', requestId: 'r', compiledAt: new Date().toISOString(), fps: 16,
      project: { tier: 't', product: 'p', language: 'en', aspectRatio: '9:16', resolution: '1080x1920', frameCount: 3 },
      chain: { image: 'qwen-image-gen', motion: 'wan2-i2v', overlay: false },
      frames: [
        { frameId: 'f1', seq: 0, videoUrl: 'URL/a.mp4', audioUrl: 'URL/narr.wav', durationS: 3, narration: 'one' },
        { frameId: 'f2', seq: 1, videoUrl: 'URL/sfx.mp4', audioUrl: 'URL/narr.wav', durationS: 3, narration: 'two', sfxFromVideo: true },
        { frameId: 'f3', seq: 2, imageUrl: 'URL/still.png', audioUrl: 'URL/narr.wav', durationS: 3, narration: 'three', animate: { effect: 'zoom_in', fps: 16 } },
        { frameId: 'f4', seq: 3, videoUrl: 'URL/b.mp4', audioUrl: 'URL/narr.wav', durationS: 3, narration: 'four' },
      ],
      droppedFrames: [{ frameId: 'f5', reason: 'wan2-i2v: failed' }],
      steps: { removeSilence: true, burnCaptions: true },
      bgm: { prompt: 'soft piano', volume: 0.15 },
      options: {},
    }));

    server = http.createServer((req, res) => {
      // One request per connection: the client's default agent keeps sockets
      // alive and a reused socket the server has just closed is an ECONNRESET.
      res.setHeader('Connection', 'close');
      const file = path.join(root, path.basename((req.url ?? '').split('?')[0]));
      if (!fs.existsSync(file)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Point the manifest's URL placeholders at the local server.
    const m = fs.readFileSync(f('manifest.json'), 'utf8').replace(/URL\//g, `${base}/`);
    fs.writeFileSync(f('manifest.json'), m);

    process.env.OUTPUT_BUCKET = 'test-bucket';
    process.env.FONTS_DIR = fontsDir();
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  function load() {
    let mod!: typeof import('../tail');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require('../tail');
    });
    return mod;
  }

  /** Write a stored S3 object to a real file so ffprobe can read it. */
  function materialise(key: string): string {
    const buf = store.get(key);
    if (!buf) throw new Error(`nothing was uploaded to ${key}; have: ${[...store.keys()].join(', ')}`);
    const out = path.join(root, `m-${key.replace(/\//g, '_')}`);
    fs.writeFileSync(out, buf);
    return out;
  }

  it('assembles four frames (plain, SFX, Ken Burns still, plain) into one gated video', async () => {
    process.env.PAYLOAD_JSON = JSON.stringify({ manifestUrl: `${base}/manifest.json`, aspectRatio: '9:16', outputPrefix: 'projects/e2e/tail/', removeSilence: true });
    await load().assemble();

    // Every frame's clip is hosted, plus the three project artifacts.
    for (const k of ['frames/f1.mp4', 'frames/f2.mp4', 'frames/f3.mp4', 'frames/f4.mp4', 'video.mp4', 'audio.wav', 'meta.json']) {
      expect(store.has(`projects/e2e/tail/${k}`)).toBe(true);
    }

    const meta = JSON.parse(store.get('projects/e2e/tail/meta.json')!.toString());
    expect(meta.frames.map((x: { frameId: string }) => x.frameId)).toEqual(['f1', 'f2', 'f3', 'f4']);
    expect(meta.videoUrl).toBe('https://test-bucket.s3.us-east-1.amazonaws.com/projects/e2e/tail/video.mp4');
    // Dropped upstream is carried through, not lost.
    expect(meta.droppedFrames).toEqual([{ frameId: 'f5', reason: 'wan2-i2v: failed' }]);
    // 4 frames x 3s of narration, each with a 1s hole removed -> clearly shorter than 12s.
    expect(meta.durationSec).toBeGreaterThan(5);
    expect(meta.durationSec).toBeLessThan(12);

    const video = materialise('projects/e2e/tail/video.mp4');
    expect(`${meta.width}x${meta.height}`).toBe('1008x1792'); // the 9:16 table size, as the legacy concat
    expect(probe(video, 'stream=codec_type', 'a:0')).toBe('audio'); // narration survived
    const v = Number(probe(video, 'stream=duration', 'v:0'));
    const a = Number(probe(video, 'stream=duration', 'a:0'));
    expect(Math.abs(v - a)).toBeLessThan(1.0);

    // A merged frame has video AND audio; the Ken Burns frame was built from a still.
    const f3 = materialise('projects/e2e/tail/frames/f3.mp4');
    expect(Number(probe(f3, 'format=duration'))).toBeGreaterThanOrEqual(2.9);
    expect(probe(f3, 'stream=codec_type', 'a:0')).toBe('audio');
    // The Ken Burns clip is the still's size (even), not the clips'.
    expect(probe(f3, 'stream=width,height', 'v:0').split('\n').join('x')).toBe('640x360');
  });

  it('refuses to assemble fewer than two surviving frames', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    m.frames = [m.frames[0]];
    fs.writeFileSync(path.join(root, 'one.json'), JSON.stringify(m));
    process.env.PAYLOAD_JSON = JSON.stringify({ manifestUrl: `${base}/one.json`, aspectRatio: '9:16', outputPrefix: 'projects/one/tail/', removeSilence: false });
    await expect(load().assemble()).rejects.toThrow(/fewer than two frames survived/);
  });

  it('drops a frame that cannot be built and still assembles the rest', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    m.frames[1].videoUrl = `${base}/does-not-exist.mp4`;
    fs.writeFileSync(path.join(root, 'broken.json'), JSON.stringify(m));
    process.env.PAYLOAD_JSON = JSON.stringify({ manifestUrl: `${base}/broken.json`, aspectRatio: '9:16', outputPrefix: 'projects/broken/tail/', removeSilence: false });
    await load().assemble();
    const meta = JSON.parse(store.get('projects/broken/tail/meta.json')!.toString());
    expect(meta.frames.map((x: { frameId: string }) => x.frameId)).toEqual(['f1', 'f3', 'f4']);
    expect(meta.droppedFrames.map((x: { frameId: string }) => x.frameId)).toEqual(['f5', 'f2']);
  });

  it('finalizes: 1080x1920, narration + looped BGM, and captions that are really burned in', async () => {
    // Serve the assembled video back over HTTP, as the state machine hands it on.
    fs.copyFileSync(materialise('projects/e2e/tail/video.mp4'), path.join(root, 'assembled.mp4'));
    const common = { manifestUrl: `${base}/manifest.json`, videoUrl: `${base}/assembled.mp4`, bgmUrl: `${base}/bgm.mp3`, aspectRatio: '9:16', targetResolution: '1080p' };

    process.env.PAYLOAD_JSON = JSON.stringify({ ...common, srtUrl: `${base}/captions.srt`, outputKey: 'projects/e2e/tail/final.mp4', resultKey: 'projects/e2e/tail/result.json' });
    await load().finalize();
    process.env.PAYLOAD_JSON = JSON.stringify({ ...common, outputKey: 'projects/e2e/tail/final-nocap.mp4', resultKey: 'projects/e2e/tail/result-nocap.json' });
    await load().finalize();

    const result = JSON.parse(store.get('projects/e2e/tail/result.json')!.toString());
    expect(result).toMatchObject({ width: 1080, height: 1920, captions: true, bgm: true });
    expect(result.videoUrl).toBe('https://test-bucket.s3.us-east-1.amazonaws.com/projects/e2e/tail/final.mp4');
    expect(JSON.parse(store.get('projects/e2e/tail/result-nocap.json')!.toString())).toMatchObject({ captions: false, bgm: true });

    const withCaps = materialise('projects/e2e/tail/final.mp4');
    const without = materialise('projects/e2e/tail/final-nocap.mp4');
    expect(probe(withCaps, 'stream=width,height', 'v:0').split('\n').join('x')).toBe('1080x1920');
    expect(probe(withCaps, 'stream=codec_type', 'a:0')).toBe('audio');

    // Captions are burned if a frame inside a cue differs from the same frame without them.
    const still = (src: string, out: string) => ff('-ss', '0.7', '-i', src, '-frames:v', '1', out);
    still(withCaps, path.join(root, 'cap.png'));
    still(without, path.join(root, 'nocap.png'));
    expect(fs.readFileSync(path.join(root, 'cap.png')).equals(fs.readFileSync(path.join(root, 'nocap.png')))).toBe(false);
  });

  it('degrades to a video without captions or BGM when those files cannot be fetched', async () => {
    process.env.PAYLOAD_JSON = JSON.stringify({
      manifestUrl: `${base}/manifest.json`, videoUrl: `${base}/assembled.mp4`, srtUrl: `${base}/missing.srt`, bgmUrl: `${base}/missing.mp3`,
      aspectRatio: '9:16', targetResolution: '1080p', outputKey: 'projects/e2e/tail/degraded.mp4', resultKey: 'projects/e2e/tail/degraded.json',
    });
    await load().finalize();
    expect(JSON.parse(store.get('projects/e2e/tail/degraded.json')!.toString())).toMatchObject({ captions: false, bgm: false, width: 1080 });
  });

  it('fails when the assembled video cannot be downloaded at all', async () => {
    process.env.PAYLOAD_JSON = JSON.stringify({
      manifestUrl: `${base}/manifest.json`, videoUrl: `${base}/nope.mp4`, aspectRatio: '9:16', targetResolution: '1080p',
      outputKey: 'projects/e2e/tail/x.mp4', resultKey: 'projects/e2e/tail/x.json',
    });
    await expect(load().finalize()).rejects.toThrow(/HTTP 404/);
  });
});
