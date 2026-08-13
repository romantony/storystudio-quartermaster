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
  cloneArtifactUrl?: string;         // Qwen voice-clone fast path (precomputed .pt)
  voiceId?: string;                  // Kokoro voice selection (4lang + narrationBasic tts)
  voiceText?: string;                // narration-basic `pipeline` mode: voice_text
  effect?: string;
  initImageUrls?: string[];
  audioUrl?: string;
  // Dialogue Premium `kind:"dialogue"` shots only — RunComfy fast/multi's two
  // input tracks (adapters/runcomfy.ts). Every other rung leaves both undefined.
  leftAudioUrl?: string;
  rightAudioUrl?: string;
  mixMode?: 'replace' | 'additive';
  // lambdamerge only — linear gain applied to audioUrl before mux/mix, see
  // CanonicalJobParams.sfxVolume (types.ts) for the full contract.
  sfxVolume?: number;
  // BGM only: the project's frames, used to compute the generated track's
  // length (sum of frame durations) — ASL has no native array-sum function,
  // and by the time BGM would otherwise run near finalize, the pipeline has
  // already dropped $.frames to stay under the 256KB state-size limit, so the
  // SFN passes the full array here (while it's still available) and lets this
  // Lambda do the sum. Ignored unless durationS is omitted.
  frames?: Array<{ duration?: number }>;
  // Dialogue Basic's BGM only (storystudio-dialogue-qm-sfn-handoff.md §3.2):
  // duration = Σ actual segment durations, NOT Σ frame durations — the
  // narrator track's real (TTS/InfiniteTalk-measured) length, which can
  // differ from the sum of its scene clips even after ReconcileSegmentTiming
  // absorbs per-segment drift (§4.5's own ±1-frame residual note). Checked
  // after `frames` above, so a caller would never send both.
  segments?: Array<{ actualDurationSeconds?: number }>;
  projectId: string;
  frameId?: string;
  userId?: string;
  requestId?: string;
  s3Target?: string;
  /** SFN Task Token ($$.Task.Token), present when the calling state uses the
   * `lambda:invoke.waitForTaskToken` integration (pipeline-stack.ts's
   * ttsTask()) instead of a plain synchronous invoke — see the branch in the
   * handler below. Lets a job whose real generation time can exceed a single
   * Lambda's window (e.g. whole-script localized TTS) resolve later via
   * webhook.ts's SendTaskSuccess/Failure instead of this Lambda blocking-
   * polling for it. */
  taskToken?: string;
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
  /** Real generated duration in seconds, when the completing rung reported one
   * (TTS/merge/concat/animate) — e.g. drives Narration-Premium's Wan2 clip
   * length off the TTS's ACTUAL length, not the planned frame.duration. */
  durationS?: number;
  /** Plain text result for text-producing rungs — Whisper transcript text
   * (srt.transcribe) or a translated script (llm.translate). Media-asset
   * rungs (image/video/voice/bgm) leave this undefined; cdnUrl/s3Key stay
   * the canonical result for those. */
  text?: string;
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

// Per-frame localized Kokoro default (voice.narrationBasic.ttsFrameLocalizedKokoro,
// pipeline-stack.ts's localizedFrameTtsKokoroBranch) — used only when the SFN
// sent no explicit voiceId for that language. One catalog rung serves
// es/pt-BR/hi, so a single `fixed.voice` fallback (background.json) can't be
// language-aware; this resolves language+gender to the right Kokoro voice_id
// instead, mirroring genderToVoice's role for English. Pairs from
// qwen-voice-clone/docs/voice-catalog.json's kokoro_voice_reference. Hindi's
// pair (hf_alpha/hm_omega) is verified live (2026-07-08, Whisper round-trip).
// Spanish/Portuguese (ef_dora/em_alex, pf_dora/pm_alex) are NOT yet verified
// live — used_in_catalog:false in that doc — same unverified posture as the
// silence-padding assumption in the fourLang redesign; confirm on the pod
// before trusting in production.
const KOKORO_LANG_GENDER_VOICE: Record<string, { male: string; female: string }> = {
  spanish: { male: 'em_alex', female: 'ef_dora' },
  portuguese: { male: 'pm_alex', female: 'pf_dora' },
  hindi: { male: 'hm_omega', female: 'hf_alpha' },
};

