import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * QM-fetch-shots-manifest — Dialogue Premium only
 * (storystudio-dialogue-qm-sfn-handoff.md §7.2). A large film (60-90+ shots,
 * long image prompts) can approach Step Functions' 256KB input limit;
 * StoryStudio then sends `shotsManifestUrl` (an R2 JSON URL) instead of
 * inlining `shots`. R2 isn't AWS S3, so the SFN's native
 * `aws-sdk:s3:getObject` integration can't fetch it directly.
 *
 * 2026-08-16 fix (real 132-shot/565KB project hit this live): the naive
 * "fetch and return the array as this Lambda's own Task output" approach
 * just moves the 256KB ceiling from execution-start to here — Step
 * Functions' per-task-output limit applies just as hard to this Lambda's
 * return value as it did to the original inline `shots`. So instead of
 * returning the manifest, this now mirrors it into S3 (`removeSilenceBucket`,
 * the pipeline's existing shared/public output bucket — already readable by
 * the state machine's role with no new IAM grant, same posture as this
 * pipeline's other public-bucket outputs) and returns only `{bucket, key}` —
 * tiny, no size issue. The state machine then reads shots directly off S3 via
 * a Distributed Map `ItemReader`, never loading the full array into
 * execution state at all (see dialoguePremiumShotMap's `itemSource:'s3'`
 * branch in infra/lib/pipeline-stack.ts).
 */

interface FetchShotsManifestEvent {
  shotsManifestUrl: string;
  projectId: string;
  jobId: string;
}

interface FetchShotsManifestResult {
  bucket: string;
  key: string;
}

const s3 = new S3Client({});
const BUCKET = process.env.OUTPUT_BUCKET!;

export const handler = async (event: FetchShotsManifestEvent): Promise<FetchShotsManifestResult> => {
  const res = await fetch(event.shotsManifestUrl);
  if (!res.ok) {
    throw new Error(`fetch-shots-manifest: GET ${event.shotsManifestUrl} -> HTTP ${res.status}`);
  }
  const shots = await res.json();
  if (!Array.isArray(shots)) {
    throw new Error(`fetch-shots-manifest: ${event.shotsManifestUrl} did not resolve to a JSON array`);
  }

  const key = `dialogue-premium-manifests/${event.projectId}/${event.jobId}-shots.json`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(shots),
    ContentType: 'application/json',
  }));
  return { bucket: BUCKET, key };
};
