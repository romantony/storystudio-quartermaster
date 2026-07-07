import { createHash } from 'crypto';
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { z } from 'zod';
import { acquire, heartbeat, reclaimExpired, reclaimExpiredLeases, reconcileCounter, release } from '../gate/dynamo-gate';
import type {
  AcquireRequest,
  AuditItem,
  BalanceItem,
  CanonicalJob,
  HeartbeatRequest,
  JobItem,
  LambdaFunctionUrlEvent,
  LambdaFunctionUrlResponse,
  Lane,
  Priority,
  ProviderConfigItem,
  Queue,
  ReleaseRequest,
} from '../types';

const TABLE = process.env.TABLE_NAME ?? 'quartermaster-jobs';
const db = new DynamoDBClient({});
const sm = new SecretsManagerClient({});

// ─── Secret cache (warm across Lambda invocations) ───────────────────────────
const secretCache = new Map<string, { value: string; exp: number }>();
async function getSecret(arn: string): Promise<string> {
  const cached = secretCache.get(arn);
  if (cached && cached.exp > Date.now()) return cached.value;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const value = res.SecretString ?? '';
  secretCache.set(arn, { value, exp: Date.now() + 5 * 60_000 }); // 5-min cache
  return value;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export const handler = async (evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> => {
  const method = evt.requestContext.http.method.toUpperCase();
  const path = evt.rawPath;

  try {
    // ── Admin routes: JWT-only auth (no gateway key in browser) ──────────────
    if (path.startsWith('/api/')) {
      if (method === 'POST' && path === '/api/auth/login') return handleLogin(evt);
      if (method === 'POST' && path === '/api/auth/logout') return handleLogout();

      const jwtSecret = await getSecret(process.env.JWT_SECRET_ARN ?? '');
      const authResult = verifyJwt(evt, jwtSecret);
      if (!authResult.ok) return json(401, { error: 'Unauthorized' });
      const actor = authResult.sub ?? 'unknown';

      if (method === 'GET' && path.startsWith('/api/catalog/')) return handleGetCatalog(evt);
      if (method === 'PUT' && path.match(/^\/api\/catalog\/[^/]+\/ladders\/.+/)) return handlePutLadder(evt, actor);
      if (method === 'GET' && path === '/api/providers') return handleGetProviders();
      if (method === 'PUT' && path.match(/^\/api\/providers\/[^/]+$/)) return handlePutProvider(evt, actor);
      if (method === 'POST' && path.match(/^\/api\/providers\/[^/]+\/rotate-key$/)) return handleRotateKey(evt, actor);
      if (method === 'GET' && path === '/api/cost') return handleGetCost(evt);
      if (method === 'GET' && path === '/api/balances') return handleGetBalances();
      if (method === 'PUT' && path.match(/^\/api\/balances\/[^/]+$/)) return handlePutBalance(evt, actor);
      if (method === 'GET' && path === '/api/audit') return handleGetAudit(evt);

      return json(404, { error: 'Not found' });
    }

    // ── Broker/job routes: gateway key required ───────────────────────────────
    const gatewayKey = await getSecret(process.env.GATEWAY_STATIC_KEY_ARN ?? '');
    if (evt.headers['x-gateway-key'] !== gatewayKey) {
      return json(401, { error: 'Unauthorized' });
    }

    // ── Broker endpoints ─────────────────────────────────────────────────────
    if (method === 'POST' && path === '/acquire') return handleAcquire(evt);
    if (method === 'POST' && path === '/release') return handleRelease(evt);
    if (method === 'POST' && path === '/heartbeat') return handleHeartbeat(evt);
    if (method === 'POST' && path === '/sweeper') return handleSweeper();

    // ── Job queue endpoints ──────────────────────────────────────────────────
    if (method === 'POST' && path === '/jobs') return handleIngest(evt);
    if (method === 'GET' && path.startsWith('/jobs/')) return handleStatus(evt);

    // ── Admission gate (Gatekeeper role) ─────────────────────────────────────
    if (method === 'POST' && path === '/admission') {
      const { handleAdmission } = await import('./admission');
      return handleAdmission(evt);
    }
    if (method === 'POST' && path.match(/^\/admission\/[^/]+\/release$/)) {
      const { handleAdmissionRelease } = await import('./admission');
      return handleAdmissionRelease(evt);
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error('[api] unhandled error', err);
    return json(500, { error: 'Internal server error' });
  }
};

// ─── Broker: /acquire ────────────────────────────────────────────────────────

async function handleAcquire(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  const body = parseBody<AcquireRequest>(evt);
  if (!body) return json(400, { error: 'Invalid request body' });

  const { tenant, lane, priority: _p, estDurationMs } = body;
  if (!lane || !tenant) return json(400, { error: 'lane and tenant are required' });

  const result = await acquire(lane as Lane, tenant, estDurationMs);
  return json(200, result);
}

// ─── Broker: /release ────────────────────────────────────────────────────────

async function handleRelease(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  const body = parseBody<ReleaseRequest>(evt);
  if (!body?.leaseId || !body.lane) return json(400, { error: 'leaseId and lane are required' });

  const result = await release(body.lane as Lane, body.leaseId);
  return json(200, result);
}

// ─── Broker: /heartbeat ──────────────────────────────────────────────────────

async function handleHeartbeat(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  const body = parseBody<HeartbeatRequest>(evt);
  if (!body?.leaseId || !body.lane) return json(400, { error: 'leaseId and lane are required' });

  const ttlMs =
    body.lane === 'video'
      ? Number(process.env.LEASE_TTL_MS_VIDEO ?? 120_000)
      : Number(process.env.LEASE_TTL_MS_SFX ?? 60_000);

  const result = await heartbeat(body.leaseId, ttlMs);
  return json(200, result);
}

// ─── Sweeper: /sweeper ───────────────────────────────────────────────────────

async function handleSweeper(): Promise<LambdaFunctionUrlResponse> {
  // Run reclaim and reconcile in parallel; reconcile after reclaim so the final
  // counter reflects truth after all expired leases have been cleaned up.
  const [jobs, leases] = await Promise.all([reclaimExpired(), reclaimExpiredLeases()]);
  const counter = await reconcileCounter();

  // RunPod worker-lifecycle tick (shadow mode by default — logs/audits the
  // scale decision without touching RunPod).
  const { runProvisioner } = await import('./provisioner');
  const provisioning = await runProvisioner().catch(e => {
    console.error('[sweeper] provisioner error', e);
    return [];
  });

  // Expire admission reservations past their TTL (granted-but-never-started
  // projects shouldn't pin fleet capacity forever).
  const { expireStaleReservations } = await import('../gate/reservation-gate');
  const reservations = await expireStaleReservations().catch(e => {
    console.error('[sweeper] reservation expiry error', e);
    return { expired: 0 };
  });

  // Re-dispatch canonical jobs sitting QUEUED — either re-queued for capacity
  // (internal endpoint was full; a slot may have freed since) or a missed inline
  // dispatch. The executor claims each atomically, so double-dispatch is safe.
  const redispatched = await redispatchQueuedCanonical().catch(e => {
    console.error('[sweeper] redispatch error', e);
    return 0;
  });

  const result = { ...jobs, leasesReclaimed: leases.reclaimed, counter, provisioning, reservationsExpired: reservations.expired, redispatched };
  console.info('[sweeper] result', result);
  return json(200, result);
}

// ─── Job queue: POST /jobs ───────────────────────────────────────────────────

const canonicalJobSchema = z.object({
  assetType: z.string(),
  tier: z.string(),
  operation: z.string(),
  product: z.string(),
  queue: z.enum(['background', 'foreground']),
  requestId: z.string(),
  prompt: z.string(),
  initImageUrls: z.array(z.string()).optional(),
  audioUrl: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  // Must mirror CanonicalJobParams (types.ts) — zod strips unknown keys, so any
  // param missing here is silently dropped on ingest. That's what broke the
  // narration-basic `pipeline` rung (voiceText → empty voice_text → pod error)
  // and had been quietly defaulting premium TTS's speaker/instruct/language.
  params: z.object({
    aspectRatio: z.string().optional(),
    resolution: z.string().optional(),
    durationS: z.number().optional(),
    generateAudio: z.boolean().optional(),
    voice: z.string().optional(),
    width: z.string().optional(),
    height: z.string().optional(),
    voiceUrl: z.string().optional(),
    voiceTranscript: z.string().optional(),
    instruct: z.string().optional(),
    speaker: z.string().optional(),
    language: z.string().optional(),
    cloneArtifactUrl: z.string().optional(),
    voiceText: z.string().optional(),
    effect: z.string().optional(),
  }).default({}),
  s3Target: z.string(),
  manifestRef: z.string().optional(),
  platform: z.string().optional(),
  projectId: z.string().optional(),
  frameId: z.string().optional(),
  userId: z.string().optional(),
  priority: z.enum(['P0', 'P1', 'P2']).optional(),
  lane: z.enum(['video', 'rest', 'none']).optional(),
  jobType: z.enum(['batch', 'realtime']).optional(),
});

async function handleIngest(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  const raw = parseBody<unknown>(evt);
  const parsed = canonicalJobSchema.safeParse(raw);
  if (!parsed.success) return json(400, { error: 'Validation failed', details: parsed.error.issues });

  const input = parsed.data as CanonicalJob;
  const jobId = stableHash(input.assetType, input.tier, input.operation, input.prompt, JSON.stringify(input.params));
  const now = Date.now();
  const lane = (input as CanonicalJob & { lane?: Lane }).lane ?? defaultLane(input.assetType);
  const priority: Priority = input.priority ?? 'P2';

  // Cache hit: check if s3Target already exists (idempotency)
  const existing = await getJobByJobId(input.requestId, jobId);
  if (existing?.status === 'COMPLETE' || existing?.status === 'COMPLETE_WITH_FALLBACKS') {
    return json(200, {
      jobId,
      requestId: input.requestId,
      status: existing.status,
      assetKey: existing.assetKey,
    });
  }

  const jobItem: JobItem = {
    pk: `REQ#${input.requestId}`,
    sk: `JOB#${jobId}`,
    status: 'QUEUED',
    lane,
    priority,
    enqueueSeq: `${now}#${jobId}`,
    provider: undefined,
    model: undefined,
    prompt: input.prompt,
    initImageUrls: input.initImageUrls,
    audioUrl: input.audioUrl,
    dependsOn: input.dependsOn,
    params: input.params,
    s3Target: input.s3Target,
    manifestRef: input.manifestRef,
    assetKey: undefined,
    attempts: 0,
    leaseId: undefined,
    leaseExpiry: undefined,
    platform: input.platform,
    projectId: input.projectId,
    frameId: input.frameId,
    userId: input.userId,
    requestId: input.requestId,
    jobId,
    jobType: input.jobType,
    assetType: input.assetType,
    tier: input.tier,
    operation: input.operation,
    queue: input.queue,
    createdAt: now,
    updatedAt: now,
  };

  // Overwrite is allowed when the existing record is absent OR already in a
  // terminal failure state (FAILED/DEAD) — a retry of a previously-failed job
  // (same requestId → same pk) must actually re-queue and re-dispatch, not
  // silently no-op. Without the terminal-status clause, ConditionalCheckFailed
  // on a pre-existing FAILED item swallowed the retry: isNew stayed false, the
  // executor was never re-invoked, yet POST /jobs still returned 202 "QUEUED"
  // — the job was permanently stuck FAILED with no visible error (confirmed
  // 2026-07-05: a project retry re-used frameIds whose jobs had failed in an
  // earlier aborted execution; every one of them "failed" again in ~5s with
  // no real attempt, because the stale FAILED record was never replaced).
  let isNew = true;
  await db.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall(jobItem, { removeUndefinedValues: true }),
    ConditionExpression: 'attribute_not_exists(pk) OR #s = :failed OR #s = :dead',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: marshall({ ':failed': 'FAILED', ':dead': 'DEAD' }),
  })).catch(e => {
    // Item already exists and is still QUEUED/PROCESSING/COMPLETE(_WITH_FALLBACKS)
    // — a genuine in-flight duplicate submit, fine not to re-dispatch.
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    isNew = false;
  });

  // Hand off to the executor asynchronously so POST /jobs returns immediately
  // (the executor can run for minutes on a RunPod cold start).
  if (isNew) await dispatchExecutor(input.requestId, jobId);

  return json(202, { jobId, requestId: input.requestId, status: 'QUEUED' });
}

