/**
 * doc-gen HTTP client and EC2 wrapper (src/docgen/client.ts, ec2.ts, signature.ts).
 */
import { DocgenClient, DocgenHttpError, DocgenUnreachableError } from '../src/docgen/client';
import { signDocgenBody, verifyDocgenSignature } from '../src/docgen/signature';
import { isCapacityError, startInstance, stopInstance, describeInstance } from '../src/docgen/ec2';

function res(status: number, body: unknown, raw = false): Response {
  return new Response(raw ? (body as string) : JSON.stringify(body), { status });
}
function client(f: jest.Mock) {
  return new DocgenClient({ baseUrl: 'https://doc-gen.example/', token: 'tok', fetchImpl: f as unknown as typeof fetch });
}

describe('DocgenClient.health', () => {
  it('sends the bearer token and returns the body when up', async () => {
    const f = jest.fn(async () => res(200, { ready: true, busy: false, current_job_id: null, checks: {} }));
    const h = await client(f).health();
    expect(h?.ready).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://doc-gen.example/v1/health');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it.each([502, 504])('treats a CloudFront %i page as "not up yet" (null), not an error', async (status) => {
    expect(await client(jest.fn(async () => res(status, '<html>CloudFront</html>', true))).health()).toBeNull();
  });

  it('treats a network failure as not up yet', async () => {
    expect(await client(jest.fn(async () => { throw new TypeError('fetch failed'); })).health()).toBeNull();
  });

  it('returns ready:false with the checks on a 503 not_ready, so "needs a person" is distinguishable from "booting"', async () => {
    const f = jest.fn(async () => res(503, { error: { code: 'not_ready', checks: { storyblocks_mcp: 'needs_login' } } }));
    const h = await client(f).health();
    expect(h).toMatchObject({ ready: false, checks: { storyblocks_mcp: 'needs_login' } });
  });

  it('throws on a 401 — a wrong token is configuration, not "still booting"', async () => {
    await expect(client(jest.fn(async () => res(401, { error: { code: 'unauthorized' } }))).health()).rejects.toMatchObject({
      httpStatus: 401,
      code: 'unauthorized',
    });
  });

  it('throws on a CloudFront 403 page (the caller address is not the allowed one)', async () => {
    await expect(client(jest.fn(async () => res(403, '<html>blocked</html>', true))).health()).rejects.toMatchObject({
      code: 'cloudfront_forbidden',
    });
  });
});

describe('DocgenClient job calls', () => {
  const payload = { request_id: 'r1' } as never;

  it('start: 202 is a new job, 200 is a replay of a known request_id', async () => {
    const body = { job_id: 'dg_1', request_id: 'r1', state: 'running' };
    expect(await client(jest.fn(async () => res(202, body))).start(payload)).toEqual({ created: true, jobId: 'dg_1', state: 'running' });
    expect(await client(jest.fn(async () => res(200, body))).start(payload)).toMatchObject({ created: false, jobId: 'dg_1' });
  });

  it('start: 409 busy surfaces the code and the current job', async () => {
    const err = await client(jest.fn(async () => res(409, { error: { code: 'busy', current_job_id: 'dg_9' } })))
      .start(payload)
      .catch((e) => e);
    expect(err).toBeInstanceOf(DocgenHttpError);
    expect(err).toMatchObject({ httpStatus: 409, code: 'busy' });
    expect((err.body as { error: { current_job_id: string } }).error.current_job_id).toBe('dg_9');
  });

  it('start: a 504 mid-boot is Unreachable (retryable), distinct from an HTTP error', async () => {
    await expect(client(jest.fn(async () => res(504, '<html/>', true))).start(payload)).rejects.toBeInstanceOf(DocgenUnreachableError);
  });

  it('events: passes after_seq and unwraps the list', async () => {
    const f = jest.fn(async () => res(200, { events: [{ seq: 5 }, { seq: 6 }] }));
    expect(await client(f).events('dg_1', 4)).toHaveLength(2);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://doc-gen.example/v1/documentaries/dg_1/events?after_seq=4');
  });

  it('respond: sends the snake_case contract body', async () => {
    const f = jest.fn(async () => res(200, { state: 'running' }));
    await client(f).respond('dg_1', { checkpointId: 'cp_script', action: 'revise', instructions: 'shorter' });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ checkpoint_id: 'cp_script', action: 'revise', instructions: 'shorter' });
  });

  it('file: encodes each path segment but keeps the slashes', async () => {
    const f = jest.fn(async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const out = await client(f).file('dg_1', 'out/my video.mp4');
    expect(out.bytes.toString()).toBe('hello');
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://doc-gen.example/v1/documentaries/dg_1/files/out/my%20video.mp4');
  });
});

describe('webhook signature', () => {
  const secret = 's3cret';
  const raw = Buffer.from('{"event":"stage.started","seq":3}');

  it('verifies a signature computed over the raw bytes', () => {
    expect(verifyDocgenSignature(raw, signDocgenBody(secret, raw), secret)).toBe(true);
  });

  it('matches doc-gen\'s documented algorithm (sha256= + hex HMAC-SHA256)', () => {
    expect(signDocgenBody(secret, raw)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('rejects a tampered body, wrong secret, missing header and wrong-length header without throwing', () => {
    const good = signDocgenBody(secret, raw);
    expect(verifyDocgenSignature(Buffer.from('{"event":"x"}'), good, secret)).toBe(false);
    expect(verifyDocgenSignature(raw, good, 'other')).toBe(false);
    expect(verifyDocgenSignature(raw, undefined, secret)).toBe(false);
    expect(verifyDocgenSignature(raw, 'sha256=abc', secret)).toBe(false);
  });
});

describe('ec2 wrapper', () => {
  it('delegates to the injected impl with the configured instance id', async () => {
    const impl = { start: jest.fn(async () => 'pending'), stop: jest.fn(async () => 'stopping'), describe: jest.fn(async () => 'running') };
    const t = { instanceId: 'i-123', region: 'us-east-1', impl };
    expect(await startInstance(t)).toBe('pending');
    expect(await stopInstance(t)).toBe('stopping');
    expect(await describeInstance(t)).toBe('running');
    expect(impl.start).toHaveBeenCalledWith('i-123');
  });

  it('recognises capacity errors (retry with backoff) and nothing else', () => {
    expect(isCapacityError({ name: 'InsufficientInstanceCapacity' })).toBe(true);
    expect(isCapacityError({ Code: 'InsufficientInstanceCapacity' })).toBe(true);
    expect(isCapacityError({ name: 'UnauthorizedOperation' })).toBe(false);
    expect(isCapacityError(new Error('boom'))).toBe(false);
    expect(isCapacityError(undefined)).toBe(false);
  });
});