function defaultLocalizedKokoroVoiceId(language?: string, gender?: string): string | undefined {
  const pair = KOKORO_LANG_GENDER_VOICE[(language ?? '').trim().toLowerCase()];
  if (!pair) return undefined;
  return (gender ?? '').trim().toLowerCase() === 'female' ? pair.female : pair.male;
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
    ?? (event.frames?.length ? event.frames.reduce((sum, f) => sum + (f.duration ?? 0), 0) : undefined)
    ?? (event.segments?.length ? event.segments.reduce((sum, s) => sum + (s.actualDurationSeconds ?? 0), 0) : undefined);

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
      cloneArtifactUrl: event.cloneArtifactUrl,
      voiceId: event.voiceId
        ?? (operation === 'ttsFrameLocalizedKokoro' ? defaultLocalizedKokoroVoiceId(event.language, event.voiceGender) : undefined),
      voiceText: event.voiceText,
      effect: event.effect,
      leftAudioUrl: event.leftAudioUrl,
      rightAudioUrl: event.rightAudioUrl,
      mixMode: event.mixMode,
      sfxVolume: event.sfxVolume,
    },
    s3Target,
    projectId: event.projectId,
    frameId: event.frameId,
    userId: event.userId,
    taskToken: event.taskToken,
  };

  // 1. Submit (idempotent: a duplicate requestId returns the existing job).
  const submitRes = await fetch(`${base}/jobs`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const submitText = await submitRes.text();
  if (submitRes.status >= 400) {
    throw new Error(`QM submit failed ${submitRes.status}: ${submitText}`);
  }
  const submitted = JSON.parse(submitText) as {
    jobId: string; requestId: string; status: string; assetKey?: string; durationS?: number; resultText?: string;
  };

  // Cache hit — POST /jobs can return COMPLETE directly.
  if (submitted.assetKey && submitted.status.startsWith('COMPLETE')) {
    const result = finalize(submitted.assetKey, requestId, submitted.jobId, submitted.status, event.aspectRatio, undefined, submitted.durationS, submitted.resultText);
    // A waitForTaskToken caller's SFN task only resumes via SendTaskSuccess/
    // Failure — a plain Lambda return does NOT resume it (unlike a normal
    // synchronous lambda:invoke). Resolve it inline here since there's
    // nothing left to wait for.
    if (event.taskToken) await sendTaskSuccess(event.taskToken, result);
    return result;
  }

  // When called with a taskToken, submit and return immediately — the SFN
  // task stays paused (waitForTaskToken) until webhook.ts resolves it via
  // ProviderTaskItem.taskToken once the job actually finishes, however long
  // that takes. This is what lets a genuinely long-running job (e.g.
  // whole-script localized TTS) outlive a single Lambda invocation instead
  // of hitting DEADLINE_MS/Lambda's own 900s ceiling below.
  if (event.taskToken) {
    return finalize(submitted.assetKey ?? '', requestId, submitted.jobId, submitted.status, event.aspectRatio);
  }

  // 2. Poll to completion.
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const r = await fetch(`${base}/jobs/${encodeURIComponent(requestId)}`, { headers });
    if (r.status === 404) continue; // not yet visible
    const data = (await r.json()) as {
      status: string; assetKey?: string; errorReason?: string; degraded?: unknown; attempts?: number; durationS?: number; resultText?: string;
    };
    if (data.status === 'COMPLETE' || data.status === 'COMPLETE_WITH_FALLBACKS') {
      if (!data.assetKey) throw new Error(`QM job ${requestId} COMPLETE but no assetKey`);
      return finalize(data.assetKey, requestId, submitted.jobId, data.status, event.aspectRatio, data.degraded, data.durationS, data.resultText);
    }
    if (data.status === 'FAILED' || data.status === 'DEAD') {
      throw new Error(`QM job ${requestId} ${data.status}: ${data.errorReason ?? 'all rungs exhausted'}`);
    }
  }
  throw new Error(`QM job ${requestId} timed out after ${DEADLINE_MS}ms`);
};

function finalize(
  assetKey: string, requestId: string, jobId: string, status: string,
  aspectRatio?: string, degraded?: unknown, durationS?: number, text?: string,
): QMGenerateResult {
  const { width, height } = dimsFor(aspectRatio);
  return { cdnUrl: assetKey, s3Key: assetKey, width, height, requestId, jobId, status, degraded, durationS, text };
}

async function sendTaskSuccess(taskToken: string, result: QMGenerateResult): Promise<void> {
  const { SFNClient, SendTaskSuccessCommand } = await import('@aws-sdk/client-sfn');
  const sfn = new SFNClient({});
  await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(result) }));
}
