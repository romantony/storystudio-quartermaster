import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as path from 'path';

interface PipelineStackProps extends StackProps {
  gatewayKeySecretArn: string;
  /** CloudFront domain of the Quartermaster API distribution (no https://) */
  qmApiDomain: string;
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    // ── QM-broker-call Lambda ────────────────────────────────────────────────
    const brokerFn = new nodejs.NodejsFunction(this, 'BrokerCallFunction', {
      functionName: 'QM-broker-call',
      entry: path.join(__dirname, '../../src/handlers/broker-call.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(120),
      memorySize: 256,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        QM_BASE_URL: `https://${props.qmApiDomain}`,
        GATEWAY_STATIC_KEY_ARN: props.gatewayKeySecretArn,
      },
    });

    brokerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.gatewayKeySecretArn],
    }));

    // Allow the existing E2E Step Function role to invoke this Lambda.
    brokerFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // ── QM-generate Lambda (SFN ↔ Quartermaster gateway task) ────────────────
    // Submits a canonical job to QM and polls it to completion; QM owns provider
    // selection, internal↔external failover, and concurrency. Replaces the
    // per-asset "acquire → provider Lambda → release" cluster.
    // Timeout must exceed QM_GENERATE_DEADLINE_MS (qm-generate.ts's own poll
    // deadline, raised to 580s alongside this) with margin, and executor.ts's
    // timeout (600s) must in turn be >= this Lambda's polling window, or the
    // three layers race each other into a false timeout on a genuinely
    // slow-but-succeeding RunPod job (confirmed live 2026-07-04, Wan2 i2v).
    const qmGenerateFn = new nodejs.NodejsFunction(this, 'QMGenerateFunction', {
      functionName: 'QM-generate',
      entry: path.join(__dirname, '../../src/handlers/qm-generate.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(610),
      memorySize: 256,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        QM_BASE_URL: `https://${props.qmApiDomain}`,
        GATEWAY_STATIC_KEY_ARN: props.gatewayKeySecretArn,
        QM_GENERATE_DEADLINE_MS: '580000',
      },
    });
    qmGenerateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.gatewayKeySecretArn],
    }));
    qmGenerateFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // ── State machine definition ─────────────────────────────────────────────
    const brokerArn = brokerFn.functionArn;

    // Basic-QM stays exactly as deployed today (broker semaphore around
    // image-basic-generator). The new gateway flow lives in QM-new below so we
    // can test it without touching production.
    const definition = buildDefinition(brokerArn);

    const sfnRole = iam.Role.fromRoleArn(this, 'E2ESfnRole',
      'arn:aws:iam::929075264324:role/E2E-StepFunction-Role');

    const stateMachine = new sfn.CfnStateMachine(this, 'BasicQMPipeline', {
      stateMachineName: 'E2E-VideoGenerationPipeline-Basic-QM',
      stateMachineType: 'STANDARD',
      roleArn: sfnRole.roleArn,
      // definitionString preserves JSON null values (ResultPath: null) which
      // the `definition` object property rejects as a CloudFormation template error.
      definitionString: JSON.stringify(definition),
      tags: [{ key: 'batchjob', value: 'true' }],
    });

    new CfnOutput(this, 'StateMachineArn', { value: stateMachine.attrArn });
    new CfnOutput(this, 'BrokerFunctionArn', { value: brokerFn.functionArn });

    // ── Premium-QM pipeline ─────────────────────────────────────────────────
    const premiumDefinition = buildPremiumDefinition(brokerArn);

    const premiumStateMachine = new sfn.CfnStateMachine(this, 'PremiumQMPipeline', {
      stateMachineName: 'E2E-VideoGenerationPipeline-Premium-QM',
      stateMachineType: 'STANDARD',
      roleArn: sfnRole.roleArn,
      definitionString: JSON.stringify(premiumDefinition),
      tags: [{ key: 'batchjob', value: 'true' }],
    });

    new CfnOutput(this, 'PremiumStateMachineArn', { value: premiumStateMachine.attrArn });

    // ── Narration-Basic-QM-New pipeline ──────────────────────────────────────
    // Narration-basic ONLY (a narration-premium QM-new machine is separate,
    // not yet built). Same Basic downstream (i2v → concat → SRT → finalize)
    // but each frame's image (t2i or i2i on referenceImageUrl) AND TTS are
    // generated through the Quartermaster gateway (QM-generate). Separate
    // machine so we can validate the gateway end-to-end without altering
    // Basic-QM/Premium-QM.
    const qmNewDefinition = buildQmNewDefinition(qmGenerateFn.functionArn, brokerArn);

    const qmNewStateMachine = new sfn.CfnStateMachine(this, 'QMNewPipeline', {
      stateMachineName: 'E2E-VideoGenerationPipeline-Narration-Basic-QM-New',
      stateMachineType: 'STANDARD',
      roleArn: sfnRole.roleArn,
      definitionString: JSON.stringify(qmNewDefinition),
      tags: [{ key: 'batchjob', value: 'true' }, { key: 'qmGateway', value: 'true' }],
    });

    new CfnOutput(this, 'QMNewStateMachineArn', { value: qmNewStateMachine.attrArn });

    // ── Narration-Premium-QM-New pipeline ────────────────────────────────────
    // Sibling of Narration-Basic-QM-New: per-frame image (Qwen t2i/i2i) → TTS
    // (Qwen voice-design) → Wan2 i2v → merge, all through the Quartermaster
    // gateway. Finalize is Premium-flavored (1080p upscale), mirroring
    // buildPremiumDefinition's FinalizeVideoPremium exactly.
    const narrationPremiumQmNewDefinition = buildNarrationPremiumQmNewDefinition(qmGenerateFn.functionArn, brokerArn);

    const narrationPremiumQmNewStateMachine = new sfn.CfnStateMachine(this, 'NarrationPremiumQMNewPipeline', {
      stateMachineName: 'E2E-VideoGenerationPipeline-Narration-Premium-QM-New',
      stateMachineType: 'STANDARD',
      roleArn: sfnRole.roleArn,
      definitionString: JSON.stringify(narrationPremiumQmNewDefinition),
      tags: [{ key: 'batchjob', value: 'true' }, { key: 'qmGateway', value: 'true' }],
    });

    new CfnOutput(this, 'NarrationPremiumQMNewStateMachineArn', { value: narrationPremiumQmNewStateMachine.attrArn });
  }
}

// ---------------------------------------------------------------------------
// QM-new SFN definition — image (t2i/i2i) + TTS through the QM gateway
// ---------------------------------------------------------------------------
// Reuses the entire Basic definition (validate → …map… → i2v → concat → SRT →
// finalize) and swaps ONLY the per-frame GenerateImages Map for a QM-generate
// version. Because the acquire/release broker states live exclusively inside
// that Map, replacing it removes every broker reference — the cloned brokerArn
// never survives into the QM-new definition.
// ---------------------------------------------------------------------------
function buildQmNewDefinition(qmGenerateArn: string, brokerArn: string): object {
  const def = JSON.parse(JSON.stringify(buildDefinition(brokerArn))) as {
    Comment: string;
    States: Record<string, any>;
  };
  def.Comment = 'E2E Video Generation Pipeline - Narration-Basic-QM-New — per-frame image (t2i/i2i) + TTS + Flux animate + merge via Quartermaster gateway. Narration-basic only; narration-premium is a separate state machine.';

  // The QM frame Map now produces the finished per-frame video (image → TTS →
  // Flux animate → Flux merge), so it emits $.videoResults directly and the
  // local Ken Burns Map (GenerateI2VBasic) is no longer needed.
  def.States.GenerateImages = qmFrameAssetsMap(qmGenerateArn);

  // BGM is now generated from a prompt (bgmPrompt), not passed in as a
  // pre-existing URL. Route through it right after the frame Map — $.frames
  // is still present at this point (DropFrameData is what discards it below),
  // and QM-generate needs the full frames array to sum durations (§bgmStates).
  def.States.GenerateImages.Next = 'RouteBGM';
  Object.assign(def.States, bgmStates(qmGenerateArn, 'narrationBasic'));

  // Repurpose DropFrameData to carry videoResults (not imageResults) and the
  // generated bgmResult straight to concat, and skip the now-removed local
  // i2v stage.
  def.States.DropFrameData = {
    Type: 'Pass',
    Comment: 'Drop $.frames to stay within the 256KB SFN state limit; carry per-frame videoResults + bgmResult to concat.',
    Parameters: {
      'jobId.$': '$.jobId',
      'projectId.$': '$.projectId',
      'projectType.$': '$.projectType',
      'aspectRatio.$': '$.aspectRatio',
      'bgmResult.$': '$.bgmResult',
      'jwtToken.$': '$.jwtToken',
      'convexEndpoint.$': '$.convexEndpoint',
      'apiKey.$': '$.apiKey',
      'videoResults.$': '$.videoResults',
    },
    Next: 'UpdateStatusConcatenating',
  };
  delete def.States.UpdateStatusGeneratingVideos;
  delete def.States.GenerateI2VBasic;

  // The generated BGM's URL now comes from bgmResult, not a passed-in bgmUrl.
  def.States.PrepareFinalizeBasic.Parameters['bgmUrl.$'] = '$.bgmResult.cdnUrl';

  return def;
}

/**
 * BGM states shared by both Narration-Basic-QM-New and Narration-Premium-QM-New
 * (the premium machine re-assigns this block with tier:'narrationPremium' after
 * cloning the basic definition — see buildNarrationPremiumQmNewDefinition).
 * Project-level (once per project, not per-frame): generates a track from
 * `bgmPrompt` when supplied, otherwise skips BGM entirely (silent final video).
 * Runs BEFORE DropFrameData so $.frames (needed to sum durations) is still
 * present — Step Functions' ASL has no native array-sum intrinsic, so
 * QM-generate does the summing itself from the raw frames array (see
 * qm-generate.ts). A frame that exhausts all BGM rungs proceeds without music
 * rather than failing the whole project.
 */
function bgmStates(qmGenerateArn: string, tier: string): Record<string, unknown> {
  return {
    RouteBGM: {
      Type: 'Choice',
      Comment: 'Generate BGM only when a prompt was supplied; otherwise skip (silent final video, no BGM)',
      Choices: [{
        And: [
          { Variable: '$.bgmPrompt', IsPresent: true },
          { Variable: '$.bgmPrompt', IsString: true },
          { Not: { Variable: '$.bgmPrompt', StringEquals: '' } },
        ],
        Next: 'QMGenerateBGM',
      }],
      Default: 'SkipBgm',
    },
    SkipBgm: {
      Type: 'Pass',
      Comment: 'No bgmPrompt supplied — proceed without background music',
      Parameters: { cdnUrl: '' },
      ResultPath: '$.bgmResult',
      Next: 'DropFrameData',
    },
    QMGenerateBGM: {
      Type: 'Task',
      Resource: qmGenerateArn,
      Comment: `Generate background music via QM (bgm.${tier}: self-hosted ACE-Step → Suno/KIE fallback). Duration = sum of all frame durations (computed by QM-generate — ASL has no array-sum intrinsic).`,
      Parameters: {
        assetType: 'bgm',
        tier,
        operation: 'generate',
        product: 'narration',
        queue: 'background',
        jobType: 'batch',
        'prompt.$': '$.bgmPrompt',
        'frames.$': '$.frames',
        'projectId.$': '$.projectId',
        'userId.$': '$.userId',
      },
      ResultPath: '$.bgmResult',
      TimeoutSeconds: 300,
      Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.bgmError', Next: 'BgmGenerationFailed' }],
      Next: 'DropFrameData',
    },
    BgmGenerationFailed: {
      Type: 'Pass',
      Comment: 'BGM generation exhausted all rungs — proceed without music rather than failing the whole project',
      Parameters: { cdnUrl: '' },
      ResultPath: '$.bgmResult',
      Next: 'DropFrameData',
    },
  };
}

/**
 * Per-frame Map that builds the finished frame video entirely through the QM
 * gateway: image (t2i, or i2i when the frame carries a UI `referenceImageUrl`
 * character) → TTS (`narrationText`, voice by `voiceGender`) → Flux `animate`
 * (smooth Ken Burns, replaces the jittery local render) → Flux `merge` (voice
 * onto the animation). Emits the item shape the concat step consumes:
 * `videoUrl` + `frameNumber` (+ `duration`, `frameId`).
 */
