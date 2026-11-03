/**
 * `E2E-VideoGenerationPipeline-Orchestrator` — the assembly tail the VPS
 * orchestrator hands a finished project to (docs/qm-sfn-ecs-tail-implementation-
 * 2026-10-02.md §3). The orchestrator generates every asset on RunPod and then
 * starts ONE execution of this machine with asset REFERENCES only (a manifest
 * URL on R2 plus a few scalars); this machine does the video generation:
 *
 *   AssembleCore   ECS   per frame: [Ken Burns a still] -> mux narration (+SFX);
 *                        project: concat -> [remove silence] -> A/V parity gate
 *   ReadAssembleMeta     S3   meta.json written by the task (ECS returns nothing)
 *   GenerateAudioLayers  Parallel, both on the BGM-S2T RunPod endpoint:
 *                          captions  transcribe, word timestamps -> SRT
 *                          bgm       ACE-Step, to the assembled video's length
 *                        each with a hosted fallback when RunPod fails
 *                        (QM-orchestrator-fallback, 2026-11-01):
 *                          captions  OpenAI gpt-transcribe + whisper-1 timings
 *                          bgm       Suno (instrumental) on KIE
 *   FinalizeVideo  ECS   upscale to 1080p -> burn captions -> overlay BGM
 *   ReadFinalizeResult   S3   result.json
 *
 * Both ECS tasks run the `qm-orchestrator-tail` task definition
 * (lib/orchestrator-tail-stack.ts): the live path's concat-and-trim image under
 * its own `orchestrator-tail` tag, entrypoint `node tail.js`
 * (infra/docker/concat-and-trim/tail.ts), on the existing `qm-concat-and-trim`
 * cluster.
 *
 * INPUT  { projectId, manifestUrl, aspectRatio, language, options:{removeSilence,
 *          captions, bgm, bgmPrompt?, sfx}, totalDurationS, outputPrefix }
 * OUTPUT { videoUrl, durationSec, frames:[{frameId, url, durationS}] }
 *
 * Captions and BGM are OPTIONAL layers and degrade gracefully (a failed RunPod
 * job, a timeout, an unreachable endpoint all mean "no captions"/"no BGM", never
 * a failed project). Everything else fails the execution with the real Error and
 * Cause, which the orchestrator copies into the project's error list.
 *
 * The orchestrator POLLS this machine (DescribeExecution); nothing here calls
 * back. The state machine's own timeout (90 min) must fire before the
 * orchestrator's 95-minute wall clock (assets/kinds.ts `sfn-tail`).
 */

export interface OrchestratorTailConfig {
  clusterArn: string;
  taskDefinitionArn: string;
  /** Container name inside the task definition. */
  containerName: string;
  subnetIds: string[];
  securityGroupId: string;
  /** Bucket the tasks write to (the existing concat-and-trim output bucket). */
  bucket: string;
  /** ARN of the QM-orchestrator-runpod Lambda. */
  runpodFunctionArn: string;
  /** Whisper — `transcribe` (word-level captions). */
  whisperEndpointId: string;
  /** ACE-Step — `bgm`. */
  bgmEndpointId: string;
  /** ARN of the QM-orchestrator-fallback Lambda: OpenAI captions, KIE Suno BGM. */
  fallbackFunctionArn: string;
}

type State = Record<string, unknown>;
export interface Definition {
  Comment: string;
  StartAt: string;
  TimeoutSeconds: number;
  States: Record<string, State>;
}

/** One poll every 10s, at most 90 of them: BGM-S2T's first job on a cold worker
 * loads three models (~80s measured 2026-10-02), so this is generous headroom
 * for a cold start plus the work itself, and bounded so a wedged job cannot
 * hold the execution open. */
export const POLL_INTERVAL_S = 10;
export const MAX_POLLS = 90;

/** Total wall clock. Must stay below the orchestrator's 95-minute budget. */
export const EXECUTION_TIMEOUT_S = 5400;

