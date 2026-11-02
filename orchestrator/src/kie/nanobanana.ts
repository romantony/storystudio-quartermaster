/**
 * KIE Nano Banana 2.1 — the hosted fallback for the RunPod Qwen image kinds (2026-11-01).
 *
 * A `qwen-image-gen`, `qwen-edit`, `ref2-edit` or `comfy-last` row whose RunPod attempt failed or
 * timed out is retried here instead of on RunPod (assets/agent.ts `usesKieQwen`). One model covers
 * both generation and edit; the RunPod payload is translated, not rebuilt, so the fallback renders
 * exactly what the builder asked for:
 *
 *   { prompt, aspect_ratio }   -> nano-banana-2-1 { prompt, aspect_ratio, resolution: 1K, output_format: png }
 *   { image_url, prompt }      -> nano-banana-2-1 { prompt, image_input: [url..], aspect_ratio, resolution: 1K, output_format: png }
 *
 * Same createTask -> recordInfo contract as Seedance (kie/seedance.ts). KIE's result links expire,
 * so the caller re-hosts the bytes in R2, and the still is conformed to the project frame size
 * (1280x720 / 720x1280) like any RunPod still — 1K is already above that, so no 2K/4K.
 */
import { KIE_BASE, KieError, kieJson, type KieTransport } from './seedance';

export const NANO_BANANA_MODEL = 'nano-banana-2-1';
/** KIE's documented caps. */
export const NANO_BANANA_PROMPT_MAX = 20_000;
export const NANO_BANANA_MAX_IMAGES = 10;
export const NANO_BANANA_RESOLUTION = '1K';

export const KIE_IMAGE_POLL_INTERVAL_MS = 4_000;
/** A still is seconds on KIE; bounded well under assets/agent.ts's orphan window. */
export const KIE_IMAGE_MAX_WAIT_MS = 5 * 60_000;

const ASPECTS = new Set(['1:1', '2:3', '3:2', '1:4', '4:1', '3:4', '4:3', '4:5', '5:4', '1:8', '8:1', '9:16', '16:9', '21:9']);

/** Any aspect the model takes passes through; anything else maps to its orientation's 16:9 / 9:16. */
export function nanoBananaAspect(aspect: unknown): string {
  const a = String(aspect ?? '').replace(/\s+/g, '');
  if (ASPECTS.has(a)) return a;
  const m = a.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  return m && Number(m[1]) < Number(m[2]) ? '9:16' : '16:9';
}

export interface KieImageRequest {
  model: typeof NANO_BANANA_MODEL;
  input: Record<string, unknown>;
}

/**
 * Translate a RunPod qwen payload. `frameAspect` is the frame's own aspect ratio, used when the
 * payload carries none (the edit endpoint's payload never does).
 */
export function kieImageRequestFromRunpod(payload: Record<string, unknown>, frameAspect?: string): KieImageRequest {
  const prompt = String(payload.prompt ?? '').trim();
  if (!prompt) throw new Error(`kie ${NANO_BANANA_MODEL}: the payload has no prompt`);
  const input: Record<string, unknown> = {
    prompt: prompt.slice(0, NANO_BANANA_PROMPT_MAX),
    aspect_ratio: nanoBananaAspect(payload.aspect_ratio ?? frameAspect),
    resolution: NANO_BANANA_RESOLUTION,
    output_format: 'png',
  };
  const imageUrl = payload.image_url;
  if (imageUrl !== undefined && imageUrl !== null && imageUrl !== '') {
    const urls = (Array.isArray(imageUrl) ? imageUrl : [imageUrl]).map(String).filter((u) => /^https?:\/\//.test(u));
    if (!urls.length) throw new Error(`kie ${NANO_BANANA_MODEL}: image_url is not an http url: ${JSON.stringify(imageUrl).slice(0, 120)}`);
    input.image_input = urls.slice(0, NANO_BANANA_MAX_IMAGES);
  }
  return { model: NANO_BANANA_MODEL, input };
}

export interface KieImageResult {
  taskId: string;
  imageUrl: string;
  costTimeMs: number | null;
}

/** createTask (retrying rate-limit/5xx), then poll until success | fail. */
export async function runKieImage(t: KieTransport, req: KieImageRequest, onTask?: (taskId: string) => Promise<void>): Promise<KieImageResult> {
  const sleep = t.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = t.pollIntervalMs ?? KIE_IMAGE_POLL_INTERVAL_MS;
  const maxWait = t.maxWaitMs ?? KIE_IMAGE_MAX_WAIT_MS;

  let taskId = '';
  let last: unknown;
  for (let attempt = 1; attempt <= 3 && !taskId; attempt++) {
    try {
      const body = await kieJson(t, `${KIE_BASE}/createTask`, { method: 'POST', body: JSON.stringify(req) }, `${req.model} createTask`);
      taskId = String(body?.data?.taskId ?? '');
      if (!taskId) throw new KieError(`${req.model} createTask: no taskId in response`, false);
    } catch (err) {
      last = err;
      if (!(err instanceof KieError) || !err.retryable || attempt === 3) throw err;
      await sleep(3_000 * 2 ** (attempt - 1));
    }
  }
  if (!taskId) throw last;
  if (onTask) await onTask(taskId);

  for (let waited = 0; waited <= maxWait; waited += interval) {
    await sleep(interval);
    let data: any;
    try {
      data = (await kieJson(t, `${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, { method: 'GET' }, `${req.model} recordInfo`)).data;
    } catch (err) {
      // A transient poll failure must not lose a task that is already paid for.
      if (!(err instanceof KieError) || !err.retryable) throw err;
      continue;
    }
    if (data?.state === 'success') {
      let urls: unknown;
      try {
        urls = JSON.parse(String(data.resultJson ?? '{}'))?.resultUrls;
      } catch {
        urls = undefined;
      }
      const imageUrl = Array.isArray(urls) ? String(urls[0] ?? '') : '';
      if (!/^https?:\/\//.test(imageUrl)) throw new Error(`${req.model} task ${taskId} succeeded with no result url`);
      return { taskId, imageUrl, costTimeMs: typeof data.costTime === 'number' ? data.costTime : null };
    }
    if (data?.state === 'fail') throw new Error(`${req.model} task ${taskId} failed [${data.failCode ?? '?'}]: ${data.failMsg ?? 'unknown error'}`);
  }
  throw new Error(`${req.model} task ${taskId} did not finish within ${Math.round(maxWait / 60_000)} min`);
}