/**
 * Re-dispatch canonical (assetType-bearing) jobs stuck in QUEUED to the executor.
 * These are jobs the executor re-queued because their internal endpoint was full
 * (approach A — wait for a worker slot rather than spill to paid external), plus
 * any that missed their inline dispatch. Runs every sweeper tick (~2 min); the
 * executor's atomic claim makes re-dispatching an already-running job a no-op.
 */
async function redispatchQueuedCanonical(): Promise<number> {
  let dispatched = 0;
  for (const lane of ['video', 'rest']) {
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await db.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'queue-index',
        KeyConditionExpression: '#lane = :lane',
        FilterExpression: '#status = :q AND attribute_exists(assetType)',
        ExpressionAttributeNames: { '#lane': 'lane', '#status': 'status' },
        ExpressionAttributeValues: marshall({ ':lane': lane, ':q': 'QUEUED' }),
        ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
      }));
      for (const raw of res.Items ?? []) {
        const job = unmarshall(raw) as JobItem;
        await dispatchExecutor(job.requestId, job.jobId);
        dispatched++;
      }
      lastKey = res.LastEvaluatedKey ? unmarshall(res.LastEvaluatedKey) : undefined;
    } while (lastKey);
  }
  return dispatched;
}

async function dispatchExecutor(requestId: string, jobId: string): Promise<void> {
  const fn = process.env.EXECUTOR_FUNCTION_NAME;
  if (!fn) {
    console.warn('[api] EXECUTOR_FUNCTION_NAME unset — job queued but not dispatched');
    return;
  }
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({});
  await lambda.send(new InvokeCommand({
    FunctionName: fn,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ requestId, jobId })),
  })).catch(e => console.error('[api] executor dispatch failed', e));
}

