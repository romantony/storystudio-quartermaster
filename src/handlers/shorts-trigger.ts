import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * TriggerShortsFromLongForm — the Step Functions ↔ shorts-longform RunPod task.
 *
 * Fire-and-forget: kicks off the `shorts-longform` RunPod endpoint's async
 * /run on the pipeline's concat video (transcript-first AI clip selection),
 * then returns immediately with the RunPod job id. Completion is reported by
 * RunPod's webhook straight to Convex — this Lambda does not poll. Failure
 * here is non-fatal to the caller (SFN Catches States.ALL around this task),
 * matching the legacy TriggerShortsFromLongForm→E2E-start-shorts contract it
 * replaces (see docs in ~/longtoshort/RUNPOD-SHORTS-WORKER.md and
 * STORYSTUDIO-INTEGRATION.md).
 *
 * `shortsOptions` is a raw passthrough merged into RunPod's `input` — the
 * worker's job.input has ~20 optional fields defined ad hoc in handler.py
 * (segments/frames, num_clips, render_style, upscale, caption_config, hook,
 * slides, bgm_volume, ass_url, ...) with no formal schema on the RunPod side,
 * so this Lambda doesn't hardcode a copy of that surface — it merges whatever
 * the caller sends and lets RunPod validate it. Caller-supplied keys win over
 * this Lambda's computed defaults (srt_url/segments_source/bgm_url), but
 * never over project_id/video_url — those are always the pipeline's own
 * concat-video facts for this execution, not caller-overridable.
 */

const sm = new SecretsManagerClient({});
let cachedKey: string | undefined;

async function getKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.RUNPOD_API_KEY_ARN! }));
  cachedKey = r.SecretString!;
  return cachedKey;
}

const ENDPOINT_ID = process.env.SHORTS_ENDPOINT_ID ?? 'u3bvq5juben8ri';

interface ShortsTriggerEvent {
  projectId: string;
  jobId: string;
  videoUrl: string;
  srtUrl?: string;
  bgmUrl?: string;
  convexEndpoint?: string;
  /** Raw passthrough merged into RunPod's job.input — see file header. */
  shortsOptions?: Record<string, unknown>;
}

export const handler = async (event: ShortsTriggerEvent): Promise<Record<string, unknown>> => {
  const apiKey = await getKey();

  const defaults: Record<string, unknown> = { mode: 'shorts' };
  // Transcript-first AI clipping is the recommended mode (frame-accurate
  // captions sliced from the real SRT, Claude picks highlight clips) — only
  // available when the pipeline produced a full-video SRT. shortsOptions can
  // override segments_source (e.g. explicit segments[] + srt_url without AI
  // selection) since it's spread after these defaults.
  if (event.srtUrl) {
    defaults.srt_url = event.srtUrl;
    defaults.segments_source = 'ai';
  }
  if (event.bgmUrl) defaults.bgm_url = event.bgmUrl;

  const input: Record<string, unknown> = {
    ...defaults,
    ...(event.shortsOptions ?? {}),
    // Never caller-overridable — always this execution's own concat video.
    project_id: event.projectId,
    video_url: event.videoUrl,
  };

  const body: Record<string, unknown> = { input };
  if (event.convexEndpoint) {
    body.webhook = `${event.convexEndpoint}/api/e2e/runpod-webhook?jobId=${encodeURIComponent(event.jobId)}`;
  }

  const r = await fetch(`https://api.runpod.ai/v2/${ENDPOINT_ID}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data = (await r.json()) as { id?: string; status?: string; error?: string };
  if (!r.ok) {
    throw new Error(`shorts-longform /run failed: ${r.status} ${JSON.stringify(data)}`);
  }
  return { runpodJobId: data.id, status: data.status };
};
