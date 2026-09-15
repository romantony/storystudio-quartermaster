/**
 * Callback delivery (impl plan §6.7, M5, 2026-09-15). POSTs a project's §9.6
 * result to its `callback_url` with exponential backoff: 8 attempts, delays
 * 1s -> 4s -> 16s -> 64s -> 256s -> 300s cap (~15.7 min worst case).
 *
 * Retried: network errors/timeouts, 5xx, 408, 425, 429. Any other non-2xx is
 * a permanent rejection (the receiver understood the request and refused it;
 * retrying won't change that). Every attempt is reported through
 * `onAttempt` so the caller can persist it as it happens, not only at the end.
 *
 * When a secret is configured, the body is signed:
 * `X-QM-Signature: sha256=<hex HMAC-SHA256(secret, rawBody)>`. The receiver
 * must verify against the raw body bytes, not re-serialized JSON.
 */
import { createHmac } from 'node:crypto';

export interface CallbackAttempt {
  attempt: number;
  at: string;
  durationMs: number;
  httpStatus?: number;
  error?: string;
}

export type CallbackOutcome = 'delivered' | 'rejected' | 'exhausted';

export interface DeliverOptions {
  url: string;
  body: unknown;
  requestId: string;
  secret?: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  onAttempt?: (a: CallbackAttempt) => Promise<void> | void;
}

const RETRYABLE_4XX = new Set([408, 425, 429]);

export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 4 ** (attempt - 1), maxDelayMs);
}

export function signBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export async function deliverCallback(opts: DeliverOptions): Promise<{ outcome: CallbackOutcome; attempts: CallbackAttempt[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rawBody = JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'qm-orchestrator/1',
    'x-qm-request-id': opts.requestId,
  };
  if (opts.secret) headers['x-qm-signature'] = signBody(opts.secret, rawBody);

  const attempts: CallbackAttempt[] = [];
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const started = Date.now();
    const record: CallbackAttempt = { attempt, at: new Date(started).toISOString(), durationMs: 0 };
    let retryable = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetchImpl(opts.url, { method: 'POST', headers, body: rawBody, signal: controller.signal });
      record.httpStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        record.durationMs = Date.now() - started;
        attempts.push(record);
        await opts.onAttempt?.(record);
        return { outcome: 'delivered', attempts };
      }
      retryable = res.status >= 500 || RETRYABLE_4XX.has(res.status);
    } catch (err) {
      record.error = controller.signal.aborted ? `timeout after ${opts.timeoutMs}ms` : String((err as Error)?.message ?? err);
    } finally {
      clearTimeout(timer);
    }
    record.durationMs = Date.now() - started;
    attempts.push(record);
    await opts.onAttempt?.(record);
    if (!retryable) return { outcome: 'rejected', attempts };
    if (attempt < opts.maxAttempts) await sleep(backoffDelayMs(attempt, opts.baseDelayMs, opts.maxDelayMs));
  }
  return { outcome: 'exhausted', attempts };
}
