import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunpodClient, backoffMs } from '../src/runpod/client';
import { RunpodError } from '../src/runpod/types';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'runpod', name), 'utf8'));

const CFG = {
  runpodApiBase: 'https://api.runpod.ai/v2',
  runpodRestBase: 'https://rest.runpod.io/v1',
  runpodApiKey: 'test-key',
  runpodMaxRetries: 2,
  runpodTimeoutMs: 1000,
};

function fakeRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const noSleep = jest.fn(async () => {});

beforeEach(() => noSleep.mockClear());

describe('RunpodClient — happy path', () => {
  it('POSTs /run with {input}, the per-job webhook, and a bearer header', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, fixture('run-accepted.json')));
    const c = new RunpodClient(CFG, { fetchImpl, sleepImpl: noSleep });

    const out = await c.run('e165se4r3eo5hp', { prompt: 'x' }, 'https://vps.example/v1/webhooks/runpod/tok');

    expect(out.id).toBe('sync-abc123-e165se4r3eo5hp');
    const [url, opts] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://api.runpod.ai/v2/e165se4r3eo5hp/run');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-key');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body as string)).toEqual({
      input: { prompt: 'x' },
      webhook: 'https://vps.example/v1/webhooks/runpod/tok',
    });
  });

  it('reads a synchronous completion (warm endpoint) including executionTime', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, fixture('run-completed-sync.json')));
    const c = new RunpodClient(CFG, { fetchImpl, sleepImpl: noSleep });
    const out = await c.run('e165se4r3eo5hp', {});
    expect(out.status).toBe('COMPLETED');
    expect(out.executionTime).toBe(11840);
    expect(out.delayTime).toBe(812);
  });

  it('health() parses the worker counts', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, fixture('health.json')));
    const c = new RunpodClient(CFG, { fetchImpl, sleepImpl: noSleep });
    const h = await c.health('e165se4r3eo5hp');
    expect(h.workers.ready).toBe(25);
    expect(h.workers.running).toBe(18);
  });

  it('patchWorkers() PATCHes the management API, not the job API', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, {}));
    const c = new RunpodClient(CFG, { fetchImpl, sleepImpl: noSleep });
    await c.patchWorkers('nd7wloyvj09xwy', { workersMin: 25, workersMax: 25 });
    const [url, opts] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://rest.runpod.io/v1/endpoints/nd7wloyvj09xwy');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body as string)).toEqual({ workersMin: 25, workersMax: 25 });
  });

  it('omits the Authorization header when no key is configured', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(200, {}));
    const c = new RunpodClient({ ...CFG, runpodApiKey: undefined }, { fetchImpl, sleepImpl: noSleep });
    await c.health('e1');
    const [, opts] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(opts.headers.Authorization).toBeUndefined();
  });
});

describe('RunpodClient — retry taxonomy (mirrors src/adapters/runpod.ts classifyError)', () => {
  it('retries a 429 then succeeds, sleeping between tries', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(fakeRes(429, 'rate limited'))
      .mockResolvedValueOnce(fakeRes(200, fixture('run-accepted.json')));
    const c = new RunpodClient(CFG, { fetchImpl, sleepImpl: noSleep });

    const out = await c.run('e1', {});
    expect(out.id).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledTimes(1);
  });

  it('gives up on a persistent 500 after maxRetries, as a Transient RunpodError', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(503, 'upstream down'));
    const c = new RunpodClient(CFG, { fetchImpl, sleepImpl: noSleep });

    await expect(c.run('e1', {})).rejects.toMatchObject({
      name: 'RunpodError',
      status: 503,
      klass: 'Transient',
    });
    // initial + 2 retries
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a 401 — TerminalProvider, one attempt only', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(401, 'bad key'));
    const c = new RunpodClient(CFG, { fetchImpl, sleepImpl: noSleep });

    await expect(c.run('e1', {})).rejects.toMatchObject({ klass: 'TerminalProvider', status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it('does NOT retry a 400 — TerminalRetryable is a caller problem, not a transport one', async () => {
    const fetchImpl = jest.fn(async () => fakeRes(400, 'bad input'));
    const c = new RunpodClient(CFG, { fetchImpl, sleepImpl: noSleep });
    await expect(c.run('e1', {})).rejects.toMatchObject({ klass: 'TerminalRetryable', status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a network error as Transient and retries it', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(fakeRes(200, fixture('run-accepted.json')));
    const c = new RunpodClient(CFG, { fetchImpl, sleepImpl: noSleep });
    await expect(c.run('e1', {})).resolves.toMatchObject({ status: 'IN_QUEUE' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('turns an AbortError (timeout) into a Transient RunpodError(0)', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = jest.fn().mockRejectedValue(abort);
    const c = new RunpodClient(CFG, { fetchImpl, sleepImpl: noSleep });
    await expect(c.run('e1', {})).rejects.toMatchObject({ name: 'RunpodError', status: 0, klass: 'Transient' });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // retried like any Transient
  });
});

describe('backoffMs', () => {
  it('is bounded, non-negative, and grows with the attempt ceiling', () => {
    for (let a = 0; a < 8; a++) {
      const v = backoffMs(a);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(20_000);
    }
  });
});
