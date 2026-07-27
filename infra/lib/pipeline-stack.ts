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
  /** Secret ARN holding the RunPod API key, used by the shorts-longform trigger */
  runpodKeySecretArn: string;
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
    // deadline) with margin, and executor.ts's timeout must in turn be >=
    // this Lambda's polling window, or the three layers race each other
    // into a false timeout on a genuinely slow-but-succeeding RunPod job
    // (confirmed live 2026-07-04, Wan2 i2v; again 2026-07-10, ERNIE explainer
    // t2i — a burst of `imageModel=="ernie"` frames against fleet.ts's
    // deliberately tiny 2-worker ERNIE_IMAGE pool pushed capacityWaits into
    // the teens, and the job didn't fail — it took ~33min wall-clock and
    // completed successfully long after this Lambda had already given up and
    // routed the frame to QMFrameFailed). Raised 580s→850s (2026-07-10) to
    // push the false-timeout point as close to AWS Lambda's hard 900s
    // execution ceiling as safely possible — this doesn't cover every
    // capacity-starved case (this one alone needed ~33min, which no single
    // Lambda invocation can ever provide), but meaningfully shrinks how often
    // QMFrameFailed fires for a job that's still legitimately queued rather
    // than actually dead. executor.ts's own timeout (raised 600s→890s,
    // 2026-07-11, api-stack.ts — a pt-BR ttsLocalizedQwen job against the
    // shared 6-worker rnqxi6c0mlq517 endpoint hit the old 600s ceiling
    // mid-poll and was falsely marked FAILED) bounds a single dispatch+
    // generation attempt, not the capacity-wait span, which is re-queued
    // across many short executor invocations (see capacityWaits in
    // executor.ts) rather than blocking one invocation for the whole wait.
    const qmGenerateFn = new nodejs.NodejsFunction(this, 'QMGenerateFunction', {
      functionName: 'QM-generate',
      entry: path.join(__dirname, '../../src/handlers/qm-generate.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(890),
      memorySize: 256,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        QM_BASE_URL: `https://${props.qmApiDomain}`,
        GATEWAY_STATIC_KEY_ARN: props.gatewayKeySecretArn,
        QM_GENERATE_DEADLINE_MS: '850000',
      },
    });
    qmGenerateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.gatewayKeySecretArn],
    }));
    // waitForTaskToken cache-hit path (see localizationStates' ttsTask()):
    // qm-generate.ts resolves the SFN task directly when POST /jobs returns
    // an already-COMPLETE job, instead of leaving it to webhook.ts.
    qmGenerateFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
      resources: ['*'],
    }));
    qmGenerateFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // ── QM-shorts-trigger Lambda (SFN → shorts-longform RunPod endpoint) ─────
    // Fire-and-forget: POSTs the finished concat video (+ SRT + BGM) to the
    // shorts-longform RunPod worker's async /run, then returns immediately —
    // completion is reported by RunPod's webhook straight to Convex. Replaces
    // the legacy TriggerShortsFromLongForm→E2E-start-shorts/10-Lambda-SFN path
    // (see ~/longtoshort/RUNPOD-SHORTS-WORKER.md + STORYSTUDIO-INTEGRATION.md).
    const shortsTriggerFn = new nodejs.NodejsFunction(this, 'ShortsTriggerFunction', {
      functionName: 'QM-shorts-trigger',
      entry: path.join(__dirname, '../../src/handlers/shorts-trigger.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        RUNPOD_API_KEY_ARN: props.runpodKeySecretArn,
        SHORTS_ENDPOINT_ID: 'u3bvq5juben8ri',
      },
    });
    shortsTriggerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.runpodKeySecretArn],
    }));
    shortsTriggerFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // ── QM-remotion-overlay Lambda (SFN → per-frame Remotion text-overlay render) ─
    // Direct Lambda invoke inside the GenerateImages Map (Option B of
    // docs/quartermaster/remotion-overlay-lambda-integration-handoff.md), not
    // routed through the QM-generate catalog/ladder — Remotion rendering isn't
    // GPU-scarce and doesn't need QM's semaphore, AWS Lambda scales it on its
    // own. Calls the already-deployed Remotion Lambda function/site/composition
    // (owned by StoryStudio, same AWS account — not built or redeployed by this
    // stack) via @remotion/lambda-client's renderMediaOnLambda/getRenderProgress,
    // pinned to the function's exact deployed version (4.0.443) — a caret range
    // resolves to the newest published client version and hard-fails with a
    // version-mismatch error against an older deployed function (confirmed live
    // in the handoff doc's own benchmark).
    const remotionOverlayFn = new nodejs.NodejsFunction(this, 'RemotionOverlayFunction', {
      functionName: 'QM-remotion-overlay',
      entry: path.join(__dirname, '../../src/handlers/remotion-overlay.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(150),
      memorySize: 256,
      bundling: {
        minify: true, sourceMap: false, externalModules: [],
        // @remotion/lambda-client's package.json "exports" map offers both a
        // working CJS build (dist/cjs/index.js) and a broken ESM one
        // (dist/esm/index.mjs, which calls createRequire(import.meta.url) —
        // esbuild's CJS output doesn't populate import.meta.url, so that
        // resolves to undefined and crashes at require-time on cold start:
        // "TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be
        // ... Received undefined"). esbuild honors the package's conditional
        // exports over its own default platform:'node' mainFields, so without
        // this it picks the ESM entry (confirmed live 2026-07-21 — 29/29 real
        // RenderTextOverlay invocations failed with this exact error, caught
        // gracefully by the passthrough failure policy but rendering zero
        // overlays). Forcing the "require" condition makes it resolve the
        // working CJS build instead.
        esbuildArgs: { '--conditions': 'require' },
      },
      environment: {
        REMOTION_FUNCTION_NAME: 'remotion-render-4-0-443-mem2048mb-disk2048mb-120sec',
        REMOTION_SERVE_URL: 'https://remotionlambda-useast1-55dp29f3ln.s3.us-east-1.amazonaws.com/sites/storystudio-frame-render/index.html',
        REMOTION_COMPOSITION_ID: 'FrameOverlay',
        REMOTION_REGION: 'us-east-1',
      },
    });
    remotionOverlayFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration'],
      resources: ['arn:aws:lambda:us-east-1:929075264324:function:remotion-render-4-0-443-mem2048mb-disk2048mb-120sec'],
    }));
    remotionOverlayFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        'arn:aws:s3:::remotionlambda-useast1-55dp29f3ln',
        'arn:aws:s3:::remotionlambda-useast1-55dp29f3ln/*',
      ],
    }));
    remotionOverlayFn.addPermission('E2ESfnInvoke', {
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
    const qmNewDefinition = buildQmNewDefinition(qmGenerateFn.functionArn, brokerArn, shortsTriggerFn.functionArn, remotionOverlayFn.functionArn);

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
    const narrationPremiumQmNewDefinition = buildNarrationPremiumQmNewDefinition(qmGenerateFn.functionArn, brokerArn, shortsTriggerFn.functionArn, remotionOverlayFn.functionArn);

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
function buildQmNewDefinition(qmGenerateArn: string, brokerArn: string, shortsTriggerArn: string, remotionOverlayArn: string): object {
  const def = JSON.parse(JSON.stringify(buildDefinition(brokerArn))) as {
    Comment: string;
    States: Record<string, any>;
  };
  def.Comment = 'E2E Video Generation Pipeline - Narration-Basic-QM-New — per-frame image (t2i/i2i) + TTS + Flux animate + merge via Quartermaster gateway. Narration-basic only; narration-premium is a separate state machine.';

  // The QM frame Map now produces the finished per-frame video (image → TTS →
  // Flux animate → Flux merge), so it emits $.videoResults directly and the
  // local Ken Burns Map (GenerateI2VBasic) is no longer needed.
  def.States.GenerateImages = qmFrameAssetsMap(qmGenerateArn, remotionOverlayArn);
  def.States.GenerateImages.Next = 'RouteBGM';

  // fourLang per-frame full-video pipeline (2026-07-25,
  // storystudio-4lang-video-pipeline-handoff.md): route into
  // qmFourLangFrameAssetsMap instead of the single-language qmFrameAssetsMap
  // above — supersedes the old whole-script post-concat localization for
  // Basic (see the RouteConcatFourLang/fourLangConcatFinalizeStates wiring
  // below). IsPresent-guarded like RouteBGM's $.bgmPrompt check, since
  // $.fourLang hasn't been normalized to a real boolean yet at this point in
  // the graph (NormalizeFourLang below runs after BGM, right before
  // DropFrameData) — a bare BooleanEquals on a possibly-absent key throws
  // States.Runtime.
  def.States.UpdateStatusGeneratingImages.Next = 'RouteFrameGeneration';
  def.States.UpdateStatusGeneratingImages.Catch[0].Next = 'RouteFrameGeneration';
  def.States.RouteFrameGeneration = {
    Type: 'Choice',
    Choices: [{
      And: [
        { Variable: '$.fourLang', IsPresent: true },
        { Variable: '$.fourLang', BooleanEquals: true },
      ],
      Next: 'GenerateImagesFourLang',
    }],
    Default: 'GenerateImages',
  };
  def.States.GenerateImagesFourLang = qmFourLangFrameAssetsMap(qmGenerateArn, remotionOverlayArn);
  def.States.GenerateImagesFourLang.Next = 'RouteBGM';

  // BGM is now generated from a prompt (bgmPrompt), not passed in as a
  // pre-existing URL. Route through it right after the frame Map — $.frames
  // is still present at this point (DropFrameData is what discards it below),
  // and QM-generate needs the full frames array to sum durations (§bgmStates).
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
      'fourLang.$': '$.fourLang',
      'generateShorts.$': '$.generateShorts',
      'shortsOptions.$': '$.shortsOptions',
    },
    Next: 'UpdateStatusConcatenating',
  };
  delete def.States.UpdateStatusGeneratingVideos;
  delete def.States.GenerateI2VBasic;

  // BUGFIX (found on the first live fourLang:true run, 2026-07-08): the
  // Parameters block above is an explicit field ALLOWLIST — it reconstructs
  // state from scratch, so any field not named there is silently dropped.
  // $.fourLang is optional (may be entirely absent when not requested), so
  // it can't be referenced directly via `'fourLang.$': '$.fourLang'` above
  // without guaranteeing it's present first — a direct `.$` reference throws
  // at runtime if the path doesn't resolve (same gotcha voiceGender/
  // voiceSpeaker/voiceInstruct/voiceLanguage already have — see
  // storystudio-qm-new-sfn-trigger.md). All 3 BGM exit paths (bgmStates(),
  // shared by both Basic and the Premium re-tier clone) route to
  // NormalizeFourLang instead of straight to DropFrameData now, so this
  // fix applies uniformly to both tiers rather than getting silently
  // overwritten when Premium recreates fresh BGM state objects.
  def.States.NormalizeFourLang = {
    Type: 'Choice',
    Comment: 'Guarantee $.fourLang is a real boolean before DropFrameData\'s Parameters allowlist would otherwise silently drop it if the caller omitted the key entirely.',
    Choices: [{ Variable: '$.fourLang', BooleanEquals: true, Next: 'SetFourLangTrue' }],
    Default: 'SetFourLangFalse',
  };
  def.States.SetFourLangTrue = { Type: 'Pass', Result: true, ResultPath: '$.fourLang', Next: 'NormalizeGenerateShortsField' };
  def.States.SetFourLangFalse = { Type: 'Pass', Result: false, ResultPath: '$.fourLang', Next: 'NormalizeGenerateShortsField' };

  // BUGFIX (2026-07-10): same allowlist gotcha as fourLang above, for the two
  // fields the later shorts-longform trigger (shortsTriggerStates below) reads
  // via CheckGenerateShorts/TriggerShortsFromLongForm. generateShorts/
  // shortsOptions were added to DropFrameData's Parameters allowlist without
  // ever being guaranteed present first, so a caller that omitted either key
  // (the common case — most projects don't request shorts) had it silently
  // dropped here, and CheckGenerateShorts always saw $.generateShorts as
  // absent and took the Default (skip) branch regardless of what StoryStudio
  // actually sent at StartExecution. Named "...Field" to avoid colliding with
  // NormalizeShortsOptions/SetShortsOptionsDefault, which are spliced in later
  // (via shortsTriggerStates, right before PrepareFinalizeBasic) and serve a
  // different purpose (defaulting $.shortsOptions for the Task Parameters
  // block, not surviving the DropFrameData allowlist).
  def.States.NormalizeGenerateShortsField = {
    Type: 'Choice',
    Comment: 'Guarantee $.generateShorts is a real boolean before DropFrameData\'s Parameters allowlist would otherwise silently drop it if the caller omitted the key entirely.',
    Choices: [{ Variable: '$.generateShorts', BooleanEquals: true, Next: 'SetGenerateShortsFieldTrue' }],
    Default: 'SetGenerateShortsFieldFalse',
  };
  def.States.SetGenerateShortsFieldTrue = { Type: 'Pass', Result: true, ResultPath: '$.generateShorts', Next: 'NormalizeShortsOptionsField' };
  def.States.SetGenerateShortsFieldFalse = { Type: 'Pass', Result: false, ResultPath: '$.generateShorts', Next: 'NormalizeShortsOptionsField' };
  def.States.NormalizeShortsOptionsField = {
    Type: 'Choice',
    Comment: 'Guarantee $.shortsOptions is a real object before DropFrameData\'s Parameters allowlist would otherwise silently drop it if the caller omitted the key entirely.',
    Choices: [{ Variable: '$.shortsOptions', IsPresent: true, Next: 'DropFrameData' }],
    Default: 'SetShortsOptionsFieldDefault',
  };
  def.States.SetShortsOptionsFieldDefault = { Type: 'Pass', Result: {}, ResultPath: '$.shortsOptions', Next: 'DropFrameData' };

  // The generated BGM's URL now comes from bgmResult, not a passed-in bgmUrl.
  def.States.PrepareFinalizeBasic.Parameters['bgmUrl.$'] = '$.bgmResult.cdnUrl';

  // SRT via QM's self-hosted RunPod Whisper instead of the E2E-voice-srt-basic
  // Lambda (which calls OpenAI Whisper — a 25MB upload cap that HTTP-413'd a
  // 5-min project's 26MB concat audio and crashed the whole execution at
  // BuildMergedVoiceResult, 2026-07-04). RunPod Whisper transcribes the audio
  // URL on the pod, no upload limit. Catch → SkipSrt so an SRT failure degrades
  // to "no captions" instead of failing the project (mirrors BgmGenerationFailed).
  def.States.TranscribeAudio = {
    Type: 'Task',
    Resource: qmGenerateArn,
    Comment: 'SRT via QM (srt.narration → self-hosted RunPod Whisper large-v3-turbo). Transcribes the concatenated-audio URL on the pod — no OpenAI 25MB upload limit.',
    Parameters: {
      assetType: 'srt',
      tier: 'narration',        // resolves to srt.narration (no per-tier srt rung)
      operation: 'transcribe',
      product: 'narration',
      queue: 'background',
      jobType: 'batch',
      'audioUrl.$': '$.concatenatedVideo.audioUrl',
      'projectId.$': '$.projectId',
    },
    ResultPath: '$.transcribeResult',
    TimeoutSeconds: 920,
    Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.transcribeError', Next: 'SkipSrt' }],
    Next: 'BuildMergedVoiceResult',
  };
  def.States.SkipSrt = {
    Type: 'Pass',
    Comment: 'SRT generation failed — proceed without captions rather than failing the whole project (graceful, mirrors BgmGenerationFailed).',
    Parameters: { cdnUrl: '' },
    ResultPath: '$.transcribeResult',
    Next: 'BuildMergedVoiceResult',
  };
  // QM-generate returns the SRT URL as `cdnUrl` (not `srtUrl`); remap. Empty on
  // SkipSrt → downstream finalize simply burns no captions.
  def.States.BuildMergedVoiceResult.Parameters['srtUrl.$'] = '$.transcribeResult.cdnUrl';
  def.States.BuildMergedVoiceResult.Parameters['captionsUrl.$'] = '$.transcribeResult.cdnUrl';

  // fourLang per-frame full-video pipeline (2026-07-25): the fourLang branch
  // needs its own per-language concat (RouteFrameGeneration above already
  // produced per-frame videoUrls{en,es,ptBr,hi}, not a single videoUrl the
  // existing ConcatenateVideos' $.videoResults shape expects), so this Choice
  // has to fire BEFORE ConcatenateVideos even runs, not after concat like the
  // old whole-script localizationStates() did. $.fourLang was already
  // normalized to a real boolean by NormalizeFourLang above (runs before
  // DropFrameData), so a plain BooleanEquals is safe here — the IsPresent
  // guard is kept anyway for defensive consistency with the rest of this file.
  // localizationStates()/RouteLocalization/LocalizeLanguages stay defined
  // below (Premium still calls localizationStates() unchanged, and neutralizes
  // this whole fourLang-per-frame block — see buildNarrationPremiumQmNewDefinition)
  // but Basic no longer wires them in.
  def.States.UpdateStatusConcatenating.Next = 'RouteConcatFourLang';
  def.States.RouteConcatFourLang = {
    Type: 'Choice',
    Choices: [{
      And: [
        { Variable: '$.fourLang', IsPresent: true },
        { Variable: '$.fourLang', BooleanEquals: true },
      ],
      Next: 'BuildLangVideoArrays',
    }],
    Default: 'ConcatenateVideos',
  };
  Object.assign(def.States, fourLangConcatFinalizeStates(qmGenerateArn));
  def.States.BuildMergedVoiceResult.Next = 'SetNoLocalizedAssets';
  def.States.SetNoLocalizedAssets = {
    Type: 'Pass',
    Comment: 'Non-fourLang path — no localized assets to report. Matches the old SkipLocalization convention ({} not []) so StoryStudio\'s existing consumer sees the same shape it always has for a non-fourLang project.',
    Parameters: {},
    ResultPath: '$.localizedAssets',
    Next: 'UpdateStatusApplyingBgm',
  };

  // Surface $.localizedAssets in both the Convex status callback and the
  // execution's final output, so StoryStudio gets the 3 per-language
  // script/audio/SRT results (or graceful failure markers) without polling
  // anything extra. Set here (not per-tier) so both Basic and the Premium
  // clone below inherit it identically.
  def.States.UpdateStatusApplyingBgm.Parameters.assets['localizedAssets.$'] = '$.localizedAssets';
  def.States.Complete.Parameters['localizedAssets.$'] = '$.localizedAssets';

  // Fire-and-forget shorts trigger — mirrors legacy Premium-QM's
  // CheckGenerateShorts/TriggerShortsFromLongForm (buildPremiumDefinition),
  // but points at the new shorts-longform RunPod worker instead of the old
  // E2E-start-shorts→10-Lambda-SFN path it replaces. Runs on the concat video
  // (mergedVoiceResult), before Fargate finalize — finalize's upscale/BGM/
  // caption burn only affects the long-form output, not the shorts.
  def.States.PrepareFinalizeBasic.Next = 'NormalizeShortsOptions';
  Object.assign(def.States, shortsTriggerStates(shortsTriggerArn, 'FinalizeVideoBasic'));

  return def;
}

