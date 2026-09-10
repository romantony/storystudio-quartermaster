/**
 * Mocked-fetch tests for quality/replicate.ts — same convention as
 * runpod-client.test.ts.
 */
import { callVisionJson, extractJson, ReplicateError, type ReplicateDeps } from '../src/quality/replicate';

function fakeRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const BASE_DEPS: Omit<ReplicateDeps, 'fetchImpl' | 'sleepImpl'> = {
  apiToken: 'test-token',
  apiBase: 'https://api.replicate.com/v1',
  visionModel: 'google/gemini-2.5-flash',
  visionModelFallback: 'google/gemini-3-pro',
  pollIntervalMs: 1,
  maxPollAttempts: 3,
  timeoutMs: 5000,
};

const noSleep = jest.fn(async () => {});
beforeEach(() => noSleep.mockClear());

describe('extractJson', () => {
  it('parses a direct JSON string', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('extracts JSON from a markdown code fence', () => {
    expect(extractJson('here you go:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 });
  });

  it('falls back to a greedy first/last brace scan', () => {
    expect(extractJson('blah {"a":1} blah')).toEqual({ a: 1 });
  });

  it('throws ReplicateError when nothing parses', () => {
    expect(() => extractJson('no json here at all')).toThrow(ReplicateError);
  });
});

describe('callVisionJson', () => {
  it('POSTs the flat Replicate input schema and polls until succeeded', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(fakeRes(200, { id: 'pred-1' })) // create
      .mockResolvedValueOnce(fakeRes(200, { status: 'processing' })) // poll 1
      .mockResolvedValueOnce(fakeRes(200, { status: 'succeeded', output: '{"scores":{"a":9}}' })); // poll 2

    const result = await callVisionJson(
      { ...BASE_DEPS, fetchImpl, sleepImpl: noSleep },
      { systemPrompt: 'sys', userMsg: 'user', imageUrls: ['https://x/img.png'] },
    );

    expect(result).toEqual({ scores: { a: 9 } });
    const [createUrl, createOpts] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('https://api.replicate.com/v1/models/google/gemini-2.5-flash/predictions');
    const body = JSON.parse(createOpts.body as string);
    expect(body.input).toEqual({
      prompt: 'user',
      system_instruction: 'sys',
      images: ['https://x/img.png'],
      videos: [],
      max_output_tokens: 4096,
      temperature: 0.2,
      top_p: 0.95,
    });
    expect(noSleep).toHaveBeenCalledTimes(1); // one "processing" tick before succeeded
  });

  it('joins an array output into one string before parsing', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(fakeRes(200, { id: 'pred-2' }))
      .mockResolvedValueOnce(fakeRes(200, { status: 'succeeded', output: ['{"a"', ':1}'] }));

    const result = await callVisionJson({ ...BASE_DEPS, fetchImpl, sleepImpl: noSleep }, { systemPrompt: '', userMsg: 'x' });
    expect(result).toEqual({ a: 1 });
  });

  it('falls back to the secondary model when the primary model fails entirely', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(fakeRes(500, 'primary down')) // primary create fails
      .mockResolvedValueOnce(fakeRes(200, { id: 'pred-fallback' })) // fallback create
      .mockResolvedValueOnce(fakeRes(200, { status: 'succeeded', output: '{"ok":true}' })); // fallback poll

    const result = await callVisionJson({ ...BASE_DEPS, fetchImpl, sleepImpl: noSleep }, { systemPrompt: '', userMsg: 'x' });
    expect(result).toEqual({ ok: true });

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toContain('/models/google/gemini-2.5-flash/predictions');
    expect(calls[1][0]).toContain('/models/google/gemini-3-pro/predictions');
  });

  it('throws ReplicateError when both primary and fallback models fail', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeRes(500, 'down'));
    await expect(callVisionJson({ ...BASE_DEPS, fetchImpl, sleepImpl: noSleep }, { systemPrompt: '', userMsg: 'x' })).rejects.toThrow(ReplicateError);
  });

  it('throws on a terminal failed/canceled prediction, without retrying the same model', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(fakeRes(200, { id: 'pred-3' }))
      .mockResolvedValueOnce(fakeRes(200, { status: 'failed', error: 'boom' }))
      // fallback attempt
      .mockResolvedValueOnce(fakeRes(200, { id: 'pred-4' }))
      .mockResolvedValueOnce(fakeRes(200, { status: 'succeeded', output: '{"ok":true}' }));

    const result = await callVisionJson({ ...BASE_DEPS, fetchImpl, sleepImpl: noSleep }, { systemPrompt: '', userMsg: 'x' });
    expect(result).toEqual({ ok: true }); // recovered via fallback
    expect(fetchImpl).toHaveBeenCalledTimes(4); // create+poll for primary (failed), create+poll for fallback
  });

  it('throws a timeout after maxPollAttempts without ever reaching succeeded', async () => {
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/predictions/') === false) return fakeRes(200, { id: 'pred-slow' }); // any create
      return fakeRes(200, { status: 'processing' }); // never succeeds
    });
    await expect(
      callVisionJson({ ...BASE_DEPS, maxPollAttempts: 2, fetchImpl, sleepImpl: noSleep }, { systemPrompt: '', userMsg: 'x' }),
    ).rejects.toThrow(ReplicateError);
  });
});