function qmFrameAssetsMap(qmGenerateArn: string): object {
  return {
    Type: 'Map',
    Comment: 'Per-frame video via Quartermaster gateway (Narration-Basic): ONE flux-tts-s2t `pipeline` call per frame does image (t2i/i2i) → Kokoro TTS → animate → merge (models resident in VRAM). Replaces 4 QM jobs/frame with 1. QM owns internal-first routing + per-endpoint concurrency.',
    ItemsPath: '$.frames',
    MaxConcurrency: 15,
    ResultPath: '$.videoResults',
    Iterator: {
      StartAt: 'QMGeneratePipeline',
      States: {
        QMGeneratePipeline: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'One-shot per frame via QM (video.narrationBasic.pipeline → flux-tts-s2t pipeline mode): image + Kokoro TTS + animate + merge. referenceImageUrl non-empty ⇒ i2i, empty ⇒ t2i (adapter filters). caption:false + no bgm — SRT and BGM are project-level. Timeout matches the QM-generate Lambda poll deadline (580s) with margin.',
          Parameters: {
            assetType: 'video',
            tier: 'narrationBasic',
            operation: 'pipeline',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'prompt.$': '$.imagePrompt',
            'voiceText.$': '$.narrationText',
            'voiceGender.$': '$$.Execution.Input.voiceGender',
            'initImageUrls.$': 'States.Array($.referenceImageUrl)',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'durationS.$': '$.duration',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.pipelineResult',
          TimeoutSeconds: 650,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.pipelineError', Next: 'QMFrameFailed' }],
          Next: 'BuildFrameVideo',
        },
        QMFrameFailed: {
          Type: 'Pass',
          Comment: 'QM pipeline call exhausted its rungs for this frame — propagate a graceful frame failure (the Map continues; concat skips it).',
          Parameters: {
            failed: true,
            error: 'QMFrameFailed',
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
          },
          End: true,
        },
        BuildFrameVideo: {
          Type: 'Pass',
          Comment: 'Emit the per-frame video item the concat step consumes (videoUrl = pipeline output: merged animation + voice).',
          Parameters: {
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            'videoUrl.$': '$.pipelineResult.cdnUrl',
            'duration.$': '$.duration',
          },
          End: true,
        },
      },
    },
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'DropFrameData',
  };
}

// ---------------------------------------------------------------------------
// Narration-Premium-QM-New SFN definition
// ---------------------------------------------------------------------------
// Sibling of buildQmNewDefinition: same downstream shape (concat → SRT →
// finalize), but the per-frame Map generates image (Qwen t2i/i2i) + TTS (Qwen
// voice-design) + Wan2 i2v + merge instead of Flux image/TTS/animate/merge, and
// the finalize section is Premium-flavored (1080p upscale), matching
// buildPremiumDefinition's FinalizeVideoPremium exactly.
// ---------------------------------------------------------------------------
function buildNarrationPremiumQmNewDefinition(qmGenerateArn: string, brokerArn: string): object {
  const def = JSON.parse(JSON.stringify(buildQmNewDefinition(qmGenerateArn, brokerArn))) as {
    Comment: string;
    States: Record<string, any>;
  };
  def.Comment = 'E2E Video Generation Pipeline - Narration-Premium-QM-New — per-frame image (Qwen t2i/i2i) + TTS (Qwen voice-design) + Wan2 i2v + merge via Quartermaster gateway';

  // Swap the Basic per-frame Map (Flux image/TTS/animate/merge) for the Premium
  // one (Qwen image, Qwen TTS, Wan2 i2v, generic merge). Re-point its Next back
  // to RouteBGM (qmPremiumFrameAssetsMap sets Next:'DropFrameData' internally,
  // matching the Basic map's shape) and re-tier the cloned BGM states — the
  // clone above inherited buildQmNewDefinition's tier:'narrationBasic' BGM
  // block, which must not silently persist into a premium project's job
  // records (wrong billing/audit attribution even though it's the same
  // physical ACE-Step rung).
  def.States.GenerateImages = qmPremiumFrameAssetsMap(qmGenerateArn);
  def.States.GenerateImages.Next = 'RouteBGM';
  Object.assign(def.States, bgmStates(qmGenerateArn, 'narrationPremium'));

  // Finalize becomes Premium-flavored (1080p upscale, longer Fargate timeout),
  // renaming the Basic finalize states to match buildPremiumDefinition's own
  // naming convention exactly (FinalizeVideoPremium etc.) rather than running a
  // "Basic"-named state with premium content.
  def.States.UpdateStatusApplyingBgm.Catch = [
    { ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'FinalizeVideoPremium' },
  ];
  def.States.UpdateStatusApplyingBgm.Next = 'ValidateFinalizeInputsPremium';

  def.States.ValidateFinalizeInputsPremium = {
    Type: 'Choice',
    Comment: 'Verify required fields exist before finalize; fail fast on missing data',
    Choices: [{ Variable: '$.mergedVoiceResult.mergedVideoUrl', IsPresent: true, Next: 'PrepareFinalizePremium' }],
    Default: 'FinalizeInputsMissingPremium',
  };
  delete def.States.ValidateFinalizeInputsBasic;

  def.States.FinalizeInputsMissingPremium = {
    Type: 'Fail',
    Error: 'FinalizeInputsMissing',
    Cause: 'Required finalize input(s) missing: $.mergedVoiceResult.mergedVideoUrl',
  };
  delete def.States.FinalizeInputsMissingBasic;

  def.States.PrepareFinalizePremium = {
    Type: 'Pass',
    Comment: 'Prepare a small payload for the Fargate finalize task (Premium: 480p→1080p upscale)',
    Parameters: {
      mode: 'premium',
      'jobId.$': '$.jobId',
      'projectId.$': '$.projectId',
      'projectType.$': '$.projectType',
      'aspectRatio.$': '$.aspectRatio',
      'videoUrl.$': '$.mergedVoiceResult.mergedVideoUrl',
      'voiceAudioUrl.$': '$.mergedVoiceResult.audioUrl',
      'captionsUrl.$': '$.mergedVoiceResult.captionsUrl',
      'bgmUrl.$': '$.bgmResult.cdnUrl',
      targetResolution: '1080p',
      'jwtToken.$': '$.jwtToken',
      'convexEndpoint.$': '$.convexEndpoint',
    },
    ResultPath: '$.finalizeTaskInput',
    Next: 'FinalizeVideoPremium',
  };
  delete def.States.PrepareFinalizeBasic;

  def.States.FinalizeVideoPremium = {
    Type: 'Task',
    Resource: 'arn:aws:states:::ecs:runTask.sync',
    Comment: 'Finalize on Fargate (no Lambda timeout ceiling): 480p→1080p upscale + captions + BGM',
    Parameters: {
      Cluster: 'arn:aws:ecs:us-east-1:929075264324:cluster/storystudio-e2e',
      LaunchType: 'FARGATE',
      TaskDefinition: 'e2e-finalize',
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          Subnets: ['subnet-02557f42e07118380', 'subnet-0389bf7ebb5a497ac'],
          SecurityGroups: ['sg-0c2549fa2cb194dc6'],
          AssignPublicIp: 'ENABLED',
        },
      },
      Overrides: {
        ContainerOverrides: [{
          Name: 'finalize',
          Environment: [{ Name: 'PAYLOAD_JSON', 'Value.$': 'States.JsonToString($.finalizeTaskInput)' }],
        }],
      },
    },
    ResultPath: '$.finalizeEcs',
    TimeoutSeconds: 5400,
    Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 1, BackoffRate: 2 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'Complete',
  };
  delete def.States.FinalizeVideoBasic;

  return def;
}

/**
 * Per-frame Map for Narration-Premium-QM-New: image (Qwen i2i when the frame
 * carries a UI `referenceImageUrl` character, else t2i) → Wan2 i2v (narrationText
 * doubles as the motion prompt, matching the legacy Premium-QM convention) → TTS
 * (Qwen voice-design, speaker/instruct/language from execution input) → merge
 * (voice onto the Wan2 video — the SAME generic Flux-TTS-S2T merge rung
 * narration-basic uses, via the video.narrationPremium.merge alias; merge is a
 * model-agnostic audio+video mux, not tied to how the silent video was made).
 * Video is generated right after the image — before TTS — so a failing
 * image/video step fails the frame before spending on TTS for it.
 * Emits the item shape the concat step consumes: `videoUrl` + `frameNumber`
 * (+ `duration`, `frameId`) — identical to the Basic map's output shape.
 */
function qmPremiumFrameAssetsMap(qmGenerateArn: string): object {
  return {
    Type: 'Map',
    Comment: 'Per-frame video via Quartermaster gateway (Narration-Premium): image (Qwen i2i/t2i) → Wan2 i2v → TTS (Qwen voice-design) → merge. QM owns provider selection, internal→external failover, and per-endpoint concurrency.',
    ItemsPath: '$.frames',
    // Lower than Basic-QM-New's 15 — premium touches 3 endpoints per frame, so its
    // worker footprint is 3x a single-endpoint project's at the same concurrency.
    // At 15, a solo premium project alone needs 12 workers (> ACCOUNT_CAP=10),
    // deferring forever even on a fully idle fleet. Must match
    // admission.ts's PREMIUM_MAP_CONCURRENCY exactly — capacity planning and real
    // SFN parallelism must agree, or under-provisioned workers meet real RunPod
    // contention this constant was supposed to prevent.
    MaxConcurrency: 8,
    ResultPath: '$.videoResults',
    Iterator: {
      StartAt: 'CheckImageCache',
      States: {
        CheckImageCache: {
          Type: 'Task',
          Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-asset-cache-check',
          Comment: 'Check S3 metadata cache — skip image generation if it already exists',
          Parameters: {
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            assetType: 'image',
          },
          ResultPath: '$.imageCacheResult',
          TimeoutSeconds: 10,
          Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 2, MaxAttempts: 1, BackoffRate: 1.5 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.cacheError', Next: 'RouteImageGen' }],
          Next: 'CheckImageCacheResult',
        },
        CheckImageCacheResult: {
          Type: 'Choice',
          Comment: 'Cached image → skip straight to video; otherwise generate the image',
          Choices: [{ Variable: '$.imageCacheResult.cached', BooleanEquals: true, Next: 'UseImageCache' }],
          Default: 'RouteImageGen',
        },
        UseImageCache: {
          Type: 'Pass',
          Comment: 'Image already in S3 — use cached CDN URL, still (re)generate the video',
          Parameters: {
            'cdnUrl.$': '$.imageCacheResult.cdnUrl',
            's3Key.$': '$.imageCacheResult.s3Key',
            'width.$': '$.imageCacheResult.width',
            'height.$': '$.imageCacheResult.height',
          },
          ResultPath: '$.imageResult',
          Next: 'QMGenerateVideo',
        },
        RouteImageGen: {
          Type: 'Choice',
          Comment: 'Character reference from the UI → image-to-image; otherwise text-to-image',
          Choices: [{
            And: [
              { Variable: '$.referenceImageUrl', IsPresent: true },
              { Variable: '$.referenceImageUrl', IsString: true },
              { Not: { Variable: '$.referenceImageUrl', StringEquals: '' } },
            ],
            Next: 'QMGenerateImageI2I',
          }],
          Default: 'QMGenerateImageT2I',
        },
        QMGenerateImageT2I: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Text-to-image via QM (image.narrationPremium.t2i: self-hosted Qwen-Image-Gen → KIE fallback)',
          Parameters: {
            assetType: 'image',
            tier: 'narrationPremium',
            operation: 't2i',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'prompt.$': '$.imagePrompt',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.imageResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'QMFrameFailed' }],
          Next: 'StoreImageMeta',
        },
        QMGenerateImageI2I: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Image-to-image via QM (image.narrationPremium.i2i: self-hosted Qwen-Image-Edit) using the UI character reference',
          Parameters: {
            assetType: 'image',
            tier: 'narrationPremium',
            operation: 'i2i',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'prompt.$': '$.imagePrompt',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'initImageUrls.$': 'States.Array($.referenceImageUrl)',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.imageResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'QMFrameFailed' }],
          Next: 'StoreImageMeta',
        },
        StoreImageMeta: {
          Type: 'Task',
          Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-store-asset-meta',
          Comment: 'Persist image metadata to S3 for cache reuse',
          Parameters: {
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            assetType: 'image',
            'cdnUrl.$': '$.imageResult.cdnUrl',
            's3Key.$': '$.imageResult.s3Key',
            'width.$': '$.imageResult.width',
            'height.$': '$.imageResult.height',
          },
          ResultPath: null,
          TimeoutSeconds: 10,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.metaStoreError', Next: 'QMGenerateVideo' }],
          Next: 'QMGenerateVideo',
        },
        RouteTTS: {
          Type: 'Choice',
          Comment: 'Frame already carries a voiceUrl → reuse it; otherwise generate TTS from narrationText',
          Choices: [{
            And: [
              { Variable: '$.voiceUrl', IsPresent: true },
              { Variable: '$.voiceUrl', IsString: true },
              { Not: { Variable: '$.voiceUrl', StringEquals: '' } },
            ],
            Next: 'UseProvidedVoice',
          }],
          Default: 'QMGenerateTTS',
        },
        UseProvidedVoice: {
          Type: 'Pass',
          Comment: 'A voiceUrl was supplied upstream — reuse it, skip TTS generation',
          Parameters: { 'cdnUrl.$': '$.voiceUrl' },
          ResultPath: '$.ttsResult',
          Next: 'QMMerge',
        },
        QMGenerateTTS: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'TTS via QM (voice.narrationPremium.tts: self-hosted Qwen3-TTS voice-design → Google fallback). Speaker/instruct/language come from execution input (project-level, not per-frame).',
          Parameters: {
            assetType: 'voice',
            tier: 'narrationPremium',
            operation: 'tts',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'prompt.$': '$.narrationText',
            'speaker.$': '$$.Execution.Input.voiceSpeaker',
            'instruct.$': '$$.Execution.Input.voiceInstruct',
            'language.$': '$$.Execution.Input.voiceLanguage',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.ttsResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'QMFrameFailed' }],
          Next: 'QMMerge',
        },
        QMGenerateVideo: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Image-to-video via QM (video.narrationPremium.i2v: self-hosted Wan 2.2 I2V-A14B 4-step Lightning → Replicate fallback). Silent MP4; narrationText doubles as the motion prompt (matches the legacy Premium-QM convention). Cold start ~170-190s + real RunPod-side queue wait when a Map wave (8 concurrent) exceeds the endpoint\'s ~3 real pods — 650s gives qm-generate.ts\'s 610s Lambda timeout (itself polling to a 580s deadline) room to actually observe a slow-but-real completion instead of timing out first.',
          Parameters: {
            assetType: 'video',
            tier: 'narrationPremium',
            operation: 'i2v',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'prompt.$': '$.narrationText',
            'durationS.$': '$.duration',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.videoResult',
          TimeoutSeconds: 650,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoError', Next: 'QMFrameFailed' }],
          Next: 'RouteTTS',
        },
        QMMerge: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Merge the TTS voice onto the Wan2-generated video via QM (video.narrationPremium.merge → aliases the same Flux-TTS-S2T merge rung narration-basic uses). MP4 with audio.',
          Parameters: {
            assetType: 'video',
            tier: 'narrationPremium',
            operation: 'merge',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'initImageUrls.$': 'States.Array($.videoResult.cdnUrl)',
            'audioUrl.$': '$.ttsResult.cdnUrl',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.mergeResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.mergeError', Next: 'QMFrameFailed' }],
          Next: 'BuildFrameVideo',
        },
        QMFrameFailed: {
          Type: 'Pass',
          Comment: 'QM exhausted all rungs for image/TTS/video/merge — propagate a graceful frame failure',
          Parameters: {
            failed: true,
            error: 'QMFrameFailed',
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
          },
          End: true,
        },
        BuildFrameVideo: {
          Type: 'Pass',
          Comment: 'Emit the per-frame video item the concat step consumes (videoUrl = merged Wan2 video + voice).',
          Parameters: {
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            'videoUrl.$': '$.mergeResult.cdnUrl',
            'duration.$': '$.duration',
          },
          End: true,
        },
      },
    },
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'DropFrameData',
  };
}