/**
 * Shared by both QM-new machines (Basic wires it in directly; Premium
 * re-assigns it after cloning, retargeting the Choice's default/Next at
 * `finalizeStateName` — mirrors bgmStates/localizationStates' clone-and-retier
 * pattern). Spliced between PrepareFinalize{Basic,Premium} and
 * FinalizeVideo{Basic,Premium}: only fires when the caller explicitly set
 * `generateShorts: true`; a missing/false key skips straight to finalize.
 * Failure is non-fatal — the shorts worker is a nice-to-have side artifact,
 * never worth failing the main long-form project over.
 *
 * NormalizeShortsOptions/SetShortsOptionsDefault guarantee `$.shortsOptions`
 * is always present before TriggerShortsFromLongForm's Parameters allowlist
 * references it via `.$` — same gotcha as fourLang/voiceGender (see
 * NormalizeFourLang above): a direct `'shortsOptions.$': '$.shortsOptions'`
 * throws at runtime if the caller omitted the key entirely, which is the
 * common case (it's optional).
 */
function shortsTriggerStates(shortsTriggerArn: string, finalizeStateName: string): Record<string, unknown> {
  return {
    NormalizeShortsOptions: {
      Type: 'Choice',
      Comment: 'Guarantee $.shortsOptions is a real object before TriggerShortsFromLongForm\'s Parameters allowlist would otherwise throw if the caller omitted the key entirely.',
      Choices: [{ Variable: '$.shortsOptions', IsPresent: true, Next: 'CheckGenerateShorts' }],
      Default: 'SetShortsOptionsDefault',
    },
    SetShortsOptionsDefault: { Type: 'Pass', Result: {}, ResultPath: '$.shortsOptions', Next: 'CheckGenerateShorts' },
    CheckGenerateShorts: {
      Type: 'Choice',
      Comment: 'Only trigger the shorts-longform worker when the caller explicitly set generateShorts=true.',
      Choices: [{
        And: [
          { Variable: '$.generateShorts', IsPresent: true },
          { Variable: '$.generateShorts', BooleanEquals: true },
        ],
        Next: 'TriggerShortsFromLongForm',
      }],
      Default: finalizeStateName,
    },
    TriggerShortsFromLongForm: {
      Type: 'Task',
      Resource: shortsTriggerArn,
      Comment: 'Fire-and-forget: POST the concat video + SRT + BGM (+ caller shortsOptions passthrough) to the shorts-longform RunPod endpoint (u3bvq5juben8ri) /run; completion reported via webhook straight to Convex. Failure is non-fatal.',
      Parameters: {
        'projectId.$': '$.projectId',
        'jobId.$': '$.jobId',
        'videoUrl.$': '$.mergedVoiceResult.mergedVideoUrl',
        'srtUrl.$': '$.mergedVoiceResult.captionsUrl',
        'bgmUrl.$': '$.bgmResult.cdnUrl',
        'convexEndpoint.$': '$.convexEndpoint',
        'shortsOptions.$': '$.shortsOptions',
      },
      ResultPath: '$.shortsExecution',
      TimeoutSeconds: 30,
      Catch: [{ ErrorEquals: ['States.ALL'], Comment: 'Shorts trigger failure is non-fatal — always proceed to finalize', ResultPath: '$.shortsError', Next: finalizeStateName }],
      Next: finalizeStateName,
    },
  };
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
      Next: 'NormalizeFourLang',
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
      TimeoutSeconds: 920,
      Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.bgmError', Next: 'BgmGenerationFailed' }],
      Next: 'NormalizeFourLang',
    },
    BgmGenerationFailed: {
      Type: 'Pass',
      Comment: 'BGM generation exhausted all rungs — proceed without music rather than failing the whole project',
      Parameters: { cdnUrl: '' },
      ResultPath: '$.bgmResult',
      Next: 'NormalizeFourLang',
    },
  };
}

/**
 * 4lang: optional post-concat localization, shared by both
 * Narration-Basic-QM-New and Narration-Premium-QM-New (the premium machine
 * re-assigns this block with tier:'narrationPremium' after cloning the basic
 * definition — see buildNarrationPremiumQmNewDefinition, mirrors bgmStates).
 * Gated on the execution input's `fourLang` boolean; when true, translates
 * the English transcript (TranscribeAudio's Whisper output, not the original
 * per-frame narrationText — the spec's "translate the SRT" source of truth)
 * into a FIXED set of 3 languages (es, pt-BR, hi — not a caller-supplied
 * list), generates localized TTS per language, then re-transcribes each
 * language's own TTS audio with Whisper to produce a properly-synced
 * localized SRT (spec §7.4: SRT must sync to the real audio, not just
 * translated text). Engine per language/project is DATA-DRIVEN, not
 * hardcoded by language or tier: StoryStudio resolves each project's chosen
 * voice to either a Qwen voice-clone .pt artifact or a Kokoro voiceId and
 * puts it on the execution input as voiceCloneArtifactUrl{Es,PtBr,Hi} /
 * voiceId{Es,PtBr,Hi} (mirrors the single-language voiceCloneArtifactUrl/
 * RouteTTSEngine pattern the primary English TTS call above already uses).
 * This SFN just passes whichever one is present straight through to QM —
 * cloneArtifactUrl present → Qwen clone fast path, voiceId present →
 * Kokoro. Hi will practically always take the Kokoro branch since Qwen has
 * no Hindi support at all (see qwen-voice-clone/docs/voice-catalog.json),
 * but that's a consequence of what gets sent, not a hardcoded rule here. A
 * language that fails at any step (including neither identifier being
 * sent) emits a graceful `{failed:true}` item (mirrors QMFrameFailed)
 * rather than failing the whole project.
 */
