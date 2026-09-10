import {
  AttributeValue,
  DynamoDBClient,
  UpdateItemCommand,
  QueryCommand,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { randomUUID } from 'crypto';
import type {
  AcquireResponse,
  HeartbeatResponse,
  JobItem,
  JobStatus,
  Lane,
  LeaseItem,
  ReleaseResponse,
} from '../types';

const TABLE = process.env.TABLE_NAME ?? 'quartermaster-jobs';
const SAFE_LIMIT = Number(process.env.SAFE_LIMIT ?? 15);
const VIDEO_FLOOR = Number(process.env.VIDEO_FLOOR ?? 8);
const REST_FLOOR = Number(process.env.REST_FLOOR ?? 7);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 5);

const TTL: Record<string, number> = {
  video: Number(process.env.LEASE_TTL_MS_VIDEO ?? 120_000),
  rest:  Number(process.env.LEASE_TTL_MS_SFX   ?? 60_000),  // conservative default for rest
};

const client = new DynamoDBClient({});

// Default TTL for RunPod single-counter leases. RunPod cold starts can run
// 2.5–4 min, so give these a generous lease so a slow-but-alive generation
// isn't reclaimed out from under itself. The executor heartbeats anyway.
const SIMPLE_TTL_MS = Number(process.env.RUNPOD_LEASE_TTL_MS ?? 360_000);

const counterPk = (counterKey: string) => `COUNTER#${counterKey}`;

// ─── Simple per-endpoint counter (RunPod pools, §Pillar 4) ───────────────────

/**
 * Acquire one slot from a single-counter semaphore keyed by `counterKey`
 * (e.g. "runpod:flux-tts-s2t"). Unlike the lane gate below there is no
 * video/rest floor — just a flat `inflight < limit` ceiling per endpoint pool.
 *
 * Used to (a) gate concurrent generations against a RunPod endpoint and
 * (b) provide the in-flight count the router/provisioner read as "queue depth".
 */
export async function acquireSimple(
  counterKey: string,
  limit: number,
  tenant: string,
  ttlMs?: number,
): Promise<AcquireResponse> {
  const leaseId = randomUUID();
  const now = Date.now();
  const expiry = now + (ttlMs ?? SIMPLE_TTL_MS);
  const pk = counterPk(counterKey);

  const attempt = async (): Promise<boolean> => {
    try {
      await client.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ pk, sk: 'SEMAPHORE' }),
        UpdateExpression: 'ADD inflight :one',
        ConditionExpression: 'attribute_not_exists(inflight) OR inflight < :limit',
        ExpressionAttributeValues: marshall({ ':one': 1, ':limit': limit }),
      }));
      return true;
    } catch (err: unknown) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  };

  let granted = await attempt();
  if (!granted) {
    const { reclaimed } = await reclaimExpiredLeases();
    if (reclaimed > 0) granted = await attempt();
  }
  if (!granted) return { granted: false, retryAfterMs: 5_000 };

  const leaseItem: LeaseItem = {
    pk: `LEASE#${leaseId}`,
    sk: 'LEASE',
    leaseId,
    lane: 'rest',
    tenant,
    leaseExpiry: expiry,
    acquiredAt: now,
    counterKey,
    ttl: Math.floor(now / 1000) + 24 * 3600,
  };
  await client.send(new PutItemCommand({ TableName: TABLE, Item: marshall(leaseItem) }));

  return { granted: true, leaseId };
}

/**
 * Release a single-counter slot acquired via acquireSimple.
 */
export async function releaseSimple(counterKey: string, leaseId: string): Promise<ReleaseResponse> {
  const pk = counterPk(counterKey);
  try {
    await client.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ pk, sk: 'SEMAPHORE' }),
      UpdateExpression: 'ADD inflight :neg',
      ConditionExpression: 'inflight > :zero',
      ExpressionAttributeValues: marshall({ ':neg': -1, ':zero': 0 }),
    }));
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) return { released: false };
    throw err;
  }

  await client.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: `LEASE#${leaseId}`, sk: 'LEASE' }),
    UpdateExpression: 'SET #s = :deleted',
    ExpressionAttributeNames: { '#s': 'deleted' },
    ExpressionAttributeValues: marshall({ ':deleted': true }),
  })).catch(() => {/* lease may already be gone */});

  return { released: true };
}