// ─── Job queue: GET /jobs/{requestId} ────────────────────────────────────────

async function handleStatus(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  // rawPath is delivered percent-encoded (colons in requestId become %3A) and
  // is never auto-decoded by Lambda Function URLs, so this must decode
  // explicitly or every lookup 404s despite the job existing.
  const requestId = decodeURIComponent(evt.rawPath.split('/').pop() ?? '');
  if (!requestId) return json(400, { error: 'requestId required' });

  const result = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
    ExpressionAttributeValues: marshall({ ':pk': `REQ#${requestId}`, ':skPrefix': 'JOB#' }),
  }));

  const items = (result.Items ?? []).map(i => unmarshall(i) as JobItem);
  if (!items.length) return json(404, { error: 'Not found' });

  // Aggregate: any COMPLETE = success; otherwise show the worst status
  const complete = items.find(i => i.status === 'COMPLETE' || i.status === 'COMPLETE_WITH_FALLBACKS');
  if (complete) {
    return json(200, {
      requestId,
      status: complete.status,
      assetKey: complete.assetKey,
      degraded: complete.degraded,
    });
  }
  const dead = items.find(i => i.status === 'DEAD');
  if (dead) return json(200, { requestId, status: 'DEAD', errorReason: dead.errorReason, attempts: dead.attempts });

  const processing = items.find(i => i.status === 'PROCESSING');
  if (processing) return json(200, { requestId, status: 'PROCESSING' });

  return json(200, { requestId, status: items[0].status });
}