function localizationStates(qmGenerateArn: string, tier: string): Record<string, unknown> {
  // waitForTaskToken (2026-07-25): this call synthesizes the WHOLE translated
  // script in one shot (not per-frame), whose real generation time can
  // exceed any single Lambda invocation's window — confirmed live when both
  // es/pt timed out at the old 850s QM_GENERATE_DEADLINE_MS ceiling
  // (qm-generate.ts), itself already pushed close to Lambda's 900s hard
  // execution limit. Plain lambda:invoke can't be pushed further; instead
  // qm-generate.ts (passed $$.Task.Token below) submits the job and returns
  // immediately, and webhook.ts resumes this task via SendTaskSuccess/
  // Failure once RunPod's async webhook actually reports completion — see
  // executor.ts's webhookCompletion rung handling and background.json's
  // voice.*.ttsLocalizedQwen/Kokoro catalog entries. TimeoutSeconds is now
  // bounded only by "did the webhook ever arrive," not Lambda's ceiling.
  const ttsTask = (engine: 'qwen' | 'kokoro') => ({
    Type: 'Task',
    Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
    Comment: engine === 'qwen'
      ? `4lang localized TTS via QM (voice.${tier}.ttsLocalizedQwen — Qwen3-TTS voice-clone .pt fast path: cloneArtifactUrl + language param).`
      : `4lang localized TTS via QM (voice.${tier}.ttsLocalizedKokoro — self-hosted Kokoro voiceId, language param drives lang_code).`,
    Parameters: {
      FunctionName: qmGenerateArn,
      Payload: {
        assetType: 'voice',
        tier,
        operation: engine === 'qwen' ? 'ttsLocalizedQwen' : 'ttsLocalizedKokoro',
        product: 'narration',
        queue: 'background',
        jobType: 'batch',
        'prompt.$': '$.translateResult.cdnUrl',
        'language.$': '$.name',
        ...(engine === 'qwen'
          ? { 'cloneArtifactUrl.$': '$.cloneArtifactUrl' }
          : { 'voiceId.$': '$.voiceId' }),
        'projectId.$': '$$.Execution.Input.projectId',
        'userId.$': '$$.Execution.Input.userId',
        // BUGFIX (found on the first successful fourLang run, 2026-07-08): with
        // no frameId, qm-generate.ts derives requestId as
        // `${projectId}:na:${assetType}:${operation}` — identical across all 3
        // parallel language branches (same assetType/operation here), so QM's
        // idempotent-by-requestId /jobs de-dup collapsed es/pt-BR onto ONE
        // shared job (whichever won the race), silently returning that same
        // result for both languages. Language code as frameId disambiguates
        // both requestId and qm-generate.ts's default s3Target the same way a
        // real frameId would for per-frame jobs.
        'frameId.$': '$.code',
        'taskToken.$': '$$.Task.Token',
      },
    },
    ResultPath: '$.ttsResult',
    TimeoutSeconds: 1800,
    Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'LocalizationFailedForLanguage' }],
    Next: 'QMGenerateLocalizedSRT',
  });

  // Guarantee $.<resultField> is always present (default '') before
  // PrepareLocalization references it via '.$' — same gotcha as
  // fourLang/shortsOptions (see NormalizeFourLang/NormalizeShortsOptions
  // above): a raw $$.Execution.Input.<field> Parameters reference throws
  // States.Runtime if the caller omitted that (optional, per-language)
  // field entirely, which is the common case (a project sends either the
  // clone-url or the voiceId for a given language, never both).
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const normalizeVoiceField = (execField: string, resultField: string, next: string): Record<string, unknown> => {
    const choice = `Normalize${cap(resultField)}`;
    const present = `Set${cap(resultField)}Present`;
    const absent = `Set${cap(resultField)}Absent`;
    return {
      [choice]: {
        Type: 'Choice',
        Choices: [{
          And: [
            { Variable: `$$.Execution.Input.${execField}`, IsPresent: true },
            { Variable: `$$.Execution.Input.${execField}`, IsString: true },
            { Not: { Variable: `$$.Execution.Input.${execField}`, StringEquals: '' } },
          ],
          Next: present,
        }],
        Default: absent,
      },
      [present]: { Type: 'Pass', Parameters: { 'value.$': `$$.Execution.Input.${execField}` }, ResultPath: `$.${resultField}`, Next: next },
      [absent]: { Type: 'Pass', Result: { value: '' }, ResultPath: `$.${resultField}`, Next: next },
    };
  };

  // Chain of 5 normalize steps run once, before PrepareLocalization fans out
  // into the 3-way Map (hi's cloneArtifactUrl isn't normalized — Qwen has no
  // Hindi support, so that leg is always the literal '' in PrepareLocalization
  // below rather than a caller-suppliable field).
  const voiceFieldChain: string[] = [
    'voiceCloneArtifactUrlEs',
    'voiceIdEs',
    'voiceCloneArtifactUrlPtBr',
    'voiceIdPtBr',
    'voiceIdHi',
  ];
  const voiceNormalizeStates: Record<string, unknown> = {};
  voiceFieldChain.forEach((field, i) => {
    const next = i + 1 < voiceFieldChain.length ? `Normalize${cap(voiceFieldChain[i + 1])}` : 'PrepareLocalization';
    Object.assign(voiceNormalizeStates, normalizeVoiceField(field, field, next));
  });

  return {
    ...voiceNormalizeStates,
    RouteLocalization: {
      Type: 'Choice',
      Comment: 'Only localize when the caller asked for 4lang AND the English transcript (TranscribeAudio) actually produced text — a failed/skipped SkipSrt has nothing to translate.',
      Choices: [{
        And: [
          { Variable: '$.fourLang', IsPresent: true },
          { Variable: '$.fourLang', BooleanEquals: true },
          { Variable: '$.transcribeResult.text', IsPresent: true },
        ],
        Next: `Normalize${cap(voiceFieldChain[0])}`,
      }],
      Default: 'SkipLocalization',
    },
    SkipLocalization: {
      Type: 'Pass',
      Comment: 'fourLang not requested, or no English transcript to translate from — proceed without localized assets.',
      Parameters: {},
      ResultPath: '$.localizedAssets',
      Next: 'UpdateStatusApplyingBgm',
    },
    PrepareLocalization: {
      Type: 'Pass',
      Comment: 'Fan out the 3 fixed 4lang targets (es, pt-BR, hi). Each item carries its own copy of the English transcript plus the per-language voice identifier normalized above (cloneArtifactUrl and/or voiceId — whichever StoryStudio actually sent), so the Map below needs no Map-level Parameters/$$.Map.Item.Value merging.',
      Parameters: {
        languageConfigs: [
          { code: 'es', name: 'Spanish', whisperLang: 'es', defaultEngine: 'qwen', 'englishText.$': '$.transcribeResult.text', 'cloneArtifactUrl.$': '$.voiceCloneArtifactUrlEs.value', 'voiceId.$': '$.voiceIdEs.value' },
          { code: 'pt-BR', name: 'Portuguese', whisperLang: 'pt', defaultEngine: 'qwen', 'englishText.$': '$.transcribeResult.text', 'cloneArtifactUrl.$': '$.voiceCloneArtifactUrlPtBr.value', 'voiceId.$': '$.voiceIdPtBr.value' },
          { code: 'hi', name: 'Hindi', whisperLang: 'hi', defaultEngine: 'kokoro', 'englishText.$': '$.transcribeResult.text', cloneArtifactUrl: '', 'voiceId.$': '$.voiceIdHi.value' },
        ],
      },
      ResultPath: '$.localizationPrep',
      Next: 'LocalizeLanguages',
    },
    LocalizeLanguages: {
      Type: 'Map',
      Comment: '4lang: translate → localized TTS → localized SRT, one branch per language, fully parallel (3 fixed languages).',
      ItemsPath: '$.localizationPrep.languageConfigs',
      MaxConcurrency: 3,
      ResultPath: '$.localizedAssets',
      Iterator: {
        StartAt: 'TranslateScript',
        States: {
          TranslateScript: {
            Type: 'Task',
            Resource: qmGenerateArn,
            Comment: 'Translate the English transcript via QM (llm — self-hosted-less direct Anthropic Claude rung). Meaning-preserving, not word-for-word (spec §7.2): preserves scene order, factual meaning, tone, pacing, pronunciation-friendly phrasing.',
            Parameters: {
              assetType: 'llm',
              tier: 'narration',
              operation: 'translate',
              product: 'narration',
              queue: 'background',
              jobType: 'batch',
              'prompt.$': "States.Format('Translate the following English video narration script into natural, meaning-preserving {}. Preserve the original scene order, factual meaning, tone, and narration pacing. Use pronunciation-friendly phrasing suitable for text-to-speech. Return ONLY the translated text, with no preamble, labels, headers, or commentary.\n\nEnglish script:\n{}', $.name, $.englishText)",
              'projectId.$': '$$.Execution.Input.projectId',
              'userId.$': '$$.Execution.Input.userId',
              // See the frameId bugfix note on ttsTask() above — without this,
              // all 3 parallel language branches derive the identical
              // requestId (`${projectId}:na:llm:translate`) and QM's
              // idempotent /jobs de-dup collapses them onto one shared
              // translation.
              'frameId.$': '$.code',
            },
            ResultPath: '$.translateResult',
            TimeoutSeconds: 120,
            Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException', 'States.TaskFailed'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
            Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.translateError', Next: 'LocalizationFailedForLanguage' }],
            Next: 'RouteLocalizedTTS',
          },
          RouteLocalizedTTS: {
            Type: 'Choice',
            Comment: 'Data-driven, not hardcoded per-language/per-tier: cloneArtifactUrl present (normalized in PrepareLocalization from voiceCloneArtifactUrl{Es,PtBr,Hi}) -> Qwen voice-clone fast path; else voiceId present (from voiceId{Es,PtBr,Hi}) -> Kokoro; else fall back to defaultEngine (es/pt-BR: qwen, hi: kokoro — the pre-2026-07-10 hardcoded mapping, preserved as the fallback so a project that sends neither field for a language keeps working exactly as before, just without an explicit voice pinned).',
            Choices: [
              {
                And: [
                  { Variable: '$.cloneArtifactUrl', IsPresent: true },
                  { Not: { Variable: '$.cloneArtifactUrl', StringEquals: '' } },
                ],
                Next: 'QMGenerateLocalizedTTSQwen',
              },
              {
                And: [
                  { Variable: '$.voiceId', IsPresent: true },
                  { Not: { Variable: '$.voiceId', StringEquals: '' } },
                ],
                Next: 'QMGenerateLocalizedTTSKokoro',
              },
              { Variable: '$.defaultEngine', StringEquals: 'kokoro', Next: 'QMGenerateLocalizedTTSKokoro' },
            ],
            Default: 'QMGenerateLocalizedTTSQwen',
          },
          QMGenerateLocalizedTTSQwen: ttsTask('qwen'),
          QMGenerateLocalizedTTSKokoro: ttsTask('kokoro'),
          QMGenerateLocalizedSRT: {
            Type: 'Task',
            Resource: qmGenerateArn,
            Comment: 'Localized SRT via QM (srt.narration — same self-hosted Whisper rung as the English TranscribeAudio step), re-transcribing this language\'s OWN generated TTS audio rather than reusing translated text with English timings — keeps captions synced to the real localized speech (spec §7.4).',
            Parameters: {
              assetType: 'srt',
              tier: 'narration',
              operation: 'transcribe',
              product: 'narration',
              queue: 'background',
              jobType: 'batch',
              'audioUrl.$': '$.ttsResult.cdnUrl',
              'language.$': '$.whisperLang',
              'projectId.$': '$$.Execution.Input.projectId',
              // See the frameId bugfix note on ttsTask() above — without this,
              // this collides with the ENGLISH TranscribeAudio call too (same
              // assetType:'srt'/tier:'narration'/operation:'transcribe'
              // triple, no frameId there either), not just across languages.
              'frameId.$': '$.code',
            },
            ResultPath: '$.srtResult',
            TimeoutSeconds: 920,
            Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
            Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.srtError', Next: 'SkipLocalizedSrt' }],
            Next: 'BuildLanguageAsset',
          },
          SkipLocalizedSrt: {
            Type: 'Pass',
            Comment: 'Localized SRT generation failed — keep the translated script + audio, proceed without captions for this language (mirrors SkipSrt).',
            Parameters: { cdnUrl: '' },
            ResultPath: '$.srtResult',
            Next: 'BuildLanguageAsset',
          },
          BuildLanguageAsset: {
            Type: 'Pass',
            Comment: 'Success shape for one language.',
            Parameters: {
              'language.$': '$.code',
              'scriptText.$': '$.translateResult.cdnUrl',
              'voiceoverUrl.$': '$.ttsResult.cdnUrl',
              'srtUrl.$': '$.srtResult.cdnUrl',
            },
            End: true,
          },
          LocalizationFailedForLanguage: {
            Type: 'Pass',
            Comment: 'This language exhausted its localization steps — emit a graceful failure item rather than aborting the whole Map (mirrors QMFrameFailed).',
            Parameters: {
              'language.$': '$.code',
              failed: true,
              error: 'LocalizationError',
            },
            End: true,
          },
        },
      },
      Next: 'UpdateStatusApplyingBgm',
    },
  };
}

/**
 * Per-frame Remotion text-overlay states, shared by both qmFrameAssetsMap
 * (Basic) and qmPremiumFrameAssetsMap (Premium) iterators — direct Lambda
 * invoke (Option B of docs/quartermaster/remotion-overlay-lambda-integration-handoff.md),
 * not routed through the QM-generate catalog/ladder, spliced in right after
 * each iterator's shared BuildFrameVideo state produces `videoUrl`.
 *
 * `NormalizeTextManifest`/`SetTextManifestDefault` must run as the iterator's
 * very first state (StartAt), before anything else, guaranteeing `$.textManifest`
 * is always a real string (empty when the frame doesn't carry one — only the 5
 * genres needing an on-screen overlay do) — same "Pass + ResultPath, never
 * Parameters" safe-default pattern as NormalizeFourLang/the 4lang voice-field
 * chain above: a direct `.$` reference to an absent key throws `States.Runtime`,
 * and BuildFrameVideo's own Parameters block (a full `$` reshape, no ResultPath)
 * needs to reference `$.textManifest` safely to carry it through to
 * RouteTextOverlay below.
 *
 * RouteTextOverlay/RenderTextOverlay/ApplyTextOverlay/SkipTextOverlay run once
 * BuildFrameVideo has already produced the frame's videoUrl. Because this all
 * happens *inside* the Map (before it closes), textManifest never needs to
 * survive DropFrameData's allowlist — consumed and discarded within the same
 * iteration, unlike the older Fargate-batch proposal's design.
 */
function textOverlayStates(remotionOverlayArn: string, nextAfterNormalize: string): Record<string, unknown> {
  const nonEmptyTextManifest = {
    And: [
      { Variable: '$.textManifest', IsPresent: true },
      { Variable: '$.textManifest', IsString: true },
      { Not: { Variable: '$.textManifest', StringEquals: '' } },
    ],
  };
  return {
    NormalizeTextManifest: {
      Type: 'Choice',
      Comment: 'Guarantee $.textManifest is a real string before BuildFrameVideo\'s Parameters allowlist would otherwise throw if the frame omitted it entirely (the common case — only explainer/educational/advertisement/documentary/product-promotion frames carry one).',
      Choices: [{ ...nonEmptyTextManifest, Next: nextAfterNormalize }],
      Default: 'SetTextManifestDefault',
    },
    SetTextManifestDefault: { Type: 'Pass', Result: '', ResultPath: '$.textManifest', Next: nextAfterNormalize },
    RouteTextOverlay: {
      Type: 'Choice',
      Comment: 'Gate purely on a non-empty textManifest — StoryStudio only populates this for the 5 genres needing an on-screen text overlay, so its presence alone already encodes the genre gate; no separate top-level textOverlayEnabled flag needed (same data-driven-not-flag-driven style RouteImageModel/RouteImageGen already use for imageModel).',
      Choices: [{ ...nonEmptyTextManifest, Next: 'RenderTextOverlay' }],
      Default: 'SkipTextOverlay',
    },
    RenderTextOverlay: {
      Type: 'Task',
      Resource: remotionOverlayArn,
      Comment: 'Per-frame Remotion text-overlay render (QM-remotion-overlay Lambda, direct invoke — see remotion-overlay-lambda-integration-handoff.md §6 Option B). Composites $.textManifest\'s textElements onto the already-animated, already-audio-merged clip BuildFrameVideo just produced. duration is the clip\'s real length (BuildFrameVideo\'s $.duration — see NormalizeRealDuration for Basic, $.ttsResult.durationS for Premium, both already the real reported length) — the Lambda force-overrides Remotion\'s rendered duration to this, since textManifest.durationInFrames was computed by StoryStudio before real TTS ran and otherwise silently truncates the clip\'s tail (confirmed live 2026-07-21: cut-off narration audio).',
      Parameters: {
        'clipUrl.$': '$.videoUrl',
        'textManifest.$': '$.textManifest',
        'frameId.$': '$.frameId',
        'duration.$': '$.duration',
      },
      ResultPath: '$.overlayResult',
      TimeoutSeconds: 180,
      Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
      Catch: [{ ErrorEquals: ['States.ALL'], Comment: 'Passthrough failure policy (handoff doc §8\'s recommendation): one frame\'s overlay failing degrades to its un-overlaid clip rather than failing the whole video.', ResultPath: '$.overlayError', Next: 'SkipTextOverlay' }],
      Next: 'ApplyTextOverlay',
    },
    ApplyTextOverlay: {
      Type: 'Pass',
      Comment: 'Overlay succeeded — use the overlaid clip in place of the original.',
      Parameters: {
        'frameId.$': '$.frameId',
        'frameNumber.$': '$.frameNumber',
        'videoUrl.$': '$.overlayResult.overlayRenderedUrl',
        'duration.$': '$.duration',
      },
      End: true,
    },
    SkipTextOverlay: {
      Type: 'Pass',
      Comment: 'No text overlay needed (empty textManifest), or the overlay render failed — keep the original un-overlaid clip. Reshapes to the same videoResults[] item shape as ApplyTextOverlay so nothing downstream of the Map needs to branch on which path ran.',
      Parameters: {
        'frameId.$': '$.frameId',
        'frameNumber.$': '$.frameNumber',
        'videoUrl.$': '$.videoUrl',
        'duration.$': '$.duration',
      },
      End: true,
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
function qmFrameAssetsMap(qmGenerateArn: string, remotionOverlayArn: string): object {
  return {
    Type: 'Map',
    Comment: 'Per-frame video via Quartermaster gateway (Narration-Basic): ONE flux-tts-s2t `pipeline` call per frame does image (t2i/i2i) → Kokoro TTS → animate → merge (models resident in VRAM). Replaces 4 QM jobs/frame with 1. QM owns internal-first routing + per-endpoint concurrency. Exception: frames with imageModel=="ernie" or "qwen-image-gen" (explainer/educational/advertisement/documentary/product-promotion, on-screen text overlay) branch to a decomposed 4-step flow instead — this rung is t2i-only (no pipeline/animate/merge mode of its own), so those frames pay 4 QM jobs to get a clean text-free image, while every other frame keeps the 1-job optimization. Frames carrying a non-empty textManifest (the same 5 genres) additionally get a Remotion text-overlay render spliced in after BuildFrameVideo — see textOverlayStates below.',
    ItemsPath: '$.frames',
    MaxConcurrency: 15,
    ResultPath: '$.videoResults',
    Iterator: {
      StartAt: 'NormalizeTextManifest',
      States: {
        ...textOverlayStates(remotionOverlayArn, 'RouteImageModel'),
        RouteImageModel: {
          Type: 'Choice',
          Comment: 'imageModel=="ernie" OR "qwen-image-gen" (StoryStudio-resolved — explainer/educational/advertisement/documentary/product-promotion frames needing an on-screen text overlay) → decomposed image/TTS/animate/merge via image.explainer.t2i (Qwen-Image-Gen). Two accepted values because pipeline.ts sends "ernie" only via its (currently dead) hasTextTag path, and "qwen-image-gen" for narration-premium\'s real text-free-genre frames — narration-basic still always sends "flux-klein-4b" today (StoryStudio\'s own documented choice), so this branch only fires for Basic via the "ernie" tag path until/unless that changes. Any other value, or the field missing entirely (older callers pre-dating the 2026-07-05 imageModel field), keeps the efficient one-shot Flux pipeline.',
          Choices: [{
            Or: [
              { And: [
                { Variable: '$.imageModel', IsPresent: true },
                { Variable: '$.imageModel', IsString: true },
                { Variable: '$.imageModel', StringEquals: 'ernie' },
              ] },
              { And: [
                { Variable: '$.imageModel', IsPresent: true },
                { Variable: '$.imageModel', IsString: true },
                { Variable: '$.imageModel', StringEquals: 'qwen-image-gen' },
              ] },
            ],
            Next: 'QMGenerateExplainerImage',
          }],
          Default: 'QMGeneratePipeline',
        },
        QMGenerateExplainerImage: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Text-to-image via QM (image.explainer.t2i: self-hosted Qwen-Image-Gen → nano-banana fallback). No i2i mode on this rung, so this always renders from imagePrompt alone even if the frame carries a referenceImageUrl (matches StoryStudio\'s documented override: explainer/text-overlay frames use this branch regardless of the i2i/t2i row).',
          Parameters: {
            assetType: 'image',
            tier: 'explainer',
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
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'QMFrameFailed' }],
          Next: 'RouteExplainerTTS',
        },
        RouteExplainerTTS: {
          Type: 'Choice',
          Comment: 'Frame already carries a voiceUrl → reuse it; otherwise generate TTS from narrationText (mirrors Narration-Premium-QM-New\'s RouteTTS).',
          Choices: [{
            And: [
              { Variable: '$.voiceUrl', IsPresent: true },
              { Variable: '$.voiceUrl', IsString: true },
              { Not: { Variable: '$.voiceUrl', StringEquals: '' } },
            ],
            Next: 'UseProvidedExplainerVoice',
          }],
          Default: 'QMGenerateExplainerTTS',
        },
        UseProvidedExplainerVoice: {
          Type: 'Pass',
          Comment: 'A voiceUrl was supplied upstream — reuse it, skip TTS generation. durationS falls back to the frame\'s planned $.duration since no TTS call ran to report a real one (QMGenerateExplainerAnimate reads $.ttsResult.durationS uniformly regardless of which branch ran — mirrors Narration-Premium-QM-New\'s UseProvidedVoice; see its comment for the 2026-07-07 States.Runtime incident a field-name mismatch here caused).',
          Parameters: { 'cdnUrl.$': '$.voiceUrl', 'durationS.$': '$.duration' },
          ResultPath: '$.ttsResult',
          Next: 'QMGenerateExplainerAnimate',
        },
        QMGenerateExplainerTTS: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'TTS via QM (voice.narrationBasic.tts: self-hosted Kokoro-82M → Replicate fallback) — same voice model as the one-shot path, voice by voiceGender.',
          Parameters: {
            assetType: 'voice',
            tier: 'narrationBasic',
            operation: 'tts',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'prompt.$': '$.narrationText',
            'voiceGender.$': '$$.Execution.Input.voiceGender',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.ttsResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'QMFrameFailed' }],
          Next: 'QMGenerateExplainerAnimate',
        },
        QMGenerateExplainerAnimate: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Ken Burns animation of the Qwen-Image-Gen image via QM (video.narrationBasic.animate: self-hosted Flux-TTS-S2T animate mode) — same animation rung the one-shot path uses internally. durationS comes from $.ttsResult.durationS (the real spoken/measured length QMGenerateExplainerTTS just reported, guaranteed present regardless of branch via UseProvidedExplainerVoice\'s fallback) rather than the originally-planned $.duration estimate, so the Ken Burns clip QMGenerateExplainerMerge glues the voice onto is never shorter than the actual narration audio (mirrors Narration-Premium-QM-New\'s QMGenerateVideoNormal — a stale $.duration here previously let real speech run past the clip length and cut off the last syllable(s) of narration).',
          Parameters: {
            assetType: 'video',
            tier: 'narrationBasic',
            operation: 'animate',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'durationS.$': '$.ttsResult.durationS',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.animateResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.animateError', Next: 'QMFrameFailed' }],
          Next: 'QMGenerateExplainerMerge',
        },
        QMGenerateExplainerMerge: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Merge the TTS voice onto the Ken Burns animation via QM (video.narrationBasic.merge). ResultPath matches QMGeneratePipeline\'s ($.pipelineResult) so the shared BuildFrameVideo state below needs no branch-specific handling.',
          Parameters: {
            assetType: 'video',
            tier: 'narrationBasic',
            operation: 'merge',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'initImageUrls.$': 'States.Array($.animateResult.cdnUrl)',
            'audioUrl.$': '$.ttsResult.cdnUrl',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.pipelineResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.mergeError', Next: 'QMFrameFailed' }],
          Next: 'NormalizeRealDuration',
        },
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
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.pipelineError', Next: 'QMFrameFailed' }],
          Next: 'NormalizeRealDuration',
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
        // The pod's real merged output length ($.pipelineResult.durationS —
        // reported by both the one-shot `pipeline` mode and the explainer
        // branch's `merge` mode, per runpod/API.md; both share ResultPath
        // $.pipelineResult) is often longer than the originally-planned
        // $.duration StoryStudio sent before TTS ever ran (the real spoken
        // length of narrationText varies). Confirmed live 2026-07-21: frames
        // carrying a textManifest were audibly cut off mid-narration, because
        // RenderTextOverlay's Remotion composition renders exactly
        // textManifest.durationInFrames frames — a value StoryStudio computed
        // from the SAME stale planned duration — truncating the real clip's
        // tail. Falls back to $.duration only if the pod genuinely didn't
        // report one (shouldn't happen per the API, but Choice's IsPresent
        // check keeps this safe against that regardless).
        NormalizeRealDuration: {
          Type: 'Choice',
          Comment: 'Prefer the pod\'s real reported merged-clip duration over the originally-planned $.duration, so BuildFrameVideo\'s duration (and RenderTextOverlay\'s forced Remotion duration) reflect the actual clip, not a pre-TTS estimate.',
          Choices: [{ Variable: '$.pipelineResult.durationS', IsPresent: true, Next: 'SetRealDurationFromPipeline' }],
          Default: 'SetRealDurationFromPlanned',
        },
        SetRealDurationFromPipeline: { Type: 'Pass', Parameters: { 'value.$': '$.pipelineResult.durationS' }, ResultPath: '$.realDuration', Next: 'BuildFrameVideo' },
        SetRealDurationFromPlanned: { Type: 'Pass', Parameters: { 'value.$': '$.duration' }, ResultPath: '$.realDuration', Next: 'BuildFrameVideo' },
        BuildFrameVideo: {
          Type: 'Pass',
          Comment: 'Emit the per-frame video item the concat step consumes (videoUrl = pipeline output: merged animation + voice). duration comes from $.realDuration (the pod\'s actual reported length, see NormalizeRealDuration above), not the originally-planned $.duration, so downstream concat/SRT timing and RenderTextOverlay\'s forced clip length both match the real artifact. textManifest carried through (normalized to \'\' by NormalizeTextManifest above when absent) so RouteTextOverlay/RenderTextOverlay below can read it — this Pass\'s Parameters block replaces $ entirely, so anything not named here would otherwise be lost before the overlay step could see it.',
          Parameters: {
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            'videoUrl.$': '$.pipelineResult.cdnUrl',
            'duration.$': '$.realDuration.value',
            'textManifest.$': '$.textManifest',
          },
          Next: 'RouteTextOverlay',
        },
      },
    },
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'DropFrameData',
  };
}

const STD_RETRY = [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }];

