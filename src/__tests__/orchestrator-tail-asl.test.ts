/**
 * Tests for the orchestrator tail's state machine definition
 * (infra/lib/orchestrator-tail.ts).
 *
 * Two layers. A structural check (every reference resolves, every state is
 * reachable) catches typos. A small ASL INTERPRETER then actually executes the
 * machine against scripted ECS/S3/Lambda responses — the wiring of a state
 * machine (which JSONPath feeds which task, how a poll loop terminates, what a
 * failure turns into) is where the bugs hide, and none of it is visible to a
 * structural check. The interpreter supports exactly the ASL features this
 * definition uses; an unsupported one throws rather than guessing.
 */
import {
  buildOrchestratorTailDefinition,
  EXECUTION_TIMEOUT_S,
  MAX_POLLS,
  POLL_INTERVAL_S,
  type Definition,
  type OrchestratorTailConfig,
} from '../../infra/lib/orchestrator-tail';
import { ASSET_SPECS } from '../../orchestrator/src/assets/kinds';

const CFG: OrchestratorTailConfig = {
  clusterArn: 'arn:aws:ecs:us-east-1:1:cluster/qm-concat-and-trim',
  taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/qm-orchestrator-tail:1',
  containerName: 'orchestrator-tail',
  subnetIds: ['subnet-a', 'subnet-b'],
  securityGroupId: 'sg-1',
  bucket: 'qm-bucket',
  runpodFunctionArn: 'arn:aws:lambda:us-east-1:1:function:QM-orchestrator-runpod',
  audioEndpointId: '6apg6j7suzuezw',
};

const DEF = buildOrchestratorTailDefinition(CFG);

// ── structural ────────────────────────────────────────────────────────────

type AnyState = Record<string, any>;

function targets(state: AnyState): string[] {
  const out: string[] = [];
  if (state.Next) out.push(state.Next);
  if (state.Default) out.push(state.Default);
  for (const c of state.Choices ?? []) out.push(c.Next);
  for (const c of state.Catch ?? []) out.push(c.Next);
  return out;
}

function checkGraph(startAt: string, states: Record<string, AnyState>, path: string): void {
  expect(states[startAt]).toBeDefined();
  const seen = new Set<string>();
  const queue = [startAt];
  while (queue.length) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const st = states[name];
    expect({ path, name, exists: !!st }).toEqual({ path, name, exists: true });
    const terminal = st.Type === 'Succeed' || st.Type === 'Fail' || st.End === true;
    if (!terminal) expect({ path, name, hasNext: targets(st).length > 0 }).toEqual({ path, name, hasNext: true });
    if (st.Type === 'Choice') expect({ path, name, hasDefault: !!st.Default }).toEqual({ path, name, hasDefault: true });
    for (const t of targets(st)) queue.push(t);
    for (const b of st.Branches ?? []) checkGraph(b.StartAt, b.States, `${path}/${name}`);
  }
  // Nothing unreachable: a stray state is almost always a mis-typed Next.
  expect({ path, unreachable: Object.keys(states).filter((s) => !seen.has(s)) }).toEqual({ path, unreachable: [] });
}

