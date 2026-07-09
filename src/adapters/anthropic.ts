import type {
  Adapter, BuiltRequest, CanonicalJob, ErrClass,
  PollResult, Rung, SubmitResult,
} from '../types';

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const env = (k: string) => process.env[k] ?? '';

/**
 * Claude Messages API — synchronous (one HTTP round trip, no async job to
 * poll). Used for the `llm` ladder's primary rung, currently only 4lang
 * translation (translate the English narration transcript into a target
 * language before localized TTS). `job.prompt` arrives fully assembled by
 * the caller (the ASL state builds the instruction via States.Format) — this
 * adapter is a plain pass-through to the API, no prompt construction here.
 */
export const anthropic: Adapter = {
  supportsWebhook: false,

  buildRequest(job: CanonicalJob, rung: Rung): BuiltRequest {
    return {
      url: ANTHROPIC,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env('ANTHROPIC_API_KEY'),
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: {
        model: rung.modelId ?? 'claude-sonnet-5',
        max_tokens: 4096,
        messages: [{ role: 'user', content: job.prompt }],
      },
    };
  },

  parseSubmit(raw: unknown): SubmitResult {
    const r = raw as { content?: Array<{ type?: string; text?: string }>; error?: { message?: string } };
    if (r.error) {
      throw Object.assign(new Error(`Anthropic error: ${r.error.message ?? 'unknown'}`), { raw });
    }
    const text = r.content?.find(c => c.type === 'text')?.text ?? r.content?.[0]?.text;
    if (!text) {
      throw Object.assign(new Error('Anthropic response had no text content'), { raw });
    }
    // Synchronous provider — the whole result is already here, so this rides
    // executor.ts's "sync completion" branch (outputUrls populated) same as
    // any provider that returns a media URL immediately. The translated text
    // itself is carried in `text`; `outputUrls[0]` mirrors it so the generic
    // completion path (which reads outputUrls[0] as the asset) still works —
    // both end up as JobItem.assetKey / .resultText respectively.
    return { outputUrls: [text], text, raw };
  },

  async poll(_taskRef: string, _rung: Rung): Promise<PollResult> {
    // Never invoked — parseSubmit always populates outputUrls on success
    // (Claude's API has no async job/polling model).
    return { done: true, failed: true, error: 'anthropic adapter has no poll path' };
  },

  classifyError(httpCode: number, _raw: unknown): ErrClass {
    if (httpCode === 429 || httpCode === 529) return 'Transient'; // rate-limited / overloaded
    if (httpCode === 401 || httpCode === 403 || httpCode === 400) return 'TerminalPermanent';
    if (httpCode >= 500) return 'Transient';
    return 'TerminalRetryable';
  },
};
