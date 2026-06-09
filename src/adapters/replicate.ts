import type {
  Adapter, BuiltRequest, CanonicalJob, ErrClass,
  PollResult, Rung, SubmitResult, WebhookParseResult,
} from '../types';

const REP = 'https://api.replicate.com/v1';
const env = (k: string) => process.env[k] ?? '';

function normalizeOutput(output: unknown): string[] | undefined {
  if (!output) return undefined;
  if (Array.isArray(output)) return output.filter(Boolean) as string[];
  if (typeof output === 'string' && output.startsWith('http')) return [output];
  return undefined;
}

export const replicate: Adapter = {
  supportsWebhook: true,

  buildRequest(job: CanonicalJob, rung: Rung, callbackUrl?: string): BuiltRequest {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env('REPLICATE_API_TOKEN')}`,
    };

    let input: Record<string, unknown> = { prompt: job.prompt };

    if (rung.model.includes('flux-2-klein') || rung.model.includes('flux-2klein')) {
      input = {
        ...input,
        images: job.initImageUrls ?? [],
        aspect_ratio: job.params.aspectRatio ?? '16:9',
        output_format: 'jpg',
        output_megapixels: 1,
        output_quality: 80,
        go_fast: true,
      };
    } else if (rung.model.includes('nano-banana')) {
      // google/nano-banana on Replicate
      input = {
        ...input,
        image_input: job.initImageUrls ?? [],
        aspect_ratio: job.params.aspectRatio ?? '16:9',
        resolution: job.params.resolution ?? '1K',
        output_format: 'png',
      };
    } else if (rung.model.includes('wan-2.2-i2v') || rung.model.includes('wan-i2v')) {
      input = {
        ...input,
        image: job.initImageUrls?.[0],
        last_image: job.initImageUrls?.[1],
        num_frames: 81,
        resolution: '480p',
        frames_per_second: 16,
        go_fast: true,
      };
    } else if (rung.model.includes('seedance')) {
      input = {
        ...input,
        image: job.initImageUrls?.[0],
        last_frame_image: job.initImageUrls?.[1],
        reference_images: job.initImageUrls?.slice(2),
        resolution: job.params.resolution ?? '720p',
        aspect_ratio: job.params.aspectRatio ?? '16:9',
        duration: job.params.durationS ?? 5,
        generate_audio: !!job.params.generateAudio,
      };
    } else if (rung.model.includes('kokoro')) {
      input = {
        text: job.prompt,
        voice: job.params.voice ?? 'af_nicole',
        speed: 1,
      };
    } else if (rung.model.includes('audiogen')) {
      input = {
        prompt: job.prompt,
        duration: job.params.durationS ?? 3,
      };
    }

    // URL: /v1/models/{owner}/{name}/predictions
    const [owner, ...rest] = rung.model.split('/');
    const name = rest.join('/');
    const url = `${REP}/models/${owner}/${name}/predictions`;

    const body: Record<string, unknown> = { input };
    if (callbackUrl) {
      body.webhook = callbackUrl;
      body.webhook_events_filter = ['completed'];
    }

    return { url, method: 'POST', headers, body };
  },

  parseSubmit(raw: unknown): SubmitResult {
    const r = raw as Record<string, unknown>;
    if (r.error) {
      throw Object.assign(new Error(`Replicate submit error: ${r.error}`), { httpCode: 422, raw });
    }
    const outputUrls = normalizeOutput(r.output);
    return { taskRef: String(r.id ?? ''), outputUrls, raw };
  },

  async poll(taskRef: string, _rung: Rung): Promise<PollResult> {
    const resp = await fetch(`${REP}/predictions/${encodeURIComponent(taskRef)}`, {
      headers: { Authorization: `Bearer ${env('REPLICATE_API_TOKEN')}` },
    });
    const json = (await resp.json()) as Record<string, unknown>;
    const status = String(json.status ?? '');

    if (status === 'succeeded') {
      return { done: true, outputUrls: normalizeOutput(json.output) };
    }
    if (status === 'failed' || status === 'canceled') {
      return { done: true, failed: true };
    }
    return { done: false };
  },

  parseWebhook(payload: unknown): WebhookParseResult {
    const p = payload as Record<string, unknown>;
    const outputUrls = normalizeOutput(p.output);
    const failed = p.status === 'failed' || p.status === 'canceled';
    return { taskRef: String(p.id ?? ''), outputUrls, failed };
  },

  classifyError(code: number, _raw: unknown): ErrClass {
    if (code === 429) return 'Transient';
    if (code === 402) return 'TerminalProvider';
    if (code === 422) return 'TerminalPermanent';
    if (code >= 500) return 'Transient';
    return 'TerminalRetryable';
  },
};
