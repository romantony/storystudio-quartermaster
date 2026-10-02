import { BGM_MAX_S, BGM_MIN_S, clampBgmInput, makeHandler, trimStatus } from '../handlers/orchestrator-runpod';

const ENDPOINT = '6apg6j7suzuezw';

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) } as unknown as Response;
}

function handlerWith(fetchImpl: jest.Mock) {
  return makeHandler({ getKey: async () => 'KEY', fetchImpl: fetchImpl as unknown as typeof fetch });
}

describe('submit', () => {
  it('posts to the endpoint’s /run with the bearer key and returns the job id', async () => {
    const f = jest.fn(async () => res(200, { id: 'abc12345-u1', status: 'IN_QUEUE' }));
    const out = await handlerWith(f)({ action: 'submit', endpointId: ENDPOINT, input: { mode: 'transcribe', audio_url: 'https://x/a.wav' } });

    expect(out).toEqual({ jobId: 'abc12345-u1', status: 'IN_QUEUE' });
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe(`https://api.runpod.ai/v2/${ENDPOINT}/run`);
    expect(init.headers.Authorization).toBe('Bearer KEY');
    expect(JSON.parse(init.body)).toEqual({ input: { mode: 'transcribe', audio_url: 'https://x/a.wav' } });
  });

  it('only allows the two modes the tail uses', async () => {
    const f = jest.fn();
    await expect(handlerWith(f)({ action: 'submit', endpointId: ENDPOINT, input: { mode: 'tts' } })).rejects.toThrow(/not allowed/);
    await expect(handlerWith(f)({ action: 'submit', endpointId: ENDPOINT, input: {} })).rejects.toThrow(/not allowed/);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses an endpoint id that is not a plain RunPod id (no path tricks)', async () => {
    const f = jest.fn();
    for (const bad of ['../x', 'a/b', '', 'ABC', 'x y z w q r s']) {
      await expect(handlerWith(f)({ action: 'submit', endpointId: bad, input: { mode: 'bgm' } })).rejects.toThrow(/invalid endpointId/);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('throws on a RunPod error so the state machine retries, rather than returning a fake job', async () => {
    const f = jest.fn(async () => res(500, 'boom'));
    await expect(handlerWith(f)({ action: 'submit', endpointId: ENDPOINT, input: { mode: 'bgm', prompt: 'p', duration_s: 30 } })).rejects.toThrow(/HTTP 500/);
  });

  it('throws when RunPod answers without a job id', async () => {
    const f = jest.fn(async () => res(200, { status: 'IN_QUEUE' }));
    await expect(handlerWith(f)({ action: 'submit', endpointId: ENDPOINT, input: { mode: 'bgm', prompt: 'p' } })).rejects.toThrow(/no job id/);
  });
});

describe('BGM duration', () => {
  it('is rounded up and capped at what ACE-Step reliably generates, then looped downstream', () => {
    expect(clampBgmInput({ mode: 'bgm', duration_s: 44.2 }).duration_s).toBe(45);
    expect(clampBgmInput({ mode: 'bgm', duration_s: 600 }).duration_s).toBe(BGM_MAX_S);
    expect(clampBgmInput({ mode: 'bgm', duration_s: 1 }).duration_s).toBe(BGM_MIN_S);
  });

  it('survives a missing or non-numeric duration', () => {
    expect(clampBgmInput({ mode: 'bgm' }).duration_s).toBe(BGM_MAX_S);
    expect(clampBgmInput({ mode: 'bgm', duration_s: 'x' }).duration_s).toBe(BGM_MAX_S);
  });

  it('adds the generation defaults without overriding the caller’s', () => {
    expect(clampBgmInput({ mode: 'bgm', duration_s: 30 })).toMatchObject({ steps: 20, guidance: 7.0 });
    expect(clampBgmInput({ mode: 'bgm', duration_s: 30, steps: 8 }).steps).toBe(8);
  });

  it('leaves a transcribe job alone', () => {
    const input = { mode: 'transcribe', duration_s: 999 };
    expect(clampBgmInput(input)).toBe(input);
  });

  it('is applied on submit', async () => {
    const f = jest.fn(async () => res(200, { id: 'abc12345-u1', status: 'IN_QUEUE' }));
    await handlerWith(f)({ action: 'submit', endpointId: ENDPOINT, input: { mode: 'bgm', prompt: 'p', duration_s: 300 } });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.input.duration_s).toBe(BGM_MAX_S);
  });
});

describe('status', () => {
  it('trims a transcribe result to its SRT url — the word list never reaches Step Functions', async () => {
    const chunks = Array.from({ length: 5000 }, (_, i) => ({ text: ` w${i}`, timestamp: [i, i + 0.4] }));
    const f = jest.fn(async () => res(200, { status: 'COMPLETED', output: { mode: 'transcribe', text: 'x'.repeat(40_000), chunks, srt: 'https://r2/t.srt' } }));

    const out = await handlerWith(f)({ action: 'status', endpointId: ENDPOINT, jobId: 'abc12345-u1' });

    expect(out).toEqual({ status: 'COMPLETED', srtUrl: 'https://r2/t.srt' });
    expect(JSON.stringify(out).length).toBeLessThan(500);
  });

  it('returns the BGM audio url', async () => {
    const f = jest.fn(async () => res(200, { status: 'COMPLETED', output: { mode: 'bgm', audio: 'https://r2/b.mp3', duration_s: 30 } }));
    expect(await handlerWith(f)({ action: 'status', endpointId: ENDPOINT, jobId: 'abc12345-u1' })).toEqual({ status: 'COMPLETED', audioUrl: 'https://r2/b.mp3' });
  });

  it('reports in-flight states without output', async () => {
    const f = jest.fn(async () => res(200, { status: 'IN_PROGRESS' }));
    expect(await handlerWith(f)({ action: 'status', endpointId: ENDPOINT, jobId: 'abc12345-u1' })).toEqual({ status: 'IN_PROGRESS' });
  });

  it('turns a COMPLETED whose output carries an error into a FAILED', () => {
    expect(trimStatus({ status: 'COMPLETED', output: { error: 'CUDA out of memory' } })).toEqual({ status: 'FAILED', error: 'CUDA out of memory' });
  });

  it('carries a failed job’s error text', () => {
    expect(trimStatus({ status: 'FAILED', error: 'worker crashed' })).toEqual({ status: 'FAILED', error: 'worker crashed' });
  });

  it('does not pass through a non-URL value as if it were one', () => {
    expect(trimStatus({ status: 'COMPLETED', output: { srt: 'not a url', audio: 42 } })).toEqual({ status: 'COMPLETED' });
  });

  it('reports a 404 as a terminal failure so the state machine stops polling', async () => {
    const f = jest.fn(async () => res(404, 'not found'));
    expect(await handlerWith(f)({ action: 'status', endpointId: ENDPOINT, jobId: 'abc12345-u1' })).toEqual({ status: 'FAILED', error: 'RunPod job not found' });
  });

  it('throws on any other HTTP error, so the state machine retries the poll', async () => {
    const f = jest.fn(async () => res(502, 'bad gateway'));
    await expect(handlerWith(f)({ action: 'status', endpointId: ENDPOINT, jobId: 'abc12345-u1' })).rejects.toThrow(/HTTP 502/);
  });

  it('rejects a job id that is not a plain RunPod id', async () => {
    const f = jest.fn();
    await expect(handlerWith(f)({ action: 'status', endpointId: ENDPOINT, jobId: '../../x' })).rejects.toThrow(/invalid jobId/);
    expect(f).not.toHaveBeenCalled();
  });
});

it('rejects an unknown action', async () => {
  await expect(handlerWith(jest.fn())({ action: 'cancel', endpointId: ENDPOINT } as never)).rejects.toThrow(/unknown action/);
});