describe('structure', () => {
  it('has every reference resolvable, every state reachable, and a Default on every Choice', () => {
    checkGraph(DEF.StartAt, DEF.States as Record<string, AnyState>, '');
  });

  it('serialises well under the 1MB state machine limit', () => {
    expect(JSON.stringify(DEF).length).toBeLessThan(50_000);
  });

  it('times out BEFORE the orchestrator’s own wall clock, so the real TIMED_OUT is what gets reported', () => {
    expect(DEF.TimeoutSeconds).toBe(EXECUTION_TIMEOUT_S);
    expect(EXECUTION_TIMEOUT_S * 1000).toBeLessThan(ASSET_SPECS['sfn-tail'].timeoutMs as number);
  });

  it('bounds the poll loops: ~15 minutes at most per RunPod layer', () => {
    expect(POLL_INTERVAL_S * MAX_POLLS).toBe(900);
  });

  it('runs both ECS tasks on the tail task definition with the tail entrypoint', () => {
    for (const name of ['AssembleCore', 'FinalizeVideo']) {
      const st = (DEF.States as Record<string, AnyState>)[name];
      expect(st.Resource).toBe('arn:aws:states:::ecs:runTask.sync');
      expect(st.Parameters.TaskDefinition).toBe(CFG.taskDefinitionArn);
      expect(st.Parameters.Overrides.ContainerOverrides[0]).toMatchObject({ Name: 'orchestrator-tail', Command: ['node', 'tail.js'] });
    }
  });

  it('every ECS and S3 failure ends in TailFailed with the real Error and Cause', () => {
    const states = DEF.States as Record<string, AnyState>;
    for (const name of ['AssembleCore', 'ReadAssembleMeta', 'FinalizeVideo', 'ReadFinalizeResult']) {
      expect(states[name].Catch).toEqual([{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'TailFailed' }]);
    }
    expect(states.TailFailed).toMatchObject({ Type: 'Fail', ErrorPath: '$.error.Error', CausePath: '$.error.Cause' });
  });
});

// ── interpreter ───────────────────────────────────────────────────────────

class Failure extends Error {
  constructor(public error: string, public cause: string) {
    super(`${error}: ${cause}`);
  }
}

function getPath(doc: unknown, p: string): any {
  if (p === '$') return doc;
  if (!p.startsWith('$.')) throw new Error(`unsupported path ${p}`);
  let cur: any = doc;
  for (const part of p.slice(2).split('.')) {
    const m = part.match(/^([^[\]]+)(?:\[(\d+)\])?$/);
    if (!m) throw new Error(`unsupported path segment ${part} in ${p}`);
    if (cur === undefined || cur === null || !(m[1] in cur)) throw new Failure('States.Runtime', `path ${p} not found`);
    cur = cur[m[1]];
    if (m[2] !== undefined) cur = cur[Number(m[2])];
  }
  return cur;
}

function hasPath(doc: unknown, p: string): boolean {
  try {
    getPath(doc, p);
    return true;
  } catch {
    return false;
  }
}

function setPath(doc: any, p: string, value: unknown): any {
  if (p === '$') return value;
  const parts = p.slice(2).split('.');
  const out = { ...doc };
  let cur = out;
  parts.slice(0, -1).forEach((k) => {
    cur[k] = { ...(cur[k] ?? {}) };
    cur = cur[k];
  });
  cur[parts[parts.length - 1]] = value;
  return out;
}

function splitArgs(s: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === '(') depth++;
    if (!quote && ch === ')') depth--;
    if (!quote && depth === 0 && ch === ',') {
      args.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

function evalExpr(expr: string, doc: unknown): any {
  expr = expr.trim();
  if (expr.startsWith('$')) return getPath(doc, expr);
  if (expr.startsWith("'") && expr.endsWith("'")) return expr.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  const m = expr.match(/^(States\.\w+)\((.*)\)$/s);
  if (!m) throw new Error(`unsupported expression ${expr}`);
  const args = splitArgs(m[2]).map((a) => evalExpr(a, doc));
  switch (m[1]) {
    case 'States.Format': {
      let i = 1;
      return String(args[0]).replace(/\{\}/g, () => String(args[i++]));
    }
    case 'States.JsonToString':
      return JSON.stringify(args[0]);
    case 'States.StringToJson':
      return JSON.parse(args[0]);
    case 'States.MathAdd':
      return Number(args[0]) + Number(args[1]);
    default:
      throw new Error(`unsupported intrinsic ${m[1]}`);
  }
}

function applyParams(params: any, doc: unknown): any {
  if (Array.isArray(params)) return params.map((p) => applyParams(p, doc));
  if (params && typeof params === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k.endsWith('.$')) out[k.slice(0, -2)] = evalExpr(v as string, doc);
      else out[k] = applyParams(v, doc);
    }
    return out;
  }
  return params;
}

