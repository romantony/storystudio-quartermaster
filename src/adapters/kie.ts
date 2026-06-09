import type {
  Adapter, BuiltRequest, CanonicalJob, ErrClass,
  PollResult, Rung, SubmitResult, WebhookParseResult,
} from '../types';

const KIE = 'https://api.kie.ai/api';
const env = (k: string) => process.env[k] ?? '';

// Snap a duration to Seedance-1.5's allowed string enum
function snapDuration(s = 5, allowed: string[]): string {
  return allowed.reduce((a, c) => Math.abs(+c - s) < Math.abs(+a - s) ? c : a);
}

export const kie: Adapter = {
  supportsWebhook: true,

  buildRequest(job: CanonicalJob, rung: Rung, callbackUrl?: string): BuiltRequest {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env('KIE_AI_API_KEY')}`,
    };

    // Suno BGM endpoint
    if (rung.model === 'suno') {
      return {
        url: `${KIE}/v1/generate`,
        method: 'POST',
        headers,
        body: {
          prompt: job.prompt,
          customMode: false,
          instrumental: true,
          model: rung.modelId ?? 'V4_5',
          callBackUrl: callbackUrl,
        },
      };
    }

    // Market models (nano-banana, seedance variants)
    let input: Record<string, unknown> = { prompt: job.prompt };

    if (rung.model === 'nano-banana-2' || rung.model === 'nano-banana') {
      input = {
        ...input,
        image_input: job.initImageUrls ?? [],
        aspect_ratio: job.params.aspectRatio ?? 'auto',
        resolution: job.params.resolution ?? '1K',
        output_format: 'png',
      };
    } else if (rung.model === 'bytedance/seedance-1.5-pro') {
      const dur = snapDuration(job.params.durationS, ['4', '8', '12']);
      input = {
        ...input,
        input_urls: job.initImageUrls ?? [],
        aspect_ratio: job.params.aspectRatio ?? '16:9',
        resolution: job.params.resolution ?? '720p',
        duration: dur,
        generate_audio: !!job.params.generateAudio,
        fixed_lens: false,
      };
    } else if (rung.model === 'bytedance/seedance-2-fast') {
      input = {
        ...input,
        first_frame_url: job.initImageUrls?.[0],
        last_frame_url: job.initImageUrls?.[1],
        reference_image_urls: job.initImageUrls?.slice(2),
        aspect_ratio: job.params.aspectRatio ?? '16:9',
        resolution: job.params.resolution ?? '720p',
        duration: Math.min(15, Math.max(4, job.params.durationS ?? 5)),
        generate_audio: !!job.params.generateAudio,
      };
    }

    return {
      url: `${KIE}/v1/jobs/createTask`,
      method: 'POST',
      headers,
      body: { model: rung.model, callBackUrl: callbackUrl, input },
    };
  },

  parseSubmit(raw: unknown): SubmitResult {
    const r = raw as Record<string, unknown>;
    if (r.code !== 200) {
      throw Object.assign(new Error(`Kie submit failed: code=${r.code}`), { httpCode: r.code, raw });
    }
    const data = r.data as Record<string, unknown>;
    return { taskRef: String(data.taskId), raw };
  },

  async poll(taskRef: string, rung: Rung): Promise<PollResult> {
    const headers = { Authorization: `Bearer ${env('KIE_AI_API_KEY')}` };
    let resp: Response;

    if (rung.model === 'suno') {
      resp = await fetch(`${KIE}/v1/generate/record-info?taskId=${encodeURIComponent(taskRef)}`, { headers });
      const json = (await resp.json()) as Record<string, unknown>;
      if (json.code !== 200) return { done: false };
      const sunoData = ((json.data as Record<string, unknown>)?.response as Record<string, unknown>)?.sunoData as Array<Record<string, unknown>>;
      const urls = sunoData?.map(s => s.audioUrl as string).filter(Boolean) ?? [];
      return { done: urls.length > 0, outputUrls: urls };
    }

    // Market task poll (Get Task Details)
    resp = await fetch(`${KIE}/v1/jobs?taskId=${encodeURIComponent(taskRef)}`, { headers });
    const json = (await resp.json()) as Record<string, unknown>;
    if (json.code !== 200) return { done: false };

    const data = json.data as Record<string, unknown>;
    const status = String(data?.status ?? '').toLowerCase();
    if (status === 'failed' || status === 'error') return { done: true, failed: true };

    const resultUrls = (data?.resultUrls ?? data?.result_urls ?? []) as string[];
    if (resultUrls.length > 0) return { done: true, outputUrls: resultUrls };
    return { done: false };
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const p = payload as Record<string, unknown>;
    const d = (p.data ?? p) as Record<string, unknown>;
    const taskRef = String(d.taskId ?? '');

    // Suno webhook: sunoData array
    const sunoData = (d.response as Record<string, unknown>)?.sunoData as Array<Record<string, unknown>>;
    if (sunoData?.length) {
      return { taskRef, outputUrls: sunoData.map(s => s.audioUrl as string).filter(Boolean) };
    }

    const resultUrls = (d.resultUrls ?? []) as string[];
    const failed = p.code !== 200;
    return { taskRef, outputUrls: resultUrls, failed };
  },

  classifyError(code: number, _raw: unknown): ErrClass {
    if (code === 429 || code === 433) return 'Transient';
    if (code === 402) return 'TerminalProvider';   // insufficient credits — alarm + fail over
    if (code === 422 || code === 505) return 'TerminalPermanent';
    if (code >= 500 || code === 408 || code === 455 || code === 501) return 'Transient';
    return 'TerminalRetryable';
  },
};