// ─── Admin: Auth ─────────────────────────────────────────────────────────────

async function handleLogin(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  const body = parseBody<{ password: string }>(evt);
  if (!body?.password) return json(400, { error: 'password required' });

  const hashArn = process.env.ADMIN_PASSWORD_HASH_ARN ?? '';
  const jwtArn = process.env.JWT_SECRET_ARN ?? '';
  const [hash, jwtSecret] = await Promise.all([getSecret(hashArn), getSecret(jwtArn)]);

  const valid = await bcrypt.compare(body.password, hash);
  if (!valid) return json(401, { error: 'Invalid credentials' });

  const token = jwt.sign({ sub: 'admin' }, jwtSecret, { expiresIn: '1h' });
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `qm_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600`,
    },
    body: JSON.stringify({ ok: true }),
  };
}

function handleLogout(): LambdaFunctionUrlResponse {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'qm_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    },
    body: JSON.stringify({ ok: true }),
  };
}

// ─── Admin: Catalog ───────────────────────────────────────────────────────────

async function handleGetCatalog(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  const queue = evt.rawPath.split('/').pop() as Queue;
  if (queue !== 'background' && queue !== 'foreground') return json(400, { error: 'Invalid queue' });

  // Try DynamoDB first, fall back to bundled JSON
  const result = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: `CATALOG#${queue}`, sk: 'CONFIG' }),
  }));

  if (result.Item) {
    const item = unmarshall(result.Item) as { catalog: unknown };
    return json(200, item.catalog);
  }

  // Fall back to bundled catalog JSON
  const catalog = queue === 'background'
    ? require('../catalog/background.json')
    : require('../catalog/foreground.json');
  return json(200, catalog);
}