function matches(rule: AnyState, doc: unknown): boolean {
  if (rule.And) return rule.And.every((r: AnyState) => matches(r, doc));
  if (rule.Or) return rule.Or.some((r: AnyState) => matches(r, doc));
  if ('IsPresent' in rule) return hasPath(doc, rule.Variable) === rule.IsPresent;
  const v = hasPath(doc, rule.Variable) ? getPath(doc, rule.Variable) : undefined;
  if ('BooleanEquals' in rule) return v === rule.BooleanEquals;
  if ('StringEquals' in rule) return v === rule.StringEquals;
  if ('NumericGreaterThan' in rule) return typeof v === 'number' && v > rule.NumericGreaterThan;
  throw new Error(`unsupported choice rule ${JSON.stringify(rule)}`);
}

interface Harness {
  /** Called for every Task; return the raw task result, or throw a Failure. */
  task(name: string, resource: string, params: any): any;
  trace: string[];
}

function run(states: Record<string, AnyState>, startAt: string, input: any, h: Harness): any {
  let doc = input;
  let name = startAt;
  for (let guard = 0; guard < 5000; guard++) {
    const st = states[name];
    h.trace.push(name);
    switch (st.Type) {
      case 'Succeed':
        return doc;
      case 'Fail':
        throw new Failure(st.ErrorPath ? getPath(doc, st.ErrorPath) : st.Error, st.CausePath ? getPath(doc, st.CausePath) : st.Cause);
      case 'Wait':
        name = st.Next;
        continue;
      case 'Pass': {
        let result = st.Parameters ? applyParams(st.Parameters, doc) : 'Result' in st ? st.Result : doc;
        if (st.ResultPath) doc = setPath(doc, st.ResultPath, result);
        else doc = result;
        if (st.End) return doc;
        name = st.Next;
        continue;
      }
      case 'Choice': {
        const hit = (st.Choices as AnyState[]).find((c) => matches(c, doc));
        name = hit ? hit.Next : st.Default;
        continue;
      }
      case 'Parallel': {
        try {
          const results = (st.Branches as AnyState[]).map((b) => run(b.States, b.StartAt, doc, h));
          doc = st.ResultPath ? setPath(doc, st.ResultPath, results) : results;
          name = st.Next;
        } catch (e) {
          const c = (st.Catch ?? []).find(() => e instanceof Failure);
          if (!c) throw e;
          doc = setPath(doc, c.ResultPath, { Error: (e as Failure).error, Cause: (e as Failure).cause });
          name = c.Next;
        }
        continue;
      }
      case 'Task': {
        try {
          const params = applyParams(st.Parameters, doc);
          let raw = h.task(name, st.Resource, params);
          if (st.ResultSelector) raw = applyParams(st.ResultSelector, raw);
          doc = st.ResultPath ? setPath(doc, st.ResultPath, raw) : raw;
          name = st.Next;
        } catch (e) {
          if (!(e instanceof Failure)) throw e;
          const c = (st.Catch ?? [])[0];
          if (!c) throw e;
          doc = setPath(doc, c.ResultPath, { Error: e.error, Cause: e.cause });
          name = c.Next;
        }
        continue;
      }
      default:
        throw new Error(`unsupported state type ${st.Type}`);
    }
  }
  throw new Error('state machine did not terminate');
}

// ── scenarios ─────────────────────────────────────────────────────────────

const BASE_INPUT = {
  projectId: 'proj_1',
  manifestUrl: 'https://r2/pipeline-manifests/proj_1/m.json',
  aspectRatio: '9:16',
  language: 'hi',
  options: { removeSilence: true, captions: true, bgm: true, bgmPrompt: 'soft piano', sfx: false },
  totalDurationS: 40,
  outputPrefix: 'projects/proj_1/tail/',
};