/**
 * One Parallel branch (self-contained mini state machine) generating one
 * localized language's per-frame TTS via self-hosted Kokoro
 * (voice.narrationBasic.ttsFrameLocalizedKokoro) — Narration Basic uses
 * Kokoro for all four languages (en/es/pt-BR/hi), never Qwen voice clone;
 * Qwen is Premium-only (see localizationStates()'s ttsTask() for that tier's
 * whole-script flow, not yet ported to per-frame). Originally es/pt-BR had
 * their own Qwen-capable branch (data-driven Qwen-vs-Kokoro choice) separate
 * from Hindi's Kokoro-only one — collapsed into this single function
 * 2026-07-26 once the product call above ruled Qwen out for Basic entirely.
 *
 * `langName` is the full English language name ('Spanish'/'Portuguese'/
 * 'Hindi') — RunPod's Kokoro handler resolves it via KOKORO_LANG_CODE
 * (runpod.ts), which is keyed by full lowercase names, not locale codes; a
 * bare code like 'es' isn't recognized and silently falls back to the
 * catalog rung's fixed hf_alpha/langCode:h. That fallback happens to be
 * correct for Hindi (masking the bug there) but would be wrong for Spanish/
 * Portuguese. Found live 2026-07-26 when the old Qwen leg sent the same bare
 * code as its `language` param and RunPod's Qwen engine rejected it outright
 * ("Invalid language 'es'/'pt-BR'. Valid: [...English names...]").
 *
 * `frameId` is composited with the language code (`${frameId}:es`) — without
 * this, qm-generate.ts derives an identical requestId across the 4 parallel
 * per-language branches for the same frame (same assetType/operation), and
 * QM's idempotent-by-requestId /jobs de-dup would collapse them onto one
 * shared job, exactly like the whole-script bug already fixed once (see
 * ttsTask()'s comment in localizationStates below).
 *
 * When StoryStudio sends no explicit voiceId for this language (Default
 * leg), `voiceGender.$` is forwarded so qm-generate.ts's
 * defaultLocalizedKokoroVoiceId can resolve a language+gender-appropriate
 * Kokoro voice_id itself (spanish/portuguese/hindi × male/female) — added
 * 2026-07-26 so the fallback isn't just the catalog rung's single fixed
 * hf_alpha (Hindi female, wrong language entirely for es/pt-BR). Spanish/
 * Portuguese pairs are unverified live (used_in_catalog:false in
 * qwen-voice-clone/docs/voice-catalog.json) — same posture as the 2026-07-08
 * Hindi check; confirm on the pod before trusting in production.
 */
function localizedFrameTtsKokoroBranch(
  qmGenerateArn: string, langCode: string, langKey: string, langName: string,
  narrationField: string, idField: string,
): { StartAt: string; States: Record<string, unknown> } {
  const frameIdExpr = `States.Format('{}:${langCode}', $.frameId)`;
  return {
    StartAt: `RouteTTSFourLang${langKey}`,
    States: {
      [`RouteTTSFourLang${langKey}`]: {
        Type: 'Choice',
        Comment: `Empty ${narrationField} (StoryStudio always sends this key on a fourLang project — "" means ${langCode} generation failed for this frame, per storystudio-4lang-video-pipeline-handoff.md §1) -> skip ${langCode} for this frame rather than sending an empty TTS prompt.`,
        Choices: [{
          And: [
            { Variable: `$.${narrationField}`, IsPresent: true },
            { Variable: `$.${narrationField}`, IsString: true },
            { Not: { Variable: `$.${narrationField}`, StringEquals: '' } },
          ],
          Next: `RouteVoiceIdFourLang${langKey}`,
        }],
        Default: `SkipTTSFourLang${langKey}`,
      },
      [`SkipTTSFourLang${langKey}`]: { Type: 'Pass', Parameters: { cdnUrl: '', durationS: 0, skipped: true }, End: true },
      [`RouteVoiceIdFourLang${langKey}`]: {
        Type: 'Choice',
        Comment: `${idField} is optional — IsPresent-guarded before the .$ reference below (a bare Parameters .$ reference to an absent key throws States.Runtime). Absent -> QM-generate.ts's defaultLocalizedKokoroVoiceId resolves a language+gender-appropriate Kokoro voice_id server-side (falling back to the catalog rung's fixed hf_alpha/langCode:h only if that lookup also misses).`,
        Choices: [{
          And: [
            { Variable: `$$.Execution.Input.${idField}`, IsPresent: true },
            { Variable: `$$.Execution.Input.${idField}`, IsString: true },
            { Not: { Variable: `$$.Execution.Input.${idField}`, StringEquals: '' } },
          ],
          Next: `QMGenerateTTSFourLang${langKey}WithVoice`,
        }],
        Default: `QMGenerateTTSFourLang${langKey}Default`,
      },
      [`QMGenerateTTSFourLang${langKey}WithVoice`]: {
        Type: 'Task',
        Resource: qmGenerateArn,
        Comment: `Per-frame localized TTS via QM (voice.narrationBasic.ttsFrameLocalizedKokoro), explicit ${idField}.`,
        Parameters: {
          assetType: 'voice', tier: 'narrationBasic', operation: 'ttsFrameLocalizedKokoro', product: 'narration', queue: 'background', jobType: 'batch',
          [`prompt.$`]: `$.${narrationField}`,
          language: langName,
          [`voiceId.$`]: `$$.Execution.Input.${idField}`,
          'projectId.$': '$$.Execution.Input.projectId',
          'frameId.$': frameIdExpr,
          'userId.$': '$$.Execution.Input.userId',
        },
        TimeoutSeconds: 920,
        Retry: STD_RETRY,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: `$.ttsError${langKey}`, Next: `TtsFailedFourLang${langKey}` }],
        End: true,
      },
      [`QMGenerateTTSFourLang${langKey}Default`]: {
        Type: 'Task',
        Resource: qmGenerateArn,
        Comment: `Per-frame localized TTS via QM (voice.narrationBasic.ttsFrameLocalizedKokoro), no explicit ${idField} — voiceGender.$ lets QM-generate.ts pick a language+gender-appropriate default voice_id (defaultLocalizedKokoroVoiceId).`,
        Parameters: {
          assetType: 'voice', tier: 'narrationBasic', operation: 'ttsFrameLocalizedKokoro', product: 'narration', queue: 'background', jobType: 'batch',
          [`prompt.$`]: `$.${narrationField}`,
          language: langName,
          'voiceGender.$': '$$.Execution.Input.voiceGender',
          'projectId.$': '$$.Execution.Input.projectId',
          'frameId.$': frameIdExpr,
          'userId.$': '$$.Execution.Input.userId',
        },
        TimeoutSeconds: 920,
        Retry: STD_RETRY,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: `$.ttsError${langKey}`, Next: `TtsFailedFourLang${langKey}` }],
        End: true,
      },
      [`TtsFailedFourLang${langKey}`]: { Type: 'Pass', Parameters: { cdnUrl: '', durationS: 0, failed: true }, End: true },
    },
  };
}

/**
 * English's TTS branch — identical logic to qmFrameAssetsMap's
 * RouteExplainerTTS/UseProvidedExplainerVoice/QMGenerateExplainerTTS, just
 * reshaped as a standalone Parallel branch (End:true, no ResultPath on the
 * Task so its raw {cdnUrl,durationS,...} result becomes the branch's own $).
 * English's narrationText is never empty (required unless voiceUrl is set —
 * see the frame contract), so no skip branch is needed here.
 */
function localizedFrameTtsEnBranch(qmGenerateArn: string): { StartAt: string; States: Record<string, unknown> } {
  return {
    StartAt: 'RouteTTSFourLangEn',
    States: {
      RouteTTSFourLangEn: {
        Type: 'Choice',
        Choices: [{
          And: [
            { Variable: '$.voiceUrl', IsPresent: true },
            { Variable: '$.voiceUrl', IsString: true },
            { Not: { Variable: '$.voiceUrl', StringEquals: '' } },
          ],
          Next: 'UseProvidedVoiceFourLangEn',
        }],
        Default: 'QMGenerateTTSFourLangEn',
      },
      UseProvidedVoiceFourLangEn: { Type: 'Pass', Parameters: { 'cdnUrl.$': '$.voiceUrl', 'durationS.$': '$.duration' }, End: true },
      QMGenerateTTSFourLangEn: {
        Type: 'Task',
        Resource: qmGenerateArn,
        Comment: 'English TTS via QM (voice.narrationBasic.tts: self-hosted Kokoro-82M -> Replicate fallback) — same rung the single-language frame Map uses.',
        Parameters: {
          assetType: 'voice', tier: 'narrationBasic', operation: 'tts', product: 'narration', queue: 'background', jobType: 'batch',
          'prompt.$': '$.narrationText',
          'voiceGender.$': '$$.Execution.Input.voiceGender',
          'projectId.$': '$$.Execution.Input.projectId',
          'frameId.$': '$.frameId',
          'userId.$': '$$.Execution.Input.userId',
        },
        TimeoutSeconds: 920,
        Retry: STD_RETRY,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsErrorEn', Next: 'TtsFailedFourLangEn' }],
        End: true,
      },
      TtsFailedFourLangEn: { Type: 'Pass', Parameters: { cdnUrl: '', durationS: 0, failed: true }, End: true },
    },
  };
}

