/**
 * Comfy Cloud transport for the `comfy-video` asset (LTX-2.3, 2026-10-04).
 *
 * Flow, all live-verified 2026-10-03 (docs/TODO.md): upload still(s) ->
 * patch the committed API-format workflow -> POST /api/prompt -> poll
 * `GET /api/job/{id}/status` (NOT /api/history, which never updates) ->
 * `GET /api/jobs/{id}` for the output file -> `GET /api/view` (302 to a signed
 * GCS URL). The caller re-hosts the bytes before completing the row: the
 * signed link expires (the 2026-08-17 Replicate lesson).
 *
 * Operator decision 2026-10-04: open-weight LTX-2.3 ONLY. `assertOpenWeightGraph`
 * refuses a graph with any node outside the allow-list, so a partner/API node
 * (billed per call) can never be submitted by a future workflow edit.
 */
import i2vWorkflow from './workflows/ltx23_i2v.json';
import flf2vWorkflow from './workflows/ltx23_flf2v.json';
import ia2vWorkflow from './workflows/ltx23_ia2v.json';
import flfIa2vWorkflow from './workflows/ltx23_flf_ia2v.json';

export const COMFY_BASE = 'https://cloud.comfy.org';
export const COMFY_FPS = 25;
/** 720p. The tail's CPU upscaler makes 1080p (operator, 2026-10-04). */
export const COMFY_SIZE = { landscape: [1280, 720], portrait: [720, 1280] } as const;

/** Every node type the committed LTX-2.3 graphs use — all local to ComfyUI. */
export const ALLOWED_NODE_TYPES: ReadonlySet<string> = new Set([
  'CFGGuider', 'CLIPTextEncode', 'CheckpointLoaderSimple', 'ComfyMathExpression', 'ComfySwitchNode', 'CreateVideo',
  'EmptyLTXVLatentVideo', 'GetImageSize', 'KSamplerSelect', 'LTXAVTextEncoderLoader', 'LTXVAddGuide', 'LTXVAudioVAEDecode',
  'LTXVAudioVAELoader', 'LTXVConcatAVLatent', 'LTXVConditioning', 'LTXVCropGuides', 'LTXVEmptyLatentAudio',
  'LTXVAudioVAEEncode', 'LTXVImgToVideoInplace', 'LTXVLatentUpsampler', 'LTXVPreprocess', 'LTXVSeparateAVLatent', 'LatentUpscaleModelLoader',
  'LoadAudio', 'LoadImage', 'LoraLoader', 'LoraLoaderModelOnly', 'ManualSigmas', 'PreviewAny', 'PrimitiveBoolean', 'PrimitiveFloat',
  'PrimitiveInt', 'PrimitiveStringMultiline', 'RandomNoise', 'ResizeImageMaskNode', 'SamplerCustomAdvanced',
  'SamplerEulerAncestral', 'SaveVideo', 'SetLatentNoiseMask', 'SolidMask', 'TrimAudioDuration', 'TextGenerateLTX2Prompt', 'VAEDecodeTiled',
]);

export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export function assertOpenWeightGraph(graph: ComfyGraph): void {
  const bad = Object.entries(graph)
    .filter(([, n]) => !ALLOWED_NODE_TYPES.has(n.class_type))
    .map(([id, n]) => `${id}:${n.class_type}`);
  if (bad.length > 0) throw new Error(`comfy graph has non-allow-listed nodes (partner/API nodes are refused): ${bad.join(', ')}`);
}

export type ComfyWorkflow = 'ltx23_i2v' | 'ltx23_flf2v' | 'ltx23_ia2v' | 'ltx23_flf_ia2v';

export interface ComfyJobSpec {
  workflow: ComfyWorkflow;
  /** Uploaded input names (from `uploadImage`). `lastImage` only for flf2v. */
  firstImage: string;
  lastImage?: string;
  /** Uploaded input name of the padded dialogue audio (ia2v workflows). */
  audio?: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  fps: number;
  durationS: number;
  seed: number;
}

/** Appended to every negative prompt — the anatomy/quality guard the 10-04
 * Clockmaker test settled on. */
export const NEG_DEFAULT = 'pc game, console game, video game, cartoon, childish, ugly, deformed hands, extra fingers, distorted face';

/** Patch the node map found in the 10-03/10-04 tests (comfy-story-test/run.py). */
export function buildGraph(spec: ComfyJobSpec): ComfyGraph {
  const src = { ltx23_i2v: i2vWorkflow, ltx23_flf2v: flf2vWorkflow, ltx23_ia2v: ia2vWorkflow, ltx23_flf_ia2v: flfIa2vWorkflow }[spec.workflow];
  const g = structuredClone(src) as unknown as ComfyGraph;
  const neg = [spec.negativePrompt, NEG_DEFAULT].filter(Boolean).join(', ');
  const needAudio = spec.workflow === 'ltx23_ia2v' || spec.workflow === 'ltx23_flf_ia2v';
  const needLast = spec.workflow === 'ltx23_flf2v' || spec.workflow === 'ltx23_flf_ia2v';
  if (needAudio && !spec.audio) throw new Error(`${spec.workflow} needs audio`);
  if (needLast && !spec.lastImage) throw new Error(`${spec.workflow} needs lastImage`);
  if (spec.workflow === 'ltx23_i2v') {
    g['269'].inputs.image = spec.firstImage;
    g['320:319'].inputs.value = spec.prompt;
    g['320:312'].inputs.value = spec.width;
    g['320:299'].inputs.value = spec.height;
    g['320:300'].inputs.value = spec.fps;
    g['320:301'].inputs.value = spec.durationS;
    g['320:276'].inputs.noise_seed = spec.seed;
    g['320:313'].inputs.text = `${g['320:313'].inputs.text as string}, ${neg}`;
  } else if (spec.workflow === 'ltx23_ia2v') {
    // Audio-driven: the clip length is the audio's (340:331, float seconds).
    g['269'].inputs.image = spec.firstImage;
    g['276'].inputs.audio = spec.audio;
    g['340:319'].inputs.value = spec.prompt;
    g['340:330'].inputs.value = spec.width;
    g['340:324'].inputs.value = spec.height;
    g['340:331'].inputs.value = Number(spec.durationS);
    g['340:285'].inputs.noise_seed = spec.seed;
    g['340:314'].inputs.text = `${g['340:314'].inputs.text as string}, ${neg}`;
  } else {
    // flf2v and flf_ia2v share the 129:* subgraph; the latter adds the audio.
    g['31'].inputs.image = spec.firstImage;
    g['39'].inputs.image = spec.lastImage;
    g['129:128'].inputs.text = spec.prompt;
    g['129:112'].inputs.text = neg;
    g['129:113'].inputs.value = spec.width;
    g['129:98'].inputs.value = spec.height;
    g['129:114'].inputs.value = spec.fps;
    g['129:102'].inputs.value = spec.durationS;
    g['129:100'].inputs.noise_seed = spec.seed;
    if (spec.workflow === 'ltx23_flf_ia2v') {
      g['276'].inputs.audio = spec.audio;
      g['129:200'].inputs.value = Number(spec.durationS);
    }
  }
  assertOpenWeightGraph(g);
  return g;
}

