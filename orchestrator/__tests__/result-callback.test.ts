/**
 * deliverCallback() — §6.7 retry/backoff/signature behavior (M5).
 */
import { createHmac } from 'node:crypto';
import { backoffDelayMs, deliverCallback, type DeliverOptions } from '../src/result/callback';

function res(status: number) {
  return { status } as Response;
}

function opts(fetchImpl: jest.Mock, over: Partial<DeliverOptions> = {}) {
  const sleeps: number[] = [];
  const attempts: unknown[] = [];
  const o: DeliverOptions = {
    url: 'https://convex.example/api/qm/result',
    body: { projectId: 'proj_1', status: 'completed' },
    requestId: 'req_1',
    maxAttempts: 8,
    baseDelayMs: 1000,
    maxDelayMs: 300_000,
    timeoutMs: 15_000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    onAttempt: (a) => {
      attempts.push(a);
    },
    ...over,
  };
  return { o, sleeps, attempts };
}

describe('backoffDelayMs', () => {
  it('1s -> 4s -> 16s -> 64s -> 256s -> capped at 300s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelayMs(n, 1000, 300_000))).toEqual([
      1000, 4000, 16_000, 64_000, 256_000, 300_000, 300_000,
    ]);
  });
});

describe('deliverCallback', () => {
  it('delivers on the first 2xx, signs the exact raw body when a secret is set', async () => {
    const fetchImpl = jest.fn(async () => res(200));
    const { o, sleeps, attempts } = opts(fetchImpl, { secret: 's3cret' });
    const out = await deliverCallback(o);
    expect(out.outcome).toBe('delivered');
    expect(sleeps).toEqual([]);
    expect(attempts).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://convex.example/api/qm/result');
    const headers = init.headers as Record<string, string>;
    const expected = `sha256=${createHmac('sha256', 's3cret').update(init.body as string).digest('hex')}`;
    expect(headers['x-qm-signature']).toBe(expected);
    expect(headers['x-qm-request-id']).toBe('req_1');
    expect(JSON.parse(init.body as string)).toEqual({ projectId: 'proj_1', status: 'completed' });
  });

  it('sends no signature header without a secret', async () => {
    const fetchImpl = jest.fn(async () => res(204));
    const { o } = opts(fetchImpl);
    await deliverCallback(o);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers as Record<string, string>).not.toHaveProperty('x-qm-signature');
  });

  it('retries 5xx / 429 / network errors with backoff, then delivers', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));
    const { o, sleeps, attempts } = opts(fetchImpl);
    const out = await deliverCallback(o);
    expect(out.outcome).toBe('delivered');
    expect(sleeps).toEqual([1000, 4000, 16_000]);
    expect(attempts).toMatchObject([
      { attempt: 1, httpStatus: 503 },
      { attempt: 2, error: 'ECONNRESET' },
      { attempt: 3, httpStatus: 429 },
      { attempt: 4, httpStatus: 200 },
    ]);
  });

  it('stops immediately on a non-retryable 4xx (rejected)', async () => {
    const fetchImpl = jest.fn(async () => res(400));
    const { o, sleeps } = opts(fetchImpl);
    const out = await deliverCallback(o);
    expect(out.outcome).toBe('rejected');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('exhausts after maxAttempts, sleeping between attempts only', async () => {
    const fetchImpl = jest.fn(async () => res(502));
    const { o, sleeps, attempts } = opts(fetchImpl, { maxAttempts: 3 });
    const out = await deliverCallback(o);
    expect(out.outcome).toBe('exhausted');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 4000]);
    expect(attempts).toHaveLength(3);
  });

  it('records a timeout as a retryable error', async () => {
    const fetchImpl = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const { o, attempts } = opts(fetchImpl as unknown as jest.Mock, { maxAttempts: 1, timeoutMs: 20 });
    const out = await deliverCallback(o);
    expect(out.outcome).toBe('exhausted');
    expect(attempts).toMatchObject([{ attempt: 1, error: 'timeout after 20ms' }]);
  });
});