/**
 * Merge branch for one language — same video.narrationBasic.merge rung the
 * single-language flow uses, plus a new `durationS` param (the frame's shared
 * max-across-4-languages duration) so a language whose TTS came in shorter
 * than the animated clip gets its audio padded with trailing silence rather
 * than left short (storystudio-4lang-video-pipeline-handoff.md §3/§6). NOT
 * YET EMPIRICALLY VERIFIED that the RunPod merge worker actually pads to this
 * — same verification posture as the 2026-07-08 Qwen/Kokoro language check;
 * flagged in the implementation plan as a pre-production check, not a
 * blocker to building this plumbing.
 *
 * Starts with its own skip-check (this language's TTS cdnUrl empty — skipped
 * or failed upstream) rather than a static skip flag, so the Parallel this
 * branch lives in (MergeFourLangAudio) can decide per-frame at runtime. Every
 * exit path (skip / merge success / merge failure) explicitly sets a
 * `failed` boolean — BuildFrameVideoFourLang reads it directly via a plain
 * `.$` reference (there's no States.Or/boolean-OR intrinsic in ASL, so the
 * failure flag has to be computed once, here, not derived downstream from
 * multiple upstream fields).
 *
 * `frameId` is composited with `langCode` (`${frameId}:es`) — all 4 branches
 * share the same assetType/operation (`video`/`merge`, no per-language
 * operation name the way TTS has `tts` vs `ttsFrameLocalized{Kokoro,Qwen}`),
 * so without this every language's merge call for a frame produced the
 * IDENTICAL requestId (`{projectId}:{frameId}:video:merge`) *and* the
 * identical jobId (a hash of assetType/tier/operation/prompt/params —
 * `audioUrl` isn't part of that hash, so 4 calls with different audio but
 * otherwise-identical params hash the same). QM's `/jobs` is idempotent by
 * requestId, so all 4 collapsed onto ONE shared job — whichever language's
 * call reached QM first "won", and the other 3 silently got back that same
 * merged clip instead of their own audio. Found live 2026-07-26 tracing a
 * garbled Hindi Whisper re-transcription (a repeating-stutter artifact) back
 * to only ONE `video:merge` completion ever logged per frame instead of 4.
 * Exactly the collision class `localizedFrameTtsKokoroBranch`/
 * `localizedFrameTtsEnBranch` already guard against for TTS — merge never
 * got the same treatment when this Parallel was built.
 */
function fourLangMergeBranch(qmGenerateArn: string, langKey: string, ttsFieldKey: string, langCode: string): { StartAt: string; States: Record<string, unknown> } {
  const route = `RouteMergeFourLang${langKey}`;
  const skip = `MergeSkip${langKey}`;
  const task = `QMMergeFourLang${langKey}`;
  const success = `MergeSuccess${langKey}`;
  const failed = `MergeFailed${langKey}`;
  const frameIdExpr = `States.Format('{}:${langCode}', $.frameId)`;
  return {
    StartAt: route,
    States: {
      [route]: {
        Type: 'Choice',
        Comment: `${langKey}'s TTS was skipped or failed for this frame (empty cdnUrl) — skip merge too rather than merging an empty audio URL.`,
        Choices: [{
          And: [
            { Variable: `$.ttsResults.${ttsFieldKey}.cdnUrl`, IsPresent: true },
            { Variable: `$.ttsResults.${ttsFieldKey}.cdnUrl`, IsString: true },
            { Not: { Variable: `$.ttsResults.${ttsFieldKey}.cdnUrl`, StringEquals: '' } },
          ],
          Next: task,
        }],
        Default: skip,
      },
      [skip]: { Type: 'Pass', Parameters: { cdnUrl: '', failed: true }, End: true },
      [task]: {
        Type: 'Task',
        Resource: qmGenerateArn,
        Comment: `Merge this frame's ${langKey} TTS audio onto the SHARED animated clip (video.narrationBasic.merge) — same rung, same clip, every language merges onto it independently. durationS = the frame's max-across-4-languages duration (target for silence-padding a shorter track, see this function's header comment).`,
        Parameters: {
          assetType: 'video', tier: 'narrationBasic', operation: 'merge', product: 'narration', queue: 'background', jobType: 'batch',
          'initImageUrls.$': 'States.Array($.animateResult.cdnUrl)',
          'audioUrl.$': `$.ttsResults.${ttsFieldKey}.cdnUrl`,
          'durationS.$': '$.maxDuration.value',
          'projectId.$': '$$.Execution.Input.projectId',
          'frameId.$': frameIdExpr,
          'userId.$': '$$.Execution.Input.userId',
        },
        ResultPath: '$.mergeTaskResult',
        TimeoutSeconds: 920,
        Retry: STD_RETRY,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: `$.mergeError${langKey}`, Next: failed }],
        Next: success,
      },
      [success]: { Type: 'Pass', Parameters: { 'cdnUrl.$': '$.mergeTaskResult.cdnUrl', failed: false }, End: true },
      [failed]: { Type: 'Pass', Parameters: { cdnUrl: '', failed: true }, End: true },
    },
  };
}

/**
 * One Parallel branch (self-contained mini state machine) applying the
 * per-frame Remotion text overlay for one language — generalizes the
 * original English-only Route/Render/Apply/Skip chain to run once per
 * language (storystudio-4lang-text-overlay-handoff.md, 2026-07-26).
 * StoryStudio now sends `textManifestEs`/`textManifestPtBr`/`textManifestHi`
 * (same shape as the existing `textManifest`, only `textElements[].content`
 * translated) alongside the English field, for frame 1's title card and
 * text-free-genre on-screen captions in every language, not just English.
 *
 * Empty `textManifest{X}` (StoryStudio always sends the key — "" means no
 * on-screen text for this language/frame) -> skip overlay, pass the merged
 * clip through unchanged. An overlay failure is NOT a language failure —
 * same passthrough policy the original English branch used: fall back to
 * the un-overlaid clip rather than failing the frame or this language (TTS/
 * merge upstream already own the real per-language all-or-nothing failure
 * semantics — esFailed/ptBrFailed/hiFailed are untouched by this branch).
 */
function fourLangTextOverlayBranch(
  remotionOverlayArn: string, langKey: string, videoUrlField: string, manifestField: string,
): { StartAt: string; States: Record<string, unknown> } {
  const route = `RouteTextOverlayFourLang${langKey}`;
  const render = `RenderTextOverlayFourLang${langKey}`;
  const apply = `ApplyTextOverlayFourLang${langKey}`;
  const skip = `SkipTextOverlayFourLang${langKey}`;
  return {
    StartAt: route,
    States: {
      [route]: {
        Type: 'Choice',
        Comment: `Empty ${manifestField} -> this frame has no on-screen text for ${langKey} (or isn't a fourLang project) -> skip overlay, keep the merged clip as-is.`,
        Choices: [{
          And: [
            { Variable: `$.${manifestField}`, IsPresent: true },
            { Variable: `$.${manifestField}`, IsString: true },
            { Not: { Variable: `$.${manifestField}`, StringEquals: '' } },
          ],
          Next: render,
        }],
        Default: skip,
      },
      [render]: {
        Type: 'Task',
        Resource: remotionOverlayArn,
        Comment: `Per-frame Remotion text-overlay render for ${langKey} (storystudio-4lang-text-overlay-handoff.md) — clipUrl is this language's already-audio-merged clip, not English's.`,
        Parameters: {
          'clipUrl.$': `$.videoUrls.${videoUrlField}`,
          'textManifest.$': `$.${manifestField}`,
          'frameId.$': '$.frameId',
          'duration.$': '$.duration',
        },
        ResultPath: '$.overlayResult', TimeoutSeconds: 180, Retry: STD_RETRY,
        Catch: [{ ErrorEquals: ['States.ALL'], Comment: 'Passthrough failure policy — an overlay failure degrades to the un-overlaid clip rather than failing the frame or this language.', ResultPath: '$.overlayError', Next: skip }],
        Next: apply,
      },
      [apply]: { Type: 'Pass', Parameters: { 'cdnUrl.$': '$.overlayResult.overlayRenderedUrl' }, End: true },
      [skip]: { Type: 'Pass', Parameters: { 'cdnUrl.$': `$.videoUrls.${videoUrlField}` }, End: true },
    },
  };
}

/**
 * fourLang per-frame Map (storystudio-4lang-video-pipeline-handoff.md, built
 * 2026-07-25): supersedes localizationStates()'s whole-script post-concat
 * flow for Narration-Basic-QM-New. Per frame: image ONCE (standalone t2i/i2i
 * — never the one-shot `pipeline` rung, which bundles TTS+animate+merge for
 * a single language) -> TTS x4 in parallel (en/es/pt-BR/hi; a language whose
 * narrationText{Es,PtBr,Hi} is empty for this frame is skipped, not an error)
 * -> the frame's video duration is the MAX of whichever languages succeeded
 * (no ASL max() intrinsic, so a 3-step pairwise Choice/Pass chain) -> animate
 * ONCE at that max duration (the video is shared/common across languages,
 * only the audio differs) -> merge x4 (each language's TTS audio onto the
 * SAME shared animated clip, padded to the max duration for the languages
 * that came in shorter) -> text overlay x4 (per-language Remotion burn-in,
 * storystudio-4lang-text-overlay-handoff.md 2026-07-26 — each language
 * overlays its own translated textManifest{Es,PtBr,Hi} onto its own merged
 * clip, not just English) -> emit videoUrls{en,es,ptBr,hi} + per-language
 * failure flags (esFailed/ptBrFailed/hiFailed), consumed downstream by
 * fourLangConcatFinalizeStates()'s all-or-nothing per-language omission.
 *
 * MaxConcurrency is deliberately far below qmFrameAssetsMap's 15: this Map
 * adds up to 3 more parallel TTS calls and 3 more parallel merge calls PER
 * FRAME against the same runpod:flux-tts-s2t 6-worker pool the image/animate
 * calls already share (fleet.ts FLUX_TTS_S2T). Starting conservative (4) —
 * executor.ts's requeueForCapacity backpressure queues gracefully either way,
 * so this is a latency knob to tune from real dev-stack timing, not a
 * correctness one (see the implementation plan's Concurrency risk note).
 */
