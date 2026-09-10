/**
 * Replicate transport for the quality gates (impl plan §6.5, M4). Ported
 * from the AWS-side `dialogue-basic-qa-agent`'s `llm_client.py`, which is
 * itself explicitly generic/copy-verbatim prior art — same VLM (Replicate-
 * hosted `google/gemini-2.5-flash`, fallback `google/gemini-3-pro`), same
 * create-prediction + poll + fallback-on-any-failure shape.
 *
 * Predictions are async exactly like RunPod jobs, but nothing registers a
 * webhook with Replicate here — polling is the only option. Uses a fixed
 * poll interval (matching the proven Python original, `_POLL_INTERVAL=3s`)
 * rather than `runpod/client.ts`'s exponential-backoff jitter — that jitter
 * exists to spread out retries after a FAILED request; this is polling a
 * not-yet-done async job, where a steady cadence is the right shape, not
 * backoff.
 *
 * A thrown error here (timeout, both models failed) means "this evaluation
 * didn't run" — an infra failure, not a content verdict. agents/quality.ts
 * must not consume a rework attempt for it.
 */

export interface ReplicateDeps {
  apiToken: string | undefined;
  apiBase: string;
  visionModel: string;
  visionModelFallback: string;
  pollIntervalMs: number;
  maxPollAttempts: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface VisionCallInput {
  systemPrompt: string;
  userMsg: string;
  imageUrls?: string[];
  videoUrls?: string[];
}

export class ReplicateError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ReplicateError';
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function extractOutputText(output: unknown): string {
  if (Array.isArray(output)) return output.map((x) => String(x)).join('');
  return output == null ? '' : String(output);
}

/** Extract the first JSON object/array from free-form LLM text — direct
 * parse, then a markdown code fence, then a greedy first-brace/last-brace
 * scan. Ported verbatim from llm_client.py's _extract_json. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // fall through
    }
  }
  for (const [startChar, endChar] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = trimmed.indexOf(startChar);
    const end = trimmed.lastIndexOf(endChar);
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // try the next bracket pair
      }
    }
  }
  throw new ReplicateError(`no valid JSON found in LLM output: ${trimmed.slice(0, 300)}`);
}

async function createPrediction(deps: ReplicateDeps, model: string, body: unknown): Promise<{ id: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetchImpl(`${deps.apiBase}/models/${model}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.apiToken ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: body }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new ReplicateError(`Replicate POST /models/${model}/predictions -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function getPrediction(deps: ReplicateDeps, id: string): Promise<{ status: string; output?: unknown; error?: unknown }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const res = await fetchImpl(`${deps.apiBase}/predictions/${id}`, {
      headers: { Authorization: `Bearer ${deps.apiToken ?? ''}` },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new ReplicateError(`Replicate GET /predictions/${id} -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function pollPrediction(deps: ReplicateDeps, id: string): Promise<unknown> {
  const sleep = deps.sleepImpl ?? defaultSleep;
  for (let i = 0; i < deps.maxPollAttempts; i++) {
    const result = await getPrediction(deps, id);
    if (result.status === 'succeeded') return result.output;
    if (result.status === 'failed' || result.status === 'canceled') {
      throw new ReplicateError(`Replicate prediction ${id} ${result.status}: ${JSON.stringify(result.error)}`);
    }
    await sleep(deps.pollIntervalMs);
  }
  throw new ReplicateError(`Replicate prediction ${id} timed out after ${deps.maxPollAttempts * deps.pollIntervalMs}ms`);
}

async function runModel(deps: ReplicateDeps, model: string, input: VisionCallInput): Promise<unknown> {
  const body = {
    prompt: input.userMsg,
    system_instruction: input.systemPrompt || '',
    images: (input.imageUrls ?? []).filter(Boolean),
    videos: (input.videoUrls ?? []).filter(Boolean),
    max_output_tokens: 4096,
    temperature: 0.2,
    top_p: 0.95,
  };
  const prediction = await createPrediction(deps, model, body);
  const output = await pollPrediction(deps, prediction.id);
  return extractJson(extractOutputText(output));
}

/**
 * Calls the primary vision model; on ANY failure (network, non-2xx, bad
 * JSON, terminal failed/canceled prediction, timeout), retries once against
 * the fallback model — a model fallback, not an open-ended retry loop,
 * matching llm_client.py's exact try/primary/except/fallback structure.
 */
export async function callVisionJson(deps: ReplicateDeps, input: VisionCallInput): Promise<unknown> {
  try {
    return await runModel(deps, deps.visionModel, input);
  } catch (err) {
    try {
      return await runModel(deps, deps.visionModelFallback, input);
    } catch (fallbackErr) {
      throw new ReplicateError(
        `both vision models failed (primary: ${deps.visionModel}, fallback: ${deps.visionModelFallback})`,
        { primary: err, fallback: fallbackErr },
      );
    }
  }
}
