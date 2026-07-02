import {
  DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { ADAPTERS } from '../adapters';
import { CatalogResolver } from '../catalog/resolver';
import { acquireSimple, releaseSimple } from '../gate/dynamo-gate';
import { isInternalRung, rungKey, selectRungOrder } from './router';
import type {
  Adapter, CircuitConfig, JobItem, ProviderConfig, ProviderTaskItem, Queue, Rung,
} from '../types';

const TABLE = process.env.TABLE_NAME ?? 'quartermaster-jobs';
const WEBHOOK_BASE = process.env.WEBHOOK_BASE_URL ?? '';
// Soft cap / in-flight counter ceiling per RunPod endpoint. High enough that
// batches don't block on it (RunPod's own queue absorbs concurrency); it mainly
// feeds the routing/provisioning signal.
const RUNPOD_ENDPOINT_LIMIT = Number(process.env.RUNPOD_ENDPOINT_LIMIT ?? 25);
const POLL_INTERVAL_MS = Number(process.env.EXECUTOR_POLL_INTERVAL_MS ?? 3_000);
const POLL_BUFFER_MS = 15_000; // stop polling this long before Lambda timeout

const db = new DynamoDBClient({});
const sm = new SecretsManagerClient({});

interface ExecutorEvent {
  requestId: string;
  jobId: string;
}

interface LambdaContext {
  getRemainingTimeInMillis?: () => number;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export const handler = async (event: ExecutorEvent, context: LambdaContext = {}): Promise<void> => {
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

  await setProcessing(job);

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

  for (const rung of ordered) {
    const key = rungKey(rung);
    if (tried.has(key)) continue;
    if (!ADAPTERS[rung.provider]) continue;          // no adapter (e.g. google direct) — skip
    if (await isCircuitOpen(key, cfg)) continue;      // dead endpoint (§27.4)

    const counterKey = rung.counterKey ?? rung.provider;
    const limit = rung.counterKey
      ? RUNPOD_ENDPOINT_LIMIT
      : (resolver.getProviderConfig(rung.provider)?.limit ?? 10);

    const acq = await acquireSimple(counterKey, limit, `job:${job.jobId}`);
    if (!acq.granted) continue;                       // pool full → try next rung (failover)
    const leaseId = acq.leaseId!;

    // Mark rung tried before submitting, so a re-invoke never repeats it.
    tried.add(key);
    await appendTried(job, key);

    const adapter = ADAPTERS[rung.provider];
    const internal = isInternalRung(rung);

    try {
      const callbackUrl = internal ? undefined : `${WEBHOOK_BASE}/webhooks/${rung.provider}`;
      const raw = await submit(adapter, job, rung, callbackUrl);
      const result = adapter.parseSubmit(raw);

      // Sync completion (provider returned URLs immediately).
      if (result.outputUrls?.length) {
        await complete(job, result.outputUrls[0], rung.fb);
        await releaseSimple(counterKey, leaseId);
        await feedCircuit(key, true, cfg);
        return;
      }

      if (internal) {
        const url = await pollInline(adapter, result.taskRef ?? '', rung, context);
        await releaseSimple(counterKey, leaseId);
        if (url) {
          await complete(job, url, rung.fb);
          await feedCircuit(key, true, cfg);
          return;
        }
        await feedCircuit(key, false, cfg);
        continue; // failed / timed out → failover to next rung
      }

      // Webhook-capable external rung: hand off; webhook.ts completes/releases.
      if (!result.taskRef) {
        await releaseSimple(counterKey, leaseId);
        await feedCircuit(key, false, cfg);
        continue;
      }
      await putProviderTask(rung.provider, result.taskRef, job, leaseId, counterKey);
      return; // await callback (slot stays held until webhook releases it)
    } catch (err) {
      const httpCode = (err as { httpCode?: number }).httpCode ?? 500;
      await releaseSimple(counterKey, leaseId);
      await feedCircuit(key, false, cfg);
      console.warn('[executor] rung failed', key, httpCode, (err as Error).message);
      continue; // advance to next rung
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
  adapter: Adapter, taskRef: string, rung: Rung, context: LambdaContext,
): Promise<string | undefined> {
  if (!taskRef) return undefined;
  const remaining = () => context.getRemainingTimeInMillis?.() ?? Number.MAX_SAFE_INTEGER;
  while (remaining() > POLL_BUFFER_MS) {
    const res = await adapter.poll(taskRef, rung);
    if (res.done) return res.failed ? undefined : res.outputUrls?.[0];
    await sleep(POLL_INTERVAL_MS);
  }
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

async function setProcessing(job: JobItem): Promise<void> {
  await db.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: job.pk, sk: job.sk }),
    UpdateExpression: 'SET #s = :p, updatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({ ':p': 'PROCESSING', ':now': Date.now() }),
  }));
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