function qmFourLangFrameAssetsMap(qmGenerateArn: string, remotionOverlayArn: string): object {
  return {
    Type: 'Map',
    Comment: 'fourLang per-frame video via Quartermaster gateway: image once, TTS x4 (en/es/pt-BR/hi), video animated once at the max TTS duration across languages, merge x4 onto the shared clip. Supersedes the old whole-script post-concat localization for fourLang:true Narration-Basic projects.',
    ItemsPath: '$.frames',
    MaxConcurrency: 4,
    ResultPath: '$.videoResults',
    Iterator: {
      StartAt: 'NormalizeTextManifestFourLang',
      States: {
        NormalizeTextManifestFourLang: {
          Type: 'Choice',
          Comment: 'Guarantee $.textManifest is a real string before BuildFrameVideoFourLang references it — same gotcha textOverlayStates()\'s NormalizeTextManifest guards against.',
          Choices: [{
            And: [
              { Variable: '$.textManifest', IsPresent: true },
              { Variable: '$.textManifest', IsString: true },
              { Not: { Variable: '$.textManifest', StringEquals: '' } },
            ],
            Next: 'NormalizeTextManifestEsFourLang',
          }],
          Default: 'SetTextManifestDefaultFourLang',
        },
        SetTextManifestDefaultFourLang: { Type: 'Pass', Result: '', ResultPath: '$.textManifest', Next: 'NormalizeTextManifestEsFourLang' },
        // Es/PtBr/Hi guards (storystudio-4lang-text-overlay-handoff.md, 2026-07-26)
        // — same "absent key throws States.Runtime on a bare .$ reference" gotcha
        // as English's guard above, for the 3 new per-language manifest fields
        // fourLangTextOverlayBranch's Render step references.
        NormalizeTextManifestEsFourLang: {
          Type: 'Choice',
          Comment: 'Guarantee $.textManifestEs is a real string before TextOverlayFourLang references it.',
          Choices: [{
            And: [{ Variable: '$.textManifestEs', IsPresent: true }, { Variable: '$.textManifestEs', IsString: true }],
            Next: 'NormalizeTextManifestPtBrFourLang',
          }],
          Default: 'SetTextManifestEsDefaultFourLang',
        },
        SetTextManifestEsDefaultFourLang: { Type: 'Pass', Result: '', ResultPath: '$.textManifestEs', Next: 'NormalizeTextManifestPtBrFourLang' },
        NormalizeTextManifestPtBrFourLang: {
          Type: 'Choice',
          Comment: 'Guarantee $.textManifestPtBr is a real string before TextOverlayFourLang references it.',
          Choices: [{
            And: [{ Variable: '$.textManifestPtBr', IsPresent: true }, { Variable: '$.textManifestPtBr', IsString: true }],
            Next: 'NormalizeTextManifestHiFourLang',
          }],
          Default: 'SetTextManifestPtBrDefaultFourLang',
        },
        SetTextManifestPtBrDefaultFourLang: { Type: 'Pass', Result: '', ResultPath: '$.textManifestPtBr', Next: 'NormalizeTextManifestHiFourLang' },
        NormalizeTextManifestHiFourLang: {
          Type: 'Choice',
          Comment: 'Guarantee $.textManifestHi is a real string before TextOverlayFourLang references it.',
          Choices: [{
            And: [{ Variable: '$.textManifestHi', IsPresent: true }, { Variable: '$.textManifestHi', IsString: true }],
            Next: 'RouteImageModelFourLang',
          }],
          Default: 'SetTextManifestHiDefaultFourLang',
        },
        SetTextManifestHiDefaultFourLang: { Type: 'Pass', Result: '', ResultPath: '$.textManifestHi', Next: 'RouteImageModelFourLang' },
        RouteImageModelFourLang: {
          Type: 'Choice',
          Comment: 'Image generation must always be a standalone call for fourLang frames (never the one-shot pipeline rung, which bundles a single language\'s TTS+animate+merge) — same imageModel routing rule as qmFrameAssetsMap\'s RouteImageModel/RouteImageGen, decomposed.',
          Choices: [{
            Or: [
              { And: [{ Variable: '$.imageModel', IsPresent: true }, { Variable: '$.imageModel', IsString: true }, { Variable: '$.imageModel', StringEquals: 'ernie' }] },
              { And: [{ Variable: '$.imageModel', IsPresent: true }, { Variable: '$.imageModel', IsString: true }, { Variable: '$.imageModel', StringEquals: 'qwen-image-gen' }] },
            ],
            Next: 'QMGenerateImageExplainerFourLang',
          }],
          Default: 'RouteImageI2IFourLang',
        },
        RouteImageI2IFourLang: {
          Type: 'Choice',
          Choices: [{
            And: [
              { Variable: '$.referenceImageUrl', IsPresent: true },
              { Variable: '$.referenceImageUrl', IsString: true },
              { Not: { Variable: '$.referenceImageUrl', StringEquals: '' } },
            ],
            Next: 'QMGenerateImageI2IFourLang',
          }],
          Default: 'QMGenerateImageT2IFourLang',
        },
        QMGenerateImageExplainerFourLang: {
          Type: 'Task', Resource: qmGenerateArn,
          Comment: 'Text-to-image via QM (image.explainer.t2i) — same rung/rule as qmFrameAssetsMap\'s QMGenerateExplainerImage.',
          Parameters: {
            assetType: 'image', tier: 'explainer', operation: 't2i', product: 'narration', queue: 'background', jobType: 'batch',
            'prompt.$': '$.imagePrompt', 'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId', 'frameId.$': '$.frameId', 'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.imageResult', TimeoutSeconds: 920, Retry: STD_RETRY,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'QMFrameFailedFourLang' }],
          Next: 'GenerateFourLangTts',
        },
        QMGenerateImageT2IFourLang: {
          Type: 'Task', Resource: qmGenerateArn,
          Comment: 'Text-to-image via QM (image.narrationBasic.t2i), standalone (not the one-shot pipeline).',
          Parameters: {
            assetType: 'image', tier: 'narrationBasic', operation: 't2i', product: 'narration', queue: 'background', jobType: 'batch',
            'prompt.$': '$.imagePrompt', 'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId', 'frameId.$': '$.frameId', 'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.imageResult', TimeoutSeconds: 920, Retry: STD_RETRY,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'QMFrameFailedFourLang' }],
          Next: 'GenerateFourLangTts',
        },
        QMGenerateImageI2IFourLang: {
          Type: 'Task', Resource: qmGenerateArn,
          Comment: 'Image-to-image via QM (image.narrationBasic.i2i), standalone.',
          Parameters: {
            assetType: 'image', tier: 'narrationBasic', operation: 'i2i', product: 'narration', queue: 'background', jobType: 'batch',
            'prompt.$': '$.imagePrompt', 'initImageUrls.$': 'States.Array($.referenceImageUrl)', 'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId', 'frameId.$': '$.frameId', 'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.imageResult', TimeoutSeconds: 920, Retry: STD_RETRY,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'QMFrameFailedFourLang' }],
          Next: 'GenerateFourLangTts',
        },
        QMFrameFailedFourLang: {
          Type: 'Pass',
          Comment: 'Image generation failed — this frame can\'t produce ANY language\'s video (image is shared), so fail the whole frame (mirrors QMFrameFailed).',
          Parameters: { failed: true, error: 'QMFrameFailed', 'frameId.$': '$.frameId', 'frameNumber.$': '$.frameNumber' },
          End: true,
        },
        GenerateFourLangTts: {
          Type: 'Parallel',
          Comment: 'TTS x4, one branch per language. Each branch outputs {cdnUrl, durationS} (skipped/failed languages get durationS:0, cdnUrl:\'\').',
          Branches: [
            localizedFrameTtsEnBranch(qmGenerateArn),
            localizedFrameTtsKokoroBranch(qmGenerateArn, 'es', 'Es', 'Spanish', 'narrationTextEs', 'voiceIdEs'),
            localizedFrameTtsKokoroBranch(qmGenerateArn, 'pt-BR', 'PtBr', 'Portuguese', 'narrationTextPtBr', 'voiceIdPtBr'),
            localizedFrameTtsKokoroBranch(qmGenerateArn, 'hi', 'Hi', 'Hindi', 'narrationTextHi', 'voiceIdHi'),
          ],
          ResultSelector: { 'en.$': '$[0]', 'es.$': '$[1]', 'ptBr.$': '$[2]', 'hi.$': '$[3]' },
          ResultPath: '$.ttsResults',
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsResultsError', Next: 'QMFrameFailedFourLang' }],
          Next: 'ComputeMaxDurationStep1',
        },
        // No max() intrinsic in ASL — pairwise Choice/Pass chain across the 4
        // languages' durationS (0 for a skipped/failed language, so it never
        // wins the max).
        ComputeMaxDurationStep1: {
          Type: 'Choice',
          Choices: [{ Variable: '$.ttsResults.en.durationS', NumericGreaterThanPath: '$.ttsResults.es.durationS', Next: 'SetMaxDurationStep1En' }],
          Default: 'SetMaxDurationStep1Es',
        },
        SetMaxDurationStep1En: { Type: 'Pass', Parameters: { 'value.$': '$.ttsResults.en.durationS' }, ResultPath: '$.maxDurationStep1', Next: 'ComputeMaxDurationStep2' },
        SetMaxDurationStep1Es: { Type: 'Pass', Parameters: { 'value.$': '$.ttsResults.es.durationS' }, ResultPath: '$.maxDurationStep1', Next: 'ComputeMaxDurationStep2' },
        ComputeMaxDurationStep2: {
          Type: 'Choice',
          Choices: [{ Variable: '$.maxDurationStep1.value', NumericGreaterThanPath: '$.ttsResults.ptBr.durationS', Next: 'SetMaxDurationStep2Prev' }],
          Default: 'SetMaxDurationStep2PtBr',
        },
        SetMaxDurationStep2Prev: { Type: 'Pass', Parameters: { 'value.$': '$.maxDurationStep1.value' }, ResultPath: '$.maxDurationStep2', Next: 'ComputeMaxDurationStep3' },
        SetMaxDurationStep2PtBr: { Type: 'Pass', Parameters: { 'value.$': '$.ttsResults.ptBr.durationS' }, ResultPath: '$.maxDurationStep2', Next: 'ComputeMaxDurationStep3' },
        ComputeMaxDurationStep3: {
          Type: 'Choice',
          Choices: [{ Variable: '$.maxDurationStep2.value', NumericGreaterThanPath: '$.ttsResults.hi.durationS', Next: 'SetMaxDurationFinalPrev' }],
          Default: 'SetMaxDurationFinalHi',
        },
        SetMaxDurationFinalPrev: { Type: 'Pass', Parameters: { 'value.$': '$.maxDurationStep2.value' }, ResultPath: '$.maxDuration', Next: 'QMGenerateAnimateFourLang' },
        SetMaxDurationFinalHi: { Type: 'Pass', Parameters: { 'value.$': '$.ttsResults.hi.durationS' }, ResultPath: '$.maxDuration', Next: 'QMGenerateAnimateFourLang' },
        QMGenerateAnimateFourLang: {
          Type: 'Task', Resource: qmGenerateArn,
          Comment: 'Ken Burns animation via QM (video.narrationBasic.animate), ONCE per frame, sized to the max TTS duration across all 4 languages — this clip is shared/common across every language\'s merge below.',
          Parameters: {
            assetType: 'video', tier: 'narrationBasic', operation: 'animate', product: 'narration', queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'durationS.$': '$.maxDuration.value',
            'projectId.$': '$$.Execution.Input.projectId', 'frameId.$': '$.frameId', 'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.animateResult', TimeoutSeconds: 920, Retry: STD_RETRY,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.animateError', Next: 'QMFrameFailedFourLang' }],
          Next: 'MergeFourLangAudio',
        },
        MergeFourLangAudio: {
          Type: 'Parallel',
          Comment: 'Merge x4 — each language\'s TTS audio onto the SAME shared animated clip. A language whose TTS was skipped/failed for this frame skips merge too.',
          Branches: [
            fourLangMergeBranch(qmGenerateArn, 'En', 'en', 'en'),
            fourLangMergeBranch(qmGenerateArn, 'Es', 'es', 'es'),
            fourLangMergeBranch(qmGenerateArn, 'PtBr', 'ptBr', 'pt-BR'),
            fourLangMergeBranch(qmGenerateArn, 'Hi', 'hi', 'hi'),
          ],
          ResultSelector: { 'en.$': '$[0]', 'es.$': '$[1]', 'ptBr.$': '$[2]', 'hi.$': '$[3]' },
          ResultPath: '$.mergeResults',
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.mergeResultsError', Next: 'QMFrameFailedFourLang' }],
          Next: 'BuildFrameVideoFourLang',
        },
        BuildFrameVideoFourLang: {
          Type: 'Pass',
          Comment: 'Emit the per-frame multi-language item fourLangConcatFinalizeStates() consumes. A skipped/failed merge lands as cdnUrl:\'\' — esFailed/ptBrFailed/hiFailed drive the all-or-nothing per-language omission downstream (English never fails independently of the whole frame — see QMFrameFailedFourLang).',
          Parameters: {
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            'duration.$': '$.maxDuration.value',
            'textManifest.$': '$.textManifest',
            'textManifestEs.$': '$.textManifestEs',
            'textManifestPtBr.$': '$.textManifestPtBr',
            'textManifestHi.$': '$.textManifestHi',
            videoUrls: {
              'en.$': '$.mergeResults.en.cdnUrl',
              'es.$': '$.mergeResults.es.cdnUrl',
              'ptBr.$': '$.mergeResults.ptBr.cdnUrl',
              'hi.$': '$.mergeResults.hi.cdnUrl',
            },
            'esFailed.$': '$.mergeResults.es.failed',
            'ptBrFailed.$': '$.mergeResults.ptBr.failed',
            'hiFailed.$': '$.mergeResults.hi.failed',
          },
          Next: 'TextOverlayFourLang',
        },
        TextOverlayFourLang: {
          Type: 'Parallel',
          Comment: 'Text overlay x4 — one per-language Remotion burn-in branch (storystudio-4lang-text-overlay-handoff.md, 2026-07-26), each overlaying its own translated textManifest{Es,PtBr,Hi} onto its own merged clip. A language with no on-screen text for this frame (or an overlay failure) passes its merged clip through unchanged — never fails the frame.',
          Branches: [
            fourLangTextOverlayBranch(remotionOverlayArn, 'En', 'en', 'textManifest'),
            fourLangTextOverlayBranch(remotionOverlayArn, 'Es', 'es', 'textManifestEs'),
            fourLangTextOverlayBranch(remotionOverlayArn, 'PtBr', 'ptBr', 'textManifestPtBr'),
            fourLangTextOverlayBranch(remotionOverlayArn, 'Hi', 'hi', 'textManifestHi'),
          ],
          ResultSelector: { 'en.$': '$[0].cdnUrl', 'es.$': '$[1].cdnUrl', 'ptBr.$': '$[2].cdnUrl', 'hi.$': '$[3].cdnUrl' },
          ResultPath: '$.overlaidVideoUrls',
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.overlayResultsError', Next: 'QMFrameFailedFourLang' }],
          Next: 'FinalizeFrameVideoFourLang',
        },
        FinalizeFrameVideoFourLang: {
          Type: 'Pass',
          Comment: 'Reshape TextOverlayFourLang\'s Parallel result back into the per-frame item fourLangConcatFinalizeStates() consumes — same shape BuildFrameVideoFourLang emitted before overlay, videoUrls now overlaid where applicable.',
          Parameters: {
            'frameId.$': '$.frameId', 'frameNumber.$': '$.frameNumber', 'duration.$': '$.duration',
            'videoUrls.$': '$.overlaidVideoUrls',
            'esFailed.$': '$.esFailed', 'ptBrFailed.$': '$.ptBrFailed', 'hiFailed.$': '$.hiFailed',
          },
          End: true,
        },
      },
    },
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'DropFrameData',
  };
}

/** One Parallel branch reshaping $.videoResults into a flat {videoUrl,frameNumber}[]
 * array for one language, via Map ItemSelector + a no-op Identity iterator —
 * the standard JSONPath-mode idiom for projecting one field across an array
 * (ASL has no map/project intrinsic). fieldKey matches videoUrls' property
 * names (en/es/ptBr/hi). */
function langVideoArrayBranch(fieldKey: string): { StartAt: string; States: Record<string, unknown> } {
  // State names (including the nested Iterator's) must be unique across ALL
  // branches of the containing Parallel (BuildLangVideoArrays below), not
  // just within this one branch — confirmed via
  // `aws stepfunctions validate-state-machine-definition` (DUPLICATE_STATE_NAME),
  // so every name here is suffixed with fieldKey.
  const reshape = `Reshape${fieldKey}`;
  const identity = `Identity${fieldKey}`;
  return {
    StartAt: reshape,
    States: {
      [reshape]: {
        Type: 'Map',
        ItemsPath: '$.videoResults',
        MaxConcurrency: 20,
        ItemSelector: { 'videoUrl.$': `$$.Map.Item.Value.videoUrls.${fieldKey}`, 'frameNumber.$': '$$.Map.Item.Value.frameNumber' },
        Iterator: { StartAt: identity, States: { [identity]: { Type: 'Pass', End: true } } },
        End: true,
      },
    },
  };
}

/** Same idiom as langVideoArrayBranch, but extracts a flat boolean[] (via
 * OutputPath, unwrapping the ItemSelector's {flag} object down to the bare
 * value) for States.ArrayContains to check against below. field matches the
 * frame item's own failure-flag property (esFailed/ptBrFailed/hiFailed). */
function langFailureFlagBranch(field: string): { StartAt: string; States: Record<string, unknown> } {
  const reshape = `Reshape${field}`;
  const identity = `Identity${field}`;
  return {
    StartAt: reshape,
    States: {
      [reshape]: {
        Type: 'Map',
        ItemsPath: '$.videoResults',
        MaxConcurrency: 20,
        ItemSelector: { 'flag.$': `$$.Map.Item.Value.${field}` },
        Iterator: { StartAt: identity, States: { [identity]: { Type: 'Pass', OutputPath: '$.flag', End: true } } },
        End: true,
      },
    },
  };
}

/** One branch of ConcatenateVideosFourLang — same E2E-video-concat-premium
 * contract the single-language ConcatenateVideos already uses, unchanged,
 * just pointed at this language's reshaped video array and a language-suffixed
 * outputKey (own S3 subfolder for all 4 languages, including en, so this new
 * fourLang concat path never collides with the legacy single-language key).
 *
 * `omissionField` (unset for English, which is never omitted) gates the
 * concat call on `$.languageOmissions.<field>`, computed one state earlier by
 * ComputeLanguageOmissions. Without this gate, a language omitted on every
 * frame (all-empty videoUrls) still got sent to E2E-video-concat-premium,
 * which — found live 2026-07-26 debugging a full execution failure —
 * returns a 200 with an error-shaped body (`{statusCode:500,...}`, no
 * `audioUrl`) instead of throwing, so Step Functions treated it as success
 * and PrepareTranscribeFourLang's unconditional `.audioUrl` reference blew up
 * with States.Runtime, failing the ENTIRE execution over one omitted
 * language. Short-circuiting here to the same `{videoUrl:'',audioUrl:'',
 * failed:true}` shape the Catch-path already produces guarantees
 * `$.concatenatedVideosFourLang.<lang>.audioUrl` always resolves (to '' when
 * omitted), and skips a pointless external call besides. */
function concatFourLangBranch(
  fieldKey: string, langCode: string, omissionField?: string,
): { StartAt: string; States: Record<string, unknown> } {
  const state = `Concat${fieldKey}`;
  const failed = `${state}Failed`;
  const concatTask = {
    Type: 'Task',
    Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-video-concat-premium',
    Comment: `Concatenate all frame videos for ${langCode} (external Lambda, storystudio-unified-owned — unchanged {videoUrl,frameNumber}[] contract).`,
    Parameters: {
      'videos.$': `$.fourLangConcatPrep.${fieldKey}`,
      'aspectRatio.$': '$.aspectRatio',
      'projectId.$': '$.projectId',
      'outputKey.$': `States.Format('projects/{}/videos/${langCode}/concatenated.mp4', $.projectId)`,
      'jwtToken.$': '$.jwtToken',
      'apiKey.$': '$.apiKey',
    },
    TimeoutSeconds: 900,
    Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 10, MaxAttempts: 2, BackoffRate: 1.5 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: `$.concatError${fieldKey}`, Next: failed }],
    End: true,
  };
  const failedState = { Type: 'Pass', Comment: 'Isolate this language\'s concat failure from the other 3 — mirrors ConcatenateVideos\' own Catch->HandleFailure, but scoped per-language here.', Parameters: { videoUrl: '', audioUrl: '', failed: true }, End: true };

  if (!omissionField) {
    return { StartAt: state, States: { [state]: concatTask, [failed]: failedState } };
  }

  const route = `RouteConcat${fieldKey}`;
  const omitted = `${state}Omitted`;
  return {
    StartAt: route,
    States: {
      [route]: {
        Type: 'Choice',
        Comment: `${langCode} already known omitted (every frame failed/skipped it upstream, per ComputeLanguageOmissions) — skip the concat Lambda call entirely rather than sending it an all-empty video array.`,
        Choices: [{ Variable: `$.languageOmissions.${omissionField}`, BooleanEquals: true, Next: omitted }],
        Default: state,
      },
      [state]: concatTask,
      [omitted]: { Type: 'Pass', Comment: `${langCode} omitted before concat was ever attempted — same shape as ${failed} so downstream (PrepareTranscribeFourLang, FinalizeLocalizedVideos) can't tell the two apart.`, Parameters: { videoUrl: '', audioUrl: '', failed: true }, End: true },
      [failed]: failedState,
    },
  };
}

