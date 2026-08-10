import type {
  Adapter, BuiltRequest, CanonicalJob, ErrClass,
  PollResult, Rung, SubmitResult,
} from '../types';

/**
 * RunComfy InfiniteTalk — Dialogue Basic's narrator lip-sync
 * (community/infinite-talk/fast, mono) and Dialogue Premium's two-speaker
 * exchanges (community/infinite-talk/fast/multi). External, per-second
 * billed, not part of the RunPod fleet — see providers.runcomfy in
 * background.json and fleet.ts's header comment.
 *
 * Request/response shapes confirmed 2026-08-09 against RunComfy's own API
 * reference pages (not just inferred from the handoff doc's behavioral
 * description):
 *   https://www.runcomfy.com/models/community/infinite-talk/fast/api
 *   https://www.runcomfy.com/models/community/infinite-talk/fast/multi/api
 * Mono: {audio, image, prompt?, seed?} -> {request_id}. Multi: {left_audio,
 * right_audio, image, prompt?, order?, seed?} -> {request_id} — `order`
 * (enum "meanwhile"|"left_right"|"right_left", default "left_right") is sent
 * explicitly here even though it matches the default, so a future change to
 * RunComfy's own default can't silently change playback order out from under
 * the +1.00s-pad/trim assumption (§7.4/§7.6.6). Status:
 * GET /v1/requests/{request_id}/status -> {status: in_queue|in_progress|
 * completed|cancelled}. Result: GET /v1/requests/{request_id}/result ->
 * {video} (string) or {videos} (array) among possible fields.
 *
 * Async submit/poll only (supportsWebhook:false) — §7.6.4 of
 * storystudio-dialogue-qm-sfn-handoff.md measured 86-106s wall clock across a
 * 2x duration range, comfortably inside the executor's poll tolerance; no
 * webhook path exists on this API (confirmed by the reference pages too —
 * no callback/webhook parameter on submit).
 */

const RUNCOMFY = 'https://model-api.runcomfy.net/v1';
const env = (k: string) => process.env[k] ?? '';

export const runcomfy: Adapter = {
  supportsWebhook: false,

  buildRequest(job: CanonicalJob, rung: Rung, _callbackUrl?: string): BuiltRequest {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env('RUNCOMFY_API_KEY')}`,
    };
    const image = job.initImageUrls?.[0];

    // community/infinite-talk/fast/multi — Dialogue Premium `kind:"dialogue"`
    // shots. Exactly one exchange per call (storystudio-dialogue-qm-sfn-
    // handoff.md §7.5): left_audio drives the camera-left face, right_audio
    // the camera-right face, played sequentially (not mixed) with a fixed
    // +1.00s trailing pad that callers must trim (TrimToTrackLength, §7.6.6).
    if (rung.model === 'community/infinite-talk/fast/multi') {
      return {
        url: `${RUNCOMFY}/models/${rung.model}`,
        method: 'POST',
        headers,
        body: {
          left_audio: job.params.leftAudioUrl,
          right_audio: job.params.rightAudioUrl,
          image,
          ...(job.prompt ? { prompt: job.prompt } : {}),
          order: 'left_right',
        },
      };
    }

    // community/infinite-talk/fast (mono) — Dialogue Basic's narrator
    // segments and Dialogue Premium `kind:"monologue"` shots. No trailing
    // pad — output_duration == input audio duration exactly (§7.6.5).
    return {
      url: `${RUNCOMFY}/models/${rung.model}`,
      method: 'POST',
      headers,
      body: {
        audio: job.audioUrl,
        image,
        ...(job.prompt ? { prompt: job.prompt } : {}),
      },
    };
  },

  parseSubmit(raw: unknown): SubmitResult {
    const r = raw as Record<string, unknown>;
    const requestId = r.request_id ?? r.requestId ?? r.id;
    if (!requestId) {
      throw Object.assign(new Error('RunComfy submit failed: no request_id in response'), { raw });
    }
    return { taskRef: String(requestId), raw };
  },

  async poll(taskRef: string): Promise<PollResult> {
    const headers = { Authorization: `Bearer ${env('RUNCOMFY_API_KEY')}` };

    const statusResp = await fetch(`${RUNCOMFY}/requests/${encodeURIComponent(taskRef)}/status`, { headers });
    const statusJson = (await statusResp.json()) as Record<string, unknown>;
    const status = String(statusJson.status ?? '').toLowerCase();

    if (status === 'in_queue' || status === 'in_progress') return { done: false };
    if (status === 'cancelled' || status === 'failed' || status === 'error') {
      return { done: true, failed: true, error: `RunComfy request ${taskRef} status=${status}` };
    }
    if (status !== 'completed') return { done: false };

    const resultResp = await fetch(`${RUNCOMFY}/requests/${encodeURIComponent(taskRef)}/result`, { headers });
    const resultJson = (await resultResp.json()) as Record<string, unknown>;
    const url = runcomfyOutUrl(resultJson);
    if (!url) {
      return { done: true, failed: true, error: `RunComfy request ${taskRef} completed with no output URL` };
    }
    return { done: true, outputUrls: [url] };
  },

  classifyError(httpCode: number, _raw: unknown): ErrClass {
    if (httpCode === 401 || httpCode === 403) return 'TerminalProvider'; // bad/expired key
    if (httpCode === 429 || httpCode >= 500) return 'Transient';
    return 'TerminalRetryable';
  },
};

// Dig a video URL out of RunComfy's result envelope. `video` (string) /
// `videos` (array) are the two fields confirmed on the reference pages;
// the rest are defensive fallbacks matching the family of key names the
// runpod/kie adapters already tolerate, in case a future model variant
// shapes its result differently.
function runcomfyOutUrl(p: unknown): string | undefined {
  const dig = (x: unknown): string | undefined => {
    if (typeof x === 'string' && x.startsWith('http')) return x;
    if (Array.isArray(x)) return x.map(dig).find(Boolean);
    if (x && typeof x === 'object') {
      const keys = ['video', 'videos', 'video_url', 'videoUrl', 'output_url', 'url', 'output', 'outputs', 'result'];
      return keys.map(k => dig((x as Record<string, unknown>)[k])).find(Boolean);
    }
    return undefined;
  };
  return dig(p);
}