/** The KIE Suno fallback's own poll bound: ~22 s measured for a 45 s track,
 * so 10 minutes is ample and still bounded. */
export const FALLBACK_MAX_POLLS = 60;
/** OpenAI transcription of up to 30 min of audio, chunked and in parallel. */
export const FALLBACK_TRANSCRIBE_TIMEOUT_S = 900;

const LAMBDA_RETRY = [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 5, MaxAttempts: 3, BackoffRate: 2 }];

function ecsTask(cfg: OrchestratorTailConfig, mode: 'assemble' | 'finalize', payloadPath: string, resultPath: string, timeoutSeconds: number, next: string, comment: string): State {
  return {
    Type: 'Task',
    Resource: 'arn:aws:states:::ecs:runTask.sync',
    Comment: comment,
    Parameters: {
      Cluster: cfg.clusterArn,
      TaskDefinition: cfg.taskDefinitionArn,
      LaunchType: 'FARGATE',
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          Subnets: cfg.subnetIds,
          SecurityGroups: [cfg.securityGroupId],
          AssignPublicIp: 'ENABLED',
        },
      },
      Overrides: {
        ContainerOverrides: [
          {
            Name: cfg.containerName,
            // Also the task definition's default command; stated here so the
            // machine does not depend on it.
            Command: ['node', 'tail.js'],
            Environment: [
              { Name: 'TAIL_MODE', Value: mode },
              // Small by construction (a URL and a few scalars) — nowhere near
              // ECS's 8192-byte ContainerOverrides limit.
              { Name: 'PAYLOAD_JSON', 'Value.$': `States.JsonToString(${payloadPath})` },
            ],
          },
        ],
      },
    },
    ResultPath: resultPath,
    TimeoutSeconds: timeoutSeconds,
    // Both modes are idempotent (they overwrite the same keys), so one retry for
    // an infrastructure hiccup is safe.
    Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 1, BackoffRate: 2 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'TailFailed' }],
    Next: next,
  };
}

function readS3Json(cfg: OrchestratorTailConfig, keyExpr: string, resultPath: string, next: string, comment: string): State {
  return {
    Type: 'Task',
    Resource: 'arn:aws:states:::aws-sdk:s3:getObject',
    Comment: comment,
    Parameters: { Bucket: cfg.bucket, 'Key.$': keyExpr },
    ResultSelector: { 'result.$': 'States.StringToJson($.Body)' },
    ResultPath: resultPath,
    Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 3, MaxAttempts: 3, BackoffRate: 2 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'TailFailed' }],
    Next: next,
  };
}

interface BranchSpec {
  /** State-name prefix, e.g. "Caption". */
  prefix: string;
  /** RunPod endpoint this layer calls. */
  endpointId: string;
  /** Choice rule(s) that must hold for this layer to run. */
  gate: State;
  /** The `input` of the RunPod job (JSONPath keys end in `.$`). */
  input: Record<string, unknown>;
  /** Name of the URL field the Lambda reports (srtUrl | audioUrl) ... */
  resultField: 'srtUrl' | 'audioUrl';
  /** ... and the name this branch's output carries into PrepareFinalize. */
  outputField: 'srtUrl' | 'bgmUrl';
  comment: string;
  /** Hosted fallback, entered on every RunPod failure exit instead of Skip.
   * Its states end in `${prefix}FallbackDone` or the branch's Skip. */
  fallback?: { startAt: string; states: Record<string, State> };
}

/**
 * One optional RunPod layer: gate -> submit -> (wait -> status -> check)* -> done.
 * Every RunPod failure exit (submit/status error, FAILED/CANCELLED/TIMED_OUT,
 * COMPLETED without a url, poll bound) goes to the hosted FALLBACK when the
 * branch has one, and only from there — or directly, without one — to `Skip`,
 * which emits an EMPTY url. The gate's "not asked for" exit always goes straight
 * to Skip. The branch always produces `{ <outputField>: <url or ''> }` so
 * PrepareFinalize can read it unconditionally.
 */