/** One branch of FinalizeLocalizedVideos — es/pt-BR/hi only (English reuses
 * the EXISTING ValidateFinalizeInputsBasic/PrepareFinalizeBasic/FinalizeVideoBasic
 * chain unchanged, via BuildMergedVoiceResultFourLangEn below, so its Fargate
 * finalize call is written once, not duplicated here).
 *
 * CROSS-REPO DEPENDENCY, not verified from this repo: `outputKey`/`language`
 * are NEW fields e2e-finalize (storystudio-unified) doesn't read today — the
 * existing FinalizeVideoBasic payload has no outputKey at all, meaning
 * e2e-finalize currently determines its own output location internally and
 * reports completion straight to Convex, never back through this ASL. For
 * the 3 new localized finalize calls to land at distinct, known locations
 * (rather than 3 languages racing to overwrite English's single default
 * output), e2e-finalize needs a corresponding change to honor a caller-
 * supplied outputKey. `finalVideoUrl` below is therefore a DETERMINISTIC
 * construction from that same outputKey (mirroring how qm-generate.ts's own
 * finalize() treats `cdnUrl` as literally the storage key, no separate CDN
 * base concatenation happening in this codebase) — not a value read back
 * from the Fargate task, which today never reports anything into SFN state.
 */
function finalizeLocalizedBranch(
  qmGenerateArn: string, fieldKey: string, langCode: string, omissionField: string, transcribeIndex: number,
): { StartAt: string; States: Record<string, unknown> } {
  const check = `CheckOmitted${fieldKey}`;
  const omitted = `Omitted${fieldKey}`;
  const prepare = `PrepareFinalize${fieldKey}`;
  const finalize = `FinalizeVideo${fieldKey}`;
  const finalizeFailed = `FinalizeFailed${fieldKey}`;
  const buildAsset = `BuildLocalizedAsset${fieldKey}`;
  const taskInputPath = `$.finalizeTaskInput${fieldKey}`;
  const outputKeyExpr = `States.Format('projects/{}/videos/${langCode}/final.mp4', $.projectId)`;
  return {
    StartAt: check,
    States: {
      [check]: {
        Type: 'Choice',
        Comment: `All-or-nothing per language (locked-in product decision): if ANY frame failed ${langCode}'s TTS/merge, skip finalize entirely and omit finalVideoUrl rather than shipping a video with silent gaps.`,
        Choices: [{ Variable: `$.languageOmissions.${omissionField}`, BooleanEquals: true, Next: omitted }],
        Default: prepare,
      },
      [omitted]: { Type: 'Pass', Parameters: { language: langCode, failed: true, error: 'PartialFailure' }, End: true },
      [prepare]: {
        Type: 'Pass',
        Comment: `Same finalizeTaskInput shape PrepareFinalizeBasic builds for English, for ${langCode}.`,
        Parameters: {
          mode: 'basic',
          'jobId.$': '$.jobId',
          'projectId.$': '$.projectId',
          'projectType.$': '$.projectType',
          'aspectRatio.$': '$.aspectRatio',
          'videoUrl.$': `$.concatenatedVideosFourLang.${fieldKey}.videoUrl`,
          'voiceAudioUrl.$': `$.concatenatedVideosFourLang.${fieldKey}.audioUrl`,
          'captionsUrl.$': `$.transcribeResultsFourLang[${transcribeIndex}].srtUrl`,
          'bgmUrl.$': '$.bgmResult.cdnUrl',
          language: langCode,
          'outputKey.$': outputKeyExpr,
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
        },
        ResultPath: taskInputPath,
        Next: finalize,
      },
      [finalize]: {
        Type: 'Task',
        Resource: 'arn:aws:states:::ecs:runTask.sync',
        Comment: `Finalize on Fargate for ${langCode} — same cluster/task-def as FinalizeVideoBasic. See this function's header comment for the cross-repo outputKey dependency.`,
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
              Environment: [{ Name: 'PAYLOAD_JSON', 'Value.$': `States.JsonToString(${taskInputPath})` }],
            }],
          },
        },
        ResultPath: `$.finalizeEcs${fieldKey}`,
        TimeoutSeconds: 3600,
        Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 1, BackoffRate: 2 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: `$.finalizeError${fieldKey}`, Next: finalizeFailed }],
        Next: buildAsset,
      },
      [finalizeFailed]: { Type: 'Pass', Parameters: { language: langCode, failed: true, error: 'FinalizeFailed' }, End: true },
      [buildAsset]: {
        Type: 'Pass',
        Parameters: {
          language: langCode,
          'voiceoverUrl.$': `$.concatenatedVideosFourLang.${fieldKey}.audioUrl`,
          'srtUrl.$': `$.transcribeResultsFourLang[${transcribeIndex}].srtUrl`,
          'finalVideoUrl.$': outputKeyExpr,
        },
        End: true,
      },
    },
  };
}

/**
 * Downstream of the fourLang frame Map: reshape per-language video arrays,
 * decide per-language omission (all-or-nothing on any frame failure),
 * concat x4, transcribe x4, then let English fall through the EXISTING
 * ValidateFinalizeInputsBasic/PrepareFinalizeBasic/FinalizeVideoBasic/Complete
 * chain unchanged while es/pt-BR/hi get their own finalize fan-out
 * (FinalizeLocalizedVideos), landing in $.localizedAssets per
 * storystudio-4lang-video-pipeline-handoff.md §4. Spliced in between
 * RouteConcatFourLang (see buildQmNewDefinition) and UpdateStatusApplyingBgm
 * — the non-fourLang path (ConcatenateVideos/TranscribeAudio/
 * BuildMergedVoiceResult, all unchanged) reaches the same UpdateStatusApplyingBgm
 * via SetNoLocalizedAssets instead.
 */
