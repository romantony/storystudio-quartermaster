import {
  DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { ADAPTERS } from '../adapters';
import { CatalogResolver } from '../catalog/resolver';
import { acquireSimple, releaseSimple } from '../gate/dynamo-gate';
import { isInternalRung, rungKey, selectRungOrder } from './router';
import { endpointWorkers } from '../shared/fleet';
import type {
  Adapter, CircuitConfig, JobItem, ProviderConfig, ProviderTaskItem, Queue, Rung,
} from '../types';

const TABLE = process.env.TABLE_NAME ?? 'quartermaster-jobs';
const WEBHOOK_BASE = process.env.WEBHOOK_BASE_URL ?? '';
// Fallback per-endpoint concurrency for any RunPod counterKey not in the FLEET
// table (shouldn't happen — every RunPod rung's counterKey is in fleet.ts).
const RUNPOD_ENDPOINT_LIMIT = Number(process.env.RUNPOD_ENDPOINT_LIMIT ?? 4);
// A healthy-but-full internal endpoint re-queues the job to wait for a worker
// slot instead of spilling routine overflow to the paid external fallback
// (internal-first). Bounded so a genuinely stuck endpoint can't starve a job
// forever — past this many capacity waits (~2-min sweeper ticks) the job is
// allowed to fall over to the external DR rung.
const MAX_CAPACITY_WAITS = Number(process.env.MAX_CAPACITY_WAITS ?? 20);
// Retry the SAME rung (same provider) this many times on a generation failure
// before failing over to the next rung — internal-first: give the primary
// provider a couple tries (transient 5xx/429/OOM) before spilling to the paid
// external fallback. Inline within one invocation; bounded so total stays under
// the Lambda timeout. A capacity-full pool still re-queues (not a retry).
const RUNG_MAX_ATTEMPTS = Number(process.env.RUNG_MAX_ATTEMPTS ?? 2);
const RUNG_RETRY_BACKOFF_MS = Number(process.env.RUNG_RETRY_BACKOFF_MS ?? 2_000);
const POLL_INTERVAL_MS = Number(process.env.EXECUTOR_POLL_INTERVAL_MS ?? 3_000);
const POLL_BUFFER_MS = 15_000; // stop polling this long before Lambda timeout
// The executor self-invokes to drain a backlog at worker rate
// (dispatchNextForEndpoint). Each self-invoke extends a Lambda→Lambda lineage
// chain, and AWS's recursive-loop detection DROPS invocations once a chain
// exceeds ~16 hops (RecursiveInvocationsDropped → account-level runaway
// termination — this happened 2026-07-04). The chain is provably finite (each
// hop consumes one QUEUED job), but AWS can't know that. So we self-terminate
// the chain well under 16 and let the 2-min sweeper (redispatchQueuedCanonical)
// drain the tail — each sweeper/api/webhook dispatch starts a FRESH lineage
// (depth 0), so we never approach the kill threshold.
const MAX_DISPATCH_CHAIN = Number(process.env.MAX_DISPATCH_CHAIN ?? 10);

const db = new DynamoDBClient({});
const sm = new SecretsManagerClient({});

interface ExecutorEvent {
  requestId: string;
  jobId: string;
  // Self-invoke chain depth (dispatchNextForEndpoint). Absent/0 for the first
  // dispatch of a lineage (api, webhook, sweeper); incremented on each
  // executor→executor hop and capped at MAX_DISPATCH_CHAIN to stay under AWS's
  // recursive-loop kill threshold.
  depth?: number;
}

interface LambdaContext {
  getRemainingTimeInMillis?: () => number;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export const handler = async (event: ExecutorEvent, context: LambdaContext = {}): Promise<void> => {
  const depth = event.depth ?? 0;
  const job = await loadJob(event.requestId, event.jobId);
  if (!job) {
    console.warn('[executor] job not found', event);
    return;
  }
  if (['COMPLETE', 'COMPLETE_WITH_FALLBACKS', 'DEAD'].includes(job.status)) {
    return; // already resolved
  }
  if (!job.assetType) {
    await markFailed(job, 'job missing assetType (not a catalog job)');
    return;
  }

  // Claim the job atomically (QUEUED → PROCESSING). If this fails, another
  // invocation already owns it — a real risk now that the sweeper re-dispatches
  // QUEUED canonical jobs (step 2), which could race the original dispatch or a
  // second sweeper tick. Without this guard two executors would each acquire a
  // worker slot for the same job and submit it twice.
  if (!(await claimJob(job))) {
    console.info('[executor] job already claimed by another invocation, skipping', event.jobId);
    return;
  }

  const resolver = CatalogResolver.forQueue((job.queue ?? 'background') as Queue);
  await hydrateSecrets(resolver.getCatalog().providers);

  const ladder = resolver.getLadder(job.assetType, job.tier, job.operation);
  if (!ladder.length) {
    await markFailed(job, `no ladder for ${job.assetType}.${job.tier}.${job.operation}`);
    return;
  }

  const ordered = await selectRungOrder(ladder, job.jobType);
  const tried = new Set(job.triedRungs ?? []);
  const cfg = resolver.getCircuitConfig();
  // Internal-first capacity model: if a healthy internal endpoint is full, we
  // wait for a worker slot (re-queue) rather than spill to the paid external
  // fallback — unless the job has already waited MAX_CAPACITY_WAITS times, in
  // which case we let it fall over (DR last resort).
  const canWaitForCapacity = (job.capacityWaits ?? 0) < MAX_CAPACITY_WAITS;

  for (const rung of ordered) {
    const key = rungKey(rung);
    if (tried.has(key)) continue;
    if (!ADAPTERS[rung.provider]) continue;          // no adapter (e.g. google direct) — skip
    if (await isCircuitOpen(key, cfg)) continue;      // dead endpoint (§27.4)

    const counterKey = rung.counterKey ?? rung.provider;
    const internal = isInternalRung(rung);
    const limit = rung.counterKey
      ? endpointWorkers(counterKey)                   // per-endpoint concurrency = real pod count (fleet.ts)
      : (resolver.getProviderConfig(rung.provider)?.limit ?? 10);

    const adapter = ADAPTERS[rung.provider];
    // Try the SAME rung up to RUNG_MAX_ATTEMPTS before failing over to the next
    // one (retry the provider first, spill to fallback only after). `advance`
    // means this rung is done trying → move to the next rung.
    let advance = false;
    for (let attempt = 1; attempt <= RUNG_MAX_ATTEMPTS && !advance; attempt++) {
      const acq = await acquireSimple(counterKey, limit, `job:${job.jobId}`);
      if (!acq.granted) {
        // Pool full. A healthy internal endpoint (circuit closed) → don't spill to
        // external: re-queue and let re-dispatch retry when a slot frees.
        if (internal && canWaitForCapacity) {
          await requeueForCapacity(job);
          return;
        }
        advance = true; break;                        // external full / wait budget spent → next rung
      }
      const leaseId = acq.leaseId!;
      // Mark rung tried on the first attempt so a re-invoke never repeats it;
      // in-invocation retries are governed by this loop, not triedRungs.
      if (attempt === 1) { tried.add(key); await appendTried(job, key); }

      try {
        const rungStart = Date.now();
        const callbackUrl = internal ? undefined : `${WEBHOOK_BASE}/webhooks/${rung.provider}`;
        const raw = await submit(adapter, job, rung, callbackUrl);
        const result = adapter.parseSubmit(raw);

        // Sync completion (provider returned URLs immediately).
        if (result.outputUrls?.length) {
          await complete(job, result.outputUrls[0], rung.fb);
          await recordBaseline(rung, job, Date.now() - rungStart);
          await releaseSimple(counterKey, leaseId);
          if (internal) await dispatchNextForEndpoint(counterKey, depth).catch(() => {});
          await feedCircuit(key, true, cfg);
          return;
        }

        if (internal) {
          const url = await pollInline(adapter, result.taskRef ?? '', rung, context, key);
          await releaseSimple(counterKey, leaseId);
          // Slot freed — feed the pod its next queued job at worker rate (not a
          // 2-min sweeper tick); the sweeper stays the safety net.
          await dispatchNextForEndpoint(counterKey, depth).catch(() => {});
          if (url) {
            await complete(job, url, rung.fb);
            await recordBaseline(rung, job, Date.now() - rungStart);
            await feedCircuit(key, true, cfg);
            return;
          }
          await feedCircuit(key, false, cfg);
          // Generation failed — retry the SAME rung before failover.
          if (attempt < RUNG_MAX_ATTEMPTS) { await sleep(RUNG_RETRY_BACKOFF_MS * attempt); continue; }
          advance = true; break;                      // same-provider retries exhausted → next rung
        }

        // Webhook-capable external rung: hand off; webhook.ts completes/releases.
        if (!result.taskRef) {
          await releaseSimple(counterKey, leaseId);
          await feedCircuit(key, false, cfg);
          if (attempt < RUNG_MAX_ATTEMPTS) { await sleep(RUNG_RETRY_BACKOFF_MS * attempt); continue; }
          advance = true; break;
        }
        await putProviderTask(rung.provider, result.taskRef, job, leaseId, counterKey);
        return; // await callback (slot stays held until webhook releases it)
      } catch (err) {
        const httpCode = (err as { httpCode?: number }).httpCode ?? 500;
        // `raw` is the provider's actual response body (attached by submit()) —
        // e.g. Replicate's validation message on a 422. Previously discarded,
        // logging only httpCode + a generic "submit 422" message gave no way
        // to tell WHAT was rejected (2026-07-05: DR fallback silently failed
        // 422 then 429 for Wan2 i2v with no visibility into either cause).
        const raw = (err as { raw?: unknown }).raw;
        const rawStr = raw !== undefined ? JSON.stringify(raw).slice(0, 300) : '(no body)';
        await releaseSimple(counterKey, leaseId);
        if (internal) await dispatchNextForEndpoint(counterKey, depth).catch(() => {});
        await feedCircuit(key, false, cfg);
        console.warn('[executor] rung attempt failed', key, `attempt ${attempt}/${RUNG_MAX_ATTEMPTS}`, httpCode, (err as Error).message, rawStr);
        if (attempt < RUNG_MAX_ATTEMPTS) { await sleep(RUNG_RETRY_BACKOFF_MS * attempt); continue; }
        advance = true; break;                        // exhausted → next rung
      }
    }
  }

  await markFailed(job, 'all rungs exhausted');
};

// ─── Submit / poll ────────────────────────────────────────────────────────────

async function submit(adapter: Adapter, job: JobItem, rung: Rung, callbackUrl?: string): Promise<unknown> {
  const req = adapter.buildRequest(job as unknown as import('../types').CanonicalJob, rung, callbackUrl);
  const resp = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
  const text = await resp.text();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { raw = text; }
  if (!resp.ok) {
    throw Object.assign(new Error(`submit ${resp.status}`), { httpCode: resp.status, raw });
  }
  return raw;
}

async function pollInline(
  adapter: Adapter, taskRef: string, rung: Rung, context: LambdaContext, key: string,
): Promise<string | undefined> {
  if (!taskRef) return undefined;
  const remaining = () => context.getRemainingTimeInMillis?.() ?? Number.MAX_SAFE_INTEGER;
  while (remaining() > POLL_BUFFER_MS) {
    const res = await adapter.poll(taskRef, rung);
    if (res.done) {
      if (res.failed) {
        // Previously silent — an internal generation failure never threw, so
        // nothing was logged (2026-07-05: 13+ of 17 Wan2 i2v frames failed
        // with zero trace). Adapters best-effort populate `error`.
        console.warn('[executor] internal generation failed', key, 'taskRef', taskRef, res.error ?? '(no error detail)');
      }
      return res.failed ? undefined : res.outputUrls?.[0];
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.warn('[executor] internal generation poll timed out', key, 'taskRef', taskRef, `remaining=${remaining()}ms`);
  return undefined; // timed out
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Job status writes ──────────────────────────────────────────────────────

async function loadJob(requestId: string, jobId: string): Promise<JobItem | null> {
  const r = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: `REQ#${requestId}`, sk: `JOB#${jobId}` }),
  }));
  return r.Item ? (unmarshall(r.Item) as JobItem) : null;
}