/**
 * Read the current in-flight count for a single-counter pool (0 if unseen).
 * This is the "does the internal endpoint have capacity?" signal the router
 * uses for realtime routing, and one of the inputs the provisioner reads.
 */
export async function getInflight(counterKey: string): Promise<number> {
  const result = await client.send(new GetItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: counterPk(counterKey), sk: 'SEMAPHORE' }),
    ProjectionExpression: 'inflight',
  }));
  if (!result.Item) return 0;
  const { inflight } = unmarshall(result.Item) as { inflight?: number };
  return inflight ?? 0;
}

// ─── Acquire ─────────────────────────────────────────────────────────────────

/**
 * Try to atomically acquire one slot from the GLOBAL video/rest lane semaphore.
 *
 * NOTE ON THE `COUNTER#modelslab` KEY: the pk is vestigial branding from when
 * ModelsLab was the sole provider (decommissioned 2026-07-02). This semaphore is
 * NOT provider-specific and is very much live — it is the fleet-wide SAFE_LIMIT=15
 * ceiling the StoryStudio Step Functions pipeline holds across its image (rest
 * lane) and video (video lane) Map iterations via POST /acquire + /release.
 * Do not delete it as "dead ModelsLab code"; renaming the pk needs a sequenced
 * live migration of the counter values, not a find-and-replace.
 *
 * Uses DynamoDB conditional UpdateItem to enforce the 8/7 video/rest floor
 * (§17.4 / §21.2). ConditionalCheckFailedException means pool full → not granted.
 */
export async function acquire(
  lane: Lane,
  tenant: string,
  ttlMs?: number,
): Promise<AcquireResponse> {
  if (lane === 'none') {
    return { granted: true, leaseId: `none-${randomUUID()}` };
  }

  const leaseId = randomUUID();
  const now = Date.now();
  const expiry = now + (ttlMs ?? TTL[lane] ?? 60_000);
  const field = lane === 'video' ? 'video_inflight' : 'rest_inflight';

  // Floor conditions:
  //   video: total < SAFE_LIMIT AND (video < VIDEO_FLOOR OR rest <= REST_FLOOR)
  //   rest:  total < SAFE_LIMIT AND (rest < REST_FLOOR   OR video <= VIDEO_FLOOR)
  // DynamoDB ConditionExpression does not support arithmetic (video_inflight + rest_inflight),
  // so we maintain a total_inflight counter alongside the per-lane counters.
  const conditionExpr =
    lane === 'video'
      ? '(attribute_not_exists(total_inflight) OR total_inflight < :limit) AND (video_inflight < :myfloor OR rest_inflight <= :otherfloor)'
      : '(attribute_not_exists(total_inflight) OR total_inflight < :limit) AND (rest_inflight < :myfloor OR video_inflight <= :otherfloor)';

  const attemptAcquire = async (): Promise<boolean> => {
    try {
      await client.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ pk: 'COUNTER#modelslab', sk: 'SEMAPHORE' }),
        UpdateExpression: `ADD #field :one, total_inflight :one`,
        ConditionExpression: conditionExpr,
        ExpressionAttributeNames: { '#field': field },
        ExpressionAttributeValues: marshall({
          ':one': 1,
          ':limit': SAFE_LIMIT,
          ':myfloor': lane === 'video' ? VIDEO_FLOOR : REST_FLOOR,
          ':otherfloor': lane === 'video' ? REST_FLOOR : VIDEO_FLOOR,
        }),
      }));
      return true;
    } catch (err: unknown) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  };

  let granted = await attemptAcquire();

  // Self-healing: on first rejection, reclaim any expired leases and retry once.
  // This prevents a crashed Lambda from blocking the pool until the next sweeper tick.
  if (!granted) {
    const { reclaimed } = await reclaimExpiredLeases();
    if (reclaimed > 0) {
      granted = await attemptAcquire();
    }
  }

  if (!granted) {
    return { granted: false, retryAfterMs: 5_000 };
  }

  // Record lease for heartbeat + sweeper tracking
  const leaseItem: LeaseItem = {
    pk: `LEASE#${leaseId}`,
    sk: 'LEASE',
    leaseId,
    lane,
    tenant,
    leaseExpiry: expiry,
    acquiredAt: now,
    ttl: Math.floor(now / 1000) + 24 * 3600,
  };
  await client.send(new PutItemCommand({
    TableName: TABLE,
    Item: marshall(leaseItem),
  }));

  return { granted: true, leaseId };
}

