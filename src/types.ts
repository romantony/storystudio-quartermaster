// ─── Enumerations ────────────────────────────────────────────────────────────

export type JobStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETE'
  | 'COMPLETE_WITH_FALLBACKS'
  | 'FAILED'
  | 'DEAD';

export type Lane = 'video' | 'rest' | 'none';

export type Priority = 'P0' | 'P1' | 'P2';

export type ErrClass =
  | 'Transient'
  | 'TerminalRetryable'
  | 'TerminalPermanent'
  | 'TerminalProvider';

export type Queue = 'background' | 'foreground';

export type JobType = 'batch' | 'realtime';

// ─── Catalog / Adapter types ─────────────────────────────────────────────────

export interface Rung {
  provider: string;
  model: string;
  modelId?: string;
  endpoint?: string;
  lane: Lane;
  routingMode: 'aggregated' | 'direct' | 'render' | 'stock';
  fixed?: Record<string, string>;
  fb?: boolean;
  needs?: string[];
  resolution?: string;
  note?: string;
  // RunPod-internal rungs only: the Flux-TTS-S2T mode (image|tts|bgm|transcribe)
  // or standalone-endpoint marker. Drives request shaping in the runpod adapter.
  mode?: string;
  // RunPod-internal rungs only: the serverless endpoint ID (e.g. rnqxi6c0mlq517)
  // and the QM per-endpoint semaphore counter key (e.g. "runpod:flux-tts-s2t").
  endpointId?: string;
  counterKey?: string;
  // RunPod-internal rungs only: engine selector for tts (kokoro|qwen).
  engine?: string;
}

export interface CatalogLadder {
  aliasOf?: string;
  rungs?: Rung[];
}

export interface ProviderConfig {
  limit: number;
  floors?: { video: number; rest: number };
  secretEnv: string;
  note?: string;
}

export interface CircuitConfig {
  errorThreshold: number;
  windowSeconds: number;
  minSamples: number;
  openCooldownSeconds: number;
  halfOpenProbes: number;
}

export interface Catalog {
  version: string;
  providers: Record<string, ProviderConfig>;
  circuit: CircuitConfig;
  ladders: Record<string, Rung[] | { aliasOf: string }>;
}

// ─── Canonical Job (§29.2) ───────────────────────────────────────────────────

export interface CanonicalJobParams {
  aspectRatio?: string;
  resolution?: string;
  durationS?: number;
  generateAudio?: boolean;
  voice?: string;
  width?: string;
  height?: string;
  // TTS: reference-voice fields for Qwen voice-clone / instruct design
  voiceUrl?: string;
  voiceTranscript?: string;
  instruct?: string;
  speaker?: string;
  language?: string;
}

export interface CanonicalJob {
  assetType: string;
  tier: string;
  operation: string;
  product: string;
  queue: Queue;
  requestId: string;
  jobId: string;
  prompt: string;
  initImageUrls?: string[];
  audioUrl?: string;
  dependsOn?: string[];
  params: CanonicalJobParams;
  s3Target: string;
  manifestRef?: string;
  // attribution (§20)
  platform?: string;
  projectId?: string;
  frameId?: string;
  userId?: string;
  priority?: Priority;
  // batch → internal RunPod first (absorbs cold start); realtime → internal
  // only if warm+free slot, else external. Absent → ladder order unchanged.
  jobType?: JobType;
  // rung keys already attempted (so retries/failover don't repeat a dead rung).
  triedRungs?: string[];
}

// ─── DynamoDB Job Item ────────────────────────────────────────────────────────

export interface JobItem {
  pk: string;           // REQ#{requestId}
  sk: string;           // JOB#{jobId}
  status: JobStatus;
  lane: Lane;
  priority: Priority;
  enqueueSeq: string;   // epoch_ms#jobId — sort key for queue-index GSI
  provider?: string;
  model?: string;
  endpoint?: string;
  params?: CanonicalJobParams;
  prompt?: string;
  initImageUrls?: string[];
  audioUrl?: string;
  dependsOn?: string[];
  s3Target: string;
  manifestRef?: string;
  assetKey?: string;
  attempts: number;
  leaseId?: string;
  leaseExpiry?: number; // epoch ms
  platform?: string;
  projectId?: string;
  frameId?: string;
  userId?: string;
  requestId: string;
  jobId: string;
  jobType?: JobType;
  triedRungs?: string[];
  assetType?: string;
  tier?: string;
  operation?: string;
  queue?: Queue;
  createdAt: number;    // epoch ms
  updatedAt: number;    // epoch ms
  degraded?: Array<{ jobId: string; reason: string }>;
  errorReason?: string;
}