export interface ComfyTransport {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Poll interval; default 5s. */
  pollMs?: number;
  /** Give up on one job after this long; default 15 min. */
  timeoutMs?: number;
}

const f = (t: ComfyTransport): typeof fetch => t.fetchImpl ?? fetch;
const base = (t: ComfyTransport): string => t.baseUrl ?? COMFY_BASE;
const headers = (t: ComfyTransport): Record<string, string> => ({ 'X-API-Key': t.apiKey });

/** Download `url` and upload it as a Comfy input (image or audio — same
 * endpoint); returns the input name. */
export async function uploadImage(t: ComfyTransport, url: string, name: string): Promise<string> {
  const src = await f(t)(url);
  if (!src.ok) throw new Error(`comfy upload: GET ${url} -> HTTP ${src.status}`);
  const form = new FormData();
  form.append('image', new Blob([await src.arrayBuffer()]), name);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const res = await f(t)(`${base(t)}/api/upload/image`, { method: 'POST', headers: headers(t), body: form });
  if (!res.ok) throw new Error(`comfy upload: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { name: string; subfolder?: string };
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

interface OutputFile { filename: string; subfolder?: string; type?: string }

function findVideo(x: unknown): OutputFile | undefined {
  if (Array.isArray(x)) {
    for (const v of x) { const h = findVideo(v); if (h) return h; }
  } else if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o.filename === 'string' && /\.(mp4|webm|mov)$/i.test(o.filename) && (o.type ?? 'output') === 'output') return o as unknown as OutputFile;
    for (const v of Object.values(o)) { const h = findVideo(v); if (h) return h; }
  }
  return undefined;
}

export interface ComfyResult { promptId: string; wallS: number; file: OutputFile; bytes: Buffer }

/** Submit, poll to completion, and fetch the clip's bytes. Throws on any failure. */
export async function runGraph(t: ComfyTransport, graph: ComfyGraph, onSubmitted?: (promptId: string) => Promise<void>): Promise<ComfyResult> {
  assertOpenWeightGraph(graph);
  const sleep = t.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sub = await f(t)(`${base(t)}/api/prompt`, {
    method: 'POST',
    headers: { ...headers(t), 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, extra_data: { api_key_comfy_org: t.apiKey } }),
  });
  if (!sub.ok) throw new Error(`comfy submit: HTTP ${sub.status} ${(await sub.text()).slice(0, 600)}`);
  const promptId = ((await sub.json()) as { prompt_id: string }).prompt_id;
  await onSubmitted?.(promptId);

  const t0 = Date.now();
  const limit = t.timeoutMs ?? 900_000;
  for (;;) {
    await sleep(t.pollMs ?? 5000);
    const s = await f(t)(`${base(t)}/api/job/${promptId}/status`, { headers: headers(t) });
    if (!s.ok) throw new Error(`comfy status ${promptId}: HTTP ${s.status}`);
    const sj = (await s.json()) as { status?: string };
    const status = String(sj.status ?? '').toLowerCase();
    if (['completed', 'success', 'succeeded'].includes(status)) break;
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      throw new Error(`comfy job ${promptId} ${status}: ${JSON.stringify(sj).slice(0, 800)}`);
    }
    if (Date.now() - t0 > limit) throw new Error(`comfy job ${promptId} still ${status} after ${Math.round(limit / 1000)}s`);
  }
  const wallS = (Date.now() - t0) / 1000;

  const jr = await f(t)(`${base(t)}/api/jobs/${promptId}`, { headers: headers(t) });
  if (!jr.ok) throw new Error(`comfy job ${promptId}: HTTP ${jr.status}`);
  const job = (await jr.json()) as { preview_output?: OutputFile; outputs?: unknown };
  // Prefer the declared output; never an echoed input (type "input").
  const file = job.preview_output?.type === 'output' ? job.preview_output : findVideo(job.outputs);
  if (!file) throw new Error(`comfy job ${promptId}: no video in outputs`);
  const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' });
  const v = await f(t)(`${base(t)}/api/view?${q}`, { headers: headers(t), redirect: 'follow' });
  if (!v.ok) throw new Error(`comfy view ${promptId}: HTTP ${v.status}`);
  return { promptId, wallS, file, bytes: Buffer.from(await v.arrayBuffer()) };
}