// ─── Release ──────────────────────────────────────────────────────────────────

/**
 * Release a previously acquired slot.
 * Guarded by > 0 to prevent the counter going negative on double-release.
 * After release, triggers pullNext to admit the next QUEUED job (§24.3).
 */
export async function release(lane: Lane, leaseId: string): Promise<ReleaseResponse> {
  if (lane === 'none') return { released: true };

  const field = lane === 'video' ? 'video_inflight' : 'rest_inflight';

  try {
    await client.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: 'COUNTER#modelslab', sk: 'SEMAPHORE' }),
      UpdateExpression: `ADD #field :neg, total_inflight :neg`,
      ConditionExpression: '#field > :zero',
      ExpressionAttributeNames: { '#field': field },
      ExpressionAttributeValues: marshall({ ':neg': -1, ':zero': 0 }),
    }));
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) {
      return { released: false };
    }
    throw err;
  }

  // Delete the lease record (best-effort)
  await client.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: `LEASE#${leaseId}`, sk: 'LEASE' }),
    UpdateExpression: 'SET #s = :deleted',
    ExpressionAttributeNames: { '#s': 'deleted' },
    ExpressionAttributeValues: marshall({ ':deleted': true }),
  })).catch(() => {/* lease may already be gone */});

  // Admit the next QUEUED job (self-sustaining chain, §24.3)
  await pullNext(lane).catch(e => console.error('[gate] pullNext error', e));

  return { released: true };
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

/**
 * Extend the lease TTL. No-op if the lease has already been reclaimed (returns extended:false).
 */
export async function heartbeat(leaseId: string, ttlMs: number): Promise<HeartbeatResponse> {
  const newExpiry = Date.now() + ttlMs;
  try {
    await client.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: `LEASE#${leaseId}`, sk: 'LEASE' }),
      UpdateExpression: 'SET leaseExpiry = :exp',
      ConditionExpression: 'attribute_exists(pk) AND #del <> :t',
      ExpressionAttributeNames: { '#del': 'deleted' },
      ExpressionAttributeValues: marshall({ ':exp': newExpiry, ':t': true }),
    }));
    return { extended: true };
  } catch (err: unknown) {
    if (isConditionalCheckFailed(err)) return { extended: false };
    throw err;
  }
}

// ─── Pull Next (§24.3) ───────────────────────────────────────────────────────

/**
 * After a slot is freed, query the queue-index GSI for the oldest QUEUED job in the
 * given lane (video first, then rest) and inline-admit it.
 *
 * Returns the admitted jobId or null.
 */
export async function pullNext(releasedLane: Lane): Promise<string | null> {
  // Try video lane first, then rest (§17.4 video-first reclaim priority)
  const lanesToTry: Lane[] = releasedLane === 'video' ? ['video', 'rest'] : ['rest', 'video'];

  for (const lane of lanesToTry) {
    if (lane === 'none') continue;
    const oldest = await queryOldestQueued(lane);
    if (!oldest) continue;

    const admitted = await inlineAdmit(oldest, lane);
    if (admitted) return oldest.jobId;
  }
  return null;
}

async function queryOldestQueued(lane: Lane): Promise<JobItem | null> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'queue-status-index',
    KeyConditionExpression: '#lane = :lane',
    ExpressionAttributeNames: { '#lane': 'queueLane' },
    ExpressionAttributeValues: marshall({ ':lane': lane }),
    ScanIndexForward: true,   // ascending enqueueSeq = FIFO
    Limit: 5,                 // check a few in case dependsOn blocks the first
  }));

  if (!result.Items?.length) return null;

  for (const raw of result.Items) {
    const item = unmarshall(raw) as JobItem;
    if (item.dependsOn?.length) {
      const allDone = await checkDependenciesComplete(item.dependsOn);
      if (!allDone) continue;
    }
    return item;
  }
  return null;
}

