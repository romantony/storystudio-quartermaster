import type {
  Adapter, BuiltRequest, CanonicalJob, ErrClass,
  PollResult, Rung, SubmitResult, WebhookParseResult,
} from '../types';

const RUNPOD = 'https://api.runpod.ai/v2';
const env = (k: string) => process.env[k] ?? '';

// Dig an asset URL out of RunPod's variable output shape. Extended beyond video
// to cover the Flux-TTS-S2T / qwen endpoints (image, audio, srt).
function runpodOutUrl(p: unknown): string | undefined {
  const dig = (x: unknown): string | undefined => {
    if (typeof x === 'string' && x.startsWith('http')) return x;
    if (Array.isArray(x)) return x.map(dig).find(Boolean);
    if (x && typeof x === 'object') {
      const keys = [
        'image', 'image_url', 'imageUrl', 'audio', 'audio_url', 'srt', 'srt_url',
        'video_url', 'videoUrl', 'output_url', 'url', 'output', 'result', 'video', 'artifacts',
      ];
      return keys.map(k => dig((x as Record<string, unknown>)[k])).find(Boolean);
    }
    return undefined;
  };
  return dig(p);
}

const TERMINAL_STATUSES = new Set(['FAILED', 'ERROR', 'CANCELLED', 'TIMED_OUT']);

/**
 * Base URL for a rung's RunPod endpoint. Self-hosted Flux-TTS-S2T / qwen rungs
 * carry an explicit `endpointId` (the serverless endpoint id, e.g.
 * rnqxi6c0mlq517); the legacy lipsync rung uses the named `/infinitetalk` route.
 */
function endpointBase(rung: Rung): string {
  if (rung.endpointId) return `${RUNPOD}/${rung.endpointId}`;
  return `${RUNPOD}/infinitetalk`;
}

// Build the `input` object for a self-hosted Flux-TTS-S2T / qwen generation,
// keyed on the rung's `mode`. Mirrors /home/roman-antony/runpod/API.md.
function buildRunpodInput(job: CanonicalJob, rung: Rung): Record<string, unknown> {
  const p = job.params;
  const attribution: Record<string, unknown> = {};
  if (job.projectId) attribution.project_id = job.projectId;
  if (job.frameId) attribution.frame_id = job.frameId;

  switch (rung.mode) {
    case 'image': {
      // Flux-TTS-S2T image mode — T2I / I2I (reference_images).
      return {
        mode: 'image',
        image_prompt: job.prompt,
        aspect_ratio: p.aspectRatio ?? '16:9',
        reference_images: job.initImageUrls ?? [],
        img_steps: 4,
        img_guidance: 1.0,
        ...attribution,
      };
    }
    case 't2i': {
      // Standalone qwen-image-gen endpoint.
      return {
        prompt: job.prompt,
        aspect_ratio: p.aspectRatio ?? '16:9',
        ...attribution,
      };
    }
    case 'i2i': {
      // Standalone qwen-image-edit endpoint.
      return {
        image_url: job.initImageUrls?.[0],
        prompt: job.prompt,
        ...attribution,
      };
    }
    case 'tts': {
      if (rung.engine === 'qwen') {
        // Qwen3-TTS design / voice-clone.
        const input: Record<string, unknown> = {
          mode: 'tts',
          engine: 'qwen',
          text: job.prompt,
          language: p.language ?? 'English',
          instruct: p.instruct ?? '',
          ...attribution,
        };
        if (p.voiceUrl) {
          input.voice_url = p.voiceUrl;
          input.voice_transcript = p.voiceTranscript ?? '';
        } else {
          input.speaker = p.speaker ?? 'Ryan';
        }
        return input;
      }
      // Kokoro (default).
      return {
        mode: 'tts',
        engine: 'kokoro',
        text: job.prompt,
        voice: p.voice ?? 'am_michael',
        speed: 1.0,
        lang_code: 'a',
        ...attribution,
      };
    }
    case 'bgm': {
      // ACE-Step reliably generates only ~120-180s of music; a full-length track
      // (e.g. 366s for a 5-min project) fails or hangs, then spills to the slow
      // KIE fallback and times out (observed 2026-07-04). Generate at most
      // BGM_MAX_DURATION_S and let the downstream mix loop it to fill the video —
      // background music loops fine, and the legacy preset-track path always
      // supplied short loops that finalize looped anyway.
      const requested = p.durationS ?? 30.0;
      const cap = Number(process.env.BGM_MAX_DURATION_S ?? 120);
      return {
        mode: 'bgm',
        prompt: job.prompt,
        duration_s: Math.min(requested, cap),
        steps: 20,
        guidance: 7.0,
        ...attribution,
      };
    }
    case 'transcribe': {
      return {
        mode: 'transcribe',
        audio_url: job.audioUrl,
        task: 'transcribe',
        language: 'en',
        return_timestamps: 'word',
        ...attribution,
      };
    }
    case 'animate': {
      // Ken Burns zoom/pan on a still image → silent MP4. `ken_burns` is the
      // smooth cinematic effect (replaces the jittery local render).
      return {
        mode: 'animate',
        image_url: job.initImageUrls?.[0],
        duration_s: p.durationS ?? 5,
        effect: rung.fixed?.effect ?? 'ken_burns',
        fps: 24,
        ...attribution,
      };
    }
    case 'merge': {
      // Combine a (silent) video with an audio track → MP4 with audio.
      // initImageUrls[0] carries the video URL; audioUrl carries the voice.
      return {
        mode: 'merge',
        video_url: job.initImageUrls?.[0],
        audio_url: job.audioUrl,
        ...attribution,
      };
    }
    case 'pipeline': {
      // Narration-basic one-shot: image → Kokoro TTS → animate → merge in a
      // single call (all models resident in VRAM), replacing 4 separate QM jobs.
      // caption:false — SRT is produced project-level (Whisper on concat audio);
      // no bgm here — BGM is one project-level call over the whole video.
      // reference_images only when a non-empty character ref is present (else t2i).
      const refs = (job.initImageUrls ?? []).filter((u) => typeof u === 'string' && u.length > 0);
      return {
        mode: 'pipeline',
        image_prompt: job.prompt,
        voice_text: p.voiceText ?? '',
        tts_engine: 'kokoro',
        tts_voice: p.voice ?? 'am_michael',
        effect: p.effect ?? rung.fixed?.effect ?? 'ken_burns',
        aspect_ratio: p.aspectRatio ?? '9:16',
        caption: false,
        ...(refs.length ? { reference_images: refs } : {}),
        ...attribution,
      };
    }
    case 'i2v': {
      // Wan2.2 I2V-A14B (4-step Lightning). Aspect ratio inherits from the
      // input image; `resolution` only sets the pixel budget. duration_s is one
      // of 3–7 (→ frame_num = duration_s*16+1). Standalone Wan2 endpoint.
      return {
        image: job.initImageUrls?.[0],
        prompt: job.prompt ?? '',
        resolution: rung.fixed?.resolution ?? '480p',
        duration_s: p.durationS ?? 5,
        sample_steps: 4,
        ...attribution,
      };
    }
    default:
      // Fallback: pass the prompt through untouched.
      return { prompt: job.prompt, ...attribution };
  }
}