// ─── Semaphore Item ───────────────────────────────────────────────────────────

export interface SemaphoreItem {
  pk: 'COUNTER#modelslab';
  sk: 'SEMAPHORE';
  video_inflight: number;
  rest_inflight: number;
}

// ─── Lease Item ───────────────────────────────────────────────────────────────

export interface LeaseItem {
  pk: string;        // LEASE#{leaseId}
  sk: 'LEASE';
  leaseId: string;
  lane: Lane;
  tenant: string;
  leaseExpiry: number;
  acquiredAt: number;
  // Set for RunPod-style single-counter leases (COUNTER#runpod:*). When absent,
  // the lease belongs to the modelslab video/rest floor semaphore.
  counterKey?: string;
}

// ─── Webhook Token Map ────────────────────────────────────────────────────────

export interface ProviderTaskItem {
  pk: string;       // PROVIDERTASK#{provider}#{taskRef}
  sk: 'TOKEN';
  jobId: string;
  requestId: string;
  taskToken?: string;
  s3Target: string;
  createdAt: number;
  ttl: number;      // Unix epoch seconds for DynamoDB TTL auto-delete
  claimed?: boolean;
  // Slot-release + failover context so webhook.ts can free the semaphore slot
  // and (on failure) re-invoke the executor to try the next rung.
  provider?: string;
  leaseId?: string;
  leaseCounterKey?: string;   // COUNTER#{key} the slot was taken from
}

// ─── Circuit Breaker Item ─────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface HealthItem {
  pk: 'HEALTH';
  sk: string;        // {provider}:{endpoint}
  state: CircuitState;
  errorCount: number;
  sampleCount: number;
  windowStart: number;
  openedAt?: number;
  updatedAt: number;
}

// ─── Admin / Config Items ─────────────────────────────────────────────────────