async function handlePutLadder(evt: LambdaFunctionUrlEvent, actor: string): Promise<LambdaFunctionUrlResponse> {
  const parts = evt.rawPath.split('/');
  // /api/catalog/{queue}/ladders/{key}
  const queue = parts[3] as Queue;
  const ladderKey = parts.slice(5).join('/');
  if (!queue || !ladderKey) return json(400, { error: 'queue and ladder key required' });

  const body = parseBody<{ rungs: unknown[] }>(evt);
  if (!body?.rungs) return json(400, { error: 'rungs array required' });

  // Load current catalog from DynamoDB or file
  const current = await loadCatalogFromDb(queue) ?? require(`../catalog/${queue}.json`);
  const before = current.ladders[ladderKey];
  current.ladders[ladderKey] = body.rungs;
  current.version = `${new Date().toISOString().slice(0, 10)}.${Date.now()}`;

  await db.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall({ pk: `CATALOG#${queue}`, sk: 'CONFIG', catalog: current }, { removeUndefinedValues: true }),
  }));

  await writeAudit(actor, 'PUT_LADDER', `${queue}/${ladderKey}`, before, body.rungs);
  return json(200, { ok: true, version: current.version });
}

// ─── Admin: Providers ─────────────────────────────────────────────────────────

async function handleGetProviders(): Promise<LambdaFunctionUrlResponse> {
  const result = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: marshall({ ':pk': 'PROVIDER' }),
  }));
  const items = (result.Items ?? []).map(i => {
    const p = unmarshall(i) as ProviderConfigItem;
    return { ...p, secretArn: undefined }; // never expose ARN to browser
  });
  return json(200, items);
}

async function handlePutProvider(evt: LambdaFunctionUrlEvent, actor: string): Promise<LambdaFunctionUrlResponse> {
  const name = evt.rawPath.split('/').pop() ?? '';
  const body = parseBody<Partial<ProviderConfigItem>>(evt);
  if (!body || !name) return json(400, { error: 'provider name and body required' });

  const existing = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: 'PROVIDER', sk: name }),
  }));

  const before = existing.Item ? unmarshall(existing.Item) : null;
  const now = Date.now();
  const updated: ProviderConfigItem = {
    pk: 'PROVIDER',
    sk: name,
    baseUrl: body.baseUrl ?? '',
    authType: body.authType ?? 'bearer',
    secretArn: body.secretArn ?? (before as ProviderConfigItem)?.secretArn ?? '',
    keyLast4: body.keyLast4 ?? (before as ProviderConfigItem)?.keyLast4 ?? '****',
    limit: body.limit ?? 10,
    floors: body.floors,
    enabled: body.enabled ?? true,
    updatedAt: now,
    updatedBy: actor,
  };

  await db.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall(updated, { removeUndefinedValues: true }),
  }));

  await writeAudit(actor, 'PUT_PROVIDER', name, before, { ...updated, secretArn: '[redacted]' });
  return json(200, { ok: true });
}

async function handleRotateKey(evt: LambdaFunctionUrlEvent, actor: string): Promise<LambdaFunctionUrlResponse> {
  const parts = evt.rawPath.split('/');
  const name = parts[parts.length - 2]; // /api/providers/{name}/rotate-key
  const body = parseBody<{ newKey: string }>(evt);
  if (!body?.newKey || !name) return json(400, { error: 'name and newKey required' });

  // Look up existing provider to get secretArn
  const result = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: 'PROVIDER', sk: name }),
  }));
  if (!result.Item) return json(404, { error: 'Provider not found' });

  const provider = unmarshall(result.Item) as ProviderConfigItem;
  const last4 = body.newKey.slice(-4);

  // Write new Secrets Manager version
  const { SecretsManagerClient: SMC, PutSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const smClient = new SMC({});
  await smClient.send(new PutSecretValueCommand({
    SecretId: provider.secretArn,
    SecretString: body.newKey,
  }));

  // Invalidate cache
  secretCache.delete(provider.secretArn);

  // Update keyLast4 in provider record
  await db.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: 'PROVIDER', sk: name }),
    UpdateExpression: 'SET keyLast4 = :k, updatedAt = :t, updatedBy = :a',
    ExpressionAttributeValues: marshall({ ':k': last4, ':t': Date.now(), ':a': actor }),
  }));

  await writeAudit(actor, 'ROTATE_KEY', name, { keyLast4: provider.keyLast4 }, { keyLast4: last4 });
  return json(200, { ok: true, keyLast4: last4 });
}

