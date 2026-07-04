import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * QM-generate — the Step Functions ↔ Quartermaster gateway task.
 *
 * A single SFN state calls this Lambda instead of the old
 * "acquire slot → provider Lambda → release slot" cluster. It submits a
 * canonical job to QM (`POST /jobs`), then polls (`GET /jobs/{requestId}`)
 * until the asset is ready, and returns the asset URL shaped as a drop-in for
 * the old `image-basic-generator` output (`cdnUrl`/`s3Key`/`width`/`height`).
 * QM owns provider selection, internal↔external failover, and concurrency —
 * so the SFN no longer needs per-asset fallback branches or semaphore states.
 */

const sm = new SecretsManagerClient({});
let cachedKey: string | undefined;

async function getKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.GATEWAY_STATIC_KEY_ARN! }));
  cachedKey = r.SecretString!;
  return cachedKey;
}

const POLL_INTERVAL_MS = Number(process.env.QM_POLL_INTERVAL_MS ?? 3_000);
const DEADLINE_MS = Number(process.env.QM_GENERATE_DEADLINE_MS ?? 290_000);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface QMGenerateEvent {
  assetType: string;                 // "image" | "voice" | "bgm" | "srt" | "video"
  tier: string;                      // "narrationBasic" | "narrationPremium" | ...
  operation?: string;                // "t2i" | "i2i" | "tts" | "animate" | "merge" | ...
  product?: string;                  // default "narration"
  queue?: 'background' | 'foreground';
  jobType?: 'batch' | 'realtime';    // default "batch" (these SFNs are batch)
  prompt?: string;                   // optional for video animate/merge
  voiceGender?: string;              // "male" | "female" — maps to a Kokoro voice
  aspectRatio?: string;
  resolution?: string;
  durationS?: number;
  voice?: string;
  voiceUrl?: string;
  voiceTranscript?: string;
  instruct?: string;
  speaker?: string;
  language?: string;
  voiceText?: string;                // narration-basic `pipeline` mode: voice_text
  effect?: string;
  initImageUrls?: string[];
  audioUrl?: string;
  // BGM only: the project's frames, used to compute the generated track's
  // length (sum of frame durations) — ASL has no native array-sum function,
  // and by the time BGM would otherwise run near finalize, the pipeline has
  // already dropped $.frames to stay under the 256KB state-size limit, so the
  // SFN passes the full array here (while it's still available) and lets this
  // Lambda do the sum. Ignored unless durationS is omitted.
  frames?: Array<{ duration?: number }>;
  projectId: string;
  frameId?: string;
  userId?: string;
  requestId?: string;
  s3Target?: string;
}

interface QMGenerateResult {
  cdnUrl: string;
  s3Key: string;
  width: number;
  height: number;
  requestId: string;
  jobId: string;
  status: string;
  degraded?: unknown;
}

const DIMS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '1:1':  { width: 1024, height: 1024 },
  '21:9': { width: 1536, height: 640 },
};
const dimsFor = (ar?: string) => DIMS[ar ?? ''] ?? { width: 1024, height: 1024 };

// Voice-gender → Kokoro voice. Male → am_adam, female → af_bella; anything
// missing/unknown defaults to am_adam.
function genderToVoice(gender?: string): string {
  return (gender ?? '').trim().toLowerCase() === 'female' ? 'af_bella' : 'am_adam';
}

export const handler = async (event: QMGenerateEvent): Promise<QMGenerateResult> => {
  const base = process.env.QM_BASE_URL!;
  const key = await getKey();
  const headers = { 'Content-Type': 'application/json', 'x-gateway-key': key };

  const operation = event.operation ?? 't2i';
  const requestId = event.requestId
    ?? `${event.projectId}:${event.frameId ?? 'na'}:${event.assetType}:${operation}`;
  const s3Target = event.s3Target
    ?? `storystudio/${event.assetType}s/${event.projectId}_${event.frameId ?? 'na'}_${operation}`;
  const durationS = event.durationS
    ?? (event.frames?.length ? event.frames.reduce((sum, f) => sum + (f.duration ?? 0), 0) : undefined);

  const body = {
    assetType: event.assetType,
    tier: event.tier,
    operation,
    product: event.product ?? 'narration',
    queue: event.queue ?? 'background',
    jobType: event.jobType ?? 'batch',
    requestId,
    prompt: event.prompt ?? '',
    initImageUrls: event.initImageUrls,
    audioUrl: event.audioUrl,
    params: {
      aspectRatio: event.aspectRatio,
      resolution: event.resolution,
      durationS,
      voice: event.voice ?? genderToVoice(event.voiceGender),
      voiceUrl: event.voiceUrl,
      voiceTranscript: event.voiceTranscript,
      instruct: event.instruct,
      speaker: event.speaker,
      language: event.language,
      voiceText: event.voiceText,
      effect: event.effect,
    },
    s3Target,
    projectId: event.projectId,
    frameId: event.frameId,
    userId: event.userId,
  };

  // 1. Submit (idempotent: a duplicate requestId returns the existing job).
  const submitRes = await fetch(`${base}/jobs`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const submitText = await submitRes.text();
  if (submitRes.status >= 400) {
    throw new Error(`QM submit failed ${submitRes.status}: ${submitText}`);
  }
  const submitted = JSON.parse(submitText) as { jobId: string; requestId: string; status: string; assetKey?: string };

  // Cache hit — POST /jobs can return COMPLETE directly.
  if (submitted.assetKey && submitted.status.startsWith('COMPLETE')) {
    return finalize(submitted.assetKey, requestId, submitted.jobId, submitted.status, event.aspectRatio);
  }

  // 2. Poll to completion.
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const r = await fetch(`${base}/jobs/${encodeURIComponent(requestId)}`, { headers });
    if (r.status === 404) continue; // not yet visible
    const data = (await r.json()) as {
      status: string; assetKey?: string; errorReason?: string; degraded?: unknown; attempts?: number;
    };
    if (data.status === 'COMPLETE' || data.status === 'COMPLETE_WITH_FALLBACKS') {
      if (!data.assetKey) throw new Error(`QM job ${requestId} COMPLETE but no assetKey`);
      return finalize(data.assetKey, requestId, submitted.jobId, data.status, event.aspectRatio, data.degraded);
    }
    if (data.status === 'FAILED' || data.status === 'DEAD') {
      throw new Error(`QM job ${requestId} ${data.status}: ${data.errorReason ?? 'all rungs exhausted'}`);
    }
  }
  throw new Error(`QM job ${requestId} timed out after ${DEADLINE_MS}ms`);
};

function finalize(
  assetKey: string, requestId: string, jobId: string, status: string,
  aspectRatio?: string, degraded?: unknown,
): QMGenerateResult {
  const { width, height } = dimsFor(aspectRatio);
  return { cdnUrl: assetKey, s3Key: assetKey, width, height, requestId, jobId, status, degraded };
}