function runpodBranch(cfg: OrchestratorTailConfig, b: BranchSpec): { StartAt: string; States: Record<string, State> } {
  const P = b.prefix;
  const skip = `${P}Skip`;
  const statusPath = `$.${P.toLowerCase()}Status`;
  const jobPath = `$.${P.toLowerCase()}Job`;
  const pollPath = `$.${P.toLowerCase()}Poll`;
  const fail = b.fallback ? b.fallback.startAt : skip;

  return {
    StartAt: `${P}Gate`,
    States: {
      [`${P}Gate`]: {
        Type: 'Choice',
        Comment: b.comment,
        Choices: [{ ...b.gate, Next: `${P}Submit` }],
        Default: skip,
      },
      [`${P}Submit`]: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke',
        Parameters: {
          FunctionName: cfg.runpodFunctionArn,
          Payload: { action: 'submit', endpointId: b.endpointId, input: b.input },
        },
        ResultSelector: { 'jobId.$': '$.Payload.jobId' },
        ResultPath: jobPath,
        TimeoutSeconds: 60,
        Retry: LAMBDA_RETRY,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: `$.${P.toLowerCase()}Error`, Next: fail }],
        Next: `${P}InitPoll`,
      },
      [`${P}InitPoll`]: { Type: 'Pass', Result: { n: 0 }, ResultPath: pollPath, Next: `${P}Wait` },
      [`${P}Wait`]: { Type: 'Wait', Seconds: POLL_INTERVAL_S, Next: `${P}Status` },
      [`${P}Status`]: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke',
        Parameters: {
          FunctionName: cfg.runpodFunctionArn,
          Payload: { action: 'status', endpointId: b.endpointId, 'jobId.$': `${jobPath}.jobId` },
        },
        ResultSelector: { 'r.$': '$.Payload' },
        ResultPath: statusPath,
        TimeoutSeconds: 60,
        Retry: LAMBDA_RETRY,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: `$.${P.toLowerCase()}Error`, Next: fail }],
        Next: `${P}Check`,
      },
      [`${P}Check`]: {
        Type: 'Choice',
        Choices: [
          {
            And: [
              { Variable: `${statusPath}.r.status`, StringEquals: 'COMPLETED' },
              { Variable: `${statusPath}.r.${b.resultField}`, IsPresent: true },
            ],
            Next: `${P}Done`,
          },
          // COMPLETED with no url, or any terminal failure: skip the layer.
          { Variable: `${statusPath}.r.status`, StringEquals: 'COMPLETED', Next: fail },
          { Variable: `${statusPath}.r.status`, StringEquals: 'FAILED', Next: fail },
          { Variable: `${statusPath}.r.status`, StringEquals: 'CANCELLED', Next: fail },
          { Variable: `${statusPath}.r.status`, StringEquals: 'TIMED_OUT', Next: fail },
        ],
        // IN_QUEUE / IN_PROGRESS: count the poll and go round again.
        Default: `${P}Count`,
      },
      [`${P}Count`]: {
        Type: 'Pass',
        Parameters: { 'n.$': `States.MathAdd(${pollPath}.n, 1)` },
        ResultPath: pollPath,
        Next: `${P}Limit`,
      },
      [`${P}Limit`]: {
        Type: 'Choice',
        Choices: [{ Variable: `${pollPath}.n`, NumericGreaterThan: MAX_POLLS, Next: fail }],
        Default: `${P}Wait`,
      },
      [`${P}Done`]: {
        Type: 'Pass',
        Parameters: { [`${b.outputField}.$`]: `${statusPath}.r.${b.resultField}` },
        End: true,
      },
      ...(b.fallback?.states ?? {}),
      [skip]: {
        Type: 'Pass',
        Comment: `${P} is an optional layer: any failure, timeout or absence (RunPod and its fallback) means none, not a failed project.`,
        Parameters: { [b.outputField]: '' },
        End: true,
      },
    },
  };
}

