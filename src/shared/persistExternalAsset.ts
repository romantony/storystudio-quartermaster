import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { isInternalRung } from '../handlers/router';
import type { Rung } from '../types';

/**
 * External providers (Replicate, RunComfy, KIE) return ephemeral delivery
 * URLs — they are not permanent storage and expire. Confirmed live
 * 2026-08-17: a real 163-shot dialogue-premium project lost 103 of 122
 * "successfully" generated shots when their replicate.delivery links went
 * dead (HTTP 404) within a few hours, before the pipeline's concat step ever
 * got to read them. Internal rungs (self-hosted RunPod, same-account Lambda —
 * see isInternalRung) already persist their own output to permanent storage
 * themselves (the pod/Lambda code, not this file), so this is a deliberate
 * no-op for them.
 *
 * For everything else: download the asset now, while the provider's link is
 * still fresh, and re-host it on QM's own S3 storage before the job is ever
 * marked COMPLETE — so nothing downstream (concat, hours later) can ever see
 * a dead link. Reuses `qm-merge-output`, the same public/permanent bucket
 * QM-merge already writes finished media to, rather than standing up a new
 * bucket for the same kind of asset.
 *
 * Deliberately throws (does not fall back to the original URL) on any
 * failure — using the ephemeral URL anyway would just delay the identical
 * failure to a much later, harder-to-diagnose point (concat time, hours
 * later) instead of failing fast here, where both call sites (executor.ts's
 * per-rung attempt loop, webhook.ts's top-level catch) already have
 * established, correct handling for a thrown completion error: executor.ts
 * retries/fails over to the next rung immediately; webhook.ts logs and lets
 * the job time out through the normal 850s ceiling, same graceful
 * ShotFailed degrade as any other real generation failure.
 */
const s3 = new S3Client({});
const BUCKET = process.env.EXTERNAL_ASSET_BUCKET;

function extensionFromUrl(url: string): string {
  const m = /\.([a-zA-Z0-9]{2,5})(?:\?|#|$)/.exec(new URL(url).pathname);
  return m ? m[1] : 'bin';
}

export async function persistIfExternal(url: string, rung: Rung, jobId: string): Promise<string> {
  if (isInternalRung(rung)) return url;
  if (!BUCKET) throw new Error('persistIfExternal: EXTERNAL_ASSET_BUCKET not configured');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`persistIfExternal: GET ${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const key = `external-mirror/${rung.provider}/${jobId}.${extensionFromUrl(url)}`;

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buf,
    ContentType: contentType,
  }));

  return `https://${BUCKET}.s3.us-east-1.amazonaws.com/${key}`;
}