/** Resolve the internal endpoint counterKey a QUEUED job would route to (catalog). */
function jobCounterKey(job: JobItem): string | undefined {
  if (!job.assetType) return undefined;
  const resolver = CatalogResolver.forQueue((job.queue ?? 'background') as Queue);
  const ladder = resolver.getLadder(job.assetType, job.tier, job.operation);
  return ladder.find(isInternalRung)?.counterKey;
}

/**
 * A worker slot on `counterKey` just freed — immediately dispatch the oldest
 * QUEUED job that routes to it, so a backlog drains at the pod's worker rate
 * instead of waiting for the next 2-min sweeper tick. Dispatches ONE job; that
 * job's own completion pulls the next, chaining through the backlog. The atomic
 * claimJob guard makes a race with the sweeper (or a sibling release) a no-op.
 *
 * `depth` is this executor invocation's position in the self-invoke chain. Once
 * it reaches MAX_DISPATCH_CHAIN we STOP chaining (any remaining QUEUED jobs are
 * picked up by the next sweeper tick, starting a fresh lineage) so the chain
 * never trips AWS's recursive-loop detection (~16-hop kill → RunawayTermination).
 */
async function dispatchNextForEndpoint(counterKey: string, depth: number): Promise<void> {
  const fn = process.env.AWS_LAMBDA_FUNCTION_NAME;
  if (!fn) return;
  if (depth + 1 >= MAX_DISPATCH_CHAIN) {
    // Chain length budget spent — hand the backlog tail to the 2-min sweeper
    // rather than extend the lineage toward AWS's recursion kill threshold.
    console.info('[executor] dispatch chain cap reached, deferring to sweeper', counterKey, `depth=${depth}`);
    return;
  }
  for (const lane of ['video', 'rest']) {
    const res = await db.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'queue-index',
      KeyConditionExpression: '#lane = :lane',
      FilterExpression: '#status = :q AND attribute_exists(assetType)',
      ExpressionAttributeNames: { '#lane': 'lane', '#status': 'status' },
      ExpressionAttributeValues: marshall({ ':lane': lane, ':q': 'QUEUED' }),
    })); // queue-index sorts by enqueueSeq → oldest first
    for (const raw of res.Items ?? []) {
      const j = unmarshall(raw) as JobItem;
      if (jobCounterKey(j) === counterKey) {
        const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
        await new LambdaClient({}).send(new InvokeCommand({
          FunctionName: fn,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ requestId: j.requestId, jobId: j.jobId, depth: depth + 1 })),
        }));
        return; // one dispatch; its completion pulls the next
      }
    }
  }
}