/** Captions fallback: one synchronous call (gpt-transcribe text + whisper-1 word
 * timings, src/handlers/orchestrator-fallback.ts) that writes the SRT itself. */
function captionFallback(cfg: OrchestratorTailConfig): { startAt: string; states: Record<string, State> } {
  return {
    startAt: 'CaptionFallback',
    states: {
      CaptionFallback: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke',
        Comment: 'RunPod BGM-S2T gave no captions: OpenAI gpt-transcribe (text) + whisper-1 (word timings).',
        Parameters: {
          FunctionName: cfg.fallbackFunctionArn,
          Payload: {
            action: 'transcribe',
            'audioUrl.$': '$.assemble.result.audioUrl',
            'language.$': '$.language',
            'outputPrefix.$': '$.outputPrefix',
          },
        },
        ResultSelector: { 'r.$': '$.Payload' },
        ResultPath: '$.captionFallback',
        TimeoutSeconds: FALLBACK_TRANSCRIBE_TIMEOUT_S,
        // Lambda-service hiccups only: the handler retries OpenAI itself, and a
        // second full transcription of a long video is not worth the wait.
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.captionFallbackError', Next: 'CaptionSkip' }],
        Next: 'CaptionFallbackCheck',
      },
      CaptionFallbackCheck: {
        Type: 'Choice',
        Choices: [{ Variable: '$.captionFallback.r.srtUrl', IsPresent: true, Next: 'CaptionFallbackDone' }],
        Default: 'CaptionSkip',
      },
      CaptionFallbackDone: {
        Type: 'Pass',
        Parameters: { 'srtUrl.$': '$.captionFallback.r.srtUrl' },
        End: true,
      },
    },
  };
}

/** BGM fallback: Suno on KIE, submit -> (wait -> status -> check)*. The status
 * call re-hosts the finished track in S3 (KIE's links expire). */
function bgmFallback(cfg: OrchestratorTailConfig): { startAt: string; states: Record<string, State> } {
  const call = (payload: Record<string, unknown>, resultSelector: Record<string, unknown>, resultPath: string, next: string): State => ({
    Type: 'Task',
    Resource: 'arn:aws:states:::lambda:invoke',
    Parameters: { FunctionName: cfg.fallbackFunctionArn, Payload: payload },
    ResultSelector: resultSelector,
    ResultPath: resultPath,
    TimeoutSeconds: 120,
    Retry: LAMBDA_RETRY,
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.bgmFallbackError', Next: 'BgmSkip' }],
    Next: next,
  });
  return {
    startAt: 'BgmFallbackSubmit',
    states: {
      BgmFallbackSubmit: {
        ...call(
          { action: 'bgm-submit', 'prompt.$': '$.options.bgmPrompt', 'durationS.$': '$.assemble.result.durationSec' },
          { 'taskId.$': '$.Payload.taskId' },
          '$.bgmFallbackJob',
          'BgmFallbackInitPoll',
        ),
        Comment: 'RunPod BGM-S2T gave no BGM: Suno (instrumental) on KIE, to the assembled video\'s length.',
      },
      BgmFallbackInitPoll: { Type: 'Pass', Result: { n: 0 }, ResultPath: '$.bgmFallbackPoll', Next: 'BgmFallbackWait' },
      BgmFallbackWait: { Type: 'Wait', Seconds: POLL_INTERVAL_S, Next: 'BgmFallbackStatus' },
      BgmFallbackStatus: call(
        { action: 'bgm-status', 'taskId.$': '$.bgmFallbackJob.taskId', 'durationS.$': '$.assemble.result.durationSec', 'outputPrefix.$': '$.outputPrefix' },
        { 'r.$': '$.Payload' },
        '$.bgmFallbackStatus',
        'BgmFallbackCheck',
      ),
      BgmFallbackCheck: {
        Type: 'Choice',
        Choices: [
          {
            And: [
              { Variable: '$.bgmFallbackStatus.r.status', StringEquals: 'COMPLETED' },
              { Variable: '$.bgmFallbackStatus.r.audioUrl', IsPresent: true },
            ],
            Next: 'BgmFallbackDone',
          },
          { Variable: '$.bgmFallbackStatus.r.status', StringEquals: 'COMPLETED', Next: 'BgmSkip' },
          { Variable: '$.bgmFallbackStatus.r.status', StringEquals: 'FAILED', Next: 'BgmSkip' },
        ],
        Default: 'BgmFallbackCount',
      },
      BgmFallbackCount: {
        Type: 'Pass',
        Parameters: { 'n.$': 'States.MathAdd($.bgmFallbackPoll.n, 1)' },
        ResultPath: '$.bgmFallbackPoll',
        Next: 'BgmFallbackLimit',
      },
      BgmFallbackLimit: {
        Type: 'Choice',
        Choices: [{ Variable: '$.bgmFallbackPoll.n', NumericGreaterThan: FALLBACK_MAX_POLLS, Next: 'BgmSkip' }],
        Default: 'BgmFallbackWait',
      },
      BgmFallbackDone: {
        Type: 'Pass',
        Parameters: { 'bgmUrl.$': '$.bgmFallbackStatus.r.audioUrl' },
        End: true,
      },
    },
  };
}

