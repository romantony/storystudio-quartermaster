import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

/**
 * QM-orchestrator-runpod — the one place the orchestrator tail's Step Functions
 * state machine talks to RunPod (docs/qm-sfn-ecs-tail-implementation-2026-10-02.md
 * §3). Two actions, called from a submit -> Wait -> status loop in the ASL:
 *
 *   submit  POST /v2/<endpoint>/run     -> { jobId, status }
 *   status  GET  /v2/<endpoint>/status/<jobId>
 *                                       -> { status, srtUrl?, audioUrl?, error? }
 *
 * A Lambda rather than an SFN HTTP Task so the API key stays in Secrets Manager
 * (an HTTP Task needs it in an EventBridge Connection, with the `Bearer ` prefix
 * glued on at deploy time), and so the response can be TRIMMED: a transcribe job
 * returns every word with its timestamps — easily 100KB for a long video — and
 * Step Functions caps a state's payload at 256KB. Only the two URLs the tail
 * needs ever reach the state machine.
 *
 * Only BGM-S2T modes the tail uses are allowed, so a bad state-machine edit
 * cannot turn this into a general RunPod proxy.
 */

const RUNPOD_BASE = process.env.RUNPOD_API_BASE ?? 'https://api.runpod.ai/v2';
const ENDPOINT_ID = /^[a-z0-9]{8,32}$/;
const JOB_ID = /^[A-Za-z0-9-]{8,80}$/;
const ALLOWED_MODES = new Set(['transcribe', 'bgm']);

/** ACE-Step reliably generates ~120s; the tail loops the track under the video
 * (ffmpeg -stream_loop in finalize), same convention as the cohort path's
 * builders/bgm.ts. A floor keeps a degenerate duration from failing the model. */
export const BGM_MIN_S = 5;
export const BGM_MAX_S = 120;

export interface SubmitEvent {
  action: 'submit';
  endpointId: string;
  input: Record<string, unknown>;
}

export interface StatusEvent {
  action: 'status';
  endpointId: string;
  jobId: string;
}

export type RunpodEvent = SubmitEvent | StatusEvent;

export interface RunpodDeps {
  getKey(): Promise<string>;
  fetchImpl: typeof fetch;
}

/** The fields of a RunPod output the state machine may see. */
export interface TrimmedStatus {
  status: string;
  /** SRT cue file (transcribe). */
  srtUrl?: string;
  /** Generated audio (bgm). */
  audioUrl?: string;
  error?: string;
}

export function clampBgmInput(input: Record<string, unknown>): Record<string, unknown> {
  if (input.mode !== 'bgm') return input;
  const requested = Number(input.duration_s);
  const duration = Number.isFinite(requested) ? requested : BGM_MAX_S;
  return { steps: 20, guidance: 7.0, ...input, duration_s: Math.min(BGM_MAX_S, Math.max(BGM_MIN_S, Math.ceil(duration))) };
}

function pickUrl(output: unknown, ...fields: string[]): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  for (const f of fields) {
    const v = (output as Record<string, unknown>)[f];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  return undefined;
}

/** RunPod reports a worker-side failure inside a COMPLETED job's output. */
function outputError(output: unknown): string | undefined {
  if (output && typeof output === 'object') {
    const e = (output as { error?: unknown }).error;
    if (typeof e === 'string' && e.trim()) return e.slice(0, 500);
  }
  return undefined;
}

export function trimStatus(raw: { status?: string; output?: unknown; error?: unknown }): TrimmedStatus {
  const status = String(raw.status ?? 'UNKNOWN');
  const workerError = status === 'COMPLETED' ? outputError(raw.output) : undefined;
  // A COMPLETED whose output carries an error string is a failure, not a success.
  if (workerError) return { status: 'FAILED', error: workerError };
  const out: TrimmedStatus = { status };
  const srtUrl = pickUrl(raw.output, 'srt');
  const audioUrl = pickUrl(raw.output, 'audio', 'audio_url', 'url');
  if (srtUrl) out.srtUrl = srtUrl;
  if (audioUrl) out.audioUrl = audioUrl;
  if (raw.error) out.error = String(typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error)).slice(0, 500);
  return out;
}

export function makeHandler(deps: RunpodDeps) {
  return async (event: RunpodEvent): Promise<Record<string, unknown>> => {
    if (!event || !ENDPOINT_ID.test(event.endpointId ?? '')) throw new Error(`invalid endpointId: ${JSON.stringify((event as { endpointId?: unknown })?.endpointId)}`);
    const key = await deps.getKey();
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

    if (event.action === 'submit') {
      const mode = String(event.input?.mode ?? '');
      if (!ALLOWED_MODES.has(mode)) throw new Error(`mode ${JSON.stringify(mode)} is not allowed (allowed: ${[...ALLOWED_MODES].join(', ')})`);
      const res = await deps.fetchImpl(`${RUNPOD_BASE}/${event.endpointId}/run`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: clampBgmInput(event.input) }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`RunPod submit failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      const body = JSON.parse(text) as { id?: string; status?: string };
      if (!body.id) throw new Error(`RunPod submit returned no job id: ${text.slice(0, 300)}`);
      return { jobId: body.id, status: body.status ?? 'IN_QUEUE' };
    }

    if (event.action === 'status') {
      if (!JOB_ID.test(event.jobId ?? '')) throw new Error(`invalid jobId: ${JSON.stringify(event.jobId)}`);
      const res = await deps.fetchImpl(`${RUNPOD_BASE}/${event.endpointId}/status/${event.jobId}`, { headers });
      const text = await res.text();
      // 404: RunPod says this job id will never resolve. Report it as a terminal
      // failure so the state machine skips the layer instead of polling forever.
      if (res.status === 404) return { status: 'FAILED', error: 'RunPod job not found' };
      if (!res.ok) throw new Error(`RunPod status failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      return { ...trimStatus(JSON.parse(text)) };
    }

    throw new Error(`unknown action ${JSON.stringify((event as { action?: unknown }).action)}`);
  };
}

const sm = new SecretsManagerClient({});
let cachedKey: string | undefined;

async function getKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.RUNPOD_API_KEY_ARN! }));
  cachedKey = (r.SecretString ?? '').trim();
  return cachedKey;
}

export const handler = makeHandler({ getKey, fetchImpl: (...a) => fetch(...a) });
