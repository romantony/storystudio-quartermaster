import { createHmac, timingSafeEqual } from 'crypto';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { ADAPTERS } from '../adapters';
import { releaseSimple } from '../gate/dynamo-gate';
// complete/recordBaseline/loadJob are DB-only (no Lambda-specific state), so
// reusing them here — rather than duplicating — keeps a webhookCompletion
// internal rung's completion/cost/baseline accounting identical to the
// inline-poll path in executor.ts.
import { complete, loadJob, recordBaseline } from './executor';
import type {
  LambdaFunctionUrlEvent,
  LambdaFunctionUrlResponse,
  ProviderTaskItem,
  Rung,
} from '../types';

const TABLE = process.env.TABLE_NAME ?? 'quartermaster-jobs';
const db = new DynamoDBClient({});
const sm = new SecretsManagerClient({});

const secretCache = new Map<string, { value: string; exp: number }>();
async function getSecret(arn: string): Promise<string> {
  const cached = secretCache.get(arn);
  if (cached && cached.exp > Date.now()) return cached.value;
  const res = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const value = res.SecretString ?? '';
  secretCache.set(arn, { value, exp: Date.now() + 5 * 60_000 });
  return value;
}

export const handler = async (evt: LambdaFunctionUrlEvent): Promise<LambdaFunctionUrlResponse> => {
  // Always return 200 quickly so providers don't retry-storm
  const ok: LambdaFunctionUrlResponse = { statusCode: 200, body: '{"ok":true}', headers: { 'Content-Type': 'application/json' } };

  try {
    // 1. Extract provider from path: /webhooks/{provider}
    const provider = evt.rawPath.split('/').pop()?.toLowerCase() ?? '';
    if (!provider || !ADAPTERS[provider]) {
      console.warn('[webhook] unknown provider', provider);
      return ok;
    }

    // 2. Coarse gate: shared secret, delivered as a `?key=` query param on the
    // callbackUrl QM itself hands each provider (executor.ts's callbackUrl) —
    // providers have no mechanism to attach a custom auth header to their
    // callback POST, so checking only a header 401s every real webhook
    // (confirmed live 2026-08-09: RunPod's own dashboard showed a job
    // completing in ~5min, but every callback here was rejected, so QM's job
    // record never left PROCESSING and the SFN task eventually timed out
    // waiting on it). The header is still accepted too, for manual/curl
    // testing — see storystudio-reply-dialogue-validate-input-gap.md's
    // sibling investigation for the live symptom this fixes.
    const gatewayKey = await getSecret(process.env.GATEWAY_STATIC_KEY_ARN ?? '');
    const presentedKey = evt.queryStringParameters?.key ?? evt.headers['x-gateway-key'];
    if (presentedKey !== gatewayKey) {
      console.warn('[webhook] invalid gateway key');
      return { statusCode: 401 };
    }

    // 3. Verify provider HMAC signature
    const bodyStr = evt.body ?? '';
    const sigValid = await verifySignature(provider, evt.headers, bodyStr);
    if (!sigValid) {
      console.warn('[webhook] invalid signature for provider', provider);
      return { statusCode: 401 };
    }

    // 4. Parse webhook payload
    const raw = JSON.parse(bodyStr);
    const adapter = ADAPTERS[provider];
    if (!adapter.parseWebhook) return ok;

    const { taskRef, outputUrls, failed, durationS, text, executionTimeMs } = adapter.parseWebhook(raw);
    if (!taskRef) return ok;

    // 5. Lookup PROVIDERTASK# item
    const mapResult = await db.send(new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: `PROVIDERTASK#${provider}#${taskRef}`, sk: 'TOKEN' }),
    }));
    if (!mapResult.Item) {
      console.info('[webhook] unknown taskRef', taskRef, '— ack and drop');
      return ok;
    }

    const map = unmarshall(mapResult.Item) as ProviderTaskItem;

    // 6. Idempotency: conditional-claim so duplicate webhooks are no-ops
    const claimed = await claimWebhookOnce(map.pk);
    if (!claimed) {
      console.info('[webhook] duplicate webhook for', taskRef);
      return ok;
    }

    // 7. Release the semaphore slot the executor held for this async task.
    if (map.leaseCounterKey && map.leaseId) {
      await releaseSimple(map.leaseCounterKey, map.leaseId).catch(e =>
        console.warn('[webhook] slot release failed', e));
    }

    const now = Date.now();

    if (failed) {
      // Don't dead-end the request — hand back to the executor, which will try
      // the next untried rung (the failed rung is already in triedRungs) and
      // only mark FAILED once the ladder is exhausted.
      await dispatchExecutor(map.requestId, map.jobId).catch(e =>
        console.warn('[webhook] executor re-dispatch failed', e));
      console.info('[webhook] provider failed → failover', provider, taskRef);
    } else {
      const assetKey = outputUrls?.[0];
      // A webhookCompletion internal rung (RunPod, endpointId set) reuses
      // executor.ts's own complete()/recordBaseline() so cost/baseline
      // accounting matches the inline-poll path exactly — the plain
      // UpdateItemCommand below (unchanged) still covers external providers
      // (replicate/kie), which were already completing this way and don't
      // carry GPU cost/baseline data.
      const isInternalWebhookJob = map.provider === 'runpod' && !!map.endpointId;
      if (isInternalWebhookJob && assetKey) {
        const job = await loadJob(map.requestId, map.jobId);
        if (job) {
          const rung: Rung = {
            provider: map.provider ?? provider,
            endpointId: map.endpointId,
            counterKey: map.leaseCounterKey,
            model: '', lane: 'rest', routingMode: 'direct',
          };
          await complete(job, assetKey, undefined, durationS, text, rung, executionTimeMs);
          await recordBaseline(rung, job, now - map.createdAt);
        } else {
          console.warn('[webhook] job record missing for internal webhookCompletion task', map.requestId, map.jobId);
        }
      } else {
        await db.send(new UpdateItemCommand({
          TableName: TABLE,
          Key: marshall({ pk: `REQ#${map.requestId}`, sk: `JOB#${map.jobId}` }),
          UpdateExpression: 'SET #status = :s, updatedAt = :now' + (assetKey ? ', assetKey = :ak' : ''),
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: marshall({
            ':s': 'COMPLETE',
            ':now': now,
            ...(assetKey ? { ':ak': assetKey } : {}),
          }),
        }));
      }
      console.info('[webhook] resolved', provider, taskRef, 'COMPLETE');
    }

    // If a taskToken is present, resume the paused Step Functions task
    // (waitForTaskToken integration — see pipeline-stack.ts's ttsTask()).
    if (map.taskToken) {
      await resumeStepFunction(map.taskToken, {
        failed, requestId: map.requestId, jobId: map.jobId, assetKey: outputUrls?.[0], durationS, text,
      }).catch(e => console.warn('[webhook] sendTaskSuccess/Failure failed', e));
    }

    return ok;
  } catch (err) {
    console.error('[webhook] error', err);
    return ok; // always 200 to prevent provider retries
  }
};

