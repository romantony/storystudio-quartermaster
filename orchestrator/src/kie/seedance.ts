/**
 * KIE transport for the `seedance-video` asset (Dialogue Premium, 2026-10-23).
 *
 * Seedance 2 Mini (`bytedance/seedance-2-mini`) turns the frame's still into a clip WITH ITS OWN
 * SPEECH: the dialogue sits in the prompt and the model voices it, so Dialogue Premium plans no TTS.
 * The contract is the one StoryStudio's Convex side already uses (backend/convex/
 * seedance2MiniGeneration.ts): POST /jobs/createTask, then poll GET /jobs/recordInfo until
 * `state` is success | fail. The signed output link expires, so the caller re-hosts the bytes in R2
 * before completing the row (the 2026-08-17 lesson, same as comfy-video).
 *
 * First-frame image-to-video only. KIE: first/last frame and reference images are mutually
 * exclusive; a dialogue shot is anchored by its still, which already carries both characters
 * (qwen-image-edit composite), so reference mode is never used here.
 */

export const KIE_BASE = 'https://api.kie.ai/api/v1/jobs';
export const SEEDANCE_MODEL = 'bytedance/seedance-2-mini';

/** KIE's integer-second range for this model. */
export const SEEDANCE_MIN_S = 4;
export const SEEDANCE_MAX_S = 15;

export const SEEDANCE_POLL_INTERVAL_MS = 10_000;
/** A 15 s clip with speech takes minutes (Convex allowed 5). Kept UNDER assets/agent.ts's
 * LAMBDA_ORPHAN_RECOVERY_MS (10 min): this call blocks the row, and past that window reconcile
 * would requeue a row whose KIE task is still running and pay for it twice. */
export const SEEDANCE_MAX_WAIT_MS = 9 * 60_000;

export type SeedanceAspect = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9';

export interface KieTransport {
  apiKey: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export interface SeedanceRequest {
  prompt: string;
  firstFrameUrl: string;
  durationS: number;
  aspectRatio: SeedanceAspect;
  /** "480p" | "720p". The tail's finalize step upscales to the target resolution. */
  resolution?: '480p' | '720p';
}

export interface SeedanceResult {
  taskId: string;
  videoUrl: string;
  costTimeMs: number | null;
}

export function clampSeedanceDuration(seconds: number): number {
  return Math.min(SEEDANCE_MAX_S, Math.max(SEEDANCE_MIN_S, Math.round(seconds)));
}

/** The aspect ratios KIE takes; anything else falls back to the frame's nearest. */
export function seedanceAspect(aspectRatio: string | undefined): SeedanceAspect {
  const a = String(aspectRatio ?? '').replace(/\s+/g, '');
  if (a === '9:16' || a === '1:1' || a === '4:3' || a === '3:4' || a === '21:9') return a;
  return '16:9';
}

export function buildSeedanceInput(req: SeedanceRequest): Record<string, unknown> {
  return {
    model: SEEDANCE_MODEL,
    input: {
      prompt: req.prompt,
      first_frame_url: req.firstFrameUrl,
      // The speech is the point of this model: never ask for a silent clip.
      generate_audio: true,
      resolution: req.resolution ?? '720p',
      aspect_ratio: req.aspectRatio,
      duration: clampSeedanceDuration(req.durationS),
      nsfw_checker: false,
    },
  };
}

class KieError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'KieError';
  }
}

async function kieJson(t: KieTransport, url: string, init: RequestInit, what: string): Promise<any> {
  const f = t.fetchImpl ?? fetch;
  const res = await f(url, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.apiKey}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new KieError(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`, res.status === 429 || res.status >= 500);
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new KieError(`${what}: response is not JSON: ${text.slice(0, 200)}`, true);
  }
  if (body?.code !== 200) throw new KieError(`${what}: code ${body?.code} ${body?.msg ?? ''}`, body?.code === 429 || body?.code >= 500);
  return body;
}

/** One createTask. Retries only rate-limit/5xx, with a short backoff. */
export async function createSeedanceTask(t: KieTransport, req: SeedanceRequest): Promise<string> {
  const sleep = t.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const body = await kieJson(t, `${KIE_BASE}/createTask`, { method: 'POST', body: JSON.stringify(buildSeedanceInput(req)) }, 'seedance createTask');
      const taskId = body?.data?.taskId;
      if (!taskId) throw new KieError('seedance createTask: no taskId in response', false);
      return String(taskId);
    } catch (err) {
      last = err;
      if (!(err instanceof KieError) || !err.retryable || attempt === 3) break;
      await sleep(5_000 * 2 ** (attempt - 1));
    }
  }
  throw last;
}

/** Poll until the task finishes; `onTask` fires once with the id so the caller can record it. */
export async function runSeedance(t: KieTransport, req: SeedanceRequest, onTask?: (taskId: string) => Promise<void>): Promise<SeedanceResult> {
  const sleep = t.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = t.pollIntervalMs ?? SEEDANCE_POLL_INTERVAL_MS;
  const maxWait = t.maxWaitMs ?? SEEDANCE_MAX_WAIT_MS;

  const taskId = await createSeedanceTask(t, req);
  if (onTask) await onTask(taskId);

  let waited = 0;
  while (waited <= maxWait) {
    let data: any;
    try {
      data = (await kieJson(t, `${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, { method: 'GET' }, 'seedance recordInfo')).data;
    } catch (err) {
      // A transient poll failure must not lose a task that is already paid for.
      if (!(err instanceof KieError) || !err.retryable) throw err;
      data = { state: 'waiting' };
    }
    if (data?.state === 'success') {
      let urls: unknown;
      try {
        urls = JSON.parse(String(data.resultJson ?? '{}'))?.resultUrls;
      } catch {
        urls = undefined;
      }
      const videoUrl = Array.isArray(urls) ? String(urls[0] ?? '') : '';
      if (!videoUrl) throw new Error(`seedance task ${taskId} succeeded with no result url`);
      return { taskId, videoUrl, costTimeMs: typeof data.costTime === 'number' ? data.costTime : null };
    }
    if (data?.state === 'fail') {
      throw new Error(`seedance task ${taskId} failed [${data.failCode ?? '?'}]: ${data.failMsg ?? 'unknown error'}`);
    }
    await sleep(interval);
    waited += interval;
  }
  throw new Error(`seedance task ${taskId} did not finish within ${Math.round(maxWait / 60_000)} min`);
}