/**
 * Atomically claim a QUEUED job (→ PROCESSING). Returns false if the job is no
 * longer QUEUED (another executor invocation already owns it) — the caller must
 * then abort. Idempotent-safe under the sweeper's re-dispatch of QUEUED jobs.
 */
async function claimJob(job: JobItem): Promise<boolean> {
  try {
    await db.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: job.pk, sk: job.sk }),
      UpdateExpression: 'SET #s = :p, updatedAt = :now',
      ConditionExpression: '#s = :q',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: marshall({ ':p': 'PROCESSING', ':q': 'QUEUED', ':now': Date.now() }),
    }));
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/**
 * Re-queue a job that found its healthy internal endpoint at capacity: PROCESSING
 * → QUEUED, bump capacityWaits (NOT attempts — a capacity wait isn't a failure),
 * so the next sweeper tick re-dispatches it when a worker slot frees.
 */
async function requeueForCapacity(job: JobItem): Promise<void> {
  await db.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: job.pk, sk: job.sk }),
    UpdateExpression: 'SET #s = :q, updatedAt = :now, capacityWaits = if_not_exists(capacityWaits, :zero) + :one',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({ ':q': 'QUEUED', ':now': Date.now(), ':zero': 0, ':one': 1 }),
  }));
  console.info('[executor] re-queued for capacity (internal endpoint full)', job.jobId,
    `capacityWaits=${(job.capacityWaits ?? 0) + 1}`);
}

