import type {
  Adapter, BuiltRequest, CanonicalJob, ErrClass,
  PollResult, Rung, SubmitResult, WebhookParseResult,
} from '../types';

const RUNPOD = 'https://api.runpod.ai/v2';
const env = (k: string) => process.env[k] ?? '';

// Dig a video URL out of RunPod's variable output shape
function runpodOutUrl(p: unknown): string | undefined {
  const dig = (x: unknown): string | undefined => {
    if (typeof x === 'string' && x.startsWith('http')) return x;
    if (Array.isArray(x)) return x.map(dig).find(Boolean);
    if (x && typeof x === 'object') {
      const keys = ['video_url', 'videoUrl', 'output_url', 'url', 'output', 'result', 'video', 'artifacts'];
      return keys.map(k => dig((x as Record<string, unknown>)[k])).find(Boolean);
    }
    return undefined;
  };
  return dig(p);
}

const TERMINAL_STATUSES = new Set(['FAILED', 'ERROR', 'CANCELLED', 'TIMED_OUT']);

export const runpod: Adapter = {
  supportsWebhook: true,

  buildRequest(job: CanonicalJob, rung: Rung, callbackUrl?: string): BuiltRequest {
    const body: Record<string, unknown> = {
      input: {
        prompt: job.prompt,
        image: job.initImageUrls?.[0],    // spokesperson image (must be COMPLETE)
        audio: job.audioUrl,              // TTS output URL (must be COMPLETE)
        resolution: (rung as Record<string, unknown>).resolution ?? job.params.resolution ?? '720p',
        enable_safety_checker: true,
      },
    };
    if (callbackUrl) body.webhook = callbackUrl;

    return {
      url: `${RUNPOD}/infinitetalk/run`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env('RUNPOD_API_KEY')}`,
      },
      body,
    };
  },

  parseSubmit(raw: unknown): SubmitResult {
    const url = runpodOutUrl(raw);
    if (url) return { outputUrls: [url], raw };
    const r = raw as Record<string, unknown>;
    return { taskRef: String(r.id ?? ''), raw };
  },

  async poll(taskRef: string, _rung: Rung): Promise<PollResult> {
    const resp = await fetch(`${RUNPOD}/infinitetalk/status/${encodeURIComponent(taskRef)}`, {
      headers: { Authorization: `Bearer ${env('RUNPOD_API_KEY')}` },
    });
    const json = (await resp.json()) as Record<string, unknown>;
    const status = String(json.status ?? '').toUpperCase();

    if (status === 'COMPLETED') {
      const url = runpodOutUrl(json);
      return { done: true, outputUrls: url ? [url] : undefined };
    }
    if (TERMINAL_STATUSES.has(status)) {
      return { done: true, failed: true };
    }
    return { done: false };
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const p = payload as Record<string, unknown>;
    const status = String(p.status ?? '').toUpperCase();
    const url = runpodOutUrl(p);
    return {
      taskRef: String(p.id ?? ''),
      outputUrls: url ? [url] : undefined,
      failed: TERMINAL_STATUSES.has(status),
    };
  },

  classifyError(code: number, _raw: unknown): ErrClass {
    if (code === 429) return 'Transient';
    if (code === 401) return 'TerminalProvider';
    if (code >= 500) return 'Transient';
    return 'TerminalRetryable';
  },
};