async function checkDependenciesComplete(dependsOn: string[]): Promise<boolean> {
  for (const dep of dependsOn) {
    const [reqId, jobId] = dep.split('/');
    const result = await client.send(new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: `REQ#${reqId}`, sk: `JOB#${jobId}` }),
      ProjectionExpression: '#s',
      ExpressionAttributeNames: { '#s': 'status' },
    }));
    if (!result.Item) return false;
    const { status } = unmarshall(result.Item) as { status: JobStatus };
    if (status !== 'COMPLETE' && status !== 'COMPLETE_WITH_FALLBACKS') return false;
  }
  return true;
}

/**
 * Attempt to atomically claim a QUEUED job and acquire its slot in one transaction.
 */
async function inlineAdmit(job: JobItem, lane: Lane): Promise<boolean> {
  const field = lane === 'video' ? 'video_inflight' : 'rest_inflight';
  const now = Date.now();
  const leaseExpiry = now + (TTL[lane] ?? 60_000);
  const leaseId = randomUUID();

  const conditionExpr =
    lane === 'video'
      ? '(attribute_not_exists(total_inflight) OR total_inflight < :limit) AND (video_inflight < :myfloor OR rest_inflight <= :otherfloor)'
      : '(attribute_not_exists(total_inflight) OR total_inflight < :limit) AND (rest_inflight < :myfloor OR video_inflight <= :otherfloor)';

  try {
    await client.send(new TransactWriteItemsCommand({
      TransactItems: [
        // 1. Acquire slot (total_inflight maintained alongside per-lane counter)
        {
          Update: {
            TableName: TABLE,
            Key: marshall({ pk: 'COUNTER#modelslab', sk: 'SEMAPHORE' }),
            UpdateExpression: `ADD #field :one, total_inflight :one`,
            ConditionExpression: conditionExpr,
            ExpressionAttributeNames: { '#field': field },
            ExpressionAttributeValues: marshall({
              ':one': 1,
              ':limit': SAFE_LIMIT,
              ':myfloor': lane === 'video' ? VIDEO_FLOOR : REST_FLOOR,
              ':otherfloor': lane === 'video' ? REST_FLOOR : VIDEO_FLOOR,
            }),
          },
        },
        // 2. Flip job to PROCESSING (idempotency: only if still QUEUED)
        {
          Update: {
            TableName: TABLE,
            Key: marshall({ pk: job.pk, sk: job.sk }),
            UpdateExpression: 'SET #status = :proc, leaseId = :lid, leaseExpiry = :exp, leaseLane = :ln, updatedAt = :now REMOVE queueLane',
            ConditionExpression: '#status = :queued',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: marshall({
              ':proc': 'PROCESSING',
              ':queued': 'QUEUED',
              ':lid': leaseId,
              ':exp': leaseExpiry,
              ':ln': lane,
              ':now': now,
            }),
          },
        },
      ],
    }));
    return true;
  } catch (err: unknown) {
    if (isTransactionCancelled(err)) return false;
    throw err;
  }
}

// ─── Reclaim Expired (sweeper, §21.4 / §26.4) ────────────────────────────────

/**
 * Find PROCESSING jobs past leaseExpiry and release their slots.
 * Called by the sweeper Lambda on a cron schedule.
 * Returns count of reclaimed + count re-queued + count marked DEAD.
 */