async function appendTried(job: JobItem, key: string): Promise<void> {
  await db.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: job.pk, sk: job.sk }),
    UpdateExpression: 'SET triedRungs = list_append(if_not_exists(triedRungs, :empty), :k)',
    ExpressionAttributeValues: marshall({ ':empty': [], ':k': [key] }),
  }));
}

async function complete(job: JobItem, assetKey: string, fallback?: boolean): Promise<void> {
  await db.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: job.pk, sk: job.sk }),
    UpdateExpression: 'SET #s = :s, assetKey = :ak, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({
      ':s': fallback ? 'COMPLETE_WITH_FALLBACKS' : 'COMPLETE',
      ':ak': assetKey,
      ':now': Date.now(),
    }),
  }));
  console.info('[executor] COMPLETE', job.requestId, job.jobId, assetKey);
}

/**
 * Fold a successful internal generation's wall time (submit→complete) into the
 * per-asset EWMA baseline: BASELINE#{counterKey} / {assetType}.{tier}.{operation}.
 * Internal RunPod rungs only (guarded by counterKey — external rungs have none).
 * Best-effort: baselines are advisory (drive admission ETAs), never fail the job.
 */
async function recordBaseline(rung: Rung, job: JobItem, genMs: number): Promise<void> {
  if (!rung.counterKey || genMs <= 0) return;
  const asset = `${job.assetType}.${job.tier ?? 'na'}.${job.operation ?? 'na'}`;
  const alpha = Number(process.env.BASELINE_EWMA_ALPHA ?? 0.2);
  const pk = `BASELINE#${rung.counterKey}`;
  try {
    const cur = await db.send(new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ pk, sk: asset }),
      ProjectionExpression: 'ewmaMs',
    }));
    const prev = cur.Item ? (unmarshall(cur.Item) as { ewmaMs?: number }) : {};
    const ewmaMs = prev.ewmaMs == null ? genMs : Math.round(alpha * genMs + (1 - alpha) * prev.ewmaMs);
    await db.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ pk, sk: asset }),
      UpdateExpression:
        'SET ewmaMs = :e, samples = if_not_exists(samples, :zero) + :one, lastMs = :l, updatedAt = :u',
      ExpressionAttributeValues: marshall({ ':e': ewmaMs, ':zero': 0, ':one': 1, ':l': genMs, ':u': Date.now() }),
    }));
  } catch (e) {
    console.warn('[executor] baseline record failed', pk, asset, (e as Error).message);
  }
}