// ─── Admin: Cost ──────────────────────────────────────────────────────────────

async function handleGetCost(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  const qs = evt.queryStringParameters ?? {};
  const date = qs.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const platform = qs.platform;

  // Query metering items for the date
  const pk = platform ? `USAGE:${platform}:${date}` : undefined;
  if (!pk) return json(200, { message: 'Specify ?platform= or ?date=' });

  const result = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: marshall({ ':pk': pk }),
  }));

  const items = (result.Items ?? []).map(i => unmarshall(i));
  return json(200, { date, platform, entries: items });
}

// ─── Admin: Balances ──────────────────────────────────────────────────────────

async function handleGetBalances(): Promise<LambdaFunctionUrlResponse> {
  const result = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: marshall({ ':pk': 'BALANCE' }),
  }));
  const items = (result.Items ?? []).map(i => unmarshall(i) as BalanceItem);
  return json(200, items);
}

async function handlePutBalance(evt: LambdaFunctionUrlEvent, actor: string): Promise<LambdaFunctionUrlResponse> {
  const provider = evt.rawPath.split('/').pop() ?? '';
  const body = parseBody<Partial<BalanceItem>>(evt);
  if (!body || !provider) return json(400, { error: 'provider and body required' });

  const now = Date.now();
  await db.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall({
      pk: 'BALANCE',
      sk: provider,
      balanceUsd: body.balanceUsd ?? 0,
      source: body.source ?? 'estimated',
      lastTopupUsd: body.lastTopupUsd,
      lastTopupAt: body.lastTopupUsd ? now : undefined,
      thresholdUsd: body.thresholdUsd ?? 10,
      burnUsdPerDay: body.burnUsdPerDay ?? 0,
      runwayDays: body.burnUsdPerDay ? (body.balanceUsd ?? 0) / body.burnUsdPerDay : 999,
      updatedAt: now,
    }, { removeUndefinedValues: true }),
  }));

  await writeAudit(actor, 'PUT_BALANCE', provider, null, body);
  return json(200, { ok: true });
}

// ─── Admin: Audit ─────────────────────────────────────────────────────────────

async function handleGetAudit(evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> {
  const limit = Number(evt.queryStringParameters?.limit ?? 50);
  const result = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: marshall({ ':pk': 'AUDIT' }),
    ScanIndexForward: false,
    Limit: Math.min(limit, 200),
  }));
  return json(200, (result.Items ?? []).map(i => unmarshall(i)));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function json(statusCode: number, body: unknown): LambdaFunctionUrlResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseBody<T>(evt: LambdaFunctionUrlEvent): T | null {
  try {
    return evt.body ? JSON.parse(evt.body) as T : null;
  } catch {
    return null;
  }
}

function stableHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

function defaultLane(assetType: string): Lane {
  return assetType === 'video' || assetType === 'lipsync' ? 'video' : 'rest';
}

function verifyJwt(evt: LambdaFunctionUrlEvent, secret: string): { ok: boolean; sub?: string } {
  const cookie = evt.headers['cookie'] ?? '';
  const match = cookie.match(/qm_token=([^;]+)/);
  if (!match) return { ok: false };
  try {
    const payload = jwt.verify(match[1], secret) as jwt.JwtPayload;
    return { ok: true, sub: payload.sub };
  } catch {
    return { ok: false };
  }
}

async function loadCatalogFromDb(queue: Queue) {
  const result = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: `CATALOG#${queue}`, sk: 'CONFIG' }),
  }));
  if (!result.Item) return null;
  return (unmarshall(result.Item) as { catalog: unknown }).catalog;
}

async function getJobByJobId(requestId: string, jobId: string): Promise<JobItem | null> {
  const result = await db.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: `REQ#${requestId}`, sk: `JOB#${jobId}` }),
  }));
  return result.Item ? unmarshall(result.Item) as JobItem : null;
}

async function writeAudit(actor: string, action: string, target: string, before: unknown, after: unknown): Promise<void> {
  const now = Date.now();
  const item: AuditItem = {
    pk: 'AUDIT',
    sk: `${now}#${actor}`,
    action,
    target,
    before,
    after,
    actor,
    timestamp: now,
  };
  await db.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall(item, { removeUndefinedValues: true }),
  }));
}
