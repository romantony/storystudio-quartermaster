/**
 * The single transport to RunPod. Every call the orchestrator makes goes
 * through here: /run, /status, /cancel, /health on api.runpod.ai, and the
 * worker-count PATCH on rest.runpod.io.
 *
 * Guarantees this layer provides so callers do not each reinvent them:
 *   - a hard per-call deadline (AbortController), never an open-ended fetch;
 *   - retry with jittered exponential backoff on Transient failures
 *     (429, >=500, network error, timeout), capped at cfg.runpodMaxRetries;
 *   - a typed RunpodError carrying the HTTP status and its ErrClass for
 *     everything else, so a caller can branch on Transient vs Terminal.
 *
 * Retry taxonomy is src/adapters/runpod.ts's classifyError, unchanged.
 *
 * NOTE (spec §6.3): patchWorkers must have exactly one caller — agents/fleet.ts.
 * That constraint is enforced by a test in a later milestone, not here.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../config';
import { log } from '../telemetry/log';
import {
  classifyError,
  RunpodError,
  type HealthResponse,
  type PatchWorkersBody,
  type RunResponse,
  type StatusResponse,
} from './types';

type FetchLike = typeof fetch;

export interface RunpodClientDeps {
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable for tests so backoff does not actually wait. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class RunpodClient {
  private readonly apiBase: string;
  private readonly restBase: string;
  private readonly apiKey: string | undefined;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(
    cfg: Pick<
      Config,
      'runpodApiBase' | 'runpodRestBase' | 'runpodApiKey' | 'runpodMaxRetries' | 'runpodTimeoutMs'
    >,
    deps: RunpodClientDeps = {},
  ) {
    this.apiBase = cfg.runpodApiBase.replace(/\/$/, '');
    this.restBase = cfg.runpodRestBase.replace(/\/$/, '');
    this.apiKey = cfg.runpodApiKey;
    this.maxRetries = cfg.runpodMaxRetries;
    this.timeoutMs = cfg.runpodTimeoutMs;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleepImpl = deps.sleepImpl ?? ((ms) => sleep(ms));
  }

  // ── serverless job API (api.runpod.ai/v2) ──────────────────────────────

  /** POST /v2/{endpointId}/run. `webhook` is per-job (spec §7.2). */
  run(endpointId: string, input: unknown, webhookUrl?: string): Promise<RunResponse> {
    const body: Record<string, unknown> = { input };
    if (webhookUrl) body.webhook = webhookUrl;
    return this.request<RunResponse>('POST', `${this.apiBase}/${endpointId}/run`, body);
  }

  /** GET /v2/{endpointId}/status/{jobId}. The reconciliation fallback path. */
  status(endpointId: string, jobId: string): Promise<StatusResponse> {
    return this.request<StatusResponse>(
      'GET',
      `${this.apiBase}/${endpointId}/status/${encodeURIComponent(jobId)}`,
    );
  }

  /** POST /v2/{endpointId}/cancel/{jobId}. Used on stall/abort before draining. */
  cancel(endpointId: string, jobId: string): Promise<unknown> {
    return this.request<unknown>(
      'POST',
      `${this.apiBase}/${endpointId}/cancel/${encodeURIComponent(jobId)}`,
    );
  }

  /** GET /v2/{endpointId}/health. The verify in "verify, never assume". */
  health(endpointId: string): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', `${this.apiBase}/${endpointId}/health`);
  }

  // ── management API (rest.runpod.io/v1) ─────────────────────────────────

  /**
   * PATCH /v1/endpoints/{endpointId} { workersMin, workersMax }. The only call
   * that changes a worker count. Ported from provisioner.ts's patchRunPod().
   */
  patchWorkers(endpointId: string, body: PatchWorkersBody): Promise<unknown> {
    return this.request<unknown>('PATCH', `${this.restBase}/endpoints/${endpointId}`, body);
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    body?: unknown,
  ): Promise<T> {
    let attempt = 0;
    // attempt 0 is the first try; up to maxRetries additional tries.
    for (;;) {
      try {
        return await this.once<T>(method, url, body);
      } catch (err) {
        const retriable = err instanceof RunpodError ? err.klass === 'Transient' : true; // network/timeout
        if (!retriable || attempt >= this.maxRetries) throw err;
        const wait = backoffMs(attempt);
        log().warn(
          { url, method, attempt, wait, err: err instanceof Error ? err.message : err },
          'runpod call failed, retrying',
        );
        await this.sleepImpl(wait);
        attempt += 1;
      }
    }
  }

  private async once<T>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    body?: unknown,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });

      const text = await res.text();
      const parsed = text ? safeJson(text) : undefined;

      if (!res.ok) {
        throw new RunpodError(
          `RunPod ${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          classifyError(res.status),
          parsed,
        );
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof RunpodError) throw err;
      if ((err as Error)?.name === 'AbortError') {
        // A timeout is Transient — surfaced as a RunpodError(0) so the retry
        // loop and callers treat it uniformly.
        throw new RunpodError(`RunPod ${method} ${url} timed out after ${this.timeoutMs}ms`, 0, 'Transient');
      }
      throw new RunpodError(
        `RunPod ${method} ${url} failed: ${(err as Error)?.message ?? err}`,
        0,
        'Transient',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Full jitter: random in [0, base * 2^attempt], capped at 20s. */
export function backoffMs(attempt: number): number {
  const ceiling = Math.min(20_000, 500 * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