export function buildOrchestratorTailDefinition(cfg: OrchestratorTailConfig): Definition {
  const captionBranch = runpodBranch(cfg, {
    prefix: 'Caption',
    endpointId: cfg.whisperEndpointId,
    comment: 'Word-level captions, only when the project asked for them.',
    gate: { Variable: '$.options.captions', BooleanEquals: true },
    input: {
      mode: 'transcribe',
      // The assembled AUDIO, after silence removal: the only point at which
      // word timings are true.
      'audio_url.$': '$.assemble.result.audioUrl',
      task: 'transcribe',
      // Without it Whisper guesses, and transcribes e.g. Hindi as English phonetics.
      'language.$': '$.language',
      return_timestamps: 'word',
      // One cue per word: finalize groups them itself, so each highlight lands
      // on the real word timing (a 4-word cue only has its outer bounds).
      words_per_group: 1,
    },
    resultField: 'srtUrl',
    outputField: 'srtUrl',
    fallback: captionFallback(cfg),
  });

  const bgmBranch = runpodBranch(cfg, {
    prefix: 'Bgm',
    endpointId: cfg.bgmEndpointId,
    comment: 'Background music, only when the project asked for it and gave a prompt.',
    gate: {
      And: [
        { Variable: '$.options.bgm', BooleanEquals: true },
        { Variable: '$.options.bgmPrompt', IsPresent: true },
      ],
    },
    input: {
      mode: 'bgm',
      'prompt.$': '$.options.bgmPrompt',
      // The Lambda clamps this to what ACE-Step reliably generates; finalize
      // loops the track under the whole video.
      'duration_s.$': '$.assemble.result.durationSec',
    },
    resultField: 'audioUrl',
    outputField: 'bgmUrl',
    fallback: bgmFallback(cfg),
  });

  const states: Record<string, State> = {
    PrepareAssemble: {
      Type: 'Pass',
      Comment: 'The assemble task\'s small payload: a manifest URL and three scalars.',
      Parameters: {
        'manifestUrl.$': '$.manifestUrl',
        'aspectRatio.$': '$.aspectRatio',
        'outputPrefix.$': '$.outputPrefix',
        'removeSilence.$': '$.options.removeSilence',
      },
      ResultPath: '$.assemblePayload',
      Next: 'AssembleCore',
    },
    AssembleCore: ecsTask(
      cfg, 'assemble', '$.assemblePayload', '$.assembleEcs', 3600, 'ReadAssembleMeta',
      'Per-frame merge (+ Ken Burns for stills, SFX mix), concat, silence removal and the A/V parity gate, on the qm-orchestrator-tail Fargate task.',
    ),
    ReadAssembleMeta: readS3Json(
      cfg, "States.Format('{}meta.json', $.outputPrefix)", '$.assemble', 'GenerateAudioLayers',
      'ecs:runTask.sync returns nothing, so the task wrote meta.json (assembled video/audio urls, real duration, per-frame clips) and it is read back here.',
    ),
    GenerateAudioLayers: {
      Type: 'Parallel',
      Comment: 'Word-level captions and BGM, in parallel, on the BGM-S2T RunPod endpoint (fallbacks: OpenAI transcription, KIE Suno). Optional layers: this state never fails the project.',
      Branches: [captionBranch, bgmBranch],
      ResultPath: '$.layers',
      Catch: [
        {
          ErrorEquals: ['States.ALL'],
          ResultPath: '$.layersError',
          Next: 'NoLayers',
        },
      ],
      Next: 'PrepareFinalize',
    },
    NoLayers: {
      Type: 'Pass',
      Comment: 'Something unexpected broke the optional layers: ship the video without them.',
      Result: [{ srtUrl: '' }, { bgmUrl: '' }],
      ResultPath: '$.layers',
      Next: 'PrepareFinalize',
    },
    PrepareFinalize: {
      Type: 'Pass',
      Parameters: {
        'manifestUrl.$': '$.manifestUrl',
        'videoUrl.$': '$.assemble.result.videoUrl',
        'srtUrl.$': '$.layers[0].srtUrl',
        'bgmUrl.$': '$.layers[1].bgmUrl',
        'aspectRatio.$': '$.aspectRatio',
        targetResolution: '1080p',
        'outputKey.$': "States.Format('{}final.mp4', $.outputPrefix)",
        'resultKey.$': "States.Format('{}result.json', $.outputPrefix)",
      },
      ResultPath: '$.finalizePayload',
      Next: 'FinalizeVideo',
    },
    FinalizeVideo: ecsTask(
      cfg, 'finalize', '$.finalizePayload', '$.finalizeEcs', 3600, 'ReadFinalizeResult',
      'Upscale to 1080p, unsharp, burn the word-highlight captions and overlay the BGM, on the same Fargate task.',
    ),
    ReadFinalizeResult: readS3Json(
      cfg, "States.Format('{}result.json', $.outputPrefix)", '$.final', 'BuildOutput',
      'The finalize task\'s result.json: the final video url and its real duration.',
    ),
    BuildOutput: {
      Type: 'Pass',
      Comment: 'The execution output the orchestrator reads on SUCCEEDED (assets/agent.ts reconcileSfnRow): { videoUrl, durationSec, frames }.',
      Parameters: {
        'videoUrl.$': '$.final.result.videoUrl',
        'durationSec.$': '$.final.result.durationSec',
        'frames.$': '$.assemble.result.frames',
      },
      Next: 'Done',
    },
    Done: { Type: 'Succeed' },
    TailFailed: {
      Type: 'Fail',
      Comment: 'The Error and Cause of whatever failed, passed straight through: the orchestrator copies them into the project\'s error list.',
      ErrorPath: '$.error.Error',
      CausePath: '$.error.Cause',
    },
  };

  return {
    Comment:
      'Orchestrator assembly tail: ECS merge/concat/silence-removal -> RunPod BGM-S2T word-level captions + BGM -> ECS upscale/burn/overlay. ' +
      'Started by the VPS orchestrator with asset references only; it polls this execution.',
    StartAt: 'PrepareAssemble',
    // Fires before the orchestrator's own 95-minute wall clock, so the real
    // TIMED_OUT (with its history) is what gets reported.
    TimeoutSeconds: EXECUTION_TIMEOUT_S,
    States: states,
  };
}
