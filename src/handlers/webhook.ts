import { createHmac, timingSafeEqual } from 'crypto';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { ADAPTERS } from '../adapters';
import type {
  JobStatus,
  LambdaFunctionUrlEvent,
  LambdaFunctionUrlResponse,
  ProviderTaskItem,
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

    // 2. Coarse gate: X-Gateway-Key
    const gatewayKey = await getSecret(process.env.GATEWAY_STATIC_KEY_ARN ?? '');
    if (evt.headers['x-gateway-key'] !== gatewayKey) {
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

    const { taskRef, outputUrls, failed } = adapter.parseWebhook(raw);
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

    // 7. Phase 1 (no SFN): update job status directly in DynamoDB
    const now = Date.now();
    const newStatus: JobStatus = failed ? 'FAILED' : 'COMPLETE';
    const assetKey = outputUrls?.[0];

    await db.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ pk: `REQ#${map.requestId}`, sk: `JOB#${map.jobId}` }),
      UpdateExpression: 'SET #status = :s, updatedAt = :now' + (assetKey ? ', assetKey = :ak' : ''),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':s': newStatus,
        ':now': now,
        ...(assetKey ? { ':ak': assetKey } : {}),
      }),
    }));

    // Phase 2 stub: if a taskToken is present, resume the Step Function
    if (map.taskToken) {
      await resumeStepFunction(map.taskToken, { outputUrls, failed }).catch(e =>
        console.warn('[webhook] sendTaskSuccess/Failure failed (SFN not wired yet)', e),
      );
    }

    console.info('[webhook] resolved', provider, taskRef, newStatus);
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

// ─── Step Functions stub (Phase 2) ───────────────────────────────────────────

async function resumeStepFunction(taskToken: string, result: { outputUrls?: string[]; failed?: boolean }) {
  const { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } = await import('@aws-sdk/client-sfn');
  const sfn = new SFNClient({});
  if (result.failed) {
    await sfn.send(new SendTaskFailureCommand({
      taskToken,
      error: 'ProviderFailed',
      cause: 'Provider reported failure',
    }));
  } else {
    await sfn.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ outputUrls: result.outputUrls }),
    }));
  }
}