const META = {
  videoUrl: 'https://qm-bucket.s3.us-east-1.amazonaws.com/projects/proj_1/tail/video.mp4',
  audioUrl: 'https://qm-bucket.s3.us-east-1.amazonaws.com/projects/proj_1/tail/audio.wav',
  durationSec: 37.4,
  frames: [{ frameId: 'f1', url: 'https://qm-bucket/f1.mp4', durationS: 5 }],
};

interface Script {
  /** RunPod statuses returned by successive polls, per layer ('transcribe' | 'bgm'). */
  polls?: Partial<Record<'transcribe' | 'bgm', Array<Record<string, unknown>>>>;
  submitFails?: Array<'transcribe' | 'bgm'>;
  assembleFails?: boolean;
  finalizeFails?: boolean;
}

function execute(input: any, script: Script = {}) {
  const trace: string[] = [];
  const ecs: Array<{ mode: string; payload: any }> = [];
  const lambdaCalls: any[] = [];
  const jobs: Record<string, 'transcribe' | 'bgm'> = {};
  const cursor: Record<string, number> = { transcribe: 0, bgm: 0 };

  const harness: Harness = {
    trace,
    task(name, resource, params) {
      if (resource === 'arn:aws:states:::ecs:runTask.sync') {
        const env = params.Overrides.ContainerOverrides[0].Environment as Array<{ Name: string; Value: string }>;
        const mode = env.find((e) => e.Name === 'TAIL_MODE')!.Value;
        ecs.push({ mode, payload: JSON.parse(env.find((e) => e.Name === 'PAYLOAD_JSON')!.Value) });
        if (mode === 'assemble' && script.assembleFails) throw new Failure('States.TaskFailed', 'ECS task stopped: ffmpeg exited 1');
        if (mode === 'finalize' && script.finalizeFails) throw new Failure('States.TaskFailed', 'ECS task stopped: finalize encode failed');
        return {};
      }
      if (resource === 'arn:aws:states:::aws-sdk:s3:getObject') {
        if (params.Bucket !== CFG.bucket) throw new Error(`read from the wrong bucket ${params.Bucket}`);
        if (params.Key.endsWith('meta.json')) return { Body: JSON.stringify(META) };
        if (params.Key.endsWith('result.json')) {
          return { Body: JSON.stringify({ videoUrl: 'https://qm-bucket/final.mp4', durationSec: 37.4, width: 1080, height: 1920, captions: true, bgm: true }) };
        }
        throw new Error(`unexpected key ${params.Key}`);
      }
      if (resource === 'arn:aws:states:::lambda:invoke') {
        lambdaCalls.push(params.Payload);
        const p = params.Payload;
        if (p.action === 'submit') {
          const mode = p.input.mode as 'transcribe' | 'bgm';
          if (script.submitFails?.includes(mode)) throw new Failure('Lambda.ServiceException', 'RunPod submit failed: HTTP 500');
          jobs[`${mode}-job`] = mode;
          return { Payload: { jobId: `${mode}-job`, status: 'IN_QUEUE' } };
        }
        const mode = jobs[p.jobId];
        const queue = script.polls?.[mode] ?? [];
        const i = cursor[mode]++;
        const r = queue[Math.min(i, queue.length - 1)] ?? (mode === 'transcribe' ? { status: 'COMPLETED', srtUrl: 'https://r2/t.srt' } : { status: 'COMPLETED', audioUrl: 'https://r2/b.mp3' });
        return { Payload: r };
      }
      throw new Error(`unexpected task ${name} ${resource}`);
    },
  };

  let output: any;
  let failure: Failure | undefined;
  try {
    output = run(DEF.States as Record<string, AnyState>, DEF.StartAt, input, harness);
  } catch (e) {
    if (e instanceof Failure) failure = e;
    else throw e;
  }
  return { output, failure, trace, ecs, lambdaCalls };
}

