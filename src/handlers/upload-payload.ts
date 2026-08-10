import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * QM-upload-payload — writes an arbitrary JSON string to S3 and hands back
 * its key. Exists solely to work around `ecs:runTask`'s hard 8192-byte
 * `Overrides` limit: ConcatAndTrim's per-frame video-URL payload blows past
 * that at large frame counts (confirmed failing at 69 frames — see
 * qm-concat-trim-ecs-migration memory), so the payload is written here
 * first and only a short S3 key crosses the ContainerOverrides boundary;
 * the container fetches the real payload from S3 instead of reading it
 * from an env var.
 */

interface UploadPayloadEvent {
  key: string;
  body: string;
}

const s3 = new S3Client({});
const BUCKET = process.env.OUTPUT_BUCKET!;

export const handler = async (event: UploadPayloadEvent): Promise<{ key: string }> => {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: event.key,
    Body: event.body,
    ContentType: 'application/json',
  }));
  return { key: event.key };
};