// ---------------------------------------------------------------------------
// SFN definition
// ---------------------------------------------------------------------------
function buildDefinition(brokerArn: string): object {
  const acquireImageSlot = {
    Type: 'Task',
    Resource: brokerArn,
    Comment: 'Acquire a rest-lane slot from Quartermaster before calling ModelsLab/Replicate',
    Parameters: {
      action: 'acquire',
      lane: 'rest',
      'tenant.$': "States.Format('sfn:{}:image', $$.Execution.Input.projectId)",
      priority: 'P1',
      estDurationMs: 180000,
    },
    ResultPath: '$.qmAcquire',
    TimeoutSeconds: 120,
    Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 3, MaxAttempts: 2, BackoffRate: 1.5 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.acquireError', Next: 'AcquireImageSlotFailed' }],
    Next: 'GenerateImage',
  };

  const acquireImageSlotFailed = {
    Type: 'Pass',
    Comment: 'Propagate acquire failure as a graceful iteration failure',
    Parameters: {
      failed: true,
      error: 'AcquireSlotFailed',
      'frameId.$': '$.frameId',
      'frameNumber.$': '$.frameNumber',
    },
    End: true,
  };

  const releaseImageSlot = {
    Type: 'Task',
    Resource: brokerArn,
    Comment: 'Release rest-lane slot back to Quartermaster after successful generation',
    Parameters: {
      action: 'release',
      lane: 'rest',
      'leaseId.$': '$.qmAcquire.leaseId',
      outcome: 'success',
    },
    ResultPath: null,
    TimeoutSeconds: 15,
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'BuildImagePayload' }],
    Next: 'BuildImagePayload',
  };

  const releaseImageSlotOnError = {
    Type: 'Task',
    Resource: brokerArn,
    Comment: 'Release slot on primary-generation failure before attempting fallback',
    Parameters: {
      action: 'release',
      lane: 'rest',
      'leaseId.$': '$.qmAcquire.leaseId',
      outcome: 'fail',
    },
    ResultPath: null,
    TimeoutSeconds: 15,
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'GenerateImageFallback' }],
    Next: 'GenerateImageFallback',
  };

  const releaseImageSlotFallback = {
    Type: 'Task',
    Resource: brokerArn,
    Comment: 'Release rest-lane slot after fallback generation completes',
    Parameters: {
      action: 'release',
      lane: 'rest',
      'leaseId.$': '$.qmAcquire.leaseId',
      outcome: 'success',
    },
    ResultPath: null,
    TimeoutSeconds: 15,
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'BuildImagePayloadFallback' }],
    Next: 'BuildImagePayloadFallback',
  };

  return {
    Comment: 'E2E Video Generation Pipeline - Basic (QM) — image generation routed through Quartermaster semaphore',
    StartAt: 'ValidateInput',
    States: {
      ValidateInput: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-validate-input',
        Comment: 'Validate input parameters and prepare pipeline execution',
        ResultPath: '$.validationResult',
        Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 2, MaxAttempts: 2, BackoffRate: 1.5 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
        Next: 'CheckValidation',
      },
      CheckValidation: {
        Type: 'Choice',
        Choices: [{ Variable: '$.validationResult.valid', BooleanEquals: true, Next: 'UpdateStatusGeneratingImages' }],
        Default: 'FailValidation',
      },
      FailValidation: {
        Type: 'Pass',
        Comment: 'Validation failed — propagate error to Convex before terminating',
        Parameters: {
          status: 'FAILED',
          'projectId.$': '$$.Execution.Input.projectId',
          'jobId.$': '$$.Execution.Input.jobId',
          'jwtToken.$': '$$.Execution.Input.jwtToken',
          'convexEndpoint.$': '$$.Execution.Input.convexEndpoint',
          error: { Error: 'InvalidInput', Cause: 'E2E-validate-input returned invalid — check voiceUrls, frames, and required fields' },
          message: 'Validation failed: required input fields are missing or invalid',
        },
        Next: 'UpdateStatusFailed',
      },
      UpdateStatusGeneratingImages: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Update Convex job status (best-effort)',
        Parameters: {
          'jobId.$': '$.jobId',
          status: 'generating-images',
          message: 'Generating images...',
          progress: { step: 1, totalSteps: 8, percent: 10 },
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
        },
        ResultPath: null,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'GenerateImages' }],
        Next: 'GenerateImages',
        TimeoutSeconds: 30,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      },

      // ── GenerateImages Map ─────────────────────────────────────────────────
      GenerateImages: {
        Type: 'Map',
        Comment: 'Generate images via Quartermaster (acquire rest-lane slot → image-basic-generator → release). MaxConcurrency=15 matches the Quartermaster pool size; QM gates actual API calls.',
        ItemsPath: '$.frames',
        MaxConcurrency: 15,
        ResultPath: '$.imageResults',
        Iterator: {
          StartAt: 'CheckImageCache',
          States: {
            CheckImageCache: {
              Type: 'Task',
              Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-asset-cache-check',
              Comment: 'Check S3 metadata cache — skip generation if image already exists',
              Parameters: {
                'projectId.$': '$$.Execution.Input.projectId',
                'frameId.$': '$.frameId',
                assetType: 'image',
              },
              ResultPath: '$.imageCacheResult',
              TimeoutSeconds: 10,
              Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 2, MaxAttempts: 1, BackoffRate: 1.5 }],
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.cacheError', Next: 'AcquireImageSlot' }],
              Next: 'CheckImageCacheResult',
            },
            CheckImageCacheResult: {
              Type: 'Choice',
              Comment: 'Route to cached URL or acquire a Quartermaster slot for generation',
              Choices: [{ Variable: '$.imageCacheResult.cached', BooleanEquals: true, Next: 'UseImageCache' }],
              Default: 'AcquireImageSlot',
            },
            UseImageCache: {
              Type: 'Pass',
              Comment: 'Asset already in S3 — use cached CDN URL and skip generation',
              Parameters: {
                'cdnUrl.$': '$.imageCacheResult.cdnUrl',
                's3Key.$': '$.imageCacheResult.s3Key',
                'width.$': '$.imageCacheResult.width',
                'height.$': '$.imageCacheResult.height',
              },
              ResultPath: '$.imageResult',
              Next: 'BuildImagePayload',
            },
            AcquireImageSlot: acquireImageSlot,
            AcquireImageSlotFailed: acquireImageSlotFailed,
            GenerateImage: {
              Type: 'Task',
              Resource: 'arn:aws:lambda:us-east-1:929075264324:function:image-basic-generator',
              Comment: 'Generate single frame image via ModelsLab Flux Klein (slot held by Quartermaster)',
              Parameters: {
                'prompt.$': '$.imagePrompt',
                'aspectRatio.$': '$$.Execution.Input.aspectRatio',
                'projectId.$': '$$.Execution.Input.projectId',
                'frameId.$': '$.frameId',
                'userId.$': '$$.Execution.Input.userId',
              },
              ResultPath: '$.imageResult',
              TimeoutSeconds: 300,
              Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
              // On failure: release the slot before attempting fallback
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.kieError', Next: 'ReleaseImageSlotOnError' }],
              Next: 'StoreImageMeta',
            },
            StoreImageMeta: {
              Type: 'Task',
              Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-store-asset-meta',
              Comment: 'Persist image metadata to S3 for cache reuse on retries or reruns',
              Parameters: {
                'projectId.$': '$$.Execution.Input.projectId',
                'frameId.$': '$.frameId',
                assetType: 'image',
                'cdnUrl.$': '$.imageResult.cdnUrl',
                's3Key.$': '$.imageResult.s3Key',
                'width.$': '$.imageResult.width',
                'height.$': '$.imageResult.height',
              },
              ResultPath: null,
              TimeoutSeconds: 10,
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.metaStoreError', Next: 'ReleaseImageSlot' }],
              Next: 'ReleaseImageSlot',
            },
            ReleaseImageSlot: releaseImageSlot,
            ReleaseImageSlotOnError: releaseImageSlotOnError,
            GenerateImageFallback: {
              Type: 'Task',
              Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-generate-images-fallback',
              Comment: 'Fallback image generation via Replicate when image-basic-generator fails',
              Parameters: {
                'frame.$': '$',
                'aspectRatio.$': '$$.Execution.Input.aspectRatio',
                'projectId.$': '$$.Execution.Input.projectId',
                'jobId.$': '$$.Execution.Input.jobId',
                'projectType.$': '$$.Execution.Input.projectType',
                'jwtToken.$': '$$.Execution.Input.jwtToken',
              },
              ResultPath: '$.fallbackImageResult',
              TimeoutSeconds: 600,
              Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 10, MaxAttempts: 2, BackoffRate: 2.0 }],
              Next: 'ReleaseImageSlotFallback',
            },
            ReleaseImageSlotFallback: releaseImageSlotFallback,
            BuildImagePayload: {
              Type: 'Pass',
              Comment: 'Map image-basic-generator response to downstream I2VBasic format. Includes voiceUrl for audio embedding.',
              Parameters: {
                'frameId.$': '$.frameId',
                'frameNumber.$': '$.frameNumber',
                'imageUrl.$': '$.imageResult.cdnUrl',
                'aspectRatio.$': '$$.Execution.Input.aspectRatio',
                dimensions: { 'width.$': '$.imageResult.width', 'height.$': '$.imageResult.height' },
                'duration.$': '$.duration',
                'voiceUrl.$': '$.voiceUrl',
              },
              End: true,
            },
            BuildImagePayloadFallback: {
              Type: 'Pass',
              Comment: 'Map E2E-generate-images-fallback response (old format) to downstream I2VBasic format. Includes voiceUrl for audio embedding.',
              Parameters: {
                'frameId.$': '$.frameId',
                'frameNumber.$': '$.frameNumber',
                'imageUrl.$': '$.fallbackImageResult.imageUrl',
                'aspectRatio.$': '$.fallbackImageResult.aspectRatio',
                'dimensions.$': '$.fallbackImageResult.dimensions',
                'duration.$': '$.duration',
                'voiceUrl.$': '$.voiceUrl',
              },
              End: true,
            },
          },
        },
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
        Next: 'DropFrameData',
      },

      // ── Remainder of pipeline (unchanged) ─────────────────────────────────
      DropFrameData: {
        Type: 'Pass',
        Comment: 'Drop $.frames to stay within 256KB SF state limit. voiceUrl is now in each imageResult item.',
        Parameters: {
          'jobId.$': '$.jobId',
          'projectId.$': '$.projectId',
          'projectType.$': '$.projectType',
          'aspectRatio.$': '$.aspectRatio',
          'bgmUrl.$': '$.bgmUrl',
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
          'apiKey.$': '$.apiKey',
          'imageResults.$': '$.imageResults',
        },
        Next: 'UpdateStatusGeneratingVideos',
      },
      UpdateStatusGeneratingVideos: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Update Convex job status (best-effort)',
        Parameters: {
          'jobId.$': '$.jobId',
          status: 'generating-videos',
          message: 'Generating videos...',
          progress: { step: 3, totalSteps: 8, percent: 40 },
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
          assets: { 'frames.$': '$.imageResults' },
        },
        ResultPath: null,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'GenerateI2VBasic' }],
        Next: 'GenerateI2VBasic',
        TimeoutSeconds: 30,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      },
      GenerateI2VBasic: {
        Type: 'Map',
        Comment: 'Generate I2V videos using Ken Burns effect (outputs 1080p). Local render — no Quartermaster slot needed.',
        ItemsPath: '$.imageResults',
        MaxConcurrency: 3,
        ResultPath: '$.videoResults',
        Iterator: {
          StartAt: 'I2VBasic',
          States: {
            I2VBasic: {
              Type: 'Task',
              Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-generate-i2v-basic',
              Comment: 'Ken Burns animation with per-frame audio embedded (voiceUrl → audioUrl)',
              Parameters: {
                'frameId.$': '$.frameId',
                'frameNumber.$': '$.frameNumber',
                'duration.$': '$.duration',
                'imageUrl.$': '$.imageUrl',
                'aspectRatio.$': '$.aspectRatio',
                'dimensions.$': '$.dimensions',
                'projectId.$': '$$.Execution.Input.projectId',
                'jwtToken.$': '$$.Execution.Input.jwtToken',
                'audioUrl.$': '$.voiceUrl',
              },
              TimeoutSeconds: 300,
              Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 10, MaxAttempts: 2, BackoffRate: 2.0 }],
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'I2VGenerationFailed' }],
              End: true,
            },
            I2VGenerationFailed: {
              Type: 'Pass',
              Comment: 'Resilient error capture replacing hard Fail state. Allows Map to complete with partial results.',
              Parameters: {
                failed: true,
                error: 'I2VGenerationError',
                'frameId.$': '$.frameId',
                'frameNumber.$': '$.frameNumber',
              },
              End: true,
            },
          },
        },
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
        Next: 'UpdateStatusConcatenating',
      },
      UpdateStatusConcatenating: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Update Convex job status (best-effort)',
        Parameters: {
          'jobId.$': '$.jobId',
          status: 'concatenating',
          message: 'Concatenating video...',
          progress: { step: 5, totalSteps: 8, percent: 70 },
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
          assets: { 'frames.$': '$.videoResults' },
        },
        ResultPath: null,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'ConcatenateVideos' }],
        Next: 'ConcatenateVideos',
        TimeoutSeconds: 30,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      },
      ConcatenateVideos: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-video-concat-premium',
        Comment: 'Concatenate all 1080p frame videos into single video',
        Parameters: {
          'videos.$': '$.videoResults',
          'aspectRatio.$': '$.aspectRatio',
          'projectId.$': '$.projectId',
          'outputKey.$': "States.Format('projects/{}/videos/concatenated.mp4', $.projectId)",
          'jwtToken.$': '$.jwtToken',
          'apiKey.$': '$.apiKey',
        },
        ResultPath: '$.concatenatedVideo',
        TimeoutSeconds: 900,
        Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 10, MaxAttempts: 2, BackoffRate: 1.5 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
        Next: 'TranscribeAudio',
      },
      TranscribeAudio: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-voice-srt-basic',
        Comment: 'Run OpenAI Whisper on extracted concat audio (CDN WAV) to produce drift-free SRT captions.',
        Parameters: {
          'voiceAudioUrl.$': '$.concatenatedVideo.audioUrl',
          'projectId.$': '$.projectId',
          'jobId.$': '$.jobId',
          frames: [],
          fullScript: '',
          ttsProvider: 'kokoro',
          voiceId: 'skip',
          voiceSpeed: 1.0,
          'jwtToken.$': '$.jwtToken',
        },
        ResultPath: '$.transcribeResult',
        TimeoutSeconds: 600,
        Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 15, MaxAttempts: 2, BackoffRate: 2.0 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
        Next: 'BuildMergedVoiceResult',
      },
      BuildMergedVoiceResult: {
        Type: 'Pass',
        Comment: 'Map concat video (CDN URL) + Whisper SRT into the mergedVoiceResult shape expected by downstream states.',
        Parameters: {
          'mergedVideoUrl.$': '$.concatenatedVideo.videoUrl',
          'audioUrl.$': '$.concatenatedVideo.audioUrl',
          'srtUrl.$': '$.transcribeResult.srtUrl',
          'captionsUrl.$': '$.transcribeResult.srtUrl',
        },
        ResultPath: '$.mergedVoiceResult',
        Next: 'UpdateStatusApplyingBgm',
      },
      UpdateStatusApplyingBgm: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Update Convex job status (best-effort)',
        Parameters: {
          'jobId.$': '$.jobId',
          status: 'applying-bgm',
          message: 'Finalizing (captions + BGM)...',
          progress: { step: 6, totalSteps: 8, percent: 85 },
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
          assets: { 'mergedVideoUrl.$': '$.mergedVoiceResult.mergedVideoUrl' },
        },
        ResultPath: null,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'FinalizeVideoBasic' }],
        Next: 'ValidateFinalizeInputsBasic',
        TimeoutSeconds: 30,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      },
      ValidateFinalizeInputsBasic: {
        Type: 'Choice',
        Comment: 'Verify required fields exist before finalize; fail fast on missing data',
        Choices: [{ Variable: '$.mergedVoiceResult.mergedVideoUrl', IsPresent: true, Next: 'PrepareFinalizeBasic' }],
        Default: 'FinalizeInputsMissingBasic',
      },
      FinalizeInputsMissingBasic: {
        Type: 'Fail',
        Error: 'FinalizeInputsMissing',
        Cause: 'Required finalize input(s) missing: $.mergedVoiceResult.mergedVideoUrl',
      },
      PrepareFinalizeBasic: {
        Type: 'Pass',
        Comment: 'Prepare a small payload for the Fargate finalize task',
        Parameters: {
          mode: 'basic',
          'jobId.$': '$.jobId',
          'projectId.$': '$.projectId',
          'projectType.$': '$.projectType',
          'aspectRatio.$': '$.aspectRatio',
          'videoUrl.$': '$.mergedVoiceResult.mergedVideoUrl',
          'voiceAudioUrl.$': '$.mergedVoiceResult.audioUrl',
          'captionsUrl.$': '$.mergedVoiceResult.captionsUrl',
          'bgmUrl.$': '$.bgmUrl',
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
        },
        ResultPath: '$.finalizeTaskInput',
        Next: 'FinalizeVideoBasic',
      },
      FinalizeVideoBasic: {
        Type: 'Task',
        Resource: 'arn:aws:states:::ecs:runTask.sync',
        Comment: 'Finalize on Fargate (no Lambda timeout ceiling): audio merge + captions + BGM',
        Parameters: {
          Cluster: 'arn:aws:ecs:us-east-1:929075264324:cluster/storystudio-e2e',
          LaunchType: 'FARGATE',
          TaskDefinition: 'e2e-finalize',
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              Subnets: ['subnet-02557f42e07118380', 'subnet-0389bf7ebb5a497ac'],
              SecurityGroups: ['sg-0c2549fa2cb194dc6'],
              AssignPublicIp: 'ENABLED',
            },
          },
          Overrides: {
            ContainerOverrides: [{
              Name: 'finalize',
              Environment: [{ Name: 'PAYLOAD_JSON', 'Value.$': 'States.JsonToString($.finalizeTaskInput)' }],
            }],
          },
        },
        ResultPath: '$.finalizeEcs',
        TimeoutSeconds: 3600,
        Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 1, BackoffRate: 2 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
        Next: 'Complete',
      },
      Complete: {
        Type: 'Pass',
        Comment: 'Pipeline completed successfully',
        Parameters: {
          status: 'SUCCESS',
          'projectId.$': '$.projectId',
          message: 'E2E Basic-QM pipeline completed successfully (finalize ran on Fargate)',
        },
        End: true,
      },
      HandleFailure: {
        Type: 'Pass',
        Comment: 'Handle pipeline failure and prepare error response',
        Parameters: {
          status: 'FAILED',
          'projectId.$': '$$.Execution.Input.projectId',
          'jobId.$': '$$.Execution.Input.jobId',
          'jwtToken.$': '$$.Execution.Input.jwtToken',
          'convexEndpoint.$': '$$.Execution.Input.convexEndpoint',
          'error.$': '$.error',
          message: 'E2E Basic-QM pipeline failed',
        },
        Next: 'UpdateStatusFailed',
      },
      UpdateStatusFailed: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Update Convex job status (best-effort)',
        Parameters: {
          'jobId.$': '$.jobId',
          status: 'failed',
          message: 'E2E Basic-QM pipeline failed',
          'error.$': '$.error',
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
        },
        ResultPath: null,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'FailState' }],
        Next: 'FailState',
        TimeoutSeconds: 30,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      },
      FailState: {
        Type: 'Fail',
        Error: 'PipelineExecutionFailed',
        Cause: 'E2E Basic-QM pipeline execution failed',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Premium SFN definition
// ---------------------------------------------------------------------------
// Wraps GenerateImage (rest lane) and GenerateI2V (video lane) in the per-frame
// iterator with acquire/release calls to Quartermaster. All other states are
// identical to E2E-VideoGenerationPipeline-Premium.
// ---------------------------------------------------------------------------
function buildPremiumDefinition(brokerArn: string): object {
  // ── Image slot helpers (rest lane) ────────────────────────────────────────
  const acquireImageSlot = {
    Type: 'Task',
    Resource: brokerArn,
    Comment: 'Acquire a rest-lane slot from Quartermaster before image-basic-generator',
    Parameters: {
      action: 'acquire',
      lane: 'rest',
      'tenant.$': "States.Format('sfn:{}:image', $$.Execution.Input.projectId)",
      priority: 'P1',
      estDurationMs: 180000,
    },
    ResultPath: '$.qmImageAcquire',
    TimeoutSeconds: 120,
    Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 3, MaxAttempts: 2, BackoffRate: 1.5 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.acquireImageError', Next: 'AcquireImageSlotFailed' }],
    Next: 'GenerateImage',
  };

  const acquireImageSlotFailed = {
    Type: 'Pass',
    Comment: 'Acquire slot timed out — fail this frame gracefully',
    Parameters: {
      failed: true,
      error: 'AcquireImageSlotFailed',
      'frameId.$': '$.frameId',
      'frameNumber.$': '$.frameNumber',
    },
    End: true,
  };

  const releaseImageSlot = {
    Type: 'Task',
    Resource: brokerArn,
    Comment: 'Release rest-lane slot after successful image generation',
    Parameters: {
      action: 'release',
      lane: 'rest',
      'leaseId.$': '$.qmImageAcquire.leaseId',
      outcome: 'success',
    },
    ResultPath: null,
    TimeoutSeconds: 15,
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'BuildFramePayload' }],
    Next: 'BuildFramePayload',
  };

  const releaseImageSlotOnError = {
    Type: 'Task',
    Resource: brokerArn,
    Comment: 'Release rest-lane slot on image generation failure before fallback',
    Parameters: {
      action: 'release',
      lane: 'rest',
      'leaseId.$': '$.qmImageAcquire.leaseId',
      outcome: 'fail',
    },
    ResultPath: null,
    TimeoutSeconds: 15,
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'GenerateImageFallback' }],
    Next: 'GenerateImageFallback',
  };

  // ── Video slot helpers (video lane) ───────────────────────────────────────
  const acquireVideoSlot = {
    Type: 'Task',
    Resource: brokerArn,
    Comment: 'Acquire a video-lane slot from Quartermaster before video-i2v-generator',
    Parameters: {
      action: 'acquire',
      lane: 'video',
      'tenant.$': "States.Format('sfn:{}:video', $$.Execution.Input.projectId)",
      priority: 'P1',
      estDurationMs: 600000,
    },
    ResultPath: '$.qmVideoAcquire',
    TimeoutSeconds: 120,
    Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 3, MaxAttempts: 2, BackoffRate: 1.5 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.acquireVideoError', Next: 'AcquireVideoSlotFailed' }],
    Next: 'GenerateI2V',
  };

  const acquireVideoSlotFailed = {
    Type: 'Pass',
    Comment: 'Acquire video slot timed out — fail this frame gracefully',
    Parameters: {
      failed: true,
      error: 'AcquireVideoSlotFailed',
      'frameId.$': '$.frameId',
      'frameNumber.$': '$.frameNumber',
    },
    End: true,
  };

  const releaseVideoSlot = {
    Type: 'Task',
    Resource: brokerArn,
    Comment: 'Release video-lane slot after successful I2V generation',
    Parameters: {
      action: 'release',
      lane: 'video',
      'leaseId.$': '$.qmVideoAcquire.leaseId',
      outcome: 'success',
    },
    ResultPath: null,
    TimeoutSeconds: 15,
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'MergeFrameAudio' }],
    Next: 'MergeFrameAudio',
  };

  const releaseVideoSlotOnError = {
    Type: 'Task',
    Resource: brokerArn,
    Comment: 'Release video-lane slot on I2V failure before frame fail state',
    Parameters: {
      action: 'release',
      lane: 'video',
      'leaseId.$': '$.qmVideoAcquire.leaseId',
      outcome: 'fail',
    },
    ResultPath: null,
    TimeoutSeconds: 15,
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'FrameI2VFailed' }],
    Next: 'FrameI2VFailed',
  };

  return {
    Comment: 'E2E Video Generation Pipeline - Premium-QM (Wan 2.2 I2V, ~480p + upscale, Quartermaster semaphore for image+video lanes)',
    StartAt: 'ValidateInput',
    States: {
      ValidateInput: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-validate-input',
        Comment: 'Validate input parameters and prepare pipeline execution',
        ResultPath: '$.validationResult',
        Retry: [{ ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 2, MaxAttempts: 2, BackoffRate: 1.5 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
        Next: 'CheckValidation',
      },
      CheckValidation: {
        Type: 'Choice',
        Choices: [{ Variable: '$.validationResult.valid', BooleanEquals: true, Next: 'StoreFramesInS3' }],
        Default: 'FailValidation',
      },
      StoreFramesInS3: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-store-frames',
        Comment: 'Store full frame details to S3 and return minimal references to reduce payload size and avoid 256KB Step Functions limit',
        TimeoutSeconds: 60,
        Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 2, MaxAttempts: 2, BackoffRate: 2.0 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.storeFramesError', Next: 'FailValidation' }],
        Next: 'ParallelHookAndImages',
      },
      FailValidation: {
        Type: 'Pass',
        Parameters: {
          status: 'FAILED',
          'projectId.$': '$$.Execution.Input.projectId',
          'jobId.$': '$$.Execution.Input.jobId',
          'jwtToken.$': '$$.Execution.Input.jwtToken',
          'convexEndpoint.$': '$$.Execution.Input.convexEndpoint',
          error: { Error: 'InvalidInput', Cause: 'E2E-validate-input returned invalid' },
          message: 'E2E Premium-QM pipeline failed validation',
        },
        Next: 'UpdateStatusFailed',
      },

      // ── ParallelHookAndImages ────────────────────────────────────────────
      ParallelHookAndImages: {
        Type: 'Parallel',
        Comment: 'Run hook generation and per-frame generation (TTS+Image+I2V) in parallel',
        Branches: [
          // Branch 1: Hook generation — unchanged (uses Replicate, not ModelsLab)
          {
            StartAt: 'GenerateHook',
            States: {
              GenerateHook: {
                Type: 'Task',
                Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-generate-hook',
                Comment: 'Hook generation with Replicate S2V (fast, ~2-3 min). Returns error with audio/image if failed.',
                Parameters: {
                  'hookConfig.$': '$.hookConfig',
                  'aspectRatio.$': '$.aspectRatio',
                  'projectId.$': '$.projectId',
                  'jwtToken.$': '$.jwtToken',
                },
                TimeoutSeconds: 420,
                Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 5, MaxAttempts: 1, BackoffRate: 1.5 }],
                Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.hookPrimaryError', Next: 'CheckHookFallbackNeeded' }],
                ResultPath: '$.hookResult',
                Next: 'CheckHookSuccess',
              },
              CheckHookSuccess: {
                Type: 'Choice',
                Comment: 'Check if primary hook generation succeeded or needs fallback',
                Choices: [
                  { And: [{ Variable: '$.hookResult.requiresFallback', IsPresent: true }, { Variable: '$.hookResult.requiresFallback', BooleanEquals: true }], Next: 'GenerateHookFallback' },
                  { And: [{ Variable: '$.hookResult.hookSkipped', IsPresent: true }, { Variable: '$.hookResult.hookSkipped', BooleanEquals: true }], Next: 'HookComplete' },
                ],
                Default: 'HookComplete',
              },
              CheckHookFallbackNeeded: {
                Type: 'Pass',
                Comment: 'Hook generation failed, skipping',
                Next: 'HookGenerationSkipped',
              },
              GenerateHookFallback: {
                Type: 'Task',
                Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-generate-hook-fallback',
                Comment: 'Fallback hook generation with KIE API (slower, ~10-12 min). Uses image/audio from primary.',
                Parameters: {
                  'imageUrl.$': '$.hookResult.imageUrl',
                  'audioUrl.$': '$.hookResult.audioUrl',
                  'prompt.$': '$.hookResult.prompt',
                  'aspectRatio.$': '$.hookResult.aspectRatio',
                  'projectId.$': '$.hookResult.projectId',
                },
                TimeoutSeconds: 900,
                Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 10, MaxAttempts: 1, BackoffRate: 1.5 }],
                Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.hookFallbackError', Next: 'HookGenerationSkipped' }],
                ResultPath: '$.hookResult',
                Next: 'HookComplete',
              },
              HookComplete: {
                Type: 'Pass',
                Comment: 'Hook generation completed successfully - return only hookResult to avoid 256KB limit',
                OutputPath: '$.hookResult',
                End: true,
              },
              HookGenerationSkipped: {
                Type: 'Pass',
                Comment: 'Continue pipeline without hook if both primary and fallback fail - return only hookResult',
                Result: { statusCode: 200, hookSkipped: true, videoUrl: null },
                End: true,
              },
            },
          },
          // Branch 2: Per-frame generation (TTS + Image + I2V) with QM semaphore
          {
            StartAt: 'UpdateStatusGeneratingFrames',
            States: {
              UpdateStatusGeneratingFrames: {
                Type: 'Task',
                Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
                Comment: 'Update Convex job status (best-effort)',
                Parameters: {
                  'jobId.$': '$$.Execution.Input.jobId',
                  status: 'generating-frames',
                  message: 'Generating TTS, images, and videos in parallel per frame...',
                  progress: { step: 2, totalSteps: 7, percent: 20 },
                  'jwtToken.$': '$$.Execution.Input.jwtToken',
                  'convexEndpoint.$': '$$.Execution.Input.convexEndpoint',
                },
                ResultPath: null,
                Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'GenerateAllFrames' }],
                Next: 'GenerateAllFrames',
                TimeoutSeconds: 30,
                Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
              },
              GenerateAllFrames: {
                Type: 'Map',
                Comment: 'Per-frame: TTS → AcquireImageSlot → Image → ReleaseImageSlot → AcquireVideoSlot → I2V → ReleaseVideoSlot → AudioMerge. MaxConcurrency=5 prevents Lambda/API burst throttle at startup.',
                ItemsPath: '$$.Execution.Input.frames',
                MaxConcurrency: 5,
                Iterator: {
                  StartAt: 'CheckPreGeneratedAudio',
                  States: {
                    CheckPreGeneratedAudio: {
                      Type: 'Choice',
                      Comment: 'Skip TTS entirely if frame already has a CDN audio URL (pre-generated voice)',
                      Choices: [{ Variable: '$.voiceUrl', StringGreaterThan: '', Next: 'UsePreGeneratedTTS' }],
                      Default: 'GenerateFrameTTS',
                    },
                    UsePreGeneratedTTS: {
                      Type: 'Pass',
                      Comment: 'Frame has pre-generated audio — use voiceUrl directly, skip TTS',
                      Parameters: {
                        ok: true,
                        'cdnUrl.$': '$.voiceUrl',
                        'audioDuration.$': '$.duration',
                        'voiceName.$': '$.voiceName',
                      },
                      ResultPath: '$.ttsResult',
                      Next: 'CheckImageCache',
                    },
                    GenerateFrameTTS: {
                      Type: 'Task',
                      Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-google-tts',
                      Comment: 'Generate narration audio for this frame via Google Gemini TTS',
                      Parameters: {
                        'text.$': '$.narrationText',
                        'voiceName.$': '$.voiceName',
                        'model.$': '$.ttsModel',
                        'projectId.$': '$$.Execution.Input.projectId',
                        'userId.$': '$$.Execution.Input.userId',
                      },
                      TimeoutSeconds: 60,
                      ResultPath: '$.ttsResult',
                      Retry: [{ ErrorEquals: ['Lambda.TooManyRequestsException'], IntervalSeconds: 15, MaxAttempts: 4, BackoffRate: 2.0, JitterStrategy: 'FULL' }],
                      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'GenerateFrameTTSFallback' }],
                      Next: 'CheckImageCache',
                    },
                    GenerateFrameTTSFallback: {
                      Type: 'Pass',
                      Comment: 'TTS failed — use pre-generated voiceUrl from Convex if available; fall back to silence if both are empty',
                      Parameters: {
                        ok: false,
                        'cdnUrl.$': '$.voiceUrl',
                        'audioDuration.$': '$.duration',
                        'voiceName.$': '$.voiceName',
                      },
                      ResultPath: '$.ttsResult',
                      Next: 'CheckImageCache',
                    },
                    CheckImageCache: {
                      Type: 'Task',
                      Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-asset-cache-check',
                      Comment: 'Check S3 metadata cache before calling image-basic-generator',
                      Parameters: {
                        'projectId.$': '$$.Execution.Input.projectId',
                        'frameId.$': '$.frameId',
                        assetType: 'image',
                      },
                      ResultPath: '$.imageCacheResult',
                      TimeoutSeconds: 10,
                      Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 2, MaxAttempts: 1, BackoffRate: 1.5 }],
                      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageCacheError', Next: 'AcquireImageSlot' }],
                      Next: 'CheckImageCacheResult',
                    },
                    CheckImageCacheResult: {
                      Type: 'Choice',
                      Choices: [{ Variable: '$.imageCacheResult.cached', BooleanEquals: true, Next: 'UseImageCache' }],
                      Default: 'AcquireImageSlot',
                    },
                    UseImageCache: {
                      Type: 'Pass',
                      Comment: 'Image asset cached — skip generation, build frame payload directly',
                      Parameters: {
                        'cdnUrl.$': '$.imageCacheResult.cdnUrl',
                        's3Key.$': '$.imageCacheResult.s3Key',
                        'width.$': '$.imageCacheResult.width',
                        'height.$': '$.imageCacheResult.height',
                      },
                      ResultPath: '$.imageResult',
                      Next: 'BuildFramePayload',
                    },
                    AcquireImageSlot: acquireImageSlot,
                    AcquireImageSlotFailed: acquireImageSlotFailed,
                    GenerateImage: {
                      Type: 'Task',
                      Resource: 'arn:aws:lambda:us-east-1:929075264324:function:image-basic-generator',
                      Comment: 'Generate frame image via ModelsLab Flux Klein. Slot held by Quartermaster rest lane.',
                      Parameters: {
                        'prompt.$': '$.imagePrompt',
                        'aspectRatio.$': '$$.Execution.Input.aspectRatio',
                        'projectId.$': '$$.Execution.Input.projectId',
                        'frameId.$': '$.frameId',
                        'userId.$': '$$.Execution.Input.userId',
                        'referenceImageUrls.$': '$.referenceImageUrls',
                        strength: 0.75,
                        'genre.$': '$$.Execution.Input.genre',
                      },
                      ResultPath: '$.imageResult',
                      TimeoutSeconds: 300,
                      Retry: [
                        { ErrorEquals: ['Lambda.TooManyRequestsException'], IntervalSeconds: 20, MaxAttempts: 5, BackoffRate: 2.0, JitterStrategy: 'FULL' },
                        { ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 },
                      ],
                      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'ReleaseImageSlotOnError' }],
                      Next: 'StoreImageMeta',
                    },
                    StoreImageMeta: {
                      Type: 'Task',
                      Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-store-asset-meta',
                      Comment: 'Persist image metadata to S3 for cache reuse on retries',
                      Parameters: {
                        'projectId.$': '$$.Execution.Input.projectId',
                        'frameId.$': '$.frameId',
                        assetType: 'image',
                        'cdnUrl.$': '$.imageResult.cdnUrl',
                        's3Key.$': '$.imageResult.s3Key',
                        'width.$': '$.imageResult.width',
                        'height.$': '$.imageResult.height',
                      },
                      ResultPath: null,
                      TimeoutSeconds: 10,
                      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageMetaError', Next: 'ReleaseImageSlot' }],
                      Next: 'ReleaseImageSlot',
                    },
                    ReleaseImageSlot: releaseImageSlot,
                    ReleaseImageSlotOnError: releaseImageSlotOnError,
                    GenerateImageFallback: {
                      Type: 'Task',
                      Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-generate-images-fallback',
                      Comment: 'Image generation fallback via Replicate when image-basic-generator fails',
                      Parameters: {
                        'frame.$': '$',
                        'aspectRatio.$': '$$.Execution.Input.aspectRatio',
                        'projectId.$': '$$.Execution.Input.projectId',
                        'jobId.$': '$$.Execution.Input.jobId',
                        'jwtToken.$': '$$.Execution.Input.jwtToken',
                      },
                      ResultPath: '$.fallbackImageResult',
                      TimeoutSeconds: 600,
                      Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 5, BackoffRate: 2.0, JitterStrategy: 'FULL' }],
                      Next: 'BuildFramePayloadFallback',
                    },
                    BuildFramePayload: {
                      Type: 'Pass',
                      Comment: 'Merge TTS + image results. imageUrl for I2V. Keeps payload small for 256KB SF limit.',
                      Parameters: {
                        'frameId.$': '$.frameId',
                        'frameNumber.$': '$.frameNumber',
                        'imageUrl.$': '$.imageResult.cdnUrl',
                        's3Key.$': '$.imageResult.s3Key',
                        'audioUrl.$': '$.ttsResult.cdnUrl',
                        'audioDuration.$': '$.ttsResult.audioDuration',
                        'imagePrompt.$': '$.imagePrompt',
                        'narrationText.$': '$.narrationText',
                      },
                      Next: 'CheckVideoCache',
                    },
                    BuildFramePayloadFallback: {
                      Type: 'Pass',
                      Comment: 'Merge TTS + fallback image results. Fallback Lambda returns imageUrl but no s3Key.',
                      Parameters: {
                        'frameId.$': '$.frameId',
                        'frameNumber.$': '$.frameNumber',
                        'imageUrl.$': '$.fallbackImageResult.imageUrl',
                        s3Key: '',
                        'audioUrl.$': '$.ttsResult.cdnUrl',
                        'audioDuration.$': '$.ttsResult.audioDuration',
                        'imagePrompt.$': '$.imagePrompt',
                        'narrationText.$': '$.narrationText',
                      },
                      Next: 'CheckVideoCache',
                    },
                    CheckVideoCache: {
                      Type: 'Task',
                      Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-asset-cache-check',
                      Comment: 'Check S3 metadata cache before calling video-i2v-generator',
                      Parameters: {
                        'projectId.$': '$$.Execution.Input.projectId',
                        'frameId.$': '$.frameId',
                        assetType: 'video',
                      },
                      ResultPath: '$.videoCacheResult',
                      TimeoutSeconds: 10,
                      Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 2, MaxAttempts: 1, BackoffRate: 1.5 }],
                      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoCacheError', Next: 'AcquireVideoSlot' }],
                      Next: 'CheckVideoCacheResult',
                    },
                    CheckVideoCacheResult: {
                      Type: 'Choice',
                      Choices: [{ Variable: '$.videoCacheResult.cached', BooleanEquals: true, Next: 'UseVideoCache' }],
                      Default: 'AcquireVideoSlot',
                    },
                    UseVideoCache: {
                      Type: 'Pass',
                      Comment: 'Video asset cached — normalize to i2vResult format and skip generation',
                      Parameters: {
                        'videoUrl.$': '$.videoCacheResult.cdnUrl',
                        'videoS3Url.$': '$.videoCacheResult.cdnUrl',
                        'videoS3Key.$': '$.videoCacheResult.s3Key',
                      },
                      ResultPath: '$.i2vResult',
                      Next: 'MergeFrameAudio',
                    },
                    AcquireVideoSlot: acquireVideoSlot,
                    AcquireVideoSlotFailed: acquireVideoSlotFailed,
                    GenerateI2V: {
                      Type: 'Task',
                      Resource: 'arn:aws:lambda:us-east-1:929075264324:function:video-i2v-generator',
                      Comment: 'Generate I2V video via ModelsLab Wan 2.2. Slot held by Quartermaster video lane.',
                      Parameters: {
                        'imageUrl.$': '$.imageUrl',
                        'prompt.$': '$.narrationText',
                        negativePrompt: 'blurry, distorted faces, jittery motion, watermark, text overlay, low quality, artifacts',
                        'durationSeconds.$': '$.audioDuration',
                        fps: 16,
                        'projectId.$': '$$.Execution.Input.projectId',
                        'frameId.$': '$.frameId',
                        'userId.$': '$$.Execution.Input.userId',
                      },
                      TimeoutSeconds: 900,
                      ResultPath: '$.rawI2VResult',
                      Retry: [
                        { ErrorEquals: ['Lambda.TooManyRequestsException', 'Lambda.AWSLambdaException'], IntervalSeconds: 30, MaxAttempts: 5, BackoffRate: 2.0, JitterStrategy: 'FULL' },
                        { ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 15, MaxAttempts: 2, BackoffRate: 2.0 },
                      ],
                      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.i2vError', Next: 'ReleaseVideoSlotOnError' }],
                      Next: 'NormalizeI2VResult',
                    },
                    NormalizeI2VResult: {
                      Type: 'Pass',
                      Comment: 'Map video-i2v-generator response (cdnUrl/s3Key) to i2vResult shape',
                      Parameters: {
                        'videoUrl.$': '$.rawI2VResult.cdnUrl',
                        'videoS3Url.$': '$.rawI2VResult.cdnUrl',
                        'videoS3Key.$': '$.rawI2VResult.s3Key',
                      },
                      ResultPath: '$.i2vResult',
                      Next: 'StoreVideoMeta',
                    },
                    StoreVideoMeta: {
                      Type: 'Task',
                      Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-store-asset-meta',
                      Comment: 'Persist video metadata to S3 for cache reuse on retries',
                      Parameters: {
                        'projectId.$': '$$.Execution.Input.projectId',
                        'frameId.$': '$.frameId',
                        assetType: 'video',
                        'cdnUrl.$': '$.i2vResult.videoUrl',
                        's3Key.$': '$.i2vResult.videoS3Key',
                      },
                      ResultPath: null,
                      TimeoutSeconds: 10,
                      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoMetaError', Next: 'ReleaseVideoSlot' }],
                      Next: 'ReleaseVideoSlot',
                    },
                    ReleaseVideoSlot: releaseVideoSlot,
                    ReleaseVideoSlotOnError: releaseVideoSlotOnError,
                    FrameI2VFailed: {
                      Type: 'Pass',
                      Comment: 'Resilient error capture — allows Map to complete with partial results',
                      Parameters: {
                        failed: true,
                        error: 'I2VGenerationFailed',
                        'frameId.$': '$.frameId',
                        'frameNumber.$': '$.frameNumber',
                      },
                      End: true,
                    },
                    MergeFrameAudio: {
                      Type: 'Task',
                      Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-audio-merge',
                      Comment: 'Merge TTS audio onto the I2V video',
                      Parameters: {
                        frame: {
                          'frameId.$': '$.frameId',
                          'frameNumber.$': '$.frameNumber',
                          'videoUrl.$': '$.i2vResult.videoUrl',
                          'videoS3Url.$': '$.i2vResult.videoS3Url',
                          'videoS3Key.$': '$.i2vResult.videoS3Key',
                          'audioUrl.$': '$.audioUrl',
                        },
                        'projectId.$': '$$.Execution.Input.projectId',
                        'aspectRatio.$': '$$.Execution.Input.aspectRatio',
                        'jwtToken.$': '$$.Execution.Input.jwtToken',
                      },
                      TimeoutSeconds: 300,
                      ResultPath: '$.audioMergeResult',
                      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.audioMergeError', Next: 'BuildFinalFrameResultSilent' }],
                      Next: 'BuildFinalFrameResult',
                    },
                    BuildFinalFrameResult: {
                      Type: 'Pass',
                      Comment: 'Slim final per-frame result — only what concatenation needs.',
                      Parameters: {
                        'frameId.$': '$.audioMergeResult.frameId',
                        'frameNumber.$': '$.audioMergeResult.frameNumber',
                        'videoUrl.$': '$.audioMergeResult.videoUrl',
                        'duration.$': '$.audioMergeResult.duration',
                        'audioUrl.$': '$.audioUrl',
                        'imageUrl.$': '$.imageUrl',
                      },
                      End: true,
                    },
                    BuildFinalFrameResultSilent: {
                      Type: 'Pass',
                      Comment: 'Audio merge failed — fall back to silent I2V video',
                      Parameters: {
                        'frameId.$': '$.frameId',
                        'frameNumber.$': '$.frameNumber',
                        'videoUrl.$': '$.i2vResult.videoUrl',
                        'duration.$': '$.audioDuration',
                        'audioUrl.$': '$.audioUrl',
                        'imageUrl.$': '$.imageUrl',
                      },
                      End: true,
                    },
                  },
                },
                Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.framesError', Next: 'FramesHandleFailure' }],
                End: true,
              },
              FramesHandleFailure: {
                Type: 'Fail',
                Error: 'FrameGenerationFailed',
                Cause: 'Per-frame generation failed',
              },
            },
          },
        ],
        ResultPath: '$.parallelResults',
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
        Next: 'MergeParallelResults',
      },

      // ── Post-parallel states (unchanged from original) ───────────────────
      MergeParallelResults: {
        Type: 'Pass',
        Comment: 'Merge parallel execution results (minimal metadata only)',
        Parameters: {
          'jobId.$': '$.jobId',
          'projectId.$': '$.projectId',
          'projectType.$': '$.projectType',
          'aspectRatio.$': '$.aspectRatio',
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
          'apiKey.$': '$.apiKey',
          voiceUrls: [],
          'bgmUrl.$': '$$.Execution.Input.bgmUrl',
          'generateShorts.$': '$.generateShorts',
          'shortsRenderStyle.$': '$.shortsRenderStyle',
          'hookConfig.$': '$.hookConfig',
          'captionsUrl.$': '$.captionsUrl',
          voiceAudioUrl: '',
          'mode.$': '$.mode',
          'framesStorageKey.$': '$.framesStorageKey',
          'hookResult.$': '$.parallelResults[0]',
          'audioMergedVideos.$': '$.parallelResults[1]',
        },
        Next: 'UpdateStatusRunningQA',
      },
      UpdateStatusRunningQA: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Notify Convex that narration-premium QA review is starting',
        Parameters: {
          'jobId.$': '$.jobId',
          status: 'running-qa-review',
          message: 'Running QA review on generated images and videos...',
          progress: { step: 5, totalSteps: 9, percent: 55 },
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
        },
        ResultPath: null,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'PrepareQAPayload' }],
        Next: 'PrepareQAPayload',
        TimeoutSeconds: 30,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      },
      PrepareQAPayload: {
        Type: 'Pass',
        Comment: 'Assemble QA agent input from pipeline state',
        Parameters: {
          'projectId.$': '$.projectId',
          'jobId.$': '$.jobId',
          framesS3Bucket: 'storystudio-unified-storage-prod',
          'framesS3Key.$': '$.framesStorageKey',
          'audioMergedVideos.$': '$.audioMergedVideos',
          'characterBible.$': '$$.Execution.Input.characterBible',
          'synopsis.$': '$$.Execution.Input.synopsis',
          'aspectRatio.$': '$.aspectRatio',
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
          mode: 'review-and-rework',
          auditPercent: 100,
          reworkAttempt: 1,
          _pipelineContext: {
            'jobId.$': '$.jobId',
            'projectId.$': '$.projectId',
            'aspectRatio.$': '$.aspectRatio',
            'bgmUrl.$': '$.bgmUrl',
            'captionsUrl.$': '$.captionsUrl',
            'voiceUrls.$': '$.voiceUrls',
            'hookResult.$': '$.hookResult',
            'audioMergedVideos.$': '$.audioMergedVideos',
            'generateShorts.$': '$.generateShorts',
            'shortsRenderStyle.$': '$.shortsRenderStyle',
            'hookConfig.$': '$.hookConfig',
            'voiceAudioUrl.$': '$.voiceAudioUrl',
            'mode.$': '$.mode',
            'projectType.$': '$.projectType',
            'apiKey.$': '$.apiKey',
            'convexEndpoint.$': '$.convexEndpoint',
            'jwtToken.$': '$.jwtToken',
          },
        },
        ResultPath: '$.qaInput',
        Next: 'QaAgentNarrationPremium',
      },
      QaAgentNarrationPremium: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:narration-premium-qa-agent',
        Comment: 'Run QA on all generated images and videos.',
        Parameters: {
          'projectId.$': '$.qaInput.projectId',
          'jobId.$': '$.qaInput.jobId',
          'framesS3Bucket.$': '$.qaInput.framesS3Bucket',
          'framesS3Key.$': '$.qaInput.framesS3Key',
          'audioMergedVideos.$': '$.qaInput.audioMergedVideos',
          'characterBible.$': '$.qaInput.characterBible',
          'synopsis.$': '$.qaInput.synopsis',
          'mode.$': '$.qaInput.mode',
          'auditPercent.$': '$.qaInput.auditPercent',
        },
        TimeoutSeconds: 1800,
        ResultPath: '$.qaAgentResult',
        Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 15, MaxAttempts: 1, BackoffRate: 1.5 }],
        Catch: [{ ErrorEquals: ['States.ALL'], Comment: 'QA agent failure is non-fatal — pipeline continues to concat with best available frames', ResultPath: '$.qaError', Next: 'QAResultFallback' }],
        Next: 'CheckQAResult',
      },
      CheckQAResult: {
        Type: 'Choice',
        Comment: 'Route based on QA result: pass → concat, frames need rework → rework agent',
        Choices: [
          { Variable: '$.qaAgentResult.passStatus', StringEquals: 'PASS', Next: 'UpdateStatusQAPassed' },
          { And: [{ Variable: '$.qaAgentResult.framesNeedingRework[0]', IsPresent: true }, { Variable: '$.qaInput.reworkAttempt', NumericLessThan: 3 }], Next: 'PrepareReworkPayload' },
        ],
        Default: 'UpdateStatusQAFailed',
      },
      QAResultFallback: {
        Type: 'Pass',
        Comment: 'QA agent errored — treat as pass to avoid blocking pipeline',
        Parameters: {
          passStatus: 'PASS',
          overallScore: 0,
          totalIssues: 0,
          framesNeedingRework: [],
          reworkTriggered: false,
          reportS3Key: null,
          reportMarkdownS3Key: null,
          triggerVideoConcat: true,
        },
        ResultPath: '$.qaAgentResult',
        Next: 'UpdateStatusQAPassed',
      },
      UpdateStatusQAPassed: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Notify Convex that QA review passed',
        Parameters: {
          'jobId.$': '$$.Execution.Input.jobId',
          status: 'qa-passed',
          message: 'QA review passed — proceeding to concatenation',
          progress: { step: 6, totalSteps: 9, percent: 65 },
          'jwtToken.$': '$$.Execution.Input.jwtToken',
          'convexEndpoint.$': '$$.Execution.Input.convexEndpoint',
          qaResult: { passStatus: 'PASS', 'overallScore.$': '$.qaAgentResult.overallScore', 'totalIssues.$': '$.qaAgentResult.totalIssues', 'reportS3Key.$': '$.qaAgentResult.reportS3Key' },
        },
        ResultPath: null,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'RestorePipelineContextAfterQA' }],
        Next: 'RestorePipelineContextAfterQA',
        TimeoutSeconds: 30,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      },
      RestorePipelineContextAfterQA: {
        Type: 'Pass',
        Comment: 'Restore the full pipeline context for the concatenation step',
        Parameters: {
          'jobId.$': '$.qaInput._pipelineContext.jobId',
          'projectId.$': '$.qaInput._pipelineContext.projectId',
          'projectType.$': '$.qaInput._pipelineContext.projectType',
          'aspectRatio.$': '$.qaInput._pipelineContext.aspectRatio',
          'bgmUrl.$': '$.qaInput._pipelineContext.bgmUrl',
          'captionsUrl.$': '$.qaInput._pipelineContext.captionsUrl',
          'voiceUrls.$': '$.qaInput._pipelineContext.voiceUrls',
          'hookResult.$': '$.qaInput._pipelineContext.hookResult',
          'audioMergedVideos.$': '$.qaInput._pipelineContext.audioMergedVideos',
          'generateShorts.$': '$.qaInput._pipelineContext.generateShorts',
          'shortsRenderStyle.$': '$.qaInput._pipelineContext.shortsRenderStyle',
          'hookConfig.$': '$.qaInput._pipelineContext.hookConfig',
          'voiceAudioUrl.$': '$.qaInput._pipelineContext.voiceAudioUrl',
          'mode.$': '$.qaInput._pipelineContext.mode',
          'apiKey.$': '$.qaInput._pipelineContext.apiKey',
          'convexEndpoint.$': '$.qaInput._pipelineContext.convexEndpoint',
          'jwtToken.$': '$.qaInput._pipelineContext.jwtToken',
        },
        Next: 'UpdateStatusConcatenating',
      },
      PrepareReworkPayload: {
        Type: 'Pass',
        Comment: 'Prepare rework agent input from QA results',
        Parameters: {
          'projectId.$': '$.qaInput.projectId',
          'jobId.$': '$.qaInput.jobId',
          'auditId.$': '$.qaAgentResult.auditId',
          'framesS3Bucket.$': '$.qaInput.framesS3Bucket',
          'framesS3Key.$': '$.qaInput.framesS3Key',
          'framesNeedingRework.$': '$.qaAgentResult.framesNeedingRework',
          'frameResults.$': '$.qaAgentResult.frameResults',
          'characterBible.$': '$.qaInput.characterBible',
          'aspectRatio.$': '$.qaInput.aspectRatio',
          'audioMergedVideos.$': '$.qaInput._pipelineContext.audioMergedVideos',
          'jwtToken.$': '$.qaInput.jwtToken',
          'convexEndpoint.$': '$.qaInput.convexEndpoint',
          'reworkAttempt.$': '$.qaInput.reworkAttempt',
          '_pipelineContext.$': '$.qaInput._pipelineContext',
        },
        ResultPath: '$.reworkInput',
        Next: 'ReworkAgentNarrationPremium',
      },
      ReworkAgentNarrationPremium: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:narration-premium-rework-agent',
        Comment: 'Rewrite failing prompts and regenerate images/videos for frames that failed QA',
        Parameters: {
          'projectId.$': '$.reworkInput.projectId',
          'jobId.$': '$.reworkInput.jobId',
          'auditId.$': '$.reworkInput.auditId',
          'framesS3Bucket.$': '$.reworkInput.framesS3Bucket',
          'framesS3Key.$': '$.reworkInput.framesS3Key',
          'framesNeedingRework.$': '$.reworkInput.framesNeedingRework',
          'frameResults.$': '$.reworkInput.frameResults',
          'characterBible.$': '$.reworkInput.characterBible',
          'aspectRatio.$': '$.reworkInput.aspectRatio',
          'audioMergedVideos.$': '$.reworkInput.audioMergedVideos',
          'jwtToken.$': '$.reworkInput.jwtToken',
          'reworkAttempt.$': '$.reworkInput.reworkAttempt',
        },
        TimeoutSeconds: 2700,
        ResultPath: '$.reworkAgentResult',
        Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 15, MaxAttempts: 1, BackoffRate: 1.5 }],
        Catch: [{ ErrorEquals: ['States.ALL'], Comment: 'Rework agent failure — proceed to concat with original frames', ResultPath: '$.reworkError', Next: 'RestorePipelineContextAfterQA' }],
        Next: 'CheckReworkComplete',
      },
      CheckReworkComplete: {
        Type: 'Choice',
        Comment: 'If rework produced new frames, run re-QA. Otherwise proceed to concat.',
        Choices: [{ Variable: '$.reworkAgentResult.requiresReQA', BooleanEquals: true, Next: 'PrepareReQAPayload' }],
        Default: 'RestorePipelineContextAfterQA',
      },
      PrepareReQAPayload: {
        Type: 'Pass',
        Comment: 'Prepare second-pass QA input using reworked frame S3 key',
        Parameters: {
          'projectId.$': '$.reworkInput.projectId',
          'jobId.$': '$.reworkInput.jobId',
          'framesS3Bucket.$': '$.reworkAgentResult.framesS3Bucket',
          'framesS3Key.$': '$.reworkAgentResult.framesS3Key',
          'audioMergedVideos.$': '$.reworkAgentResult.updatedAudioMergedVideos',
          'characterBible.$': '$.reworkInput.characterBible',
          'synopsis.$': '$$.Execution.Input.synopsis',
          mode: 'review',
          auditPercent: 100,
          reworkAttempt: 2,
          _pipelineContext: {
            'jobId.$': '$.reworkInput._pipelineContext.jobId',
            'projectId.$': '$.reworkInput._pipelineContext.projectId',
            'projectType.$': '$.reworkInput._pipelineContext.projectType',
            'aspectRatio.$': '$.reworkInput._pipelineContext.aspectRatio',
            'bgmUrl.$': '$.reworkInput._pipelineContext.bgmUrl',
            'captionsUrl.$': '$.reworkInput._pipelineContext.captionsUrl',
            'voiceUrls.$': '$.reworkInput._pipelineContext.voiceUrls',
            'hookResult.$': '$.reworkInput._pipelineContext.hookResult',
            'audioMergedVideos.$': '$.reworkAgentResult.updatedAudioMergedVideos',
            'generateShorts.$': '$.reworkInput._pipelineContext.generateShorts',
            'shortsRenderStyle.$': '$.reworkInput._pipelineContext.shortsRenderStyle',
            'hookConfig.$': '$.reworkInput._pipelineContext.hookConfig',
            'voiceAudioUrl.$': '$.reworkInput._pipelineContext.voiceAudioUrl',
            'mode.$': '$.reworkInput._pipelineContext.mode',
            'apiKey.$': '$.reworkInput._pipelineContext.apiKey',
            'convexEndpoint.$': '$.reworkInput._pipelineContext.convexEndpoint',
            'jwtToken.$': '$.reworkInput._pipelineContext.jwtToken',
          },
        },
        ResultPath: '$.qaInput',
        Next: 'ReQaAgentNarrationPremium',
      },
      ReQaAgentNarrationPremium: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:narration-premium-qa-agent',
        Comment: 'Second-pass QA on reworked frames — results are logged but pipeline always proceeds',
        Parameters: {
          'projectId.$': '$.qaInput.projectId',
          'jobId.$': '$.qaInput.jobId',
          'framesS3Bucket.$': '$.qaInput.framesS3Bucket',
          'framesS3Key.$': '$.qaInput.framesS3Key',
          'audioMergedVideos.$': '$.qaInput.audioMergedVideos',
          'characterBible.$': '$.qaInput.characterBible',
          'synopsis.$': '$.qaInput.synopsis',
          'mode.$': '$.qaInput.mode',
          'auditPercent.$': '$.qaInput.auditPercent',
        },
        TimeoutSeconds: 1800,
        ResultPath: '$.qaAgentResult',
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.qaError', Next: 'UpdateStatusQAFailed' }],
        Next: 'UpdateStatusQAFailed',
      },
      UpdateStatusQAFailed: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Notify Convex QA found issues (non-blocking — pipeline continues)',
        Parameters: {
          'jobId.$': '$$.Execution.Input.jobId',
          status: 'qa-issues-found',
          message: 'QA review found issues — best-available frames will be used for final video',
          progress: { step: 6, totalSteps: 9, percent: 65 },
          'jwtToken.$': '$$.Execution.Input.jwtToken',
          'convexEndpoint.$': '$$.Execution.Input.convexEndpoint',
        },
        ResultPath: null,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'RestorePipelineContextAfterQA' }],
        Next: 'RestorePipelineContextAfterQA',
        TimeoutSeconds: 30,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      },
      UpdateStatusConcatenating: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Update Convex job status (best-effort)',
        Parameters: {
          'jobId.$': '$.jobId',
          status: 'concatenating',
          message: 'Concatenating video...',
          progress: { step: 5, totalSteps: 7, percent: 70 },
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
          assets: { 'frames.$': '$.audioMergedVideos' },
        },
        ResultPath: null,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'ConcatenateVideos' }],
        Next: 'ConcatenateVideos',
        TimeoutSeconds: 30,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      },
      ConcatenateVideos: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-video-concat-premium',
        Comment: 'Concatenate all ~480p frame videos (with audio) into single video',
        Parameters: {
          'videos.$': '$.audioMergedVideos',
          'hookVideo.$': '$.hookResult',
          'aspectRatio.$': '$.aspectRatio',
          'projectId.$': '$.projectId',
          'outputKey.$': "States.Format('projects/{}/videos/concatenated.mp4', $.projectId)",
          'jwtToken.$': '$.jwtToken',
          'apiKey.$': '$.apiKey',
        },
        ResultPath: '$.concatenatedVideo',
        TimeoutSeconds: 900,
        Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 10, MaxAttempts: 1, BackoffRate: 1.5 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
        Next: 'CheckConcatenationResult',
      },
      CheckConcatenationResult: {
        Type: 'Choice',
        Comment: 'Ensure concatenation produced a final video URL before continuing',
        Choices: [{ Variable: '$.concatenatedVideo.videoUrl', IsPresent: true, Next: 'CheckSRTCache' }],
        Default: 'SetConcatenationError',
      },
      CheckSRTCache: {
        Type: 'Choice',
        Comment: 'Skip SRT regeneration only when a CDN-backed (cdn-v2.ai-storystudio.com) captionsUrl was pre-generated.',
        Choices: [{ Variable: '$.captionsUrl', StringMatches: 'https://cdn-v2.ai-storystudio.com/*', Next: 'UseCachedSRT' }],
        Default: 'GenerateGlobalCaptions',
      },
      UseCachedSRT: {
        Type: 'Pass',
        Comment: 'SRT already exists in S3 (cdn-v2) — reuse it',
        Parameters: { 'captionsUrl.$': '$.captionsUrl' },
        ResultPath: '$.captionsResult',
        Next: 'UpdateStatusApplyingBgm',
      },
      SetConcatenationError: {
        Type: 'Pass',
        Comment: 'Normalize concat failures to pipeline error flow',
        Parameters: { Error: 'VideoConcatenationError', 'Cause.$': 'States.JsonToString($.concatenatedVideo)' },
        ResultPath: '$.error',
        Next: 'HandleFailure',
      },
      GenerateGlobalCaptions: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-generate-global-srt-kie',
        Comment: 'Transcribe concatenated audio via Replicate Whisper and upload SRT to S3/CDN',
        Parameters: {
          'projectId.$': '$.projectId',
          'jobId.$': '$.jobId',
          'audioUrl.$': '$.concatenatedVideo.audioUrl',
          'sourceVideoUrl.$': '$.concatenatedVideo.videoUrl',
          uppercase: true,
          language: 'auto',
        },
        ResultPath: '$.captionsResult',
        TimeoutSeconds: 720,
        Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 1.5 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.captionsError', Next: 'CaptionsFallback' }],
        Next: 'UpdateStatusApplyingBgm',
      },
      CaptionsFallback: {
        Type: 'Pass',
        Comment: 'Fallback to precomputed captionsUrl from Convex input',
        Parameters: { 'captionsUrl.$': '$.captionsUrl' },
        ResultPath: '$.captionsResult',
        Next: 'UpdateStatusApplyingBgm',
      },
      UpdateStatusApplyingBgm: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Update Convex job status (best-effort)',
        Parameters: {
          'jobId.$': '$.jobId',
          status: 'applying-bgm',
          message: 'Finalizing (captions + BGM)...',
          progress: { step: 6, totalSteps: 7, percent: 85 },
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
          assets: {
            'concatenatedVideoUrl.$': '$.concatenatedVideo.videoUrl',
            'concatenatedVideoR2Key.$': '$.concatenatedVideo.videoKey',
            'captionsUrl.$': '$.captionsResult.captionsUrl',
          },
        },
        ResultPath: null,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'FinalizeVideoPremium' }],
        Next: 'ValidateFinalizeInputsPremium',
        TimeoutSeconds: 30,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      },
      ValidateFinalizeInputsPremium: {
        Type: 'Choice',
        Comment: 'Verify required fields exist before finalize; fail fast on missing data',
        Choices: [{
          And: [
            { Variable: '$.concatenatedVideo.videoUrl', IsPresent: true },
            { Variable: '$.captionsResult.captionsUrl', IsPresent: true },
          ],
          Next: 'PrepareFinalizePremium',
        }],
        Default: 'FinalizeInputsMissingPremium',
      },
      FinalizeInputsMissingPremium: {
        Type: 'Fail',
        Error: 'FinalizeInputsMissing',
        Cause: 'Required finalize input(s) missing: $.concatenatedVideo.videoUrl + $.captionsResult.captionsUrl',
      },
      PrepareFinalizePremium: {
        Type: 'Pass',
        Comment: 'Prepare a small payload for the Fargate finalize task',
        Parameters: {
          mode: 'premium',
          'jobId.$': '$.jobId',
          'projectId.$': '$.projectId',
          'projectType.$': '$.projectType',
          'aspectRatio.$': '$.aspectRatio',
          'videoUrl.$': '$.concatenatedVideo.videoUrl',
          'videoR2Key.$': '$.concatenatedVideo.videoKey',
          'captionsUrl.$': '$.captionsResult.captionsUrl',
          'bgmUrl.$': '$.bgmUrl',
          targetResolution: '1080p',
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
        },
        ResultPath: '$.finalizeTaskInput',
        Next: 'CheckGenerateShorts',
      },
      CheckGenerateShorts: {
        Type: 'Choice',
        Comment: 'Only trigger the shorts pipeline when the caller explicitly set generateShorts=true.',
        Choices: [{
          And: [
            { Variable: '$.generateShorts', IsPresent: true },
            { Variable: '$.generateShorts', BooleanEquals: true },
          ],
          Next: 'TriggerShortsFromLongForm',
        }],
        Default: 'FinalizeVideoPremium',
      },
      TriggerShortsFromLongForm: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-start-shorts',
        Comment: 'Fire-and-forget: start shorts pipeline on raw concat video. Failure is non-fatal.',
        Parameters: {
          'projectId.$': '$.projectId',
          'projectType.$': '$.projectType',
          'concatVideoUrl.$': '$.concatenatedVideo.videoUrl',
          'globalSubtitleUrl.$': '$.captionsResult.captionsUrl',
          'bgmUrl.$': '$.bgmUrl',
          'frames.$': '$.audioMergedVideos',
          'sourceAspectRatio.$': '$.aspectRatio',
          'convexEndpoint.$': '$.convexEndpoint',
        },
        ResultPath: '$.shortsExecution',
        TimeoutSeconds: 60,
        Catch: [{ ErrorEquals: ['States.ALL'], Comment: 'Shorts trigger failure is non-fatal — always proceed to FinalizeVideoPremium', ResultPath: '$.shortsError', Next: 'FinalizeVideoPremium' }],
        Next: 'FinalizeVideoPremium',
      },
      FinalizeVideoPremium: {
        Type: 'Task',
        Resource: 'arn:aws:states:::ecs:runTask.sync',
        Comment: 'Finalize on Fargate (no Lambda timeout ceiling): upscale + captions + BGM',
        Parameters: {
          Cluster: 'arn:aws:ecs:us-east-1:929075264324:cluster/storystudio-e2e',
          LaunchType: 'FARGATE',
          TaskDefinition: 'e2e-finalize',
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              Subnets: ['subnet-02557f42e07118380', 'subnet-0389bf7ebb5a497ac'],
              SecurityGroups: ['sg-0c2549fa2cb194dc6'],
              AssignPublicIp: 'ENABLED',
            },
          },
          Overrides: {
            ContainerOverrides: [{
              Name: 'finalize',
              Environment: [{ Name: 'PAYLOAD_JSON', 'Value.$': 'States.JsonToString($.finalizeTaskInput)' }],
            }],
          },
        },
        ResultPath: '$.finalizeEcs',
        TimeoutSeconds: 5400,
        Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 1, BackoffRate: 2 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
        Next: 'Complete',
      },
      Complete: {
        Type: 'Pass',
        Comment: 'Pipeline completed successfully',
        Parameters: {
          status: 'SUCCESS',
          'projectId.$': '$.projectId',
          'concatenatedVideoUrl.$': '$.concatenatedVideo.videoUrl',
          'concatenatedVideoR2Key.$': '$.concatenatedVideo.videoKey',
          'captionsUrl.$': '$.captionsResult.captionsUrl',
          message: 'E2E Premium-QM pipeline completed successfully (finalize ran on Fargate)',
        },
        End: true,
      },
      HandleFailure: {
        Type: 'Pass',
        Comment: 'Handle pipeline failure and prepare error response',
        Parameters: {
          status: 'FAILED',
          'projectId.$': '$$.Execution.Input.projectId',
          'jobId.$': '$$.Execution.Input.jobId',
          'jwtToken.$': '$$.Execution.Input.jwtToken',
          'convexEndpoint.$': '$$.Execution.Input.convexEndpoint',
          'error.$': '$.error',
          message: 'E2E Premium-QM pipeline failed',
        },
        Next: 'UpdateStatusFailed',
      },
      UpdateStatusFailed: {
        Type: 'Task',
        Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-update-status',
        Comment: 'Update Convex job status (best-effort)',
        Parameters: {
          'jobId.$': '$.jobId',
          status: 'failed',
          message: 'E2E Premium-QM pipeline failed',
          'error.$': '$.error',
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
        },
        ResultPath: null,
        Retry: [
          { ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 },
          { ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 2, MaxAttempts: 2, BackoffRate: 2.0 },
        ],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'FailState' }],
        Next: 'FailState',
        TimeoutSeconds: 30,
      },
      FailState: {
        Type: 'Fail',
        Error: 'PipelineExecutionFailed',
        Cause: 'E2E Premium-QM pipeline execution failed',
      },
    },
  };
}