function fourLangConcatFinalizeStates(qmGenerateArn: string): Record<string, unknown> {
  return {
    BuildLangVideoArrays: {
      Type: 'Parallel',
      Comment: 'Reshape $.videoResults (per-frame items carrying 4 videoUrls + failure flags) into 4 flat {videoUrl,frameNumber}[] arrays (for ConcatenateVideosFourLang) and 3 flat boolean[] arrays (per-frame es/ptBr/hi failure flags, for the omission check below).',
      Branches: [
        langVideoArrayBranch('en'), langVideoArrayBranch('es'), langVideoArrayBranch('ptBr'), langVideoArrayBranch('hi'),
        langFailureFlagBranch('esFailed'), langFailureFlagBranch('ptBrFailed'), langFailureFlagBranch('hiFailed'),
      ],
      ResultSelector: {
        'en.$': '$[0]', 'es.$': '$[1]', 'ptBr.$': '$[2]', 'hi.$': '$[3]',
        'esFailedFlags.$': '$[4]', 'ptBrFailedFlags.$': '$[5]', 'hiFailedFlags.$': '$[6]',
      },
      ResultPath: '$.fourLangConcatPrep',
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
      Next: 'ComputeLanguageOmissions',
    },
    ComputeLanguageOmissions: {
      Type: 'Pass',
      Comment: 'All-or-nothing per language: any frame with esFailed/ptBrFailed/hiFailed:true omits that language\'s finalVideoUrl for the whole project. States.ArrayContains is a real ASL intrinsic; Choice states can\'t call intrinsics directly in a Variable comparison, so this Pass materializes the boolean first.',
      Parameters: {
        'esOmitted.$': 'States.ArrayContains($.fourLangConcatPrep.esFailedFlags, true)',
        'ptBrOmitted.$': 'States.ArrayContains($.fourLangConcatPrep.ptBrFailedFlags, true)',
        'hiOmitted.$': 'States.ArrayContains($.fourLangConcatPrep.hiFailedFlags, true)',
      },
      ResultPath: '$.languageOmissions',
      Next: 'ConcatenateVideosFourLang',
    },
    ConcatenateVideosFourLang: {
      Type: 'Parallel',
      Branches: [
        concatFourLangBranch('en', 'en'),
        concatFourLangBranch('es', 'es', 'esOmitted'),
        concatFourLangBranch('ptBr', 'pt-BR', 'ptBrOmitted'),
        concatFourLangBranch('hi', 'hi', 'hiOmitted'),
      ],
      ResultSelector: { 'en.$': '$[0]', 'es.$': '$[1]', 'ptBr.$': '$[2]', 'hi.$': '$[3]' },
      ResultPath: '$.concatenatedVideosFourLang',
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
      Next: 'PrepareTranscribeFourLang',
    },
    PrepareTranscribeFourLang: {
      Type: 'Pass',
      Comment: 'Fan-out config for TranscribeAudioFourLang below — mirrors localizationStates()\'s PrepareLocalization idiom. en has no whisperLang hint (\'\'), matching today\'s single-language TranscribeAudio, which sends no language field at all. `omitted` (always false for en, which is never omitted) carries $.languageOmissions through per-item so the Map iterator below can skip the Whisper call entirely for a language already known omitted, rather than transcribing a known-empty audioUrl.',
      Parameters: {
        transcribeConfigs: [
          { code: 'en', whisperLang: '', omitted: false, 'audioUrl.$': '$.concatenatedVideosFourLang.en.audioUrl' },
          { code: 'es', whisperLang: 'es', 'omitted.$': '$.languageOmissions.esOmitted', 'audioUrl.$': '$.concatenatedVideosFourLang.es.audioUrl' },
          { code: 'pt-BR', whisperLang: 'pt', 'omitted.$': '$.languageOmissions.ptBrOmitted', 'audioUrl.$': '$.concatenatedVideosFourLang.ptBr.audioUrl' },
          { code: 'hi', whisperLang: 'hi', 'omitted.$': '$.languageOmissions.hiOmitted', 'audioUrl.$': '$.concatenatedVideosFourLang.hi.audioUrl' },
        ],
      },
      ResultPath: '$.transcribePrep',
      Next: 'TranscribeAudioFourLang',
    },
    TranscribeAudioFourLang: {
      Type: 'Map',
      Comment: 'SRT x4 via QM (srt.narration — same self-hosted Whisper rung TranscribeAudio uses today), one per language\'s concatenated audio. Array order is fixed (matches transcribeConfigs: en=[0], es=[1], pt-BR=[2], hi=[3]) — downstream states index into it directly rather than re-keying by language.',
      ItemsPath: '$.transcribePrep.transcribeConfigs',
      MaxConcurrency: 4,
      ResultPath: '$.transcribeResultsFourLang',
      Iterator: {
        StartAt: 'RouteTranscribeOmission',
        States: {
          RouteTranscribeOmission: {
            Type: 'Choice',
            Comment: 'Skip the Whisper call entirely for a language already known omitted (every frame failed/skipped it upstream, per ComputeLanguageOmissions) — its audioUrl is \'\' anyway, so there\'s nothing useful to transcribe.',
            Choices: [{ Variable: '$.omitted', BooleanEquals: true, Next: 'SkipTranscribeOneLanguage' }],
            Default: 'RouteTranscribeLanguageHint',
          },
          RouteTranscribeLanguageHint: {
            Type: 'Choice',
            Comment: 'Only forward a language hint when non-empty (en\'s whisperLang is \'\') — matches this codebase\'s existing "empty string == not sent" convention (frame narrationText{Es,PtBr,Hi}, bgmPrompt).',
            Choices: [{ Variable: '$.whisperLang', StringEquals: '', Next: 'TranscribeOneLanguageNoHint' }],
            Default: 'TranscribeOneLanguageWithHint',
          },
          TranscribeOneLanguageWithHint: {
            Type: 'Task',
            Resource: qmGenerateArn,
            Parameters: {
              assetType: 'srt', tier: 'narration', operation: 'transcribe', product: 'narration', queue: 'background', jobType: 'batch',
              'audioUrl.$': '$.audioUrl',
              'language.$': '$.whisperLang',
              'projectId.$': '$$.Execution.Input.projectId',
              'frameId.$': '$.code',
            },
            ResultPath: '$.srtResult', TimeoutSeconds: 920, Retry: STD_RETRY,
            Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.srtError', Next: 'SkipTranscribeOneLanguage' }],
            Next: 'BuildTranscribeItem',
          },
          TranscribeOneLanguageNoHint: {
            Type: 'Task',
            Resource: qmGenerateArn,
            Parameters: {
              assetType: 'srt', tier: 'narration', operation: 'transcribe', product: 'narration', queue: 'background', jobType: 'batch',
              'audioUrl.$': '$.audioUrl',
              'projectId.$': '$$.Execution.Input.projectId',
              'frameId.$': '$.code',
            },
            ResultPath: '$.srtResult', TimeoutSeconds: 920, Retry: STD_RETRY,
            Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.srtError', Next: 'SkipTranscribeOneLanguage' }],
            Next: 'BuildTranscribeItem',
          },
          SkipTranscribeOneLanguage: { Type: 'Pass', Parameters: { cdnUrl: '' }, ResultPath: '$.srtResult', Next: 'BuildTranscribeItem' },
          BuildTranscribeItem: { Type: 'Pass', Parameters: { 'code.$': '$.code', 'srtUrl.$': '$.srtResult.cdnUrl' }, End: true },
        },
      },
      Next: 'BuildMergedVoiceResultFourLangEn',
    },
    BuildMergedVoiceResultFourLangEn: {
      Type: 'Pass',
      Comment: 'Same shape as the non-fourLang BuildMergedVoiceResult, sourced from the "en" entries above — lets English fall through the EXISTING ValidateFinalizeInputsBasic -> PrepareFinalizeBasic -> FinalizeVideoBasic -> Complete chain completely unchanged (English\'s Fargate finalize call is written once, reused by both paths, not duplicated in FinalizeLocalizedVideos below).',
      Parameters: {
        'mergedVideoUrl.$': '$.concatenatedVideosFourLang.en.videoUrl',
        'audioUrl.$': '$.concatenatedVideosFourLang.en.audioUrl',
        'srtUrl.$': '$.transcribeResultsFourLang[0].srtUrl',
        'captionsUrl.$': '$.transcribeResultsFourLang[0].srtUrl',
      },
      ResultPath: '$.mergedVoiceResult',
      Next: 'FinalizeLocalizedVideos',
    },
    FinalizeLocalizedVideos: {
      Type: 'Parallel',
      Comment: 'es/pt-BR/hi finalize fan-out — English is deliberately NOT a branch here (see BuildMergedVoiceResultFourLangEn). Output array (order: es, pt-BR, hi) becomes $.localizedAssets directly, matching the doc\'s array-of-{language,...} shape.',
      Branches: [
        finalizeLocalizedBranch(qmGenerateArn, 'es', 'es', 'esOmitted', 1),
        finalizeLocalizedBranch(qmGenerateArn, 'ptBr', 'pt-BR', 'ptBrOmitted', 2),
        finalizeLocalizedBranch(qmGenerateArn, 'hi', 'hi', 'hiOmitted', 3),
      ],
      ResultPath: '$.localizedAssets',
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
      Next: 'UpdateStatusApplyingBgm',
    },
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
function buildNarrationPremiumQmNewDefinition(qmGenerateArn: string, brokerArn: string, shortsTriggerArn: string, remotionOverlayArn: string): object {
  const def = JSON.parse(JSON.stringify(buildQmNewDefinition(qmGenerateArn, brokerArn, shortsTriggerArn, remotionOverlayArn))) as {
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
  def.States.GenerateImages = qmPremiumFrameAssetsMap(qmGenerateArn, remotionOverlayArn);
  def.States.GenerateImages.Next = 'RouteBGM';
  Object.assign(def.States, bgmStates(qmGenerateArn, 'narrationPremium'));

  // Neutralize the fourLang PER-FRAME full-video pipeline inherited from the
  // Basic clone (2026-07-25, storystudio-4lang-video-pipeline-handoff.md) —
  // that flow is Basic-only for now (Premium is an explicit followup once
  // Basic is proven), and its per-frame Map/catalog rungs are Basic-tiered
  // (image.narrationBasic.*, voice.narrationBasic.*, video.narrationBasic.*),
  // wrong for a Premium project. Without this, a Premium execution with
  // fourLang:true would silently route through Basic's rungs via the
  // inherited RouteFrameGeneration/RouteConcatFourLang Choices. Delete the
  // inherited states outright (rather than leaving them unreferenced dead
  // weight — every added sibling here compounds this file's overall ASL
  // definition size) and repoint straight back to the pre-fourLang-per-frame
  // wiring, restoring Premium's existing whole-script localizationStates()
  // flow exactly as it was before this feature existed.
  delete def.States.RouteFrameGeneration;
  delete def.States.GenerateImagesFourLang;
  delete def.States.RouteConcatFourLang;
  delete def.States.BuildLangVideoArrays;
  delete def.States.ComputeLanguageOmissions;
  delete def.States.ConcatenateVideosFourLang;
  delete def.States.PrepareTranscribeFourLang;
  delete def.States.TranscribeAudioFourLang;
  delete def.States.BuildMergedVoiceResultFourLangEn;
  delete def.States.FinalizeLocalizedVideos;
  delete def.States.SetNoLocalizedAssets;
  def.States.UpdateStatusGeneratingImages.Next = 'GenerateImages';
  def.States.UpdateStatusGeneratingImages.Catch[0].Next = 'GenerateImages';
  def.States.UpdateStatusConcatenating.Next = 'ConcatenateVideos';

  // Same re-tier for the cloned 4lang localization states — the clone above
  // inherited buildQmNewDefinition's tier:'narrationBasic' localized-TTS
  // states (voice.narrationBasic.ttsLocalized{Qwen,Kokoro}); overwrite with
  // the narrationPremium-tiered versions for correct billing/audit
  // attribution (same physical rungs either way — mirrors the BGM re-tier
  // immediately above).
  Object.assign(def.States, localizationStates(qmGenerateArn, 'narrationPremium'));
  def.States.BuildMergedVoiceResult.Next = 'RouteLocalization';

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
    Next: 'NormalizeShortsOptions',
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

  // The clone above inherited buildQmNewDefinition's CheckGenerateShorts/
  // TriggerShortsFromLongForm pointed at FinalizeVideoBasic (now deleted) —
  // retarget both at FinalizeVideoPremium.
  Object.assign(def.States, shortsTriggerStates(shortsTriggerArn, 'FinalizeVideoPremium'));

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
function qmPremiumFrameAssetsMap(qmGenerateArn: string, remotionOverlayArn: string): object {
  return {
    Type: 'Map',
    Comment: 'Per-frame video via Quartermaster gateway (Narration-Premium): image (Qwen i2i/t2i) → TTS (Qwen voice-design) → Wan2 i2v → merge. QM owns provider selection, internal→external failover, and per-endpoint concurrency. TTS runs BEFORE video (reordered) so RouteVideoLength can branch on the TTS\'s real spoken length: ≤7s (Wan2\'s max duration_s) → one clip at that length, used as-is; >7s → one fixed 5s clip, duplicated via concat to 10s (video_urls: [url, url] — cheaper than a second unique Wan2 generation, near-identical motion anyway), then merge trims the result down to the real audio length. Exception: frames with imageModel=="ernie" or "qwen-image-gen" (explainer/educational/advertisement/documentary/product-promotion, on-screen text overlay) get their image from image.explainer.t2i (Qwen-Image-Gen) instead of the normal t2i/i2i rung — everything downstream is unchanged, since only the image source differs. Frames carrying a non-empty textManifest (the same 5 genres) additionally get a Remotion text-overlay render spliced in after BuildFrameVideo — see textOverlayStates below.',
    ItemsPath: '$.frames',
    // Lower than Basic-QM-New's 15 — premium touches 3 endpoints per frame, so its
    // worker footprint is 3x a single-endpoint project's at the same concurrency.
    // At 15, a solo premium project alone needs 12 workers (> ACCOUNT_CAP=10),
    // deferring forever even on a fully idle fleet. Must match Wan2's real pod
    // count (fleet.ts's WAN2_I2V entry / PROJECT_FLEET's narration-premium
    // gateMax) exactly — capacity planning and real SFN parallelism must agree,
    // or under-provisioned workers meet real RunPod contention this constant
    // was supposed to prevent. Lowered 8→6 (2026-07-21): re-confirmed against
    // the dashboard that only 6 real Wan2 pods exist today, not 8.
    MaxConcurrency: 6,
    ResultPath: '$.videoResults',
    Iterator: {
      StartAt: 'NormalizeTextManifest',
      States: {
        ...textOverlayStates(remotionOverlayArn, 'CheckImageCache'),
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
          Next: 'RouteTTS',
        },
        RouteImageGen: {
          Type: 'Choice',
          Comment: 'imageModel=="ernie" OR "qwen-image-gen" (explainer/educational/advertisement/documentary/product-promotion frame needing an on-screen text overlay) → Qwen-Image-Gen via image.explainer.t2i, checked first since it overrides the normal i2i/t2i choice (this rung has no i2i mode). Two accepted values: pipeline.ts sends "qwen-image-gen" literally for narration-premium\'s real text-free-genre, reference-less frames (confirmed live 2026-07-12) — "ernie" is kept too for its (currently dead) hasTextTag path. Otherwise: character reference from the UI → image-to-image; else text-to-image.',
          Choices: [
            {
              Or: [
                { And: [
                  { Variable: '$.imageModel', IsPresent: true },
                  { Variable: '$.imageModel', IsString: true },
                  { Variable: '$.imageModel', StringEquals: 'ernie' },
                ] },
                { And: [
                  { Variable: '$.imageModel', IsPresent: true },
                  { Variable: '$.imageModel', IsString: true },
                  { Variable: '$.imageModel', StringEquals: 'qwen-image-gen' },
                ] },
              ],
              Next: 'QMGenerateImageExplainer',
            },
            {
              And: [
                { Variable: '$.referenceImageUrl', IsPresent: true },
                { Variable: '$.referenceImageUrl', IsString: true },
                { Not: { Variable: '$.referenceImageUrl', StringEquals: '' } },
              ],
              Next: 'QMGenerateImageI2I',
            },
          ],
          Default: 'QMGenerateImageT2I',
        },
        QMGenerateImageExplainer: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Text-to-image via QM (image.explainer.t2i: self-hosted Qwen-Image-Gen → nano-banana fallback). No i2i mode on this rung, so this always renders from imagePrompt alone even if the frame carries a referenceImageUrl.',
          Parameters: {
            assetType: 'image',
            tier: 'explainer',
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
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'QMFrameFailed' }],
          Next: 'StoreImageMeta',
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
          TimeoutSeconds: 920,
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
          TimeoutSeconds: 920,
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
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.metaStoreError', Next: 'RouteTTS' }],
          Next: 'RouteTTS',
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
          Default: 'RouteTTSEngine',
        },
        UseProvidedVoice: {
          Type: 'Pass',
          Comment: 'A voiceUrl was supplied upstream — reuse it, skip TTS generation. durationS falls back to the frame\'s planned $.duration since no TTS call ran to report a real one (RouteVideoLength reads $.ttsResult.durationS uniformly regardless of which TTS branch ran — must match QMGenerateResult\'s actual field name, durationS, not duration; a mismatch here caused a live States.Runtime failure on 2026-07-07: RouteVideoLength\'s NumericGreaterThan threw on a nonexistent $.ttsResult.duration path).',
          Parameters: { 'cdnUrl.$': '$.voiceUrl', 'durationS.$': '$.duration' },
          ResultPath: '$.ttsResult',
          Next: 'RouteVideoLength',
        },
        RouteTTSEngine: {
          Type: 'Choice',
          Comment: 'voiceCloneArtifactUrl present (StoryStudio resolved a chosen voice_id to its precomputed .pt clone artifact — see runpod/qwen-voice-clone-stepfunction-request.md) → clone path; otherwise the existing speaker/instruct design voice. Choice IsPresent is safe against older execution inputs that omit this field entirely (unlike a raw $$.Execution.Input.* Parameters reference, which would throw States.Runtime if the key is missing).',
          Choices: [{
            And: [
              { Variable: '$$.Execution.Input.voiceCloneArtifactUrl', IsPresent: true },
              { Variable: '$$.Execution.Input.voiceCloneArtifactUrl', IsString: true },
              { Not: { Variable: '$$.Execution.Input.voiceCloneArtifactUrl', StringEquals: '' } },
            ],
            Next: 'QMGenerateTTSClone',
          }],
          Default: 'QMGenerateTTS',
        },
        QMGenerateTTSClone: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'TTS via QM (voice.narrationPremium.tts, Qwen3-TTS clone_artifact_url fast path — reuses the project\'s precomputed .pt voice clone across every frame). No speaker/instruct: the artifact already encodes the cloned voice\'s identity and style.',
          Parameters: {
            assetType: 'voice',
            tier: 'narrationPremium',
            operation: 'tts',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'prompt.$': '$.narrationText',
            'cloneArtifactUrl.$': '$$.Execution.Input.voiceCloneArtifactUrl',
            'language.$': '$$.Execution.Input.voiceLanguage',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.ttsResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'QMFrameFailed' }],
          Next: 'RouteVideoLength',
        },
        QMGenerateTTS: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'TTS via QM (voice.narrationPremium.tts: self-hosted Qwen3-TTS voice-design, no external fallback for now — Google TTS is reserved for UI). Speaker/instruct/language come from execution input (project-level, not per-frame).',
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
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'QMFrameFailed' }],
          Next: 'RouteVideoLength',
        },
        RouteVideoLength: {
          Type: 'Choice',
          Comment: 'TTS duration > 7s (Wan2\'s max duration_s) → generate a fixed 5s clip and extend it via concat, rather than requesting a clip at the real (unsupportable) length. ≤7s → generate one clip at the real duration, used as-is.',
          Choices: [{
            Variable: '$.ttsResult.durationS',
            NumericGreaterThan: 7,
            Next: 'QMGenerateVideoShort',
          }],
          Default: 'QMGenerateVideo',
        },
        QMGenerateVideoShort: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Image-to-video via QM (video.narrationPremium.i2v), fixed 5s clip — TTS ran past Wan2\'s 7s max, so this clip gets duplicated via QMConcatVideo (5+5=10s) rather than requesting an unsupportable duration_s. Same source image/prompt as the normal path.',
          Parameters: {
            assetType: 'video',
            tier: 'narrationPremium',
            operation: 'i2v',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'prompt.$': '$.narrationText',
            durationS: 5,
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.videoResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoError', Next: 'QMFrameFailed' }],
          Next: 'QMConcatVideo',
        },
        QMConcatVideo: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Extend the 5s clip via QM (video.narrationPremium.concat: self-hosted Flux-TTS-S2T concat, internal-only). Duplicates the SAME clip URL twice (video_urls: [url, url], 5+5=10s) rather than generating a second unique Wan2 clip — near-identical motion anyway (same source image), so duplicating is free coverage. merge (downstream) trims the 10s result to the real TTS audio length via ffmpeg -shortest (already built into run_merge, Flux-klien-4b/handler.py:879-894 — no pod change needed).',
          Parameters: {
            assetType: 'video',
            tier: 'narrationPremium',
            operation: 'concat',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'initImageUrls.$': 'States.Array($.videoResult.cdnUrl, $.videoResult.cdnUrl)',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.finalVideoResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.concatError', Next: 'QMFrameFailed' }],
          Next: 'QMMerge',
        },
        QMGenerateVideo: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Image-to-video via QM (video.narrationPremium.i2v: self-hosted Wan 2.2 I2V-A14B 4-step Lightning → Replicate fallback). Silent MP4; narrationText doubles as the motion prompt (matches the legacy Premium-QM convention). Runs AFTER TTS (reordered from the original image→video→TTS flow) so durationS can come from the TTS\'s ACTUAL spoken length ($.ttsResult.durationS, guaranteed ≤7s here — RouteVideoLength routed the >7s case to QMGenerateVideoShort instead) rather than the originally-planned $.duration. Cold start ~170-190s + real RunPod-side queue wait when a Map wave (8 concurrent) exceeds the endpoint\'s ~3 real pods — 650s gives qm-generate.ts\'s 610s Lambda timeout (itself polling to a 580s deadline) room to actually observe a slow-but-real completion instead of timing out first.',
          Parameters: {
            assetType: 'video',
            tier: 'narrationPremium',
            operation: 'i2v',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'prompt.$': '$.narrationText',
            'durationS.$': '$.ttsResult.durationS',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.videoResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoError', Next: 'QMFrameFailed' }],
          Next: 'UseSingleClipVideo',
        },
        UseSingleClipVideo: {
          Type: 'Pass',
          Comment: 'TTS duration ≤ 7s — the single Wan2 clip already covers it, no extension needed.',
          Parameters: { 'cdnUrl.$': '$.videoResult.cdnUrl' },
          ResultPath: '$.finalVideoResult',
          Next: 'QMMerge',
        },
        QMMerge: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Merge the TTS voice onto the (possibly concat-extended) video via QM (video.narrationPremium.merge → aliases the same Flux-TTS-S2T merge rung narration-basic uses). MP4 with audio; run_merge\'s ffmpeg call uses -shortest (Flux-klien-4b/handler.py:879-894), which always cuts to min(video, audio) — confirmed this already trims the video down to the audio\'s length whenever video is longer, so the fixed-5s-duplicated-to-10s clip from QMConcatVideo comes out correct with no pod-side change.',
          Parameters: {
            assetType: 'video',
            tier: 'narrationPremium',
            operation: 'merge',
            product: 'narration',
            queue: 'background',
            jobType: 'batch',
            'initImageUrls.$': 'States.Array($.finalVideoResult.cdnUrl)',
            'audioUrl.$': '$.ttsResult.cdnUrl',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.mergeResult',
          TimeoutSeconds: 920,
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
          Comment: 'Emit the per-frame video item the concat step consumes (videoUrl = merged Wan2 video + voice). duration comes from $.ttsResult.durationS (the real spoken/target length that drove Wan2 + merge\'s trim) rather than the originally-planned $.duration, so downstream concat/SRT timing matches the actual final artifact — guaranteed present regardless of which TTS branch ran (see UseProvidedVoice/QMGenerateTTS/QMGenerateTTSClone). textManifest carried through (normalized to \'\' by NormalizeTextManifest above when absent) so RouteTextOverlay/RenderTextOverlay below can read it — this Pass\'s Parameters block replaces $ entirely, so anything not named here would otherwise be lost before the overlay step could see it.',
          Parameters: {
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            'videoUrl.$': '$.mergeResult.cdnUrl',
            'duration.$': '$.ttsResult.durationS',
            'textManifest.$': '$.textManifest',
          },
          Next: 'RouteTextOverlay',
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