export async function reclaimExpired(): Promise<{
  reclaimed: number;
  requeued: number;
  dead: number;
}> {
  const now = Date.now();
  let reclaimed = 0, requeued = 0, dead = 0;

  for (const lane of ['video', 'rest'] as Lane[]) {
    // Query the sparse lease-reclaim-index (leaseLane+leaseExpiry, set only
    // while a job holds an inline-admitted PROCESSING lease) instead of paging
    // through queue-index's entire lane history — that Query had no sort-key
    // bound, so it read every job ever indexed under this lane just to filter
    // client-side for the handful (if any) of expired leases.
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await client.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'lease-reclaim-index',
        KeyConditionExpression: '#lane = :lane AND leaseExpiry < :now',
        ExpressionAttributeNames: { '#lane': 'leaseLane' },
        ExpressionAttributeValues: marshall({
          ':lane': lane,
          ':now': now,
        }),
        ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
      }));

      for (const raw of result.Items ?? []) {
        const job = unmarshall(raw) as JobItem;
        reclaimed++;

        // Release the slot
        const field = lane === 'video' ? 'video_inflight' : 'rest_inflight';
        await client.send(new UpdateItemCommand({
          TableName: TABLE,
          Key: marshall({ pk: 'COUNTER#modelslab', sk: 'SEMAPHORE' }),
          UpdateExpression: 'ADD #field :neg',
          ConditionExpression: '#field > :zero',
          ExpressionAttributeNames: { '#field': field },
          ExpressionAttributeValues: marshall({ ':neg': -1, ':zero': 0 }),
        })).catch(() => {/* ignore if already at 0 */});

        const newAttempts = (job.attempts ?? 0) + 1;
        const newStatus: JobStatus = newAttempts >= MAX_ATTEMPTS ? 'DEAD' : 'QUEUED';

        await client.send(new UpdateItemCommand({
          TableName: TABLE,
          Key: marshall({ pk: job.pk, sk: job.sk }),
          // Re-enter queue-status-index (queueLane) when requeued so the next
          // dispatch pass finds it; always drop the released lease-reclaim-index
          // key (leaseLane) whether requeued or marked DEAD.
          UpdateExpression: 'SET #status = :s, attempts = :a, updatedAt = :now'
            + (newStatus === 'QUEUED' ? ', queueLane = :ql' : '')
            + ' REMOVE leaseId, leaseExpiry, leaseLane',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: marshall({
            ':s': newStatus,
            ':a': newAttempts,
            ':now': now,
            ...(newStatus === 'QUEUED' ? { ':ql': lane } : {}),
          }),
        }));

        if (newStatus === 'DEAD') {
          dead++;
          console.warn(`[sweeper] job DEAD after ${newAttempts} attempts`, job.jobId);
        } else {
          requeued++;
        }
      }

      lastKey = result.LastEvaluatedKey ? unmarshall(result.LastEvaluatedKey) : undefined;
    } while (lastKey);
  }

  // Re-admit any QUEUED backlog (safety net for missed inline admits)
  if (reclaimed > 0) {
    await pullNext('video').catch(() => {});
    await pullNext('rest').catch(() => {});
  }

  return { reclaimed, requeued, dead };
}

// ─── Counter Reconciliation ───────────────────────────────────────────────────

/**
 * Recompute video_inflight and rest_inflight from the ground truth (actual
 * non-deleted, non-expired LEASE# records) and overwrite the COUNTER item.
 *
 * Called by the sweeper so any incremental drift (double-increment bugs,
 * lost decrement from Lambda OOM, etc.) is corrected every 2 minutes.
 */
export async function reconcileCounter(): Promise<{ video: number; rest: number }> {
  const now = Date.now();
  let video = 0;
  let rest = 0;
  // Ground-truth inflight per RunPod single-counter pool, keyed by counterKey.
  const simple: Record<string, number> = {};
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    // Same lease-index Query as reclaimExpiredLeases() — was a full-table Scan.
    const result = await client.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'lease-index',
      KeyConditionExpression: 'sk = :sk AND leaseExpiry >= :now',
      FilterExpression: 'attribute_not_exists(deleted)',
      ExpressionAttributeValues: marshall({ ':sk': 'LEASE', ':now': now }),
      ProjectionExpression: 'lane, counterKey',
      ExclusiveStartKey: lastKey,
    }));

    for (const raw of result.Items ?? []) {
      const item = unmarshall(raw) as Pick<LeaseItem, 'lane' | 'counterKey'>;
      if (item.counterKey) {
        simple[item.counterKey] = (simple[item.counterKey] ?? 0) + 1;
      } else if (item.lane === 'video') {
        video++;
      } else {
        rest++;
      }
    }

    lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  } while (lastKey);

  await client.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: 'COUNTER#modelslab', sk: 'SEMAPHORE' }),
    UpdateExpression: 'SET video_inflight = :v, rest_inflight = :r, total_inflight = :t',
    ExpressionAttributeValues: marshall({ ':v': video, ':r': rest, ':t': video + rest }),
  }));

  // Overwrite each seen RunPod counter with its ground-truth inflight. (Pools
  // with zero live leases aren't in `simple`; releaseSimple/reclaim already
  // floor them at 0, so we don't need to force-zero every known endpoint here.)
  await Promise.all(
    Object.entries(simple).map(([counterKey, count]) =>
      client.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ pk: counterPk(counterKey), sk: 'SEMAPHORE' }),
        UpdateExpression: 'SET inflight = :n',
        ExpressionAttributeValues: marshall({ ':n': count }),
      })),
    ),
  );

  return { video, rest };
}