export const runpod: Adapter = {
  supportsWebhook: true,

  buildRequest(job: CanonicalJob, rung: Rung, callbackUrl?: string): BuiltRequest {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env('RUNPOD_API_KEY')}`,
    };

    // Self-hosted Flux-TTS-S2T / qwen endpoints (identified by endpointId).
    if (rung.endpointId) {
      const input = buildRunpodInput(job, rung);
      const body: Record<string, unknown> = { input };
      if (callbackUrl) body.webhook = callbackUrl;
      return { url: `${endpointBase(rung)}/run`, method: 'POST', headers, body };
    }

    // Legacy InfiniteTalk lipsync (Documentary Premium) — unchanged.
    const body: Record<string, unknown> = {
      input: {
        prompt: job.prompt,
        image: job.initImageUrls?.[0],    // spokesperson image (must be COMPLETE)
        audio: job.audioUrl,              // TTS output URL (must be COMPLETE)
        resolution: rung.resolution ?? job.params.resolution ?? '720p',
        enable_safety_checker: true,
      },
    };
    if (callbackUrl) body.webhook = callbackUrl;

    return { url: `${RUNPOD}/infinitetalk/run`, method: 'POST', headers, body };
  },

  parseSubmit(raw: unknown): SubmitResult {
    // RunPod /run may return a completed job synchronously (warm, fast modes)
    // with `output` already populated, or just an id for async polling.
    const r = raw as Record<string, unknown>;
    const status = String(r.status ?? '').toUpperCase();
    if (status === 'COMPLETED') {
      const url = runpodOutUrl(r);
      if (url) return { outputUrls: [url], raw };
    }
    const url = runpodOutUrl(raw);
    if (url) return { outputUrls: [url], raw };
    return { taskRef: String(r.id ?? ''), raw };
  },

  async poll(taskRef: string, rung: Rung): Promise<PollResult> {
    const resp = await fetch(`${endpointBase(rung)}/status/${encodeURIComponent(taskRef)}`, {
      headers: { Authorization: `Bearer ${env('RUNPOD_API_KEY')}` },
    });
    const json = (await resp.json()) as Record<string, unknown>;
    const status = String(json.status ?? '').toUpperCase();

    if (status === 'COMPLETED') {
      const url = runpodOutUrl(json);
      return { done: true, outputUrls: url ? [url] : undefined };
    }
    if (TERMINAL_STATUSES.has(status)) {
      const out = json.output as Record<string, unknown> | undefined;
      const error = (json.error ?? out?.error ?? JSON.stringify(json).slice(0, 300)) as string;
      return { done: true, failed: true, error: `status=${status} ${error}` };
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