describe('the happy path', () => {
  const r = execute(BASE_INPUT);

  it('succeeds with exactly the output the orchestrator reads', () => {
    expect(r.failure).toBeUndefined();
    expect(r.output).toEqual({ videoUrl: 'https://qm-bucket/final.mp4', durationSec: 37.4, frames: META.frames });
  });

  it('assembles first, then generates the audio layers, then finalizes — in that order', () => {
    const order = ['PrepareAssemble', 'AssembleCore', 'ReadAssembleMeta', 'GenerateAudioLayers', 'PrepareFinalize', 'FinalizeVideo', 'ReadFinalizeResult', 'BuildOutput', 'Done'];
    expect(r.trace.filter((s) => order.includes(s))).toEqual(order);
  });

  it('hands the assemble task a manifest URL and three scalars — and nothing large', () => {
    expect(r.ecs[0]).toEqual({
      mode: 'assemble',
      payload: { manifestUrl: BASE_INPUT.manifestUrl, aspectRatio: '9:16', outputPrefix: 'projects/proj_1/tail/', removeSilence: true },
    });
    expect(JSON.stringify(r.ecs[0].payload).length).toBeLessThan(500);
  });

  it('asks Whisper for word timestamps on the ASSEMBLED audio, in the project’s language', () => {
    const submit = r.lambdaCalls.find((c) => c.action === 'submit' && c.input.mode === 'transcribe');
    expect(submit).toEqual({
      action: 'submit',
      endpointId: '6apg6j7suzuezw',
      input: { mode: 'transcribe', audio_url: META.audioUrl, task: 'transcribe', language: 'hi', return_timestamps: 'word', words_per_group: 1 },
    });
  });

  it('generates the BGM to the assembled video’s REAL duration, from the project’s prompt', () => {
    const submit = r.lambdaCalls.find((c) => c.action === 'submit' && c.input.mode === 'bgm');
    expect(submit.input).toEqual({ mode: 'bgm', prompt: 'soft piano', duration_s: 37.4 });
    expect(submit.endpointId).toBe('6apg6j7suzuezw'); // the same endpoint serves both
  });

  it('finalizes the assembled video with both layers at 1080p, writing where the state machine reads', () => {
    expect(r.ecs[1]).toEqual({
      mode: 'finalize',
      payload: {
        manifestUrl: BASE_INPUT.manifestUrl,
        videoUrl: META.videoUrl,
        srtUrl: 'https://r2/t.srt',
        bgmUrl: 'https://r2/b.mp3',
        aspectRatio: '9:16',
        targetResolution: '1080p',
        outputKey: 'projects/proj_1/tail/final.mp4',
        resultKey: 'projects/proj_1/tail/result.json',
      },
    });
  });
});

