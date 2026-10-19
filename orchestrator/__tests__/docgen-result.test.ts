/**
 * The result StoryStudio receives (src/docgen/result.ts).
 */
import { buildDocgenResult } from '../src/docgen/result';
import type { DocgenJobRow } from '../src/db/repo/docgen';

const CDN = 'https://cdn-v2.ai-storystudio.com/docgen/r1';
const out = (kind: string, path: string, url: string | undefined = `${CDN}/${path}`, bytes = 100) => ({ kind, path, bytes, ...(url ? { url } : {}) });
const FULL = [
  out('long_video', 'out/a.mp4', undefined, 9),
  out('short', 'shorts/a_spark/out/a_spark.mp4'),
  out('short', 'shorts/b_myth/out/b_myth.mp4'),
  out('short_thumbnail', 'shorts/a_spark/thumb/thumbnail.jpg'),
  out('thumbnail', 'thumb/thumbnail.jpg'),
  out('metadata', 'out/youtube_metadata.md'),
  out('shorts_metadata', 'out/shorts_metadata.md'),
  out('credits', 'out/credits.md'),
].map((o) => (o.kind === 'long_video' ? { ...o, url: `${CDN}/out/a.mp4`, bytes: 184220331 } : o));

function row(over: Partial<DocgenJobRow> = {}): DocgenJobRow {
  return {
    requestId: 'r1', docgenRequestId: 'r1', jobId: 'dg_1', projectId: 'p1', callbackUrl: 'https://cb', state: 'succeeded',
    stage: 'done', seq: 9, progress: 1, message: null, request: {}, status: { warnings: ['No audio has been listened to'], costs: { ltx_clips: 10 } } as never,
    outputs: FULL, error: null, attempts: 1, queuedAt: new Date('2026-10-12T09:00:00Z'), startedAt: new Date('2026-10-12T09:10:00Z'),
    finishedAt: new Date('2026-10-12T10:00:00Z'), lastHeartbeatAt: null, instanceStartedAt: null, lastPolledAt: null,
    updatedAt: new Date(), result: null, callbackStatus: null, ...over,
  };
}

describe('buildDocgenResult', () => {
  it('completed: the final video sits where the per-frame result puts it, with every other output alongside', () => {
    const r = buildDocgenResult(row());
    expect(r).toMatchObject({ requestId: 'r1', projectId: 'p1', kind: 'documentary', status: 'completed' });
    expect(r.assets.final).toEqual({ url: `${CDN}/out/a.mp4`, bytes: 184220331, durationS: null, resolution: null });
    expect(r.assets.frames).toEqual([]);
    expect(r.assets.shorts.map((s) => s.id)).toEqual(['a_spark', 'b_myth']);
    // each Short carries its own thumbnail when doc-gen made one
    expect(r.assets.shorts.map((s) => s.thumbnail)).toEqual([{ url: `${CDN}/shorts/a_spark/thumb/thumbnail.jpg` }, null]);
    expect(r.assets.thumbnail).toEqual({ url: `${CDN}/thumb/thumbnail.jpg` });
    expect(r.assets.metadata?.url).toMatch(/youtube_metadata\.md$/);
    expect(r.assets.shortsMetadata?.url).toMatch(/shorts_metadata\.md$/);
    expect(r.assets.credits?.url).toMatch(/credits\.md$/);
    expect(r.errors).toEqual([]);
  });

  it('carries the instance warnings and costs through, and measures queue and run time', () => {
    const r = buildDocgenResult(row());
    expect(r.warnings).toEqual(['No audio has been listened to']);
    expect(r.costs).toEqual({ ltx_clips: 10 });
    expect(r.metrics).toEqual({ queuedMs: 10 * 60_000, runMs: 50 * 60_000, attempts: 1 });
    expect(r.createdAt).toBe('2026-10-12T09:00:00.000Z');
    expect(r.finishedAt).toBe('2026-10-12T10:00:00.000Z');
  });

  it('partial: the long video is there but another output failed to upload — said in warnings, not hidden', () => {
    const outputs = FULL.map((o) => (o.kind === 'thumbnail' ? { kind: o.kind, path: o.path, bytes: o.bytes } : o));
    const r = buildDocgenResult(row({ outputs }));
    expect(r.status).toBe('partial');
    expect(r.assets.thumbnail).toBeNull();
    expect(r.assets.final).not.toBeNull();
    expect(r.warnings).toContain('Output not uploaded: thumbnail (thumb/thumbnail.jpg)');
  });

  it('failed: no usable long video, even when the instance says succeeded', () => {
    const noVideo = buildDocgenResult(row({ outputs: FULL.filter((o) => o.kind !== 'long_video') }));
    expect(noVideo.status).toBe('failed');
    expect(noVideo.assets.final).toBeNull();
    expect(noVideo.warnings.join()).toMatch(/no long video/);
    const noUrl = buildDocgenResult(row({ outputs: [{ kind: 'long_video', path: 'out/a.mp4', bytes: 1 }] }));
    expect(noUrl.status).toBe('failed');
  });

  it('failed job: errors[] uses the envelope StoryStudio already reads (step, reason) plus the code', () => {
    const r = buildDocgenResult(row({
      state: 'failed', outputs: null,
      error: { code: 'timeout', stage: 'build_long', message: 'max_runtime_minutes exceeded', retryable: true },
    }));
    expect(r.status).toBe('failed');
    expect(r.errors).toEqual([{ frameId: null, step: 'build_long', agent: 'docgen', reason: 'max_runtime_minutes exceeded', code: 'timeout', retryable: true }]);
  });

  it('cancelled is reported as a failure with a clear reason', () => {
    const r = buildDocgenResult(row({ state: 'cancelled', outputs: null, error: null }));
    expect(r.status).toBe('failed');
    expect(r.errors[0]).toMatchObject({ reason: 'cancelled', code: 'cancelled' });
  });

  it('a job that never started has null run metrics rather than a negative number', () => {
    const r = buildDocgenResult(row({ state: 'failed', startedAt: null, outputs: null, error: { code: 'invalid_request', message: 'x' } as never }));
    expect(r.metrics.queuedMs).toBeNull();
    expect(r.metrics.runMs).toBeNull();
  });
});