export interface ProviderConfigItem {
  pk: 'PROVIDER';
  sk: string;         // provider name
  baseUrl: string;
  authType: 'bearer' | 'key-field';
  secretArn: string;
  keyLast4: string;
  limit: number;
  floors?: { video: number; rest: number };
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface PriceItem {
  pk: 'PRICE';
  sk: string;         // {provider}#{model}
  unitCostUsd: number;
  unit: 'request' | 'second' | 'clip' | '1Kpx';
  currency: 'USD';
  updatedAt: number;
  updatedBy: string;
}

export interface BalanceItem {
  pk: 'BALANCE';
  sk: string;         // provider name
  balanceUsd: number;
  source: 'api' | 'estimated';
  lastTopupUsd?: number;
  lastTopupAt?: number;
  thresholdUsd: number;
  burnUsdPerDay: number;
  runwayDays: number;
  updatedAt: number;
}

export interface AuditItem {
  pk: 'AUDIT';
  sk: string;         // {timestamp}#{actor}
  action: string;
  target: string;
  before?: unknown;
  after?: unknown;
  actor: string;
  timestamp: number;
}

export interface MeteringItem {
  pk: string;         // USAGE:{projectId}:{yyyymmdd}
  sk: string;         // {model}:count | {model}:slot_ms
  value: number;
}

/**
 * Self-updating per-asset generation-time baseline (EWMA of PROCESSING→COMPLETE
 * wall time), keyed per internal RunPod endpoint. Written by the executor on each
 * successful internal generation; read by the admission gate to estimate drain/wait.
 */
export interface BaselineItem {
  pk: string;         // BASELINE#{counterKey}   e.g. BASELINE#runpod:flux-tts-s2t
  sk: string;         // {assetType}.{tier}.{operation}   e.g. image.narrationBasic.t2i
  ewmaMs: number;     // exponentially-weighted mean generation time
  samples: number;    // number of observations folded in
  lastMs: number;     // most recent observation
  updatedAt: number;  // epoch ms
  p95Ms?: number;     // reserved for later
}

// ─── RunPod endpoint provisioning state (§Pillar 2) ──────────────────────────

/**
 * One item per RunPod serverless endpoint QM provisions. Caches the last-known
 * workersMin/Max so the provisioner can compute deltas, and records the last
 * time the endpoint had a non-empty queue (drives the scale-to-zero cooldown).
 */
export interface RunPodEndpointItem {
  pk: 'RUNPODENDPOINT';
  sk: string;             // counterKey, e.g. "runpod:flux-tts-s2t"
  endpointId: string;     // RunPod endpoint id, e.g. "rnqxi6c0mlq517"
  workersMin: number;
  workersMax: number;
  lastBusyAt?: number;    // epoch ms — last tick with queued+inflight > 0
  updatedAt: number;
}

/**
 * Shadow-mode audit of a scale decision the provisioner *would* have made.
 * Written instead of calling RunPod's management PATCH until provisioning goes live.
 */
export interface ProvisionShadowItem {
  pk: 'PROVISION_SHADOW';
  sk: string;             // {timestamp}#{counterKey}
  counterKey: string;
  endpointId: string;
  reason: string;         // e.g. "prewarm", "scale-up", "scale-to-zero", "hold"
  fromWorkersMax: number;
  toWorkersMax: number;
  fromWorkersMin: number;
  toWorkersMin: number;
  queued: number;
  inflight: number;
  timestamp: number;
}

// ─── Broker API shapes ────────────────────────────────────────────────────────

export interface AcquireRequest {
  tenant: string;
  lane: Lane;
  priority: Priority;
  endpoint: string;
  estDurationMs?: number;
  leaseId?: string;
}

export interface AcquireResponse {
  granted: boolean;
  leaseId?: string;
  retryAfterMs?: number;
}

export interface ReleaseRequest {
  leaseId: string;
  lane: Lane;
  outcome?: 'success' | 'failure' | 'timeout';
  slotMs?: number;
  // attribution for metering
  platform?: string;
  projectId?: string;
  requestId?: string;
  model?: string;
  provider?: string;
  endpoint?: string;
}

export interface ReleaseResponse {
  released: boolean;
}

export interface HeartbeatRequest {
  leaseId: string;
  lane: Lane;
}

export interface HeartbeatResponse {
  extended: boolean;
}

// ─── Ingest / Status API shapes ───────────────────────────────────────────────

export interface IngestResponse {
  jobId: string;
  requestId: string;
  status: JobStatus;
  assetKey?: string;
}

export interface StatusResponse {
  requestId: string;
  status: JobStatus;
  assetKey?: string;
  degraded?: Array<{ jobId: string; reason: string }>;
  errorReason?: string;
  attempts?: number;
  createdAt?: number;
  updatedAt?: number;
}

// ─── Adapter interface (§29.2) ────────────────────────────────────────────────

export interface BuiltRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: unknown;
}

export interface SubmitResult {
  outputUrls?: string[];
  taskRef?: string;
  raw: unknown;
}

export interface PollResult {
  done: boolean;
  outputUrls?: string[];
  failed?: boolean;
  retryAfterMs?: number;
}

export interface WebhookParseResult {
  taskRef: string;
  outputUrls?: string[];
  failed?: boolean;
}

export interface Adapter {
  supportsWebhook: boolean;
  buildRequest(job: CanonicalJob, rung: Rung, callbackUrl?: string): BuiltRequest;
  parseSubmit(raw: unknown): SubmitResult;
  poll(taskRef: string, rung: Rung): Promise<PollResult>;
  parseWebhook?(payload: unknown): WebhookParseResult;
  classifyError(httpCode: number, raw: unknown): ErrClass;
}

// ─── Lambda Function URL event shapes ────────────────────────────────────────

export interface LambdaFunctionUrlEvent {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    http: {
      method: string;
      path: string;
      protocol: string;
      sourceIp: string;
      userAgent: string;
    };
    requestId: string;
    routeKey: string;
    stage: string;
    time: string;
    timeEpoch: number;
  };
  body?: string;
  isBase64Encoded: boolean;
  cookies?: string[];
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
}

export interface LambdaFunctionUrlResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  cookies?: string[];
  isBase64Encoded?: boolean;
}