describe('the optional layers', () => {
  it('skips captions and BGM entirely when the project did not ask for them', () => {
    const r = execute({ ...BASE_INPUT, options: { removeSilence: false, captions: false, bgm: false, sfx: false } });
    expect(r.failure).toBeUndefined();
    expect(r.lambdaCalls).toHaveLength(0);
    expect(r.ecs[1].payload).toMatchObject({ srtUrl: '', bgmUrl: '' });
    expect(r.ecs[0].payload.removeSilence).toBe(false);
  });

  it('skips the BGM when asked for but there is no prompt to generate from', () => {
    const { bgmPrompt: _drop, ...options } = BASE_INPUT.options;
    const r = execute({ ...BASE_INPUT, options });
    expect(r.lambdaCalls.filter((c) => c.input?.mode === 'bgm')).toHaveLength(0);
    expect(r.ecs[1].payload.bgmUrl).toBe('');
    expect(r.ecs[1].payload.srtUrl).toBe('https://r2/t.srt');
  });

  it('keeps polling through IN_QUEUE and IN_PROGRESS until the job completes', () => {
    const r = execute(BASE_INPUT, {
      polls: { transcribe: [{ status: 'IN_QUEUE' }, { status: 'IN_PROGRESS' }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED', srtUrl: 'https://r2/slow.srt' }] },
    });
    expect(r.ecs[1].payload.srtUrl).toBe('https://r2/slow.srt');
    expect(r.lambdaCalls.filter((c) => c.action === 'status' && c.jobId === 'transcribe-job')).toHaveLength(4);
  });

  it('finalizes WITHOUT captions when the transcribe job fails — the video still ships', () => {
    const r = execute(BASE_INPUT, { polls: { transcribe: [{ status: 'FAILED', error: 'CUDA out of memory' }] } });
    expect(r.failure).toBeUndefined();
    expect(r.ecs[1].payload).toMatchObject({ srtUrl: '', bgmUrl: 'https://r2/b.mp3' });
  });

  it.each(['CANCELLED', 'TIMED_OUT'])('treats a %s job as "no layer", not a failed project', (status) => {
    const r = execute(BASE_INPUT, { polls: { bgm: [{ status }] } });
    expect(r.failure).toBeUndefined();
    expect(r.ecs[1].payload.bgmUrl).toBe('');
  });

  it('treats COMPLETED-without-a-url as no layer rather than reading a missing field', () => {
    const r = execute(BASE_INPUT, { polls: { transcribe: [{ status: 'COMPLETED' }] } });
    expect(r.failure).toBeUndefined();
    expect(r.ecs[1].payload.srtUrl).toBe('');
  });

  it('finalizes without the layer when RunPod cannot even be reached', () => {
    const r = execute(BASE_INPUT, { submitFails: ['transcribe', 'bgm'] });
    expect(r.failure).toBeUndefined();
    expect(r.ecs[1].payload).toMatchObject({ srtUrl: '', bgmUrl: '' });
  });

  it('gives up polling after the bound instead of holding the execution open forever', () => {
    const r = execute(BASE_INPUT, { polls: { transcribe: [{ status: 'IN_PROGRESS' }] } });
    expect(r.failure).toBeUndefined();
    expect(r.ecs[1].payload.srtUrl).toBe('');
    // MAX_POLLS + 1 status calls: the loop counts, then bails.
    expect(r.lambdaCalls.filter((c) => c.action === 'status' && c.jobId === 'transcribe-job')).toHaveLength(MAX_POLLS + 1);
  });

  it('runs the two layers independently: one failing does not lose the other', () => {
    const r = execute(BASE_INPUT, { submitFails: ['bgm'] });
    expect(r.ecs[1].payload).toMatchObject({ srtUrl: 'https://r2/t.srt', bgmUrl: '' });
  });
});

describe('failures that must fail the execution', () => {
  it('fails with the real Error and Cause when assembly fails — and never generates audio or finalizes', () => {
    const r = execute(BASE_INPUT, { assembleFails: true });
    expect(r.failure).toMatchObject({ error: 'States.TaskFailed', cause: 'ECS task stopped: ffmpeg exited 1' });
    expect(r.trace).not.toContain('GenerateAudioLayers');
    expect(r.trace).not.toContain('FinalizeVideo');
    expect(r.lambdaCalls).toHaveLength(0); // no RunPod spend on a project that cannot assemble
  });

  it('fails with the real Error and Cause when finalize fails', () => {
    const r = execute(BASE_INPUT, { finalizeFails: true });
    expect(r.failure).toMatchObject({ error: 'States.TaskFailed', cause: 'ECS task stopped: finalize encode failed' });
    expect(r.output).toBeUndefined();
  });
});

describe('the definition is built from its config', () => {
  it('threads the network and endpoint settings through, with no hard-coded ids', () => {
    const other = buildOrchestratorTailDefinition({ ...CFG, subnetIds: ['subnet-z'], securityGroupId: 'sg-9', audioEndpointId: 'zzzzzzzzzz', bucket: 'other-bucket' });
    const json = JSON.stringify(other);
    expect(json).toContain('subnet-z');
    expect(json).toContain('sg-9');
    expect(json).toContain('zzzzzzzzzz');
    expect(json).toContain('other-bucket');
    expect(json).not.toContain('6apg6j7suzuezw');
    expect(json).not.toContain('subnet-a');
  });
});

export type { Definition };
