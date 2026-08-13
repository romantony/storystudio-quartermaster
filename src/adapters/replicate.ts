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

// Real output media duration in seconds — NOT Replicate's own metrics.
// predict_time (that's compute wall-clock, e.g. ~22s to generate a 5s clip;
// using it would set the scene's video duration to the generation time).
// Replicate's prediction response echoes back the exact `input` it
// received, so this is derived from request parameters known to determine
// the output's actual length, not measured after the fact.
// Root-caused 2026-08-13: this adapter never populated durationS at all —
// invisible while the webhook signature bug (a39bac1) meant no replicate
// completion ever reached the caller, then surfaced immediately once fixed:
// a video rework's videoResult had no durationS, crashing
// BuildReworkedSceneResult's unguarded `duration.$` reference.
function replicateOutDuration(p: Record<string, unknown>): number | undefined {
  const input = p.input as Record<string, unknown> | undefined;
  if (!input) return undefined;
  // wan-2.2-i2v-fast (buildRequest above): num_frames/frames_per_second are
  // hardcoded constants, not job.params.durationS — output length is fully
  // deterministic from them.
  if (typeof input.num_frames === 'number' && typeof input.frames_per_second === 'number' && input.frames_per_second > 0) {
    return input.num_frames / input.frames_per_second;
  }
  // seedance (and any other model taking an explicit `duration` input) —
  // Replicate honors this input as the output's actual length.
  if (typeof input.duration === 'number') return input.duration;
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
    } else if (rung.model.includes('whisper')) {
      // Transcription fallback — transcribe the (already-generated) audio.
      input = {
        audio: job.audioUrl,
        model: 'large-v3',
        transcription: 'srt',
        language: 'en',
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
    return { taskRef: String(r.id ?? ''), outputUrls, durationS: replicateOutDuration(r), raw };
  },

  async poll(taskRef: string, _rung: Rung): Promise<PollResult> {
    const resp = await fetch(`${REP}/predictions/${encodeURIComponent(taskRef)}`, {
      headers: { Authorization: `Bearer ${env('REPLICATE_API_TOKEN')}` },
    });
    const json = (await resp.json()) as Record<string, unknown>;
    const status = String(json.status ?? '');

    if (status === 'succeeded') {
      return { done: true, outputUrls: normalizeOutput(json.output), durationS: replicateOutDuration(json) };
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
    return { taskRef: String(p.id ?? ''), outputUrls, failed, durationS: replicateOutDuration(p) };
  },

  classifyError(code: number, _raw: unknown): ErrClass {
    if (code === 429) return 'Transient';
    if (code === 402) return 'TerminalProvider';
    if (code === 422) return 'TerminalPermanent';
    if (code >= 500) return 'Transient';
    return 'TerminalRetryable';
  },
};