async function markFailed(job: JobItem, reason: string): Promise<void> {
  await db.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: job.pk, sk: job.sk }),
    UpdateExpression: 'SET #s = :s, errorReason = :r, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({ ':s': 'FAILED', ':r': reason, ':now': Date.now() }),
  }));
  console.warn('[executor] FAILED', job.requestId, job.jobId, reason);
}

async function putProviderTask(
  provider: string, taskRef: string, job: JobItem, leaseId: string, leaseCounterKey: string,
): Promise<void> {
  const now = Date.now();
  const item: ProviderTaskItem = {
    pk: `PROVIDERTASK#${provider}#${taskRef}`,
    sk: 'TOKEN',
    jobId: job.jobId,
    requestId: job.requestId,
    s3Target: job.s3Target,
    createdAt: now,
    ttl: Math.floor(now / 1000) + 24 * 3600,
    provider,
    leaseId,
    leaseCounterKey,
  };
  await db.send(new PutItemCommand({ TableName: TABLE, Item: marshall(item, { removeUndefinedValues: true }) }));
}

// ─── Secret hydration ───────────────────────────────────────────────────────
// Adapters read raw keys from process.env[secretEnv]; the Lambda only gets the
// secret ARN in process.env[`${secretEnv}_ARN`]. Resolve once, cache on env.

async function hydrateSecrets(providers: Record<string, ProviderConfig>): Promise<void> {
  await Promise.all(
    Object.values(providers).map(async (p) => {
      const name = p.secretEnv;
      if (!name || process.env[name]) return;          // already hydrated
      const arn = process.env[`${name}_ARN`];
      if (!arn) return;                                 // not wired (e.g. google direct) — skip
      try {
        const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
        if (res.SecretString) process.env[name] = res.SecretString;
      } catch (e) {
        console.warn('[executor] secret hydrate failed for', name, e);
      }
    }),
  );
}

// ─── Minimal circuit breaker (§27.4) ─────────────────────────────────────────

interface HealthRow {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  errorCount: number;
  sampleCount: number;
  windowStart: number;
  openedAt?: number;
}

async function readHealth(key: string): Promise<HealthRow | null> {
  const r = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: 'HEALTH', sk: key }),
  }));
  return r.Item ? (unmarshall(r.Item) as HealthRow) : null;
}

async function isCircuitOpen(key: string, cfg: CircuitConfig): Promise<boolean> {
  const h = await readHealth(key);
  if (!h || h.state !== 'OPEN') return false;
  const cooldownOver = (h.openedAt ?? 0) + cfg.openCooldownSeconds * 1000 < Date.now();
  return !cooldownOver; // cooldown elapsed → allow a half-open probe
}

async function feedCircuit(key: string, ok: boolean, cfg: CircuitConfig): Promise<void> {
  const now = Date.now();
  const h = (await readHealth(key)) ?? { state: 'CLOSED', errorCount: 0, sampleCount: 0, windowStart: now };

  // Reset the rolling window if it has elapsed.
  let { errorCount, sampleCount, windowStart } = h;
  if (now - windowStart > cfg.windowSeconds * 1000) {
    errorCount = 0; sampleCount = 0; windowStart = now;
  }
  sampleCount += 1;
  if (!ok) errorCount += 1;

  let state = h.state;
  let openedAt = h.openedAt;
  if (ok && h.state === 'OPEN') {
    state = 'CLOSED'; openedAt = undefined; errorCount = 0; sampleCount = 1; windowStart = now;
  } else if (sampleCount >= cfg.minSamples && errorCount / sampleCount >= cfg.errorThreshold) {
    state = 'OPEN'; openedAt = now;
  }

  await db.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall({
      pk: 'HEALTH', sk: key, state, errorCount, sampleCount, windowStart,
      openedAt, updatedAt: now,
    }, { removeUndefinedValues: true }),
  }));
}