// ─── Signature verification (§29.4) ──────────────────────────────────────────

async function verifySignature(
  provider: string,
  headers: Record<string, string>,
  body: string,
): Promise<boolean> {
  try {
    if (provider === 'replicate') {
      const secretArn = process.env.REPLICATE_WEBHOOK_SECRET_ARN ?? '';
      if (!secretArn) return true; // no secret configured → skip verification in dev
      const secret = await getSecret(secretArn);
      const sig = headers['webhook-signature'] ?? headers['x-signature'] ?? '';
      const webhookId = headers['webhook-id'] ?? '';
      const webhookTimestamp = headers['webhook-timestamp'] ?? '';
      const signedContent = `${webhookId}.${webhookTimestamp}.${body}`;
      const expected = createHmac('sha256', secret).update(signedContent).digest('base64');
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    }

    if (provider === 'kie') {
      const secretArn = process.env.KIE_WEBHOOK_SECRET_ARN ?? '';
      if (!secretArn) return true;
      const secret = await getSecret(secretArn);
      const sig = headers['x-kie-signature'] ?? headers['x-signature'] ?? '';
      const expected = createHmac('sha256', secret).update(body).digest('hex');
      const sigHex = sig.startsWith('sha256=') ? sig.slice(7) : sig;
      return timingSafeEqual(Buffer.from(sigHex, 'hex'), Buffer.from(expected, 'hex'));
    }

    if (provider === 'runpod') {
      // RunPod doesn't use HMAC — trust based on X-Gateway-Key already checked
      return true;
    }

    return true;
  } catch {
    return false;
  }
}

// ─── Idempotency ─────────────────────────────────────────────────────────────

async function claimWebhookOnce(pk: string): Promise<boolean> {
  try {
    await db.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ pk, sk: 'TOKEN' }),
      UpdateExpression: 'SET claimed = :t',
      ConditionExpression: 'attribute_not_exists(claimed) OR claimed = :f',
      ExpressionAttributeValues: marshall({ ':t': true, ':f': false }),
    }));
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

// ─── Executor re-dispatch (failover) ─────────────────────────────────────────

async function dispatchExecutor(requestId: string, jobId: string): Promise<void> {
  const fn = process.env.EXECUTOR_FUNCTION_NAME;
  if (!fn) {
    console.warn('[webhook] EXECUTOR_FUNCTION_NAME unset — cannot fail over');
    return;
  }
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({});
  await lambda.send(new InvokeCommand({
    FunctionName: fn,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ requestId, jobId })),
  }));
}

// ─── Step Functions task-token resume (waitForTaskToken integration) ────────

interface TaskTokenResult {
  failed?: boolean;
  requestId: string;
  jobId: string;
  assetKey?: string;
  durationS?: number;
  text?: string;
}

// Resumes an SFN task paused on `lambda:invoke.waitForTaskToken`
// (pipeline-stack.ts's ttsTask()). Success output must match the shape
// qm-generate.ts's finalize() produces — downstream states (e.g.
// QMGenerateLocalizedSRT) read $.ttsResult.cdnUrl the same way regardless of
// whether the task resolved via a normal Lambda return or this callback.
async function resumeStepFunction(taskToken: string, result: TaskTokenResult) {
  const { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } = await import('@aws-sdk/client-sfn');
  const sfn = new SFNClient({});
  if (result.failed || !result.assetKey) {
    await sfn.send(new SendTaskFailureCommand({
      taskToken,
      error: 'ProviderFailed',
      cause: result.failed ? 'Provider reported failure' : 'Provider reported success with no output URL',
    }));
  } else {
    await sfn.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({
        cdnUrl: result.assetKey,
        s3Key: result.assetKey,
        width: 1024,
        height: 1024,
        requestId: result.requestId,
        jobId: result.jobId,
        status: 'COMPLETE',
        durationS: result.durationS,
        text: result.text,
      }),
    }));
  }
}