// ─── Reclaim Expired Broker Leases ────────────────────────────────────────────

/**
 * Scan for LEASE# records that have expired but were never released (Lambda crash
 * or timeout before calling /release). Decrement the counter for each and mark
 * them deleted so the semaphore stays accurate.
 *
 * Called at the end of the main sweeper run so counters are always reconciled.
 */
export async function reclaimExpiredLeases(): Promise<{ reclaimed: number }> {
  const now = Date.now();
  let reclaimed = 0;
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    // Query the sparse lease-index (sk='LEASE') instead of scanning the whole
    // table — a Scan here was billed for every item in the table, not just the
    // handful of live leases, every 2 minutes via the sweeper (see database-stack.ts).
    const result = await client.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'lease-index',
      KeyConditionExpression: 'sk = :sk AND leaseExpiry < :now',
      FilterExpression: 'attribute_not_exists(deleted)',
      ExpressionAttributeValues: marshall({ ':sk': 'LEASE', ':now': now }),
      ExclusiveStartKey: lastKey,
    }));

    for (const raw of result.Items ?? []) {
      const item = unmarshall(raw) as LeaseItem;

      if (item.counterKey) {
        // RunPod single-counter lease → decrement that endpoint's flat inflight.
        await client.send(new UpdateItemCommand({
          TableName: TABLE,
          Key: marshall({ pk: `COUNTER#${item.counterKey}`, sk: 'SEMAPHORE' }),
          UpdateExpression: 'ADD inflight :neg',
          ConditionExpression: 'inflight > :zero',
          ExpressionAttributeValues: marshall({ ':neg': -1, ':zero': 0 }),
        })).catch(() => { /* already at 0, that's fine */ });
      } else {
        // Global video/rest floor lease (the lane semaphore).
        const lane: Lane = (item.lane === 'video' ? 'video' : 'rest');
        const field = lane === 'video' ? 'video_inflight' : 'rest_inflight';
        await client.send(new UpdateItemCommand({
          TableName: TABLE,
          Key: marshall({ pk: 'COUNTER#modelslab', sk: 'SEMAPHORE' }),
          UpdateExpression: 'ADD #field :neg, total_inflight :neg',
          ConditionExpression: '#field > :zero',
          ExpressionAttributeNames: { '#field': field },
          ExpressionAttributeValues: marshall({ ':neg': -1, ':zero': 0 }),
        })).catch(() => { /* already at 0, that's fine */ });
      }

      // Mark as deleted so subsequent sweeper runs skip it
      await client.send(new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ pk: item.pk, sk: item.sk }),
        UpdateExpression: 'SET deleted = :t',
        ExpressionAttributeValues: marshall({ ':t': true }),
      }));

      reclaimed++;
    }

    lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  } while (lastKey);

  if (reclaimed > 0) {
    console.info(`[lease-sweeper] reclaimed ${reclaimed} expired broker leases`);
  }

  return { reclaimed };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ('name' in err) &&
    (err as { name: string }).name === 'ConditionalCheckFailedException'
  );
}

function isTransactionCancelled(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ('name' in err) &&
    (err as { name: string }).name === 'TransactionCanceledException'
  );
}
