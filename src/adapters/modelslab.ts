import type { Adapter, BuiltRequest, CanonicalJob, ErrClass, PollResult, Rung, SubmitResult } from '../types';

const ML = 'https://modelslab.com/api';
const env = (k: string) => process.env[k] ?? '';

function getFetchUrl(endpoint: string): string {
  if (endpoint.startsWith('v6/video')) return `${ML}/v6/video/fetch`;
  if (endpoint.startsWith('v7/voice/text-to-speech')) return `${ML}/v7/voice/fetch`;
  if (endpoint.startsWith('v6/voice')) return `${ML}/v6/voice/fetch`;
  return `${ML}/v6/images/fetch`;
}

export const modelslab: Adapter = {
  supportsWebhook: false,

  buildRequest(job: CanonicalJob, rung: Rung, _callbackUrl?: string): BuiltRequest {
    const key = env('MODELSLAB_API_KEY');
    const ep = rung.endpoint ?? '';
    const base: Record<string, unknown> = { key, model_id: rung.modelId ?? rung.model, prompt: job.prompt };

    if (job.initImageUrls?.length) {
      base.init_image = job.initImageUrls;
    }

    let url = '';
    let body: Record<string, unknown> = base;

    if (ep.startsWith('v6/text2img')) {
      url = `${ML}/v6/images/text2img`;
      body = { ...base, width: '1024', height: '1024', samples: '1' };

    } else if (ep.startsWith('v6/image_editing/qwen_edit')) {
      // Qwen Image Edit — transformer-based pixel+semantic editing, up to 4 source images.
      // API: POST /v6/image_editing/qwen_edit  { key, model_id:"qwen-edit", prompt, init_image:[...] }
      url = `${ML}/v6/image_editing/qwen_edit`;
      body = {
        key,
        model_id: 'qwen-edit',
        prompt: job.prompt,
        init_image: job.initImageUrls ?? [],
      };

    } else if (ep.startsWith('v6/img2img')) {
      url = `${ML}/v6/images/img2img`;
      body = {
        ...base,
        samples: '1',
        strength: '0.1',
        enhance_prompt: false,
        init_image: job.initImageUrls ?? [],
      };

    } else if (ep.startsWith('v7/text-to-image')) {
      url = `${ML}/v7/images/text-to-image`;
      if (rung.modelId?.startsWith('qwen')) {
        const [w, h] = resolveResolution(job.params.aspectRatio, job.params.resolution);
        body = { ...base, size: `${w}*${h}` };
      } else {
        body = {
          ...base,
          aspect_ratio: job.params.aspectRatio ?? '16:9',
          resolution: job.params.resolution ?? '1K',
        };
      }

    } else if (ep.startsWith('v7/image-to-image')) {
      url = `${ML}/v7/images/image-to-image`;
      if (rung.modelId?.startsWith('qwen')) {
        const [w, h] = resolveResolution(job.params.aspectRatio, job.params.resolution);
        body = { ...base, size: `${w}*${h}`, init_image: job.initImageUrls ?? [] };
      } else {
        body = {
          ...base,
          aspect_ratio: job.params.aspectRatio ?? '16:9',
          resolution: job.params.resolution ?? '1K',
          init_image: job.initImageUrls ?? [],
        };
      }

    } else if (ep.startsWith('v6/video')) {
      url = `${ML}/v6/video/img2video_ultra`;
      body = {
        ...base,
        init_image: job.initImageUrls?.[0],
        negative_prompt: 'static, freeze, no motion, blur, glitch, distortion',
        resolution: '480',
        output_type: 'mp4',
        ...(rung.fixed ?? {}),   // fixed: num_frames:"82", fps:"16"
      };

    } else if (ep.startsWith('v7/voice/text-to-speech')) {
      url = `${ML}/v7/voice/text-to-speech`;
      body = { key, model_id: rung.modelId ?? rung.model, prompt: job.prompt, voice_id: job.params.voice };

    } else if (ep.startsWith('v6/voice/sfx')) {
      url = `${ML}/v6/voice/sfx`;
      body = { key, model_id: 'sfx', prompt: job.prompt, duration: job.params.durationS ?? 3, temp: false };

    } else if (ep.startsWith('v6/voice/music')) {
      url = `${ML}/v6/voice/music`;
      body = { key, model_id: 'music', prompt: job.prompt };
    }

    return {
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    };
  },

  parseSubmit(raw: unknown): SubmitResult {
    const r = raw as Record<string, unknown>;
    const out = Array.isArray(r.output) ? (r.output as string[]) : r.output ? [r.output as string] : [];
    if (out.length) return { outputUrls: out, raw };
    // "Try Again" quirk (§17.1): fetch returns processing with no id — use persisted request_id
    const taskRef = String(r.id ?? r.request_id ?? '');
    return { taskRef, raw };
  },

  async poll(taskRef: string, rung: Rung): Promise<PollResult> {
    const key = env('MODELSLAB_API_KEY');
    const fetchUrl = getFetchUrl(rung.endpoint ?? '');
    const resp = await fetch(fetchUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, request_id: taskRef }),
    });
    const json = (await resp.json()) as Record<string, unknown>;

    if (json.status === 'processing' || json.output === '') {
      return { done: false };
    }
    if (json.status === 'error') {
      return { done: true, failed: true };
    }
    const urls = Array.isArray(json.output) ? (json.output as string[]) : json.output ? [json.output as string] : [];
    return { done: urls.length > 0, outputUrls: urls };
  },

  classifyError(code: number, raw: unknown): ErrClass {
    if (code === 429) return 'Transient';
    const r = raw as Record<string, unknown>;
    if (String(r?.status) === 'error' && /nsfw|moderation|invalid/i.test(String(r?.message ?? ''))) {
      return 'TerminalPermanent';
    }
    if (code >= 500) return 'Transient';
    return 'TerminalRetryable';
  },
};

// Resolve aspectRatio + resolution to width × height for ModelsLab qwen size param
function resolveResolution(aspectRatio?: string, resolution?: string): [string, string] {
  const res = resolution ?? '1K';
  const basePx = res === '2K' ? 2048 : res === '4K' ? 4096 : 1024;
  const ar = aspectRatio ?? '1:1';
  const [aw, ah] = ar.split(':').map(Number);
  if (!aw || !ah) return [String(basePx), String(basePx)];

  const w = aw >= ah ? basePx : Math.round(basePx * (aw / ah));
  const h = ah >= aw ? basePx : Math.round(basePx * (ah / aw));
  return [String(w), String(h)];
}
