import { runcomfy } from '../src/adapters/runcomfy';
import type { CanonicalJob, Rung } from '../src/types';

function job(overrides: Partial<CanonicalJob> = {}): CanonicalJob {
  return {
    assetType: 'video', tier: 'dialogueBasic', operation: 'narrator', product: 'dialogue',
    queue: 'background', requestId: 'r1', jobId: 'j1', prompt: '',
    initImageUrls: ['https://x/persona.png'],
    audioUrl: 'https://x/tts.wav',
    params: {},
    s3Target: 'x',
    ...overrides,
  };
}

const monoRung: Rung = {
  provider: 'runcomfy', model: 'community/infinite-talk/fast', endpoint: 'v1/models/community/infinite-talk/fast',
  lane: 'video', routingMode: 'direct',
};
const multiRung: Rung = {
  provider: 'runcomfy', model: 'community/infinite-talk/fast/multi', endpoint: 'v1/models/community/infinite-talk/fast/multi',
  lane: 'video', routingMode: 'direct',
};

describe('runcomfy adapter — buildRequest', () => {
  it('mono: sends {audio, image} to the fast endpoint', () => {
    const req = runcomfy.buildRequest(job(), monoRung);
    expect(req.url).toBe('https://model-api.runcomfy.net/v1/models/community/infinite-talk/fast');
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({ audio: 'https://x/tts.wav', image: 'https://x/persona.png' });
  });

  it('multi: sends {left_audio, right_audio, image} to the fast/multi endpoint', () => {
    const req = runcomfy.buildRequest(
      job({ params: { leftAudioUrl: 'https://x/left.wav', rightAudioUrl: 'https://x/right.wav' } }),
      multiRung,
    );
    expect(req.url).toBe('https://model-api.runcomfy.net/v1/models/community/infinite-talk/fast/multi');
    expect(req.body).toEqual({
      left_audio: 'https://x/left.wav', right_audio: 'https://x/right.wav', image: 'https://x/persona.png',
      order: 'left_right',
    });
  });

  it('includes an optional prompt when the job carries one, omits it otherwise', () => {
    const withPrompt = runcomfy.buildRequest(job({ prompt: 'a storyteller by a fireplace' }), monoRung);
    expect((withPrompt.body as Record<string, unknown>).prompt).toBe('a storyteller by a fireplace');
    const withoutPrompt = runcomfy.buildRequest(job({ prompt: '' }), monoRung);
    expect((withoutPrompt.body as Record<string, unknown>).prompt).toBeUndefined();
  });
});

describe('runcomfy adapter — parseSubmit', () => {
  it('extracts request_id as taskRef', () => {
    expect(runcomfy.parseSubmit({ request_id: 'abc123' })).toEqual({ taskRef: 'abc123', raw: { request_id: 'abc123' } });
  });

  it('throws when no request id is present in the response', () => {
    expect(() => runcomfy.parseSubmit({ status: 'ok' })).toThrow(/no request_id/);
  });
});

describe('runcomfy adapter — poll', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('returns done:false while in_queue/in_progress', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: () => Promise.resolve({ status: 'in_progress' }) }) as any;
    const result = await runcomfy.poll('req1', monoRung);
    expect(result).toEqual({ done: false });
  });

  it('returns done:true, failed:true on cancelled/failed status', async () => {
    global.fetch = jest.fn().mockResolvedValue({ json: () => Promise.resolve({ status: 'failed' }) }) as any;
    const result = await runcomfy.poll('req1', monoRung);
    expect(result.done).toBe(true);
    expect(result.failed).toBe(true);
  });

  it('fetches the result and returns outputUrls when completed', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ status: 'completed' }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ video_url: 'https://cdn/out.mp4' }) }) as any;
    const result = await runcomfy.poll('req1', monoRung);
    expect(result).toEqual({ done: true, outputUrls: ['https://cdn/out.mp4'] });
  });

  it('fails gracefully when completed but no output URL is found', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ status: 'completed' }) })
      .mockResolvedValueOnce({ json: () => Promise.resolve({}) }) as any;
    const result = await runcomfy.poll('req1', monoRung);
    expect(result.done).toBe(true);
    expect(result.failed).toBe(true);
  });
});

describe('runcomfy adapter — classifyError', () => {
  it('classifies auth errors as TerminalProvider, 429/5xx as Transient, other 4xx as TerminalRetryable', () => {
    expect(runcomfy.classifyError(401, {})).toBe('TerminalProvider');
    expect(runcomfy.classifyError(403, {})).toBe('TerminalProvider');
    expect(runcomfy.classifyError(429, {})).toBe('Transient');
    expect(runcomfy.classifyError(503, {})).toBe('Transient');
    expect(runcomfy.classifyError(422, {})).toBe('TerminalRetryable');
  });
});

describe('runcomfy adapter — supportsWebhook', () => {
  it('is false — RunComfy has no webhook mechanism (poll-only)', () => {
    expect(runcomfy.supportsWebhook).toBe(false);
  });
});
