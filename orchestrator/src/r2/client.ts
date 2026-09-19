/**
 * Cloudflare R2 (S3-compatible) transport — persists Remotion Lambda's
 * output into QM's own permanent storage instead of leaving it on Remotion's
 * own S3 bucket (`remotionlambda-useast1-55dp29f3ln`, owned/managed by the
 * Remotion Lambda deployment, not QM — no bucket policy, no CDN, and
 * nothing QM controls the retention of).
 *
 * Same rationale, same "throw don't fall back" philosophy, as the top-level
 * repo's `src/shared/persistExternalAsset.ts` (real incident, 2026-08-17: a
 * 163-shot project lost 103 of 122 shots when replicate.delivery links
 * expired before concat ever read them) — except that file targets QM's own
 * S3 bucket (the AWS-Lambda live path's storage), while this orchestrator's
 * whole ecosystem (postprod-lite and everything upstream of it) already
 * stores permanent output in R2, so this persists there instead, reusing
 * the same `e2e-storystudio` bucket / credentials every other QM service
 * already writes to (see orchestrator/containers/media.md).
 *
 * Deliberately throws on any failure (download or upload) rather than
 * falling back to Remotion's ephemeral URL — agents/generator.ts's lambda
 * dispatch branch treats that the same as an invoke failure (retry/fail the
 * job), not a silent degrade.
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export interface R2Transport {
  accountId: string;
  bucket: string;
  publicUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injectable for tests: replaces the real GET of `url`. */
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer>; headers: { get(name: string): string | null } }>;
  /** Injectable for tests: replaces the real R2 PutObjectCommand. */
  putImpl?: (deps: R2Transport, key: string, body: Buffer, contentType: string) => Promise<void>;
}

async function defaultPut(deps: R2Transport, key: string, body: Buffer, contentType: string): Promise<void> {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${deps.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: deps.accessKeyId, secretAccessKey: deps.secretAccessKey },
  });
  await client.send(new PutObjectCommand({ Bucket: deps.bucket, Key: key, Body: body, ContentType: contentType }));
}

/** Downloads `url` and re-uploads it to R2 at `key`, returning the new
 * permanent public URL. */
export async function persistToR2(deps: R2Transport, url: string, key: string): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`persistToR2: GET ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? 'video/mp4';

  const put = deps.putImpl ?? defaultPut;
  await put(deps, key, buf, contentType);

  return `${deps.publicUrl.replace(/\/$/, '')}/${key}`;
}

/**
 * Uploads a document this process generated (rather than re-hosting one from
 * a URL, which is what persistToR2 does) and returns its permanent public
 * URL. The project compiler's tail manifest is written with it — a file, not
 * an inline payload, so an oversized manifest can never blow a request-size
 * limit the way this pipeline's inline manifests twice did.
 *
 * Same throw-don't-degrade contract as persistToR2: a compiler that cannot
 * write its manifest has not compiled the project.
 */
export async function putJsonToR2(deps: R2Transport, key: string, value: unknown): Promise<string> {
  const body = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
  const put = deps.putImpl ?? defaultPut;
  await put(deps, key, body, 'application/json');
  return `${deps.publicUrl.replace(/\/$/, '')}/${key}`;
}
