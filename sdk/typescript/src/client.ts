export type Lane = 'video' | 'rest' | 'none';
export type Priority = 'P0' | 'P1' | 'P2';
export type Queue = 'background' | 'foreground';
export type JobStatusStr =
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETE'
  | 'COMPLETE_WITH_FALLBACKS'
  | 'FAILED'
  | 'DEAD';

export interface AcquireOptions {
  tenant: string;
  lane: Lane;
  priority?: Priority;
  endpoint?: string;
  estDurationMs?: number;
  leaseId?: string;
}

export interface AcquireResponse {
  granted: boolean;
  leaseId?: string;
  retryAfterMs?: number;
}

export interface ReleaseOptions {
  leaseId: string;
  lane: Lane;
  outcome?: 'success' | 'failure' | 'timeout';
  slotMs?: number;
  platform?: string;
  projectId?: string;
  requestId?: string;
  model?: string;
  provider?: string;
  endpoint?: string;
}

export interface HeartbeatOptions {
  leaseId: string;
  lane: Lane;
}

export interface CanonicalJobParams {
  aspectRatio?: string;
  resolution?: string;
  durationS?: number;
  generateAudio?: boolean;
  voice?: string;
}

export interface CanonicalJob {
  assetType: string;
  tier: string;
  operation: string;
  product: string;
  queue: Queue;
  requestId: string;
  prompt: string;
  s3Target: string;
  initImageUrls?: string[];
  audioUrl?: string;
  dependsOn?: string[];
  params?: CanonicalJobParams;
  manifestRef?: string;
  platform?: string;
  projectId?: string;
  userId?: string;
  priority?: Priority;
  lane?: Lane;
}

export interface JobStatus {
  requestId: string;
  status: JobStatusStr;
  assetKey?: string;
  degraded?: Array<{ jobId: string; reason: string }>;
  errorReason?: string;
  attempts?: number;
}

export class QMError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 0,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'QMError';
  }
}

export class QMClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(baseUrl: string, gatewayKey: string) {
    this.base = baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      'X-Gateway-Key': gatewayKey,
    };
  }

  // ─── Broker mode ─────────────────────────────────────────────────────────

  async acquire(options: AcquireOptions): Promise<AcquireResponse> {
    return this.post<AcquireResponse>('/acquire', {
      tenant: options.tenant,
      lane: options.lane,
      priority: options.priority ?? 'P2',
      endpoint: options.endpoint ?? 'rest',
      estDurationMs: options.estDurationMs ?? 60_000,
      leaseId: options.leaseId,
    });
  }

  async acquireWithRetry(
    options: AcquireOptions & { maxWaitMs?: number },
  ): Promise<AcquireResponse> {
    const deadline = Date.now() + (options.maxWaitMs ?? 180_000);
    while (true) {
      const result = await this.acquire(options);
      if (result.granted) return result;
      const wait = result.retryAfterMs ?? 5_000;
      if (Date.now() + wait > deadline) {
        throw new QMError(`Could not acquire slot within ${options.maxWaitMs ?? 180_000}ms`);
      }
      await sleep(wait);
    }
  }

  async release(options: ReleaseOptions): Promise<boolean> {
    const resp = await this.post<{ released: boolean }>('/release', {
      leaseId: options.leaseId,
      lane: options.lane,
      outcome: options.outcome ?? 'success',
      slotMs: options.slotMs,
      platform: options.platform,
      projectId: options.projectId,
      requestId: options.requestId,
      model: options.model,
      provider: options.provider,
      endpoint: options.endpoint,
    });
    return resp.released;
  }

  async heartbeat(options: HeartbeatOptions): Promise<boolean> {
    const resp = await this.post<{ extended: boolean }>('/heartbeat', options);
    return resp.extended;
  }

  // ─── Job queue mode ───────────────────────────────────────────────────────

  async submit(job: CanonicalJob): Promise<string> {
    const resp = await this.post<{ jobId: string }>('/jobs', {
      assetType: job.assetType,
      tier: job.tier,
      operation: job.operation,
      product: job.product,
      queue: job.queue,
      requestId: job.requestId,
      prompt: job.prompt,
      s3Target: job.s3Target,
      params: job.params ?? {},
      priority: job.priority ?? 'P2',
      initImageUrls: job.initImageUrls,
      audioUrl: job.audioUrl,
      dependsOn: job.dependsOn,
      manifestRef: job.manifestRef,
      platform: job.platform,
      projectId: job.projectId,
      userId: job.userId,
      lane: job.lane,
    });
    return resp.jobId;
  }

  async getStatus(requestId: string): Promise<JobStatus> {
    return this.get<JobStatus>(`/jobs/${encodeURIComponent(requestId)}`);
  }

  async awaitComplete(
    requestId: string,
    options: { pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<JobStatus> {
    const { pollIntervalMs = 5_000, timeoutMs = 300_000 } = options;
    const terminal = new Set(['COMPLETE', 'COMPLETE_WITH_FALLBACKS', 'DEAD']);
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const status = await this.getStatus(requestId);
      if (terminal.has(status.status)) {
        if (status.status === 'DEAD') {
          throw new QMError(`Job ${requestId} died: ${status.errorReason}`, 0, status);
        }
        return status;
      }
      if (Date.now() > deadline) {
        throw new QMError(`Timed out waiting for job ${requestId} after ${timeoutMs}ms`);
      }
      await sleep(pollIntervalMs);
    }
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const resp = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return this.handle<T>(resp);
  }

  private async get<T>(path: string): Promise<T> {
    const resp = await fetch(`${this.base}${path}`, { headers: this.headers });
    return this.handle<T>(resp);
  }

  private async handle<T>(resp: Response): Promise<T> {
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    if (!resp.ok) {
      throw new QMError(
        `QM API error ${resp.status}: ${data?.error ?? resp.statusText}`,
        resp.status,
        data,
      );
    }
    return data as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
