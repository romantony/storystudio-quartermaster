/**
 * HTTP client for the doc-gen API (https://doc-gen.ai-storystudio.com).
 *
 * The instance is stopped between jobs, so "not up" is a normal answer, not an
 * error: CloudFront returns 502/504 (HTML, not JSON) while it boots, and the
 * very first health call after a boot can 504 even when the service is fine
 * (the Storyblocks check outlasts CloudFront's 30 s limit). `health()` maps all
 * of that to `null`. Every other non-2xx throws a DocgenHttpError carrying the
 * contract's `{error:{code,...}}` body, so callers branch on `code`
 * ('busy', 'not_ready', 'wrong_checkpoint', ...), not on prose.
 */
import type { DocgenHealth, DocgenStartPayload, DocgenStatus, DocgenWebhookBody } from './types';

export class DocgenHttpError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    public readonly body: unknown,
  ) {
    super(`doc-gen ${httpStatus} ${code}`);
  }
}

/** The request never produced a usable answer (network, timeout, or a CloudFront 502/504 page). */
export class DocgenUnreachableError extends Error {}

export interface DocgenClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DocgenClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DocgenClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    // Above CloudFront's 30 s origin timeout, so CloudFront's own 504 wins the race.
    this.timeoutMs = opts.timeoutMs ?? 35_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DocgenUnreachableError(String((err as Error)?.message ?? err));
    }
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON: a CloudFront error page, or a stopped/booting instance.
      if (res.status === 502 || res.status === 504 || res.status === 503) {
        throw new DocgenUnreachableError(`HTTP ${res.status} (non-JSON)`);
      }
      throw new DocgenHttpError(res.status, res.status === 403 ? 'cloudfront_forbidden' : 'non_json', text.slice(0, 200));
    }
    if (res.status >= 200 && res.status < 300) return { status: res.status, data: data as T };
    const code = (data as { error?: { code?: string } } | undefined)?.error?.code ?? `http_${res.status}`;
    throw new DocgenHttpError(res.status, code, data);
  }

  /**
   * `null` = not up yet (stopped, booting, or slow). A `ready:false` body is
   * returned as-is — the instance is up but needs a person (e.g. Storyblocks
   * sign-in), which the caller must tell apart from "still booting".
   */
  async health(): Promise<DocgenHealth | null> {
    try {
      const { data } = await this.json<DocgenHealth>('GET', '/v1/health');
      return data;
    } catch (err) {
      if (err instanceof DocgenUnreachableError) return null;
      // 503 not_ready still carries the health body (`checks`) under the error envelope or at top level.
      if (err instanceof DocgenHttpError && err.httpStatus === 503) {
        const b = err.body as Partial<DocgenHealth> & { error?: { checks?: DocgenHealth['checks'] } };
        return {
          ready: false,
          busy: b.busy ?? false,
          current_job_id: b.current_job_id ?? null,
          checks: b.checks ?? b.error?.checks ?? {},
          ...(b.image ? { image: b.image } : {}),
        };
      }
      throw err;
    }
  }

  /** 202 = new job, 200 = this request_id was seen before (idempotent). */
  async start(payload: DocgenStartPayload): Promise<{ created: boolean; jobId: string; state: string }> {
    const { status, data } = await this.json<{ job_id: string; state: string }>('POST', '/v1/documentaries', payload);
    return { created: status === 202, jobId: data.job_id, state: data.state };
  }

  async status(jobId: string): Promise<DocgenStatus> {
    return (await this.json<DocgenStatus>('GET', `/v1/documentaries/${encodeURIComponent(jobId)}`)).data;
  }

  /** Real events after `afterSeq`; heartbeats are never in this list. */
  async events(jobId: string, afterSeq: number): Promise<DocgenWebhookBody[]> {
    const { data } = await this.json<{ events: DocgenWebhookBody[] }>(
      'GET',
      `/v1/documentaries/${encodeURIComponent(jobId)}/events?after_seq=${afterSeq}`,
    );
    return data.events ?? [];
  }

  async respond(jobId: string, a: { checkpointId: string; action: 'approve' | 'revise' | 'abort'; instructions?: string }): Promise<DocgenStatus> {
    return (
      await this.json<DocgenStatus>('POST', `/v1/documentaries/${encodeURIComponent(jobId)}/respond`, {
        checkpoint_id: a.checkpointId,
        action: a.action,
        instructions: a.instructions ?? '',
      })
    ).data;
  }

  async cancel(jobId: string): Promise<DocgenStatus> {
    return (await this.json<DocgenStatus>('POST', `/v1/documentaries/${encodeURIComponent(jobId)}/cancel`, {})).data;
  }

  /** A file from the job's run folder (review files, or an output whose upload failed). */
  async file(jobId: string, path: string): Promise<{ bytes: Buffer; contentType: string | null }> {
    const res = await this.raw('GET', `/v1/documentaries/${encodeURIComponent(jobId)}/files/${path.split('/').map(encodeURIComponent).join('/')}`);
    if (!res.ok) throw new DocgenHttpError(res.status, res.status === 404 ? 'not_found' : `http_${res.status}`, null);
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
  }
}
