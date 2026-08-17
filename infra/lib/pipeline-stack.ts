import { Stack, StackProps, CfnOutput, Duration, RemovalPolicy, Size } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as logs from 'aws-cdk-lib/aws-logs';
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

    // ── QM-remove-silence Lambda + output bucket (post-concat per-language
    // silence removal) ───────────────────────────────────────────────────────
    // 2026-07-27 product decision: a fourLang project's concatenated
    // narration video carries visible dead air at every frame boundary (each
    // frame's TTS clip bakes in leading/trailing silence — confirmed live on
    // a real project: 20.3% of a 130.9s Hindi concat was silence, ffmpeg
    // silencedetect). The real fix (trimming silence at TTS-generation time)
    // is drafted but stuck in flux4B-Wan2/handler.py, an untracked repo with
    // no established deploy process — so this runs post-concat instead, in
    // infrastructure QM fully owns. Publicly readable output bucket (no
    // CloudFront) mirrors how Remotion's own render bucket
    // (remotionlambda-useast1-55dp29f3ln) is already read directly via plain
    // S3 URLs elsewhere in this pipeline — same posture, not a new pattern.
    const removeSilenceBucket = new s3.Bucket(this, 'RemoveSilenceOutputBucket', {
      bucketName: 'qm-remove-silence-output',
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Algorithm validated locally against a real project's hi/concatenated.mp4
    // before deploying (see qm-4lang-fullvideo-perframe memory): ffmpeg
    // silencedetect -> invert into keep-segments (130ms pad each edge, not a
    // hard jump-cut) -> cut each segment via -ss/-to (a single filter_complex
    // graph with ~30 trim branches OOM-killed at this memory size) -> rejoin
    // via the concat DEMUXER (-c copy, fast, no re-encode). @ffmpeg-installer/
    // ffmpeg ships a static linux-x64 binary; bundling.nodeModules (not
    // esbuild bundling) tells CDK to npm-install it straight into the
    // deployment package so the native binary survives, matching the
    // standard recipe for native deps under NodejsFunction/esbuild.
    const removeSilenceFn = new nodejs.NodejsFunction(this, 'RemoveSilenceFunction', {
      functionName: 'QM-remove-silence',
      entry: path.join(__dirname, '../../src/handlers/remove-silence.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(600),
      memorySize: 2048,
      ephemeralStorageSize: Size.mebibytes(2048),
      bundling: { minify: true, sourceMap: false, externalModules: [], nodeModules: ['@ffmpeg-installer/ffmpeg'] },
      environment: {
        OUTPUT_BUCKET: removeSilenceBucket.bucketName,
      },
    });
    removeSilenceBucket.grantPut(removeSilenceFn);
    removeSilenceFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // ── Concat-and-trim payload uploader ─────────────────────────────────────
    // `ecs:runTask`'s Overrides field has a hard 8192-byte limit. ConcatAndTrim
    // used to inline its entire per-frame video-URL array as JSON straight into
    // the ContainerOverrides environment — fine at small frame counts, but a
    // real 69-frame fourLang test hit `ECS.InvalidParameterException:
    // Container Overrides length must be at most 8192` on all 4 language
    // branches simultaneously (every ecs:runTask call rejected synchronously,
    // before any container ever launched — see qm-concat-trim-ecs-migration
    // memory). This Lambda writes the payload to S3 first so only a short key
    // crosses the ContainerOverrides boundary; the task fetches the real
    // payload from S3 instead of reading it from an env var.
    const uploadPayloadFn = new nodejs.NodejsFunction(this, 'UploadPayloadFunction', {
      functionName: 'QM-upload-payload',
      entry: path.join(__dirname, '../../src/handlers/upload-payload.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      memorySize: 256,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        OUTPUT_BUCKET: removeSilenceBucket.bucketName,
      },
    });
    removeSilenceBucket.grantPut(uploadPayloadFn);
    uploadPayloadFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // ── Concat-and-trim ECS Fargate task ─────────────────────────────────────
    // Replaces two things that used to be separate hops through S3/R2 for
    // the same file: per-frame video concat (previously the external,
    // storystudio-unified-owned E2E-video-concat-premium Lambda — ported
    // faithfully from its actually-deployed source, see
    // infra/docker/concat-and-trim/index.ts's header comment) and post-concat
    // silence removal (previously QM-remove-silence above, which failed
    // systematically on large projects — 12/12 real attempts on a 69-frame
    // project, split between Runtime.OutOfMemory at its 2048MB ceiling and
    // States.Timeout at 600s). Fargate has neither ceiling.
    //
    // Built via CodeBuild -> ECR, not CDK's local-Docker fromAsset: the S3
    // asset below is just a zip+upload of the build context (no local Docker
    // needed for that step), CodeBuild's own privileged environment runs the
    // actual `docker build`/`docker push`. Two-phase, matching every other
    // deploy this session's explicit-verify-each-step posture: `cdk deploy`
    // creates the (empty) repo + task def referencing `:latest` by URI; a
    // manual `aws codebuild start-build` (polled to SUCCEEDED) actually
    // publishes the image before any task launch can succeed.
    const concatTrimRepo = new ecr.Repository(this, 'ConcatAndTrimRepo', {
      repositoryName: 'qm-concat-and-trim',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const concatTrimBuildContext = new s3assets.Asset(this, 'ConcatAndTrimBuildContext', {
      path: path.join(__dirname, '../docker/concat-and-trim'),
    });

    const concatTrimBuildProject = new codebuild.Project(this, 'ConcatAndTrimBuildProject', {
      projectName: 'qm-concat-and-trim-build',
      source: codebuild.Source.s3({
        bucket: concatTrimBuildContext.bucket,
        path: concatTrimBuildContext.s3ObjectKey,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
      },
      environmentVariables: {
        REPOSITORY_URI: { value: concatTrimRepo.repositoryUri },
        AWS_ACCOUNT_ID: { value: this.account },
        AWS_DEFAULT_REGION: { value: this.region },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
    });
    concatTrimRepo.grantPullPush(concatTrimBuildProject);

    // Dedicated, narrowly-scoped task role (S3 write to
    // qm-remove-silence-output only) — E2E-StepFunction-Role's iam:PassRole
    // allowlist needs this exact ARN added (done once, manually via AWS
    // CLI — see verification notes; that role is shared across ~15 other
    // Lambdas/pipelines, not something to fold into a routine `cdk deploy`
    // whose blast radius should stay scoped to QM's own stack). Explicit
    // roleName so the ARN is known/predictable before that manual step.
    const concatTrimTaskRole = new iam.Role(this, 'ConcatAndTrimTaskRole', {
      roleName: 'qm-concat-and-trim-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    removeSilenceBucket.grantPut(concatTrimTaskRole);
    // Reads its own payload back from S3 now (PAYLOAD_S3_KEY workaround above).
    removeSilenceBucket.grantRead(concatTrimTaskRole);

    // Reuse the existing, already-broadly-permissioned execution role
    // (AmazonECSTaskExecutionRolePolicy — confirmed via `aws iam
    // list-attached-role-policies` to already grant account-wide ECR pull +
    // CloudWatch Logs write) rather than creating a new one.
    // `mutable:false` stops CDK's automatic `grantPull`/logging grants from
    // trying to attach yet another policy to this shared role — unnecessary
    // (already covered by the managed policy) and avoids touching a role
    // used by resources outside this stack.
    const concatTrimExecutionRole = iam.Role.fromRoleName(this, 'ConcatAndTrimExecutionRole', 'ecsTaskExecutionRole', { mutable: false });

    // Default VPC, public subnets, no NAT gateway — the task only needs
    // outbound internet (download frame clips, write to S3) and takes no
    // inbound traffic at all (invoked via ecs:runTask, not a service).
    // Looked up (and passed explicitly to the Cluster below) rather than
    // left implicit — an ecs.Cluster with no `vpc` prop auto-creates its
    // own brand-new VPC (2 NAT gateways, private subnets, real ongoing
    // cost), which is not what we want.
    const concatTrimVpc = ec2.Vpc.fromLookup(this, 'ConcatAndTrimVpc', { isDefault: true });
    const concatTrimSg = new ec2.SecurityGroup(this, 'ConcatAndTrimSg', {
      vpc: concatTrimVpc,
      description: 'QM concat-and-trim Fargate task - outbound only',
      allowAllOutbound: true,
    });
    const concatTrimSubnetIds = concatTrimVpc.publicSubnets.map(s => s.subnetId);

    const concatTrimCluster = new ecs.Cluster(this, 'ConcatAndTrimCluster', {
      clusterName: 'qm-concat-and-trim',
      vpc: concatTrimVpc,
    });

    const concatTrimLogGroup = new logs.LogGroup(this, 'ConcatAndTrimLogGroup', {
      logGroupName: '/qm/concat-and-trim',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Sizing: 8 vCPU / 32GB (bumped 2026-07-29 from the original 4 vCPU/16GB
    // floor — the first real fourLang test, post ContainerOverrides fix,
    // measured concat+trim taking 10-12 min per language on 4 vCPU; this is
    // CPU-bound work (libx264 encode across a filter_complex normalize pass
    // over up to 69 source clips, then a second silence-cut re-encode pass),
    // so doubling vCPU is the direct lever — libx264 parallelizes well
    // across cores, unlike I/O-bound work where more vCPU wouldn't help.
    // Memory doubled alongside it for headroom, not because memory was the
    // constraint (16GB was never close to full on a 69-frame project).
    // 50GB ephemeral storage (Fargate default 20GB already exceeds Lambda's
    // 10GB hard ceiling; going further gives real margin over large-project
    // disk pressure without needing the S3-streaming workaround the
    // external Lambda needed under Lambda's tighter limits).
    const concatTrimTaskDef = new ecs.FargateTaskDefinition(this, 'ConcatAndTrimTaskDef', {
      family: 'qm-concat-and-trim',
      cpu: 8192,
      memoryLimitMiB: 32768,
      ephemeralStorageGiB: 50,
      taskRole: concatTrimTaskRole,
      executionRole: concatTrimExecutionRole,
    });
    concatTrimTaskDef.addContainer('concat-and-trim', {
      containerName: 'concat-and-trim',
      image: ecs.ContainerImage.fromEcrRepository(concatTrimRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'concat-and-trim', logGroup: concatTrimLogGroup }),
      environment: {
        OUTPUT_BUCKET: removeSilenceBucket.bucketName,
      },
    });

    // ── Dialogue Basic / Dialogue Premium — new Lambdas + Fargate task
    // (storystudio-dialogue-qm-sfn-handoff.md) ───────────────────────────────

    // QM-build-turn-tracks — pure text/data transform (Dialogue Premium).
    const buildTurnTracksFn = new nodejs.NodejsFunction(this, 'BuildTurnTracksFunction', {
      functionName: 'QM-build-turn-tracks',
      entry: path.join(__dirname, '../../src/handlers/build-turn-tracks.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });
    buildTurnTracksFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // QM-trim-clip — plain ffmpeg -t trim (Dialogue Premium's
    // TrimToTrackLength + Dialogue Basic's ReconcileSegmentTiming trim leg).
    const trimClipFn = new nodejs.NodejsFunction(this, 'TrimClipFunction', {
      functionName: 'QM-trim-clip',
      entry: path.join(__dirname, '../../src/handlers/trim-clip.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(120),
      memorySize: 1024,
      ephemeralStorageSize: Size.mebibytes(1024),
      bundling: { minify: true, sourceMap: false, externalModules: [], nodeModules: ['@ffmpeg-installer/ffmpeg'] },
      environment: { OUTPUT_BUCKET: removeSilenceBucket.bucketName },
    });
    removeSilenceBucket.grantPut(trimClipFn);
    trimClipFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // QM-reconcile-segment-timing — Dialogue Basic only (§4.5).
    const reconcileSegmentTimingFn = new nodejs.NodejsFunction(this, 'ReconcileSegmentTimingFunction', {
      functionName: 'QM-reconcile-segment-timing',
      entry: path.join(__dirname, '../../src/handlers/reconcile-segment-timing.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(600),
      memorySize: 1024,
      ephemeralStorageSize: Size.mebibytes(2048),
      bundling: { minify: true, sourceMap: false, externalModules: [], nodeModules: ['@ffmpeg-installer/ffmpeg'] },
      environment: { OUTPUT_BUCKET: removeSilenceBucket.bucketName },
    });
    removeSilenceBucket.grantPut(reconcileSegmentTimingFn);
    reconcileSegmentTimingFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // QM-append-tail-beat — Dialogue Premium only (§7.3).
    const appendTailBeatFn = new nodejs.NodejsFunction(this, 'AppendTailBeatFunction', {
      functionName: 'QM-append-tail-beat',
      entry: path.join(__dirname, '../../src/handlers/append-tail-beat.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(120),
      memorySize: 1024,
      ephemeralStorageSize: Size.mebibytes(1024),
      bundling: { minify: true, sourceMap: false, externalModules: [], nodeModules: ['@ffmpeg-installer/ffmpeg'] },
      environment: { OUTPUT_BUCKET: removeSilenceBucket.bucketName },
    });
    removeSilenceBucket.grantPut(appendTailBeatFn);
    appendTailBeatFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // QM-build-ambience-bed-specs — Dialogue Premium only (§7.7). Pure JS
    // grouping/summing, no ffmpeg.
    const buildAmbienceBedSpecsFn = new nodejs.NodejsFunction(this, 'BuildAmbienceBedSpecsFunction', {
      functionName: 'QM-build-ambience-bed-specs',
      entry: path.join(__dirname, '../../src/handlers/build-ambience-bed-specs.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
    });
    removeSilenceBucket.grantRead(buildAmbienceBedSpecsFn);
    buildAmbienceBedSpecsFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // QM-fetch-shots-manifest — Dialogue Premium only (§7.2's shotsManifestUrl
    // fallback). Mirrors the fetched manifest into removeSilenceBucket
    // (2026-08-16 — see handler's own header comment) so the shot Map can
    // read it via S3 ItemReader instead of carrying it through state.
    const fetchShotsManifestFn = new nodejs.NodejsFunction(this, 'FetchShotsManifestFunction', {
      functionName: 'QM-fetch-shots-manifest',
      entry: path.join(__dirname, '../../src/handlers/fetch-shots-manifest.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      memorySize: 256,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        OUTPUT_BUCKET: removeSilenceBucket.bucketName,
      },
    });
    removeSilenceBucket.grantPut(fetchShotsManifestFn);
    fetchShotsManifestFn.addPermission('E2ESfnInvoke', {
      principal: new iam.ArnPrincipal('arn:aws:iam::929075264324:role/E2E-StepFunction-Role'),
      action: 'lambda:InvokeFunction',
    });

    // ── qm-dialogue-mix ECS Fargate task (PiP composite + ambience-bed mix)
    // ─────────────────────────────────────────────────────────────────────
    // Same CodeBuild -> ECR pattern as concat-and-trim above — the doc's own
    // named fallback (§3.4/§10 Q3) for "inside finalize," since e2e-finalize
    // isn't part of this repo (only referenced by ARN, on the storystudio-e2e
    // cluster). One task family, two ffmpeg recipes selected by a `mode`
    // field in its payload (infra/docker/dialogue-mix/index.ts) — reduces
    // infra footprint (one ECR repo/task-def/CodeBuild pipeline) the same way
    // concat-and-trim's own trimSilence on/off branch does.
    const dialogueMixRepo = new ecr.Repository(this, 'DialogueMixRepo', {
      repositoryName: 'qm-dialogue-mix',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const dialogueMixBuildContext = new s3assets.Asset(this, 'DialogueMixBuildContext', {
      path: path.join(__dirname, '../docker/dialogue-mix'),
    });

    const dialogueMixBuildProject = new codebuild.Project(this, 'DialogueMixBuildProject', {
      projectName: 'qm-dialogue-mix-build',
      source: codebuild.Source.s3({
        bucket: dialogueMixBuildContext.bucket,
        path: dialogueMixBuildContext.s3ObjectKey,
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: true,
      },
      environmentVariables: {
        REPOSITORY_URI: { value: dialogueMixRepo.repositoryUri },
        AWS_ACCOUNT_ID: { value: this.account },
        AWS_DEFAULT_REGION: { value: this.region },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
    });
    dialogueMixRepo.grantPullPush(dialogueMixBuildProject);

    const dialogueMixTaskRole = new iam.Role(this, 'DialogueMixTaskRole', {
      roleName: 'qm-dialogue-mix-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    removeSilenceBucket.grantPut(dialogueMixTaskRole);
    removeSilenceBucket.grantRead(dialogueMixTaskRole);

    const dialogueMixExecutionRole = iam.Role.fromRoleName(this, 'DialogueMixExecutionRole', 'ecsTaskExecutionRole', { mutable: false });

    const dialogueMixSg = new ec2.SecurityGroup(this, 'DialogueMixSg', {
      vpc: concatTrimVpc,
      description: 'QM dialogue-mix Fargate task - outbound only',
      allowAllOutbound: true,
    });

    const dialogueMixCluster = new ecs.Cluster(this, 'DialogueMixCluster', {
      clusterName: 'qm-dialogue-mix',
      vpc: concatTrimVpc,
    });

    const dialogueMixLogGroup = new logs.LogGroup(this, 'DialogueMixLogGroup', {
      logGroupName: '/qm/dialogue-mix',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Same sizing rationale as concat-and-trim: CPU-bound filter_complex
    // work (multi-input overlay/geq/boxblur for the composite, acrossfade/
    // amix for the ambience mix), libx264 encode parallelizes well across
    // cores.
    const dialogueMixTaskDef = new ecs.FargateTaskDefinition(this, 'DialogueMixTaskDef', {
      family: 'qm-dialogue-mix',
      cpu: 4096,
      memoryLimitMiB: 16384,
      ephemeralStorageGiB: 30,
      taskRole: dialogueMixTaskRole,
      executionRole: dialogueMixExecutionRole,
    });
    dialogueMixTaskDef.addContainer('dialogue-mix', {
      containerName: 'dialogue-mix',
      image: ecs.ContainerImage.fromEcrRepository(dialogueMixRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'dialogue-mix', logGroup: dialogueMixLogGroup }),
      environment: {
        OUTPUT_BUCKET: removeSilenceBucket.bucketName,
      },
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
    const concatTrimEcsConfig: ConcatTrimEcsConfig = {
      clusterArn: concatTrimCluster.clusterArn,
      taskDefinitionArn: concatTrimTaskDef.taskDefinitionArn,
      containerName: 'concat-and-trim',
      subnetIds: concatTrimSubnetIds,
      securityGroupId: concatTrimSg.securityGroupId,
      outputBucket: removeSilenceBucket.bucketName,
      uploadPayloadArn: uploadPayloadFn.functionArn,
    };

    const qmNewDefinition = buildQmNewDefinition(qmGenerateFn.functionArn, brokerArn, shortsTriggerFn.functionArn, remotionOverlayFn.functionArn, removeSilenceFn.functionArn, concatTrimEcsConfig);

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
    const narrationPremiumQmNewDefinition = buildNarrationPremiumQmNewDefinition(qmGenerateFn.functionArn, brokerArn, shortsTriggerFn.functionArn, remotionOverlayFn.functionArn, removeSilenceFn.functionArn, concatTrimEcsConfig);

    const narrationPremiumQmNewStateMachine = new sfn.CfnStateMachine(this, 'NarrationPremiumQMNewPipeline', {
      stateMachineName: 'E2E-VideoGenerationPipeline-Narration-Premium-QM-New',
      stateMachineType: 'STANDARD',
      roleArn: sfnRole.roleArn,
      definitionString: JSON.stringify(narrationPremiumQmNewDefinition),
      tags: [{ key: 'batchjob', value: 'true' }, { key: 'qmGateway', value: 'true' }],
    });

    new CfnOutput(this, 'NarrationPremiumQMNewStateMachineArn', { value: narrationPremiumQmNewStateMachine.attrArn });

    // ── Dialogue-Basic-QM-New pipeline ───────────────────────────────────────
    const dialogueMixEcsConfig: DialogueMixEcsConfig = {
      clusterArn: dialogueMixCluster.clusterArn,
      taskDefinitionArn: dialogueMixTaskDef.taskDefinitionArn,
      containerName: 'dialogue-mix',
      subnetIds: concatTrimSubnetIds,
      securityGroupId: dialogueMixSg.securityGroupId,
      outputBucket: removeSilenceBucket.bucketName,
      uploadPayloadArn: uploadPayloadFn.functionArn,
    };

    const dialogueBasicQmNewDefinition = buildDialogueBasicQmNewDefinition(
      qmGenerateFn.functionArn, brokerArn, shortsTriggerFn.functionArn, remotionOverlayFn.functionArn,
      concatTrimEcsConfig, dialogueMixEcsConfig, reconcileSegmentTimingFn.functionArn,
    );

    const dialogueBasicQmNewStateMachine = new sfn.CfnStateMachine(this, 'DialogueBasicQMNewPipeline', {
      stateMachineName: 'E2E-VideoGenerationPipeline-Dialogue-Basic-QM-New',
      stateMachineType: 'STANDARD',
      roleArn: sfnRole.roleArn,
      definitionString: JSON.stringify(dialogueBasicQmNewDefinition),
      tags: [{ key: 'batchjob', value: 'true' }, { key: 'qmGateway', value: 'true' }],
    });

    new CfnOutput(this, 'DialogueBasicQMNewStateMachineArn', { value: dialogueBasicQmNewStateMachine.attrArn });

    // ── Dialogue-Premium-QM-New pipeline ─────────────────────────────────────
    const dialoguePremiumQmNewDefinition = buildDialoguePremiumQmNewDefinition({
      qmGenerateArn: qmGenerateFn.functionArn,
      brokerArn,
      shortsTriggerArn: shortsTriggerFn.functionArn,
      remotionOverlayArn: remotionOverlayFn.functionArn,
      concatTrimEcs: concatTrimEcsConfig,
      dialogueMixEcs: dialogueMixEcsConfig,
      buildTurnTracksArn: buildTurnTracksFn.functionArn,
      trimClipArn: trimClipFn.functionArn,
      appendTailBeatArn: appendTailBeatFn.functionArn,
      buildAmbienceBedSpecsArn: buildAmbienceBedSpecsFn.functionArn,
      fetchShotsManifestArn: fetchShotsManifestFn.functionArn,
    });

    const dialoguePremiumQmNewStateMachine = new sfn.CfnStateMachine(this, 'DialoguePremiumQMNewPipeline', {
      stateMachineName: 'E2E-VideoGenerationPipeline-Dialogue-Premium-QM-New',
      stateMachineType: 'STANDARD',
      roleArn: sfnRole.roleArn,
      definitionString: JSON.stringify(dialoguePremiumQmNewDefinition),
      tags: [{ key: 'batchjob', value: 'true' }, { key: 'qmGateway', value: 'true' }],
    });

    new CfnOutput(this, 'DialoguePremiumQMNewStateMachineArn', { value: dialoguePremiumQmNewStateMachine.attrArn });

    // Distributed Map (GenerateShotsFromS3, dialoguePremiumShotMap's
    // itemSource:'s3' branch) requires its OWN execution role to hold
    // self-referential child-execution permissions — confirmed live
    // 2026-08-17 (first attempt used Mode:'INLINE', which AWS rejects at
    // RUNTIME for any state with ItemReader: "ItemReader, ItemBatcher and
    // ResultWriter fields are not supported for INLINE maps" — not caught by
    // cdk synth/deploy, only a real execution surfaces it). Unlike every
    // other grant in this file (all resource-side, via fn.addPermission —
    // deliberately avoiding any edit to E2E-StepFunction-Role's own
    // hand-managed policy, since it's imported/managed outside this stack),
    // Step Functions has no resource-based-policy equivalent for
    // child-execution permissions, so this is the one deliberate exception:
    // a new, distinctly-named inline policy attached ADDITIVELY (CDK creates
    // its own AWS::IAM::Policy resource here — the two hand-managed inline
    // policies, E2E-StepFunction-Permissions + ECSRunTaskForShortsAnalyze,
    // are untouched) to the shared role, scoped as narrowly as possible to
    // just this one state machine's own executions, never a wildcard across
    // pipelines.
    sfnRole.attachInlinePolicy(new iam.Policy(this, 'DialoguePremiumDistributedMapPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['states:StartExecution'],
          resources: ['arn:aws:states:us-east-1:929075264324:stateMachine:E2E-VideoGenerationPipeline-Dialogue-Premium-QM-New'],
        }),
        new iam.PolicyStatement({
          actions: ['states:DescribeExecution', 'states:StopExecution', 'states:RedriveExecution'],
          resources: ['arn:aws:states:us-east-1:929075264324:execution:E2E-VideoGenerationPipeline-Dialogue-Premium-QM-New*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: ['arn:aws:iam::929075264324:role/E2E-StepFunction-Role'],
          conditions: { StringEquals: { 'iam:PassedToService': 'states.amazonaws.com' } },
        }),
      ],
    }));
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
function buildQmNewDefinition(qmGenerateArn: string, brokerArn: string, shortsTriggerArn: string, remotionOverlayArn: string, removeSilenceArn: string, concatTrimEcs: ConcatTrimEcsConfig): object {
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
    Comment: 'Guarantee $.fourLang is a real boolean before DropFrameData\'s Parameters allowlist would otherwise silently drop it if the caller omitted the key entirely. IsPresent-guarded (BUGFIX 2026-08-10, confirmed live on a real dialogue-basic execution, which never sends fourLang at all): a bare BooleanEquals on a path that does not resolve at all throws States.Runtime (\'Invalid path\') — same gotcha RouteFrameGeneration above already guards against — rather than the non-matching/Default fallthrough this state\'s original comment assumed.',
    Choices: [{
      And: [
        { Variable: '$.fourLang', IsPresent: true },
        { Variable: '$.fourLang', BooleanEquals: true },
      ],
      Next: 'SetFourLangTrue',
    }],
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
    Comment: 'Guarantee $.generateShorts is a real boolean before DropFrameData\'s Parameters allowlist would otherwise silently drop it if the caller omitted the key entirely. IsPresent-guarded — same fix/reason as NormalizeFourLang above (dialogue-basic never sends generateShorts either, and would hit the identical States.Runtime the very next state after fourLang).',
    Choices: [{
      And: [
        { Variable: '$.generateShorts', IsPresent: true },
        { Variable: '$.generateShorts', BooleanEquals: true },
      ],
      Next: 'SetGenerateShortsFieldTrue',
    }],
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
  Object.assign(def.States, fourLangConcatFinalizeStates(qmGenerateArn, concatTrimEcs, 'basic', shortsTriggerArn));
  def.States.BuildMergedVoiceResult.Next = 'SetNoLocalizedAssets';
  def.States.SetNoLocalizedAssets = {
    Type: 'Pass',
    Comment: 'Non-fourLang path — no localized assets to report. Matches the old SkipLocalization convention ({} not []) so StoryStudio\'s existing consumer sees the same shape it always has for a non-fourLang project.',
    Parameters: {},
    ResultPath: '$.localizedAssets',
    Next: 'UpdateStatusApplyingBgm',
  };

  // Plain non-fourLang concat, moved off the external E2E-video-concat-premium
  // Lambda onto the same QM-owned Fargate task the fourLang branches use
  // (concatAndTrimFourLangBranch), trimSilence:false — this path never had a
  // silence-removal step and this change doesn't add one (would be scope
  // creep beyond "replace concat"), same {videoUrl,audioUrl} output shape
  // and same output key convention as before, so TranscribeAudio/
  // BuildMergedVoiceResult downstream need zero changes. Inherited from
  // buildDefinition's own clone (the legacy Basic-QM pipeline keeps its own
  // unmodified copy, calling the external Lambda exactly as it did before —
  // untouched by this whole session's work) — overridden here the same way
  // GenerateImages/RouteFrameGeneration etc. already are.
  {
    const concatVideoUrlExpr = "States.Format('https://" + concatTrimEcs.outputBucket + ".s3.us-east-1.amazonaws.com/projects/{}/videos/concatenated.mp4', $.projectId)";
    const concatAudioUrlExpr = "States.Format('https://" + concatTrimEcs.outputBucket + ".s3.us-east-1.amazonaws.com/projects/{}/videos/concatenated.wav', $.projectId)";
    def.States.ConcatenateVideos = {
      Type: 'Pass',
      Comment: 'Build the concat-and-trim container payload (trimSilence:false).',
      Parameters: {
        'videos.$': '$.videoResults',
        'aspectRatio.$': '$.aspectRatio',
        'outputKey.$': "States.Format('projects/{}/videos/concatenated.mp4', $.projectId)",
        'audioOutputKey.$': "States.Format('projects/{}/videos/concatenated.wav', $.projectId)",
        trimSilence: false,
      },
      ResultPath: '$.concatPayload',
      Next: 'UploadConcatPayload',
    };
    def.States.UploadConcatPayload = {
      Type: 'Task',
      Resource: 'arn:aws:states:::lambda:invoke',
      Comment: 'ecs:runTask\'s ContainerOverrides has a hard 8192-byte limit — inlining the full per-frame video-URL array there breaks past roughly 40+ frames. Upload the payload to S3 here and pass only the short key across that boundary.',
      Parameters: {
        FunctionName: concatTrimEcs.uploadPayloadArn,
        Payload: {
          'key.$': "States.Format('projects/{}/payloads/concat.json', $.projectId)",
          'body.$': 'States.JsonToString($.concatPayload)',
        },
      },
      ResultSelector: { 'key.$': '$.Payload.key' },
      ResultPath: '$.concatPayloadUpload',
      TimeoutSeconds: 60,
      Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2 }],
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
      Next: 'ConcatenateVideosTask',
    };
    def.States.ConcatenateVideosTask = {
      Type: 'Task',
      Resource: 'arn:aws:states:::ecs:runTask.sync',
      Comment: 'Concat all frame videos into one, on QM\'s own Fargate task — no Lambda timeout/memory ceiling.',
      Parameters: {
        Cluster: concatTrimEcs.clusterArn,
        TaskDefinition: concatTrimEcs.taskDefinitionArn,
        LaunchType: 'FARGATE',
        NetworkConfiguration: {
          AwsvpcConfiguration: {
            Subnets: concatTrimEcs.subnetIds,
            SecurityGroups: [concatTrimEcs.securityGroupId],
            AssignPublicIp: 'ENABLED',
          },
        },
        Overrides: {
          ContainerOverrides: [{
            Name: concatTrimEcs.containerName,
            Environment: [{ Name: 'PAYLOAD_S3_KEY', 'Value.$': '$.concatPayloadUpload.key' }],
          }],
        },
      },
      ResultPath: '$.concatenateVideosEcs',
      TimeoutSeconds: 1800,
      Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 1, BackoffRate: 2 }],
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
      Next: 'BuildConcatenatedVideoResult',
    };
    def.States.BuildConcatenatedVideoResult = {
      Type: 'Pass',
      Comment: 'Deterministic URLs — the ECS task writes to exactly these keys, no result read back.',
      Parameters: { 'videoUrl.$': concatVideoUrlExpr, 'audioUrl.$': concatAudioUrlExpr },
      ResultPath: '$.concatenatedVideo',
      Next: 'TranscribeAudio',
    };
  }

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
        language: 'en',
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
function localizationStates(qmGenerateArn: string, tier: string, removeSilenceArn: string): Record<string, unknown> {
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
    Next: 'RemoveSilenceLocalized',
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
          // 2026-07-27: cut dead-air silence out of this language's whole-script
          // translated TTS audio before transcribing captions from it — same
          // product decision/algorithm as Basic's RemoveSilenceFourLang (see
          // QM-remove-silence's header comment), applied here to the ONE
          // audio-only artifact Premium's fourLang flow produces per language
          // (no separate concatenated video to trim — Premium pairs this
          // audio with English's existing single video, per localizationStates()'s
          // own header comment on the outputKey cross-repo gap). By construction
          // this state is only reached after TTS actually succeeded (a TTS
          // failure already diverted to LocalizationFailedForLanguage above),
          // so no empty-URL gate is needed the way Basic's per-frame case needs
          // one. ResultSelector unwraps the Lambda's {trimmedAudioUrl,...} down
          // to the bare {cdnUrl} shape QMGenerateLocalizedSRT/BuildLanguageAsset
          // already expect at $.ttsResult, so this REPLACES $.ttsResult in place
          // — safe because neither downstream state reads any other $.ttsResult
          // field (confirmed: both only ever reference $.ttsResult.cdnUrl).
          RemoveSilenceLocalized: {
            Type: 'Task',
            Resource: removeSilenceArn,
            Comment: 'Cut dead-air silence out of this language\'s translated voiceover audio (QM-remove-silence) before transcribing/finalizing it.',
            Parameters: {
              'mediaUrl.$': '$.ttsResult.cdnUrl',
              hasVideo: false,
              'outputKey.$': "States.Format('projects/{}/localized/{}/voiceover-trimmed.wav', $$.Execution.Input.projectId, $.code)",
            },
            ResultSelector: { 'cdnUrl.$': '$.trimmedAudioUrl' },
            ResultPath: '$.ttsResult',
            TimeoutSeconds: 300,
            Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 10, MaxAttempts: 2, BackoffRate: 1.5 }],
            Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.removeSilenceError', Next: 'QMGenerateLocalizedSRT' }],
            Next: 'QMGenerateLocalizedSRT',
          },
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
  narrationField: string, idField: string, tier: string,
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
        Comment: `Per-frame localized TTS via QM (voice.${tier}.ttsFrameLocalizedKokoro), explicit ${idField}.`,
        Parameters: {
          assetType: 'voice', tier, operation: 'ttsFrameLocalizedKokoro', product: 'narration', queue: 'background', jobType: 'batch',
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
        Comment: `Per-frame localized TTS via QM (voice.${tier}.ttsFrameLocalizedKokoro), no explicit ${idField} — voiceGender.$ lets QM-generate.ts pick a language+gender-appropriate default voice_id (defaultLocalizedKokoroVoiceId).`,
        Parameters: {
          assetType: 'voice', tier, operation: 'ttsFrameLocalizedKokoro', product: 'narration', queue: 'background', jobType: 'batch',
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
 * English's TTS branch for Premium fourLang — same clone-vs-design routing
 * qmPremiumFrameAssetsMap's RouteTTSEngine/QMGenerateTTSClone/QMGenerateTTS
 * uses for the single-language flow, reshaped as a standalone Parallel
 * branch (End:true, no ResultPath) mirroring localizedFrameTtsEnBranch's
 * shape above. Premium's English voice is always Qwen (design or clone),
 * never Kokoro — unlike Basic's fourLang English branch.
 */
function localizedFrameTtsEnBranchPremium(qmGenerateArn: string): { StartAt: string; States: Record<string, unknown> } {
  return {
    StartAt: 'RouteTTSFourLangEnPremium',
    States: {
      RouteTTSFourLangEnPremium: {
        Type: 'Choice',
        Comment: 'Frame already carries a voiceUrl -> reuse it; otherwise route to Qwen clone (if the project has a voiceCloneArtifactUrl) or Qwen voice-design.',
        Choices: [{
          And: [
            { Variable: '$.voiceUrl', IsPresent: true },
            { Variable: '$.voiceUrl', IsString: true },
            { Not: { Variable: '$.voiceUrl', StringEquals: '' } },
          ],
          Next: 'UseProvidedVoiceFourLangEnPremium',
        }],
        Default: 'RouteTTSEngineFourLangEnPremium',
      },
      UseProvidedVoiceFourLangEnPremium: { Type: 'Pass', Parameters: { 'cdnUrl.$': '$.voiceUrl', 'durationS.$': '$.duration' }, End: true },
      RouteTTSEngineFourLangEnPremium: {
        Type: 'Choice',
        Comment: 'Same clone-vs-design routing as qmPremiumFrameAssetsMap.RouteTTSEngine, reshaped as a standalone branch for the fourLang TTS x4 Parallel.',
        Choices: [{
          And: [
            { Variable: '$$.Execution.Input.voiceCloneArtifactUrl', IsPresent: true },
            { Variable: '$$.Execution.Input.voiceCloneArtifactUrl', IsString: true },
            { Not: { Variable: '$$.Execution.Input.voiceCloneArtifactUrl', StringEquals: '' } },
          ],
          Next: 'QMGenerateTTSCloneFourLangEn',
        }],
        Default: 'QMGenerateTTSFourLangEnPremium',
      },
      QMGenerateTTSCloneFourLangEn: {
        Type: 'Task',
        Resource: qmGenerateArn,
        Comment: 'English TTS via QM (voice.narrationPremium.tts, Qwen3-TTS clone_artifact_url fast path) — same rung the single-language frame Map uses.',
        Parameters: {
          assetType: 'voice', tier: 'narrationPremium', operation: 'tts', product: 'narration', queue: 'background', jobType: 'batch',
          'prompt.$': '$.narrationText',
          'cloneArtifactUrl.$': '$$.Execution.Input.voiceCloneArtifactUrl',
          'language.$': '$$.Execution.Input.voiceLanguage',
          'projectId.$': '$$.Execution.Input.projectId',
          'frameId.$': '$.frameId',
          'userId.$': '$$.Execution.Input.userId',
        },
        TimeoutSeconds: 920,
        Retry: STD_RETRY,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsErrorEn', Next: 'TtsFailedFourLangEnPremium' }],
        End: true,
      },
      QMGenerateTTSFourLangEnPremium: {
        Type: 'Task',
        Resource: qmGenerateArn,
        Comment: 'English TTS via QM (voice.narrationPremium.tts: self-hosted Qwen3-TTS voice-design) — same rung the single-language frame Map uses.',
        Parameters: {
          assetType: 'voice', tier: 'narrationPremium', operation: 'tts', product: 'narration', queue: 'background', jobType: 'batch',
          'prompt.$': '$.narrationText',
          'speaker.$': '$$.Execution.Input.voiceSpeaker',
          'instruct.$': '$$.Execution.Input.voiceInstruct',
          'language.$': '$$.Execution.Input.voiceLanguage',
          'projectId.$': '$$.Execution.Input.projectId',
          'frameId.$': '$.frameId',
          'userId.$': '$$.Execution.Input.userId',
        },
        TimeoutSeconds: 920,
        Retry: STD_RETRY,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsErrorEn', Next: 'TtsFailedFourLangEnPremium' }],
        End: true,
      },
      TtsFailedFourLangEnPremium: { Type: 'Pass', Parameters: { cdnUrl: '', durationS: 0, failed: true }, End: true },
    },
  };
}

/**
 * Es/PtBr per-frame localized TTS branch for Premium fourLang — Qwen
 * voice-clone only (no design-voice fallback: Premium's product decision is
 * that localized non-English voices always come from the project's
 * precomputed clone artifact, mirroring the whole-script localizationStates()
 * flow's RouteLocalizedTTS clone path, just per-frame). `cloneField` is the
 * project-level voiceCloneArtifactUrlEs/PtBr execution-input field — IsPresent-
 * guarded alongside narrationField before either is referenced via `.$` (a
 * bare reference to an absent optional field throws States.Runtime, same
 * gotcha localizedFrameTtsKokoroBranch's RouteVoiceIdFourLang guards against).
 * Missing clone artifact for a language that's otherwise configured is
 * treated the same as empty narration text: skip that language for this
 * frame rather than crashing the execution.
 */
function localizedFrameTtsQwenCloneBranch(
  qmGenerateArn: string, langCode: string, langKey: string, langName: string,
  narrationField: string, cloneField: string,
): { StartAt: string; States: Record<string, unknown> } {
  const frameIdExpr = `States.Format('{}:${langCode}', $.frameId)`;
  return {
    StartAt: `RouteTTSFourLang${langKey}`,
    States: {
      [`RouteTTSFourLang${langKey}`]: {
        Type: 'Choice',
        Comment: `Empty ${narrationField} (StoryStudio always sends this key on a fourLang project — "" means ${langCode} generation failed for this frame) OR missing project-level ${cloneField} (required — no design-voice fallback for localized Premium voices) -> skip ${langCode} for this frame.`,
        Choices: [{
          And: [
            { Variable: `$.${narrationField}`, IsPresent: true },
            { Variable: `$.${narrationField}`, IsString: true },
            { Not: { Variable: `$.${narrationField}`, StringEquals: '' } },
            { Variable: `$$.Execution.Input.${cloneField}`, IsPresent: true },
            { Variable: `$$.Execution.Input.${cloneField}`, IsString: true },
            { Not: { Variable: `$$.Execution.Input.${cloneField}`, StringEquals: '' } },
          ],
          Next: `QMGenerateTTSFourLang${langKey}`,
        }],
        Default: `SkipTTSFourLang${langKey}`,
      },
      [`SkipTTSFourLang${langKey}`]: { Type: 'Pass', Parameters: { cdnUrl: '', durationS: 0, skipped: true }, End: true },
      [`QMGenerateTTSFourLang${langKey}`]: {
        Type: 'Task',
        Resource: qmGenerateArn,
        Comment: `Per-frame localized TTS via QM (voice.narrationPremium.ttsFrameLocalizedQwen), Qwen voice-clone fast path using the project-level ${cloneField}.`,
        Parameters: {
          assetType: 'voice', tier: 'narrationPremium', operation: 'ttsFrameLocalizedQwen', product: 'narration', queue: 'background', jobType: 'batch',
          'prompt.$': `$.${narrationField}`,
          language: langName,
          'cloneArtifactUrl.$': `$$.Execution.Input.${cloneField}`,
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
function fourLangMergeBranch(
  qmGenerateArn: string, langKey: string, ttsFieldKey: string, langCode: string,
  tier: string, videoUrlPath: string,
): { StartAt: string; States: Record<string, unknown> } {
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
        Comment: `Merge this frame's ${langKey} TTS audio onto the SHARED animated/video clip (video.${tier}.merge) — same rung, same clip, every language merges onto it independently. durationS = the frame's max-across-4-languages duration (target for silence-padding a shorter track, see this function's header comment).`,
        Parameters: {
          assetType: 'video', tier, operation: 'merge', product: 'narration', queue: 'background', jobType: 'batch',
          'initImageUrls.$': `States.Array(${videoUrlPath})`,
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
          Comment: 'Reached from image gen AND from the TTS/animate/merge/overlay Catches above — whichever stage failed, this frame can\'t produce a video for at least one language (mirrors QMFrameFailed). Must emit the SAME videoUrls/esFailed/ptBrFailed/hiFailed shape FinalizeFrameVideoFourLang emits on success: found live 2026-07-27 — a single frame\'s hi:video:merge timeout reached here with the old {failed,error,frameId,frameNumber}-only shape (no videoUrls key), which crashed the downstream Reshape{en,es,ptBr,hi} Maps\' unconditional `$$.Map.Item.Value.videoUrls.<lang>` lookup with States.Runtime, failing the ENTIRE execution over one frame. Emitting empty videoUrls for all 4 languages here (English included — a whole-frame failure has no video for English either, unlike a per-language merge failure) lets the existing per-language all-or-nothing omission machinery treat this frame like any other failed frame instead of crashing.',
          Parameters: {
            failed: true,
            error: 'QMFrameFailed',
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            videoUrls: { en: '', es: '', ptBr: '', hi: '' },
            esFailed: true,
            ptBrFailed: true,
            hiFailed: true,
          },
          End: true,
        },
        GenerateFourLangTts: {
          Type: 'Parallel',
          Comment: 'TTS x4, one branch per language. Each branch outputs {cdnUrl, durationS} (skipped/failed languages get durationS:0, cdnUrl:\'\').',
          Branches: [
            localizedFrameTtsEnBranch(qmGenerateArn),
            localizedFrameTtsKokoroBranch(qmGenerateArn, 'es', 'Es', 'Spanish', 'narrationTextEs', 'voiceIdEs', 'narrationBasic'),
            localizedFrameTtsKokoroBranch(qmGenerateArn, 'pt-BR', 'PtBr', 'Portuguese', 'narrationTextPtBr', 'voiceIdPtBr', 'narrationBasic'),
            localizedFrameTtsKokoroBranch(qmGenerateArn, 'hi', 'Hi', 'Hindi', 'narrationTextHi', 'voiceIdHi', 'narrationBasic'),
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
            fourLangMergeBranch(qmGenerateArn, 'En', 'en', 'en', 'narrationBasic', '$.animateResult.cdnUrl'),
            fourLangMergeBranch(qmGenerateArn, 'Es', 'es', 'es', 'narrationBasic', '$.animateResult.cdnUrl'),
            fourLangMergeBranch(qmGenerateArn, 'PtBr', 'ptBr', 'pt-BR', 'narrationBasic', '$.animateResult.cdnUrl'),
            fourLangMergeBranch(qmGenerateArn, 'Hi', 'hi', 'hi', 'narrationBasic', '$.animateResult.cdnUrl'),
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
/** ECS resources a concat-and-trim branch needs to launch its Fargate task —
 * bundled into one object rather than 5 more positional params, threaded
 * through from where they're defined (near removeSilenceFn/removeSilenceBucket)
 * down through fourLangConcatFinalizeStates and the plain ConcatenateVideos
 * state alike. */
interface ConcatTrimEcsConfig {
  clusterArn: string;
  taskDefinitionArn: string;
  containerName: string;
  subnetIds: string[];
  securityGroupId: string;
  outputBucket: string;
  /** Lambda that uploads a JSON payload to S3 and returns its key — see this
   * config's threading-through comment. Used to keep ecs:runTask's
   * ContainerOverrides under its hard 8192-byte limit at large frame counts. */
  uploadPayloadArn: string;
}

/** Replaces concatFourLangBranch + removeSilenceFourLangBranch (both
 * deleted) — what used to be two separate Lambda hops through S3/R2 for the
 * same file (external E2E-video-concat-premium Lambda, then QM-remove-silence
 * Lambda) is now one QM-owned ECS Fargate task
 * (infra/docker/concat-and-trim/index.ts) that downloads the frame clips,
 * concats them, and — since fourLang always wants this — trims silence in
 * the same container run, uploading straight to the final trimmed keys (no
 * intermediate untrimmed upload, since nothing downstream ever consumed
 * that separately). Ported faithfully from the external Lambda's actually-
 * deployed source (confirmed by reading it directly) plus the already-proven
 * remove-silence.ts algorithm — see the container's own header comment for
 * the full list of what was ported vs deliberately dropped (JWT auth, hook/
 * avatar-clip splicing — both confirmed unused by QM-New's own calls).
 *
 * Same omission-gate contract as the old concatFourLangBranch: a language
 * already known omitted (every frame failed/skipped it upstream, per
 * ComputeLanguageOmissions) skips the Fargate task entirely rather than
 * sending it an all-empty video array. On any failure (omitted, or the ECS
 * task itself erroring/timing out), produces the same `{videoUrl:'',
 * audioUrl:'',failed:true}` shape the old two-step version did, so
 * everything downstream (PrepareTranscribeFourLang, finalizeLocalizedBranch)
 * needs zero changes — same `{videoUrl,audioUrl}` shape either way. */
function concatAndTrimFourLangBranch(
  ecs: ConcatTrimEcsConfig, fieldKey: string, langCode: string, omissionField?: string,
): { StartAt: string; States: Record<string, unknown> } {
  const prepare = `PrepareConcatTrim${fieldKey}`;
  const upload = `UploadConcatTrimPayload${fieldKey}`;
  const state = `ConcatAndTrim${fieldKey}`;
  const failed = `${state}Failed`;
  const applied = `ConcatAndTrimApplied${fieldKey}`;
  const payloadPath = `$.concatTrimPayload${fieldKey}`;
  const uploadResultPath = `$.concatTrimPayloadUpload${fieldKey}`;
  const outputKeyExpr = `States.Format('projects/{}/videos/${langCode}/concatenated-trimmed.mp4', $.projectId)`;
  const audioOutputKeyExpr = `States.Format('projects/{}/videos/${langCode}/concatenated-trimmed.wav', $.projectId)`;
  // Independent (not nested inside outputKeyExpr's own States.Format call —
  // ASL intrinsic nesting support is inconsistent enough across the fleet
  // that every other deterministic-URL construction in this file avoids it
  // too) full-URL expressions for the final {videoUrl,audioUrl} shape.
  const videoUrlExpr = `States.Format('https://${ecs.outputBucket}.s3.us-east-1.amazonaws.com/projects/{}/videos/${langCode}/concatenated-trimmed.mp4', $.projectId)`;
  const audioUrlExpr = `States.Format('https://${ecs.outputBucket}.s3.us-east-1.amazonaws.com/projects/{}/videos/${langCode}/concatenated-trimmed.wav', $.projectId)`;

  const prepareState = {
    Type: 'Pass',
    Comment: `Build the concat-and-trim container's payload for ${langCode}.`,
    Parameters: {
      'videos.$': `$.fourLangConcatPrep.${fieldKey}`,
      'aspectRatio.$': '$.aspectRatio',
      'outputKey.$': outputKeyExpr,
      'audioOutputKey.$': audioOutputKeyExpr,
      trimSilence: true,
    },
    ResultPath: payloadPath,
    Next: upload,
  };

  const uploadState = {
    Type: 'Task',
    Resource: 'arn:aws:states:::lambda:invoke',
    Comment: `Same ContainerOverrides 8192-byte workaround as the plain concat path (see UploadConcatPayload) — upload ${langCode}'s payload to S3 first, pass only the key.`,
    Parameters: {
      FunctionName: ecs.uploadPayloadArn,
      Payload: {
        'key.$': `States.Format('projects/{}/payloads/concat-${langCode}.json', $.projectId)`,
        'body.$': `States.JsonToString(${payloadPath})`,
      },
    },
    ResultSelector: { 'key.$': '$.Payload.key' },
    ResultPath: uploadResultPath,
    TimeoutSeconds: 60,
    Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: `$.concatTrimError${fieldKey}`, Next: failed }],
    Next: state,
  };

  const runTaskState = {
    Type: 'Task',
    Resource: 'arn:aws:states:::ecs:runTask.sync',
    Comment: `Concat + trim silence for ${langCode} on QM's own Fargate task — no Lambda timeout/memory ceiling (see QM-remove-silence's 12/12-attempt failure on a 69-frame project).`,
    Parameters: {
      Cluster: ecs.clusterArn,
      TaskDefinition: ecs.taskDefinitionArn,
      LaunchType: 'FARGATE',
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          Subnets: ecs.subnetIds,
          SecurityGroups: [ecs.securityGroupId],
          AssignPublicIp: 'ENABLED',
        },
      },
      Overrides: {
        ContainerOverrides: [{
          Name: ecs.containerName,
          Environment: [{ Name: 'PAYLOAD_S3_KEY', 'Value.$': `${uploadResultPath}.key` }],
        }],
      },
    },
    ResultPath: `$.concatTrimEcs${fieldKey}`,
    TimeoutSeconds: 1800,
    Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 1, BackoffRate: 2 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: `$.concatTrimError${fieldKey}`, Next: failed }],
    Next: applied,
  };

  const appliedState = {
    Type: 'Pass',
    Comment: 'Deterministic URLs — the ECS task writes to exactly these keys, no result read back (ecs:runTask.sync has no return value the way a Lambda invoke does). `failed:false` explicit (not omitted) — downstream Pass states (PrepareTranscribeFourLang) reference .failed via a Parameters `.$` path, which throws States.Runtime if the key is absent, unlike a Choice Variable which just silently non-matches on a missing key.',
    Parameters: { 'videoUrl.$': videoUrlExpr, 'audioUrl.$': audioUrlExpr, failed: false },
    End: true,
  };

  const failedState = { Type: 'Pass', Comment: 'Isolate this language\'s concat/trim failure from the other 3.', Parameters: { videoUrl: '', audioUrl: '', failed: true }, End: true };

  if (!omissionField) {
    return { StartAt: prepare, States: { [prepare]: prepareState, [upload]: uploadState, [state]: runTaskState, [applied]: appliedState, [failed]: failedState } };
  }

  const route = `RouteConcatTrim${fieldKey}`;
  const omitted = `${state}Omitted`;
  return {
    StartAt: route,
    States: {
      [route]: {
        Type: 'Choice',
        Comment: `${langCode} already known omitted (every frame failed/skipped it upstream, per ComputeLanguageOmissions) — skip the Fargate task entirely rather than sending it an all-empty video array.`,
        Choices: [{ Variable: `$.languageOmissions.${omissionField}`, BooleanEquals: true, Next: omitted }],
        Default: prepare,
      },
      [prepare]: prepareState,
      [upload]: uploadState,
      [state]: runTaskState,
      [applied]: appliedState,
      [omitted]: { Type: 'Pass', Comment: `${langCode} omitted before concat/trim was ever attempted — same shape as ${failed} so downstream can't tell the two apart.`, Parameters: { videoUrl: '', audioUrl: '', failed: true }, End: true },
      [failed]: failedState,
    },
  };
}
function finalizeLocalizedBranch(
  qmGenerateArn: string, fieldKey: string, langCode: string, transcribeIndex: number,
  mode: 'basic' | 'premium' = 'basic', targetResolution: string | undefined = undefined, timeoutSeconds = 3600,
  shortsTriggerArn: string = '',
): { StartAt: string; States: Record<string, unknown> } {
  const check = `CheckOmitted${fieldKey}`;
  const omitted = `Omitted${fieldKey}`;
  const prepare = `PrepareFinalize${fieldKey}`;
  const routeShorts = `RouteShorts${fieldKey}`;
  const triggerShorts = `TriggerShortsFourLang${fieldKey}`;
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
        Comment: `Skip finalize entirely (and omit finalVideoUrl) if ${langCode}'s concat/trim failed OR was already known omitted upstream — $.concatenatedVideosFourLang.${fieldKey}.failed is set by concatAndTrimFourLangBranch in both cases, so this one flag covers both failure modes (was $.languageOmissions.<x>Omitted, which only covered the upstream case and let a concat/trim failure cascade into a doomed Fargate finalize against an empty videoUrl — see qm-concat-trim-ecs-migration memory).`,
        Choices: [{ Variable: `$.concatenatedVideosFourLang.${fieldKey}.failed`, BooleanEquals: true, Next: omitted }],
        Default: prepare,
      },
      [omitted]: { Type: 'Pass', Parameters: { language: langCode, failed: true, error: 'PartialFailure' }, End: true },
      [prepare]: {
        Type: 'Pass',
        Comment: `Same finalizeTaskInput shape PrepareFinalize${mode === 'premium' ? 'Premium' : 'Basic'} builds for English, for ${langCode}.`,
        Parameters: {
          mode,
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
          ...(targetResolution ? { targetResolution } : {}),
          'jwtToken.$': '$.jwtToken',
          'convexEndpoint.$': '$.convexEndpoint',
        },
        ResultPath: taskInputPath,
        Next: shortsTriggerArn ? routeShorts : finalize,
      },
      ...(shortsTriggerArn ? {
        [routeShorts]: {
          Type: 'Choice',
          Comment: `Fire ${langCode}'s own long-to-shorts job when the project asked for shorts — mirrors CheckGenerateShorts, just per-language.`,
          Choices: [{ Variable: '$.generateShorts', BooleanEquals: true, Next: triggerShorts }],
          Default: finalize,
        },
        [triggerShorts]: {
          Type: 'Task',
          Resource: shortsTriggerArn,
          Comment: `Fire-and-forget long-to-shorts trigger for ${langCode}, sourced from this language's own pre-finalize concat video/SRT (same precedent as English's own trigger using its pre-finalize concat video, not the finalized master). projectId/jobId are language-suffixed — the shorts worker's R2 keys and Convex webhook correlation are otherwise global/unsuffixed and would collide across 4 parallel per-language triggers for the same project.`,
          Parameters: {
            'projectId.$': `States.Format('{}-${fieldKey}', $.projectId)`,
            'jobId.$': `States.Format('{}-${fieldKey}', $.jobId)`,
            'videoUrl.$': `$.concatenatedVideosFourLang.${fieldKey}.videoUrl`,
            'srtUrl.$': `$.transcribeResultsFourLang[${transcribeIndex}].srtUrl`,
            'bgmUrl.$': '$.bgmResult.cdnUrl',
            language: langCode,
            'convexEndpoint.$': '$.convexEndpoint',
            'shortsOptions.$': '$.shortsOptions',
          },
          ResultPath: `$.shortsExecution${fieldKey}`,
          TimeoutSeconds: 30,
          Catch: [{ ErrorEquals: ['States.ALL'], Comment: 'Shorts trigger failure is non-fatal — always proceed to finalize.', ResultPath: `$.shortsError${fieldKey}`, Next: finalize }],
          Next: finalize,
        },
      } : {}),
      [finalize]: {
        Type: 'Task',
        Resource: 'arn:aws:states:::ecs:runTask.sync',
        Comment: `Finalize on Fargate for ${langCode} — same cluster/task-def as FinalizeVideo${mode === 'premium' ? 'Premium' : 'Basic'}. See this function's header comment for the cross-repo outputKey dependency.`,
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
        TimeoutSeconds: timeoutSeconds,
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
function fourLangConcatFinalizeStates(
  qmGenerateArn: string, concatTrimEcs: ConcatTrimEcsConfig, mode: 'basic' | 'premium' = 'basic', shortsTriggerArn: string = '',
): Record<string, unknown> {
  const targetResolution = mode === 'premium' ? '1080p' : undefined;
  const finalizeTimeoutSeconds = mode === 'premium' ? 5400 : 3600;
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
      Comment: 'Concat + trim silence, one QM-owned Fargate task per language (replaces what used to be two separate Lambda hops through S3/R2 for the same file — see concatAndTrimFourLangBranch\'s header comment).',
      Branches: [
        concatAndTrimFourLangBranch(concatTrimEcs, 'en', 'en'),
        concatAndTrimFourLangBranch(concatTrimEcs, 'es', 'es', 'esOmitted'),
        concatAndTrimFourLangBranch(concatTrimEcs, 'ptBr', 'pt-BR', 'ptBrOmitted'),
        concatAndTrimFourLangBranch(concatTrimEcs, 'hi', 'hi', 'hiOmitted'),
      ],
      ResultSelector: { 'en.$': '$[0]', 'es.$': '$[1]', 'ptBr.$': '$[2]', 'hi.$': '$[3]' },
      ResultPath: '$.concatenatedVideosFourLang',
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
      Next: 'PrepareTranscribeFourLang',
    },
    PrepareTranscribeFourLang: {
      Type: 'Pass',
      Comment: 'Fan-out config for TranscribeAudioFourLang below — mirrors localizationStates()\'s PrepareLocalization idiom. en has no whisperLang hint (\'\'), matching today\'s single-language TranscribeAudio, which sends no language field at all. `omitted` sources from $.concatenatedVideosFourLang.<lang>.failed (not $.languageOmissions) so the Map iterator below skips the Whisper call for a language that failed EITHER upstream (every frame failed/skipped it) OR at concat/trim itself — both produce {videoUrl:\'\',audioUrl:\'\',failed:true} in concatAndTrimFourLangBranch, so this one flag is a strict superset of the old upstream-only signal. Without this, a concat/trim failure used to cascade into a doomed Whisper call against an empty audioUrl for every language, and then a doomed Fargate finalize (see qm-concat-trim-ecs-migration memory).',
      Parameters: {
        transcribeConfigs: [
          { code: 'en', whisperLang: '', 'omitted.$': '$.concatenatedVideosFourLang.en.failed', 'audioUrl.$': '$.concatenatedVideosFourLang.en.audioUrl' },
          { code: 'es', whisperLang: 'es', 'omitted.$': '$.concatenatedVideosFourLang.es.failed', 'audioUrl.$': '$.concatenatedVideosFourLang.es.audioUrl' },
          { code: 'pt-BR', whisperLang: 'pt', 'omitted.$': '$.concatenatedVideosFourLang.ptBr.failed', 'audioUrl.$': '$.concatenatedVideosFourLang.ptBr.audioUrl' },
          { code: 'hi', whisperLang: 'hi', 'omitted.$': '$.concatenatedVideosFourLang.hi.failed', 'audioUrl.$': '$.concatenatedVideosFourLang.hi.audioUrl' },
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
        finalizeLocalizedBranch(qmGenerateArn, 'es', 'es', 1, mode, targetResolution, finalizeTimeoutSeconds, shortsTriggerArn),
        finalizeLocalizedBranch(qmGenerateArn, 'ptBr', 'pt-BR', 2, mode, targetResolution, finalizeTimeoutSeconds, shortsTriggerArn),
        finalizeLocalizedBranch(qmGenerateArn, 'hi', 'hi', 3, mode, targetResolution, finalizeTimeoutSeconds, shortsTriggerArn),
      ],
      ResultPath: '$.localizedAssets',
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
      Next: 'UpdateStatusApplyingBgm',
    },
  };
}

/**
 * fourLang per-frame Map for Narration-Premium-QM-New (2026-07-28, porting
 * Basic's 2026-07-25 redesign — see qmFourLangFrameAssetsMap's header
 * comment for the shared design). Per frame: image ONCE (Qwen t2i/i2i, or
 * Qwen-Image-Gen for text-overlay genres) -> TTS x4 in parallel (English via
 * Qwen design/clone, es/pt-BR via Qwen voice-clone only, Hindi via Kokoro —
 * Premium's product decision, no design-voice fallback for localized voices)
 * -> the frame's video duration is the MAX of whichever languages succeeded
 * -> ONE silent Wan2 i2v clip per frame at that max duration (shared/common
 * across languages, only the audio differs) -> merge x4 (each language's TTS
 * audio onto the SAME shared clip) -> text overlay x4 (reused verbatim from
 * Basic's fourLang — direct Lambda invoke, no tier coupling) -> emit
 * videoUrls{en,es,ptBr,hi} + per-language failure flags, consumed downstream
 * by fourLangConcatFinalizeStates()'s all-or-nothing per-language omission
 * (identical to Basic's — that function is already tier-agnostic there).
 *
 * KEY DIFFERENCE from qmFourLangFrameAssetsMap: Wan2 has a 7s max
 * duration_s (Flux's animate rung does not), so the shared-clip step needs
 * the same short-clip+concat workaround qmPremiumFrameAssetsMap's
 * RouteVideoLength/QMGenerateVideoShort/QMConcatVideo already uses for the
 * single-language flow — just keyed off $.maxDuration.value (max across 4
 * languages) instead of a single TTS result's durationS.
 *
 * MaxConcurrency conservative for the same reason as Basic's fourLang Map
 * (4 vs the single-language Map's 8): each frame fires up to 4 TTS + up to 2
 * video calls + 4 merge calls against the same runpod:flux-tts-s2t pool
 * Premium's own single-language TTS/merge/image calls already share. Wan2
 * load itself is unchanged (still <=2 Wan2-family calls/frame regardless of
 * language count, since the clip is shared) — needs live tuning like Basic's
 * did.
 */
function qmPremiumFourLangFrameAssetsMap(qmGenerateArn: string, remotionOverlayArn: string): object {
  return {
    Type: 'Map',
    Comment: 'Premium fourLang per-frame video via Quartermaster gateway: image once, TTS x4 (en via Qwen design/clone, es/pt-BR via Qwen clone, hi via Kokoro), ONE silent Wan2 clip per frame at the max TTS duration across languages, merge x4 onto the shared clip. Supersedes the old whole-script post-concat localization for fourLang:true Narration-Premium projects.',
    ItemsPath: '$.frames',
    MaxConcurrency: 4,
    ResultPath: '$.videoResults',
    Iterator: {
      StartAt: 'NormalizeTextManifestFourLangPremium',
      States: {
        NormalizeTextManifestFourLangPremium: {
          Type: 'Choice',
          Comment: 'Guarantee $.textManifest is a real string before BuildFrameVideoFourLangPremium references it — same gotcha as Basic\'s NormalizeTextManifestFourLang.',
          Choices: [{
            And: [
              { Variable: '$.textManifest', IsPresent: true },
              { Variable: '$.textManifest', IsString: true },
              { Not: { Variable: '$.textManifest', StringEquals: '' } },
            ],
            Next: 'NormalizeTextManifestEsFourLangPremium',
          }],
          Default: 'SetTextManifestDefaultFourLangPremium',
        },
        SetTextManifestDefaultFourLangPremium: { Type: 'Pass', Result: '', ResultPath: '$.textManifest', Next: 'NormalizeTextManifestEsFourLangPremium' },
        NormalizeTextManifestEsFourLangPremium: {
          Type: 'Choice',
          Comment: 'Guarantee $.textManifestEs is a real string before TextOverlayFourLangPremium references it.',
          Choices: [{
            And: [{ Variable: '$.textManifestEs', IsPresent: true }, { Variable: '$.textManifestEs', IsString: true }],
            Next: 'NormalizeTextManifestPtBrFourLangPremium',
          }],
          Default: 'SetTextManifestEsDefaultFourLangPremium',
        },
        SetTextManifestEsDefaultFourLangPremium: { Type: 'Pass', Result: '', ResultPath: '$.textManifestEs', Next: 'NormalizeTextManifestPtBrFourLangPremium' },
        NormalizeTextManifestPtBrFourLangPremium: {
          Type: 'Choice',
          Comment: 'Guarantee $.textManifestPtBr is a real string before TextOverlayFourLangPremium references it.',
          Choices: [{
            And: [{ Variable: '$.textManifestPtBr', IsPresent: true }, { Variable: '$.textManifestPtBr', IsString: true }],
            Next: 'NormalizeTextManifestHiFourLangPremium',
          }],
          Default: 'SetTextManifestPtBrDefaultFourLangPremium',
        },
        SetTextManifestPtBrDefaultFourLangPremium: { Type: 'Pass', Result: '', ResultPath: '$.textManifestPtBr', Next: 'NormalizeTextManifestHiFourLangPremium' },
        NormalizeTextManifestHiFourLangPremium: {
          Type: 'Choice',
          Comment: 'Guarantee $.textManifestHi is a real string before TextOverlayFourLangPremium references it.',
          Choices: [{
            And: [{ Variable: '$.textManifestHi', IsPresent: true }, { Variable: '$.textManifestHi', IsString: true }],
            Next: 'RouteImageModelFourLangPremium',
          }],
          Default: 'SetTextManifestHiDefaultFourLangPremium',
        },
        SetTextManifestHiDefaultFourLangPremium: { Type: 'Pass', Result: '', ResultPath: '$.textManifestHi', Next: 'RouteImageModelFourLangPremium' },
        RouteImageModelFourLangPremium: {
          Type: 'Choice',
          Comment: 'Same imageModel routing rule as qmPremiumFrameAssetsMap\'s RouteImageGen — always a standalone image call for fourLang frames.',
          Choices: [{
            Or: [
              { And: [{ Variable: '$.imageModel', IsPresent: true }, { Variable: '$.imageModel', IsString: true }, { Variable: '$.imageModel', StringEquals: 'ernie' }] },
              { And: [{ Variable: '$.imageModel', IsPresent: true }, { Variable: '$.imageModel', IsString: true }, { Variable: '$.imageModel', StringEquals: 'qwen-image-gen' }] },
            ],
            Next: 'QMGenerateImageExplainerFourLangPremium',
          }],
          Default: 'RouteImageI2IFourLangPremium',
        },
        RouteImageI2IFourLangPremium: {
          Type: 'Choice',
          Choices: [{
            And: [
              { Variable: '$.referenceImageUrl', IsPresent: true },
              { Variable: '$.referenceImageUrl', IsString: true },
              { Not: { Variable: '$.referenceImageUrl', StringEquals: '' } },
            ],
            Next: 'QMGenerateImageI2IFourLangPremium',
          }],
          Default: 'QMGenerateImageT2IFourLangPremium',
        },
        QMGenerateImageExplainerFourLangPremium: {
          Type: 'Task', Resource: qmGenerateArn,
          Comment: 'Text-to-image via QM (image.explainer.t2i) — same rung/rule as qmPremiumFrameAssetsMap\'s QMGenerateImageExplainer.',
          Parameters: {
            assetType: 'image', tier: 'explainer', operation: 't2i', product: 'narration', queue: 'background', jobType: 'batch',
            'prompt.$': '$.imagePrompt', 'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId', 'frameId.$': '$.frameId', 'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.imageResult', TimeoutSeconds: 920, Retry: STD_RETRY,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'QMFrameFailedFourLangPremium' }],
          Next: 'GenerateFourLangTtsPremium',
        },
        QMGenerateImageT2IFourLangPremium: {
          Type: 'Task', Resource: qmGenerateArn,
          Comment: 'Text-to-image via QM (image.narrationPremium.t2i), standalone (not the single-language flow\'s image/TTS/video/merge steps).',
          Parameters: {
            assetType: 'image', tier: 'narrationPremium', operation: 't2i', product: 'narration', queue: 'background', jobType: 'batch',
            'prompt.$': '$.imagePrompt', 'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId', 'frameId.$': '$.frameId', 'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.imageResult', TimeoutSeconds: 920, Retry: STD_RETRY,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'QMFrameFailedFourLangPremium' }],
          Next: 'GenerateFourLangTtsPremium',
        },
        QMGenerateImageI2IFourLangPremium: {
          Type: 'Task', Resource: qmGenerateArn,
          Comment: 'Image-to-image via QM (image.narrationPremium.i2i), standalone.',
          Parameters: {
            assetType: 'image', tier: 'narrationPremium', operation: 'i2i', product: 'narration', queue: 'background', jobType: 'batch',
            'prompt.$': '$.imagePrompt', 'initImageUrls.$': 'States.Array($.referenceImageUrl)', 'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId', 'frameId.$': '$.frameId', 'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.imageResult', TimeoutSeconds: 920, Retry: STD_RETRY,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'QMFrameFailedFourLangPremium' }],
          Next: 'GenerateFourLangTtsPremium',
        },
        QMFrameFailedFourLangPremium: {
          Type: 'Pass',
          Comment: 'Reached from image gen AND from the TTS/video/merge/overlay Catches below — mirrors Basic\'s QMFrameFailedFourLang exactly (same videoUrls/esFailed/ptBrFailed/hiFailed shape required downstream).',
          Parameters: {
            failed: true,
            error: 'QMFrameFailed',
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            videoUrls: { en: '', es: '', ptBr: '', hi: '' },
            esFailed: true,
            ptBrFailed: true,
            hiFailed: true,
          },
          End: true,
        },
        GenerateFourLangTtsPremium: {
          Type: 'Parallel',
          Comment: 'TTS x4, one branch per language. English: Qwen design/clone. Es/PtBr: Qwen voice-clone only (no design fallback). Hindi: Kokoro (Qwen has no Hindi voices).',
          Branches: [
            localizedFrameTtsEnBranchPremium(qmGenerateArn),
            localizedFrameTtsQwenCloneBranch(qmGenerateArn, 'es', 'Es', 'Spanish', 'narrationTextEs', 'voiceCloneArtifactUrlEs'),
            localizedFrameTtsQwenCloneBranch(qmGenerateArn, 'pt-BR', 'PtBr', 'Portuguese', 'narrationTextPtBr', 'voiceCloneArtifactUrlPtBr'),
            localizedFrameTtsKokoroBranch(qmGenerateArn, 'hi', 'Hi', 'Hindi', 'narrationTextHi', 'voiceIdHi', 'narrationPremium'),
          ],
          ResultSelector: { 'en.$': '$[0]', 'es.$': '$[1]', 'ptBr.$': '$[2]', 'hi.$': '$[3]' },
          ResultPath: '$.ttsResults',
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsResultsError', Next: 'QMFrameFailedFourLangPremium' }],
          Next: 'ComputeMaxDurationStep1Premium',
        },
        // Same no-max()-intrinsic pairwise Choice/Pass chain as Basic's fourLang Map.
        ComputeMaxDurationStep1Premium: {
          Type: 'Choice',
          Choices: [{ Variable: '$.ttsResults.en.durationS', NumericGreaterThanPath: '$.ttsResults.es.durationS', Next: 'SetMaxDurationStep1EnPremium' }],
          Default: 'SetMaxDurationStep1EsPremium',
        },
        SetMaxDurationStep1EnPremium: { Type: 'Pass', Parameters: { 'value.$': '$.ttsResults.en.durationS' }, ResultPath: '$.maxDurationStep1', Next: 'ComputeMaxDurationStep2Premium' },
        SetMaxDurationStep1EsPremium: { Type: 'Pass', Parameters: { 'value.$': '$.ttsResults.es.durationS' }, ResultPath: '$.maxDurationStep1', Next: 'ComputeMaxDurationStep2Premium' },
        ComputeMaxDurationStep2Premium: {
          Type: 'Choice',
          Choices: [{ Variable: '$.maxDurationStep1.value', NumericGreaterThanPath: '$.ttsResults.ptBr.durationS', Next: 'SetMaxDurationStep2PrevPremium' }],
          Default: 'SetMaxDurationStep2PtBrPremium',
        },
        SetMaxDurationStep2PrevPremium: { Type: 'Pass', Parameters: { 'value.$': '$.maxDurationStep1.value' }, ResultPath: '$.maxDurationStep2', Next: 'ComputeMaxDurationStep3Premium' },
        SetMaxDurationStep2PtBrPremium: { Type: 'Pass', Parameters: { 'value.$': '$.ttsResults.ptBr.durationS' }, ResultPath: '$.maxDurationStep2', Next: 'ComputeMaxDurationStep3Premium' },
        ComputeMaxDurationStep3Premium: {
          Type: 'Choice',
          Choices: [{ Variable: '$.maxDurationStep2.value', NumericGreaterThanPath: '$.ttsResults.hi.durationS', Next: 'SetMaxDurationFinalPrevPremium' }],
          Default: 'SetMaxDurationFinalHiPremium',
        },
        SetMaxDurationFinalPrevPremium: { Type: 'Pass', Parameters: { 'value.$': '$.maxDurationStep2.value' }, ResultPath: '$.maxDuration', Next: 'RouteVideoLengthFourLangPremium' },
        SetMaxDurationFinalHiPremium: { Type: 'Pass', Parameters: { 'value.$': '$.ttsResults.hi.durationS' }, ResultPath: '$.maxDuration', Next: 'RouteVideoLengthFourLangPremium' },
        // Wan2's 7s duration_s ceiling (Flux's animate rung has none) — mirrors
        // qmPremiumFrameAssetsMap's RouteVideoLength/QMGenerateVideoShort/
        // QMConcatVideo/QMGenerateVideo/UseSingleClipVideo, keyed off the max
        // TTS duration across all 4 languages instead of a single TTS result.
        RouteVideoLengthFourLangPremium: {
          Type: 'Choice',
          Comment: 'Max TTS duration across all 4 languages > 7s (Wan2\'s max duration_s) -> generate a fixed 5s clip and extend it via concat.',
          Choices: [{ Variable: '$.maxDuration.value', NumericGreaterThan: 7, Next: 'QMGenerateVideoShortFourLangPremium' }],
          Default: 'QMGenerateVideoFourLangPremium',
        },
        QMGenerateVideoShortFourLangPremium: {
          Type: 'Task', Resource: qmGenerateArn,
          Comment: 'Image-to-video via QM (video.narrationPremium.i2v), fixed 5s clip — same workaround as qmPremiumFrameAssetsMap\'s QMGenerateVideoShort, keyed off $.maxDuration.value.',
          Parameters: {
            assetType: 'video', tier: 'narrationPremium', operation: 'i2v', product: 'narration', queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'prompt.$': '$.narrationText',
            durationS: 5,
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId', 'frameId.$': '$.frameId', 'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.videoResult', TimeoutSeconds: 920, Retry: STD_RETRY,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoError', Next: 'QMFrameFailedFourLangPremium' }],
          Next: 'QMConcatVideoFourLangPremium',
        },
        QMConcatVideoFourLangPremium: {
          Type: 'Task', Resource: qmGenerateArn,
          Comment: 'Extend the 5s clip via QM (video.narrationPremium.concat) — duplicates the same clip URL twice (5+5=10s), mirrors qmPremiumFrameAssetsMap\'s QMConcatVideo. merge below trims to the real max-duration length.',
          Parameters: {
            assetType: 'video', tier: 'narrationPremium', operation: 'concat', product: 'narration', queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.videoResult.cdnUrl, $.videoResult.cdnUrl)',
            'projectId.$': '$$.Execution.Input.projectId', 'frameId.$': '$.frameId', 'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.finalVideoResult', TimeoutSeconds: 300, Retry: STD_RETRY,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.concatError', Next: 'QMFrameFailedFourLangPremium' }],
          Next: 'MergeFourLangAudioPremium',
        },
        QMGenerateVideoFourLangPremium: {
          Type: 'Task', Resource: qmGenerateArn,
          Comment: 'Image-to-video via QM (video.narrationPremium.i2v) — ONE silent clip per frame, sized to the max TTS duration across all 4 languages (shared/common across languages). Mirrors Basic\'s QMGenerateAnimateFourLang but for Wan2.',
          Parameters: {
            assetType: 'video', tier: 'narrationPremium', operation: 'i2v', product: 'narration', queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'prompt.$': '$.narrationText',
            'durationS.$': '$.maxDuration.value',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId', 'frameId.$': '$.frameId', 'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.videoResult', TimeoutSeconds: 920, Retry: STD_RETRY,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoError', Next: 'QMFrameFailedFourLangPremium' }],
          Next: 'UseSingleClipVideoFourLangPremium',
        },
        UseSingleClipVideoFourLangPremium: {
          Type: 'Pass',
          Comment: 'Max TTS duration across all 4 languages <= 7s — the single Wan2 clip already covers it, no extension needed.',
          Parameters: { 'cdnUrl.$': '$.videoResult.cdnUrl' },
          ResultPath: '$.finalVideoResult',
          Next: 'MergeFourLangAudioPremium',
        },
        MergeFourLangAudioPremium: {
          Type: 'Parallel',
          Comment: 'Merge x4 — each language\'s TTS audio onto the SAME shared Wan2 clip (video.narrationPremium.merge → aliases the QM-owned Lambda merge, correct padding). A language whose TTS was skipped/failed for this frame skips merge too.',
          Branches: [
            fourLangMergeBranch(qmGenerateArn, 'En', 'en', 'en', 'narrationPremium', '$.finalVideoResult.cdnUrl'),
            fourLangMergeBranch(qmGenerateArn, 'Es', 'es', 'es', 'narrationPremium', '$.finalVideoResult.cdnUrl'),
            fourLangMergeBranch(qmGenerateArn, 'PtBr', 'ptBr', 'pt-BR', 'narrationPremium', '$.finalVideoResult.cdnUrl'),
            fourLangMergeBranch(qmGenerateArn, 'Hi', 'hi', 'hi', 'narrationPremium', '$.finalVideoResult.cdnUrl'),
          ],
          ResultSelector: { 'en.$': '$[0]', 'es.$': '$[1]', 'ptBr.$': '$[2]', 'hi.$': '$[3]' },
          ResultPath: '$.mergeResults',
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.mergeResultsError', Next: 'QMFrameFailedFourLangPremium' }],
          Next: 'BuildFrameVideoFourLangPremium',
        },
        BuildFrameVideoFourLangPremium: {
          Type: 'Pass',
          Comment: 'Emit the per-frame multi-language item fourLangConcatFinalizeStates() consumes — same shape Basic\'s BuildFrameVideoFourLang emits.',
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
          Next: 'TextOverlayFourLangPremium',
        },
        TextOverlayFourLangPremium: {
          Type: 'Parallel',
          Comment: 'Text overlay x4 — reuses fourLangTextOverlayBranch verbatim (direct Remotion Lambda invoke, no tier coupling), same as Basic\'s TextOverlayFourLang.',
          Branches: [
            fourLangTextOverlayBranch(remotionOverlayArn, 'En', 'en', 'textManifest'),
            fourLangTextOverlayBranch(remotionOverlayArn, 'Es', 'es', 'textManifestEs'),
            fourLangTextOverlayBranch(remotionOverlayArn, 'PtBr', 'ptBr', 'textManifestPtBr'),
            fourLangTextOverlayBranch(remotionOverlayArn, 'Hi', 'hi', 'textManifestHi'),
          ],
          ResultSelector: { 'en.$': '$[0].cdnUrl', 'es.$': '$[1].cdnUrl', 'ptBr.$': '$[2].cdnUrl', 'hi.$': '$[3].cdnUrl' },
          ResultPath: '$.overlaidVideoUrls',
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.overlayResultsError', Next: 'QMFrameFailedFourLangPremium' }],
          Next: 'FinalizeFrameVideoFourLangPremium',
        },
        FinalizeFrameVideoFourLangPremium: {
          Type: 'Pass',
          Comment: 'Reshape TextOverlayFourLangPremium\'s Parallel result back into the per-frame item fourLangConcatFinalizeStates() consumes.',
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

// ---------------------------------------------------------------------------
// Narration-Premium-QM-New SFN definition
// ---------------------------------------------------------------------------
// Sibling of buildQmNewDefinition: same downstream shape (concat → SRT →
// finalize), but the per-frame Map generates image (Qwen t2i/i2i) + TTS (Qwen
// voice-design) + Wan2 i2v + merge instead of Flux image/TTS/animate/merge, and
// the finalize section is Premium-flavored (1080p upscale), matching
// buildPremiumDefinition's FinalizeVideoPremium exactly.
// ---------------------------------------------------------------------------
function buildNarrationPremiumQmNewDefinition(qmGenerateArn: string, brokerArn: string, shortsTriggerArn: string, remotionOverlayArn: string, removeSilenceArn: string, concatTrimEcs: ConcatTrimEcsConfig): object {
  const def = JSON.parse(JSON.stringify(buildQmNewDefinition(qmGenerateArn, brokerArn, shortsTriggerArn, remotionOverlayArn, removeSilenceArn, concatTrimEcs))) as {
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

  // fourLang PER-FRAME full-video pipeline (2026-07-28, porting Basic's
  // 2026-07-25 redesign to Premium's primitives — Qwen image, Qwen TTS
  // design/clone, Wan2 i2v, generic merge). Swap the inherited Basic-tiered
  // fourLang Map for Premium's own (qmPremiumFourLangFrameAssetsMap), and
  // re-tier fourLangConcatFinalizeStates' finalize fan-out to Premium
  // (1080p, longer Fargate timeout, mode:'premium') — everything else that
  // function returns (BuildLangVideoArrays/ComputeLanguageOmissions/
  // ConcatenateVideosFourLang/RemoveSilenceFourLang/PrepareTranscribeFourLang/
  // TranscribeAudioFourLang/BuildMergedVoiceResultFourLangEn) is tier-agnostic
  // already, reused verbatim. RouteFrameGeneration/RouteConcatFourLang (both
  // inherited from the Basic clone) are also tier-agnostic — they only
  // branch on $.fourLang — so they're left as-is, not deleted.
  def.States.GenerateImagesFourLang = qmPremiumFourLangFrameAssetsMap(qmGenerateArn, remotionOverlayArn);
  def.States.GenerateImagesFourLang.Next = 'RouteBGM';
  Object.assign(def.States, fourLangConcatFinalizeStates(qmGenerateArn, concatTrimEcs, 'premium', shortsTriggerArn));

  // No whole-script localizationStates() call for Premium anymore: once the
  // per-frame fourLang path above is wired in, RouteFrameGeneration/
  // RouteConcatFourLang divert fourLang:true away from GenerateImages/
  // ConcatenateVideos/BuildMergedVoiceResult before they'd ever reach
  // RouteLocalization — so the whole-script flow is genuinely unreachable
  // for Premium now, exactly as it already is for Basic (buildQmNewDefinition
  // never calls localizationStates() either). BuildMergedVoiceResult.Next
  // stays 'SetNoLocalizedAssets' as inherited from the Basic clone.

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
    Comment: 'Verify required fields exist AND are non-empty before finalize — same fix as ValidateFinalizeInputsBasic (see qm-concat-trim-ecs-migration memory).',
    Choices: [{
      And: [
        { Variable: '$.mergedVoiceResult.mergedVideoUrl', IsPresent: true },
        { Not: { Variable: '$.mergedVoiceResult.mergedVideoUrl', StringEquals: '' } },
      ],
      Next: 'PrepareFinalizePremium',
    }],
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
    // Must match Wan2's real pod count (fleet.ts's WAN2_I2V entry / PROJECT_FLEET's
    // narration-premium gateMax) exactly — capacity planning and real SFN
    // parallelism must agree, or under-provisioned workers meet real RunPod
    // contention this constant was supposed to prevent. Raised 6→8 (2026-07-27):
    // RunPod account cap doubled 20→30, Wan2 pods raised 6→8 same day —
    // re-confirmed against the dashboard ("30/30 Workers deployed").
    MaxConcurrency: 8,
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
// Dialogue Basic / Dialogue Premium — storystudio-dialogue-qm-sfn-handoff.md
// ---------------------------------------------------------------------------
// Both clone buildQmNewDefinition's OUTPUT (not the deep legacy buildDefinition
// directly) — same strategy buildNarrationPremiumQmNewDefinition already uses.
// That inherits the entire shared plumbing (ValidateInput/CheckValidation/
// HandleFailure/Complete/status-update Tasks/DropFrameData's allowlist
// convention/shortsTriggerStates/the fourLang+shorts field-normalization
// chain) fully assembled, so only the per-project-type pieces need writing.
//
// CORRECTION (2026-08-10, learned the hard way across two real dialogue-basic
// executions — see storystudio-reply-dialogue-validate-input-gap.md): both
// claims this comment used to make here were wrong.
//
// 1. "Step Functions does not validate state reachability at deploy time" —
//    false. The live CreateStateMachine/UpdateStateMachine API rejects any
//    declared-but-unreachable state at deploy time (confirmed:
//    MISSING_TRANSITION_TARGET on an orphaned CheckValidation, first deploy
//    attempt of the ValidateInput fix). CDK's own `synth` does NOT catch
//    this — only the real API call does. RouteFrameGeneration/
//    GenerateImagesFourLang/RouteConcatFourLang/fourLangConcatFinalizeStates'
//    output are therefore explicitly `delete`d below in both builders (see
//    the `deadState` loops), not left as unreferenced dead JSON — leaving
//    any of them unreferenced would fail deployment outright.
//
// 2. The inherited NormalizeFourLang -> NormalizeGenerateShortsField ->
//    NormalizeShortsOptionsField -> SetShortsOptionsFieldDefault chain IS
//    still wired in and used (terminates at 'DropFrameData', which both
//    builders below redefine) — but its first two Choice states' bare
//    `BooleanEquals` comparisons on $.fourLang/$.generateShorts (fields
//    dialogue never sends at all) do NOT get treated as a harmless
//    non-match/Default fallthrough — they throw States.Runtime ('Invalid
//    path'), an uncatchable execution-ending error, exactly like
//    UpdateStatusConcatenating's $.videoResults bug below. Both are now
//    IsPresent-guarded (same pattern as RouteFrameGeneration), fixed at the
//    shared buildQmNewDefinition source rather than per-builder, since
//    narration tiers omitting these same optional fields are equally
//    exposed. NormalizeShortsOptionsField was already correctly
//    IsPresent-guarded and needed no fix.
// ---------------------------------------------------------------------------

interface DialogueMixEcsConfig {
  clusterArn: string;
  taskDefinitionArn: string;
  containerName: string;
  subnetIds: string[];
  securityGroupId: string;
  outputBucket: string;
  /** Same QM-upload-payload Lambda concat-and-trim uses — both modes' payloads
   * are small, but reusing the S3-indirection habit avoids ever re-learning
   * the 8192-byte ecs:runTask ContainerOverrides lesson concat-and-trim did. */
  uploadPayloadArn: string;
}

/**
 * Dialogue Basic's narrator branch (storystudio-dialogue-qm-sfn-handoff.md
 * §4.2): persona still generated ONCE (skipped when narrator.imageUrl is
 * non-empty), before the segment Map — every segment (including 0) then
 * anchors on the SAME personaImageUrl, which is precisely what removes any
 * ordering constraint between segments (the doc's recommended approach over
 * a segmentIndex===0 Choice). personaImageUrl is threaded into each Map
 * iteration via the Map state's own `Parameters` block (which can reference
 * both `$$.Map.Item.Value` for the current item AND `$` for the Map's own
 * input) rather than injected per-item into $.segments, since ASL's JSONPath
 * dialect has no per-item array transform.
 *
 * TTS routes clone-vs-design INSIDE runpod.ts's own 'tts' mode handler
 * (`if (p.cloneArtifactUrl)`) — no RouteTTSEngine Choice needed here, unlike
 * narration-premium's SFN-level split, because voice.dialogueBasic.tts has
 * only the one physical rung either way.
 *
 * InfiniteTalk is poll-only (plain lambda:invoke, not .waitForTaskToken) —
 * RunComfy has no webhook mechanism of its own (adapters/runcomfy.ts,
 * supportsWebhook:false), so the doc's originally-envisioned ">45s RunPod
 * webhook" branch (§4.3) doesn't apply to the RunComfy integration actually
 * built (that framing predates the 2026-08-08 live testing that settled on
 * RunComfy over documentary-premium's RunPod-hosted InfiniteTalk). §7.12.1
 * measured only ~106s server-side elapsed even for a 26s narrator clip —
 * comfortably inside qm-generate.ts's 850s blocking-poll ceiling — and
 * explicitly downgrades the webhook branch to "unlikely needed in practice."
 */
function dialogueBasicNarratorBranch(qmGenerateArn: string): object {
  const carry = {
    'jobId.$': '$.jobId',
    'projectId.$': '$.projectId',
    'projectType.$': '$.projectType',
    'aspectRatio.$': '$.aspectRatio',
    'narrator.$': '$.narrator',
    'narratorOverlay.$': '$.narratorOverlay',
    'segments.$': '$.segments',
    'bgmPrompt.$': '$.bgmPrompt',
    'textOverlayEnabled.$': '$.textOverlayEnabled',
    'apiKey.$': '$.apiKey',
    'jwtToken.$': '$.jwtToken',
    'convexEndpoint.$': '$.convexEndpoint',
    'userId.$': '$.userId',
    'admissionId.$': '$.admissionId',
  };
  return {
    StartAt: 'RouteNarratorPersona',
    States: {
      RouteNarratorPersona: {
        Type: 'Choice',
        Comment: 'narrator.imageUrl non-empty -> use it directly, skip persona generation entirely (§3.3/§4.2).',
        Choices: [{
          And: [
            { Variable: '$.narrator.imageUrl', IsPresent: true },
            { Variable: '$.narrator.imageUrl', IsString: true },
            { Not: { Variable: '$.narrator.imageUrl', StringEquals: '' } },
          ],
          Next: 'UseNarratorImageUrl',
        }],
        Default: 'QMGenerateNarratorPersona',
      },
      UseNarratorImageUrl: {
        Type: 'Pass',
        Parameters: { ...carry, 'personaImageUrl.$': '$.narrator.imageUrl' },
        Next: 'GenerateNarratorSegments',
      },
      QMGenerateNarratorPersona: {
        Type: 'Task',
        Resource: qmGenerateArn,
        Comment: 'Narrator persona still via QM (image.dialogueBasic.persona: self-hosted Qwen-Image-Gen -> nano-banana fallback). Generated ONCE, before the segment Map.',
        Parameters: {
          assetType: 'image',
          tier: 'dialogueBasic',
          operation: 'persona',
          product: 'dialogue',
          queue: 'background',
          jobType: 'batch',
          'prompt.$': '$.narrator.imagePrompt',
          'aspectRatio.$': '$.aspectRatio',
          'projectId.$': '$.projectId',
          'userId.$': '$.userId',
        },
        ResultPath: '$.personaResult',
        TimeoutSeconds: 920,
        Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.personaError', Next: 'NarratorBranchFailed' }],
        Next: 'SetPersonaFromResult',
      },
      SetPersonaFromResult: {
        Type: 'Pass',
        Parameters: { ...carry, 'personaImageUrl.$': '$.personaResult.cdnUrl' },
        Next: 'GenerateNarratorSegments',
      },
      GenerateNarratorSegments: {
        Type: 'Map',
        Comment: 'One QM TTS call + one RunComfy InfiniteTalk call per narrator segment (30-45s each). MaxConcurrency=3 — every segment uses the SAME personaImageUrl, so there is no cross-segment ordering dependency (§4.2).',
        ItemsPath: '$.segments',
        MaxConcurrency: 3,
        Parameters: {
          'segmentIndex.$': '$$.Map.Item.Value.segmentIndex',
          'scriptText.$': '$$.Map.Item.Value.scriptText',
          'personaImageUrl.$': '$.personaImageUrl',
          'narrator.$': '$.narrator',
          'projectId.$': '$.projectId',
          'userId.$': '$.userId',
        },
        // ResultPath '$' (replace, not merge) — mirrors Premium-QM's
        // GenerateAllFrames pattern. Merging into '$.segmentResults' instead
        // would carry the whole branch state (narrator prompt, every
        // segment's scriptText) into this branch's output; doubled across
        // both Parallel branches that pushed GenerateNarratorAndScenes over
        // Step Functions' 256KB States.DataLimitExceeded ceiling (confirmed
        // live 2026-08-10, execution js7bd2ep...3l70g77m9). BuildSegmentResult
        // already returns a slim per-segment object, so replacing the whole
        // state with the bare Map result array is exactly what downstream
        // MergeParallelResults needs.
        ResultPath: '$',
        Iterator: {
          StartAt: 'QMGenerateNarratorTTS',
          States: {
            QMGenerateNarratorTTS: {
              Type: 'Task',
              Resource: qmGenerateArn,
              Comment: 'Narrator segment TTS via QM (voice.dialogueBasic.tts: Qwen voice-clone clone_artifact_url fast path when narrator.voiceCloneArtifactUrl is set, else voice-design fallback via voiceInstruct — routed inside runpod.ts\'s own tts handler, not an SFN Choice). Returns the EXACT spoken duration (durationS) — what ReconcileSegmentTiming reconciles the scene track against (§4.5).',
              Parameters: {
                assetType: 'voice',
                tier: 'dialogueBasic',
                operation: 'tts',
                product: 'dialogue',
                queue: 'background',
                jobType: 'batch',
                'prompt.$': '$.scriptText',
                'cloneArtifactUrl.$': '$.narrator.voiceCloneArtifactUrl',
                'language.$': '$.narrator.voiceLanguage',
                'instruct.$': '$.narrator.voiceInstruct',
                'projectId.$': '$.projectId',
                'frameId.$': "States.Format('segment-{}', $.segmentIndex)",
                'userId.$': '$.userId',
              },
              ResultPath: '$.ttsResult',
              TimeoutSeconds: 920,
              Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'NarratorSegmentFailed' }],
              Next: 'RouteNarratorLipSync',
            },
            // Cost-based routing (2026-08-09 product decision, threshold
            // revised same day 20s->15s): RunComfy bills $0.015/second,
            // RunPod's legacy InfiniteTalk route bills a FLAT $0.25/generation
            // regardless of duration. Mathematical breakeven is
            // $0.25/$0.015 ≈ 16.7s, so a literal 15s threshold means the
            // 15-16.7s band is technically cheaper on RunComfy — an explicit
            // product call (simplicity over squeezing the last ~$0.02/clip in
            // a band StoryStudio's 30-40s planning never actually sends
            // anyway), not a rounding error; if that changes, this comment
            // is the first thing to revisit. StoryStudio plans every narrator
            // segment at 30-40s, so in practice RunPod is the path every real
            // segment takes — RunComfy's mono rung stays wired for the
            // rare/theoretical short-segment case rather than being deleted,
            // since this must react to the segment's ACTUAL measured TTS
            // duration, not an assumption about what StoryStudio usually
            // sends (same "trust the returned value" posture as
            // ReconcileSegmentTiming/§4.4/§4.5).
            RouteNarratorLipSync: {
              Type: 'Choice',
              Comment: 'actualDurationSeconds > 15s -> RunPod InfiniteTalk (flat-fee, cheaper for long clips); otherwise RunComfy InfiniteTalk mono (per-second, cheaper for short clips).',
              Choices: [{ Variable: '$.ttsResult.durationS', NumericGreaterThan: 15, Next: 'QMGenerateInfiniteTalkRunpod' }],
              Default: 'QMGenerateInfiniteTalk',
            },
            QMGenerateInfiniteTalk: {
              Type: 'Task',
              Resource: qmGenerateArn,
              Comment: 'Narrator lip-sync via QM (video.dialogueBasic.narrator: RunComfy InfiniteTalk mono, $0.015/s) — segments <=15s only (RouteNarratorLipSync). Poll only — see this function\'s header comment for why the doc\'s >45s webhook branch does not apply here.',
              Parameters: {
                assetType: 'video',
                tier: 'dialogueBasic',
                operation: 'narrator',
                product: 'dialogue',
                queue: 'background',
                jobType: 'batch',
                'audioUrl.$': '$.ttsResult.cdnUrl',
                'initImageUrls.$': 'States.Array($.personaImageUrl)',
                'projectId.$': '$.projectId',
                'frameId.$': "States.Format('segment-{}', $.segmentIndex)",
                'userId.$': '$.userId',
              },
              ResultPath: '$.infiniteTalkResult',
              TimeoutSeconds: 920,
              Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.infiniteTalkError', Next: 'NarratorSegmentFailed' }],
              Next: 'BuildSegmentResult',
            },
            // waitForTaskToken (2026-08-09): confirmed live — every real
            // narrator segment (30-40s scripts, the norm per product
            // decision) blew past qm-generate.ts's 850s blocking-poll
            // ceiling, throwing "timed out after 850000ms" even though the
            // underlying RunPod job was still running (RunPod InfiniteTalk
            // can take up to ~15min for audio >45s). That cascaded into
            // ReconcileSegmentTiming crashing on NaN (a segment with no
            // actualDurationSeconds) and killing the whole execution — see
            // storystudio-reply-dialogue-validate-input-gap.md's sibling
            // report on this failure. Same fix as localizationStates'
            // ttsTask() (§ above): this rung is already treated as
            // "external"/webhook-completing by executor.ts (isInternalRung()
            // is false here — no endpointId, just the legacy named
            // /infinitetalk route — see router.ts), so RunPod already POSTs
            // to our webhook on completion regardless of whether anything is
            // still polling for it. Switching to .waitForTaskToken just stops
            // qm-generate.ts from blocking-polling inside a single Lambda
            // invocation (which can never safely exceed ~850s given Lambda's
            // 900s hard ceiling) and lets webhook.ts's resumeStepFunction
            // resolve this task whenever RunPod actually finishes, no matter
            // how long that takes.
            QMGenerateInfiniteTalkRunpod: {
              Type: 'Task',
              Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
              Comment: "Narrator lip-sync via QM (video.dialogueBasic.narratorRunpod: legacy named-route RunPod InfiniteTalk, $0.25/generation flat — same integration Documentary Premium already uses, no new adapter code). Segments >15s (RouteNarratorLipSync) — i.e. the common case, since segments are planned at 30-40s. RunPod can take up to ~15min for audio >45s, so this waits on webhook.ts's callback rather than blocking-polling inside qm-generate.ts.",
              Parameters: {
                FunctionName: qmGenerateArn,
                Payload: {
                  assetType: 'video',
                  tier: 'dialogueBasic',
                  operation: 'narratorRunpod',
                  product: 'dialogue',
                  queue: 'background',
                  jobType: 'batch',
                  'prompt.$': '$.narrator.imagePrompt',
                  'audioUrl.$': '$.ttsResult.cdnUrl',
                  'initImageUrls.$': 'States.Array($.personaImageUrl)',
                  'projectId.$': '$.projectId',
                  'frameId.$': "States.Format('segment-{}', $.segmentIndex)",
                  'userId.$': '$.userId',
                  'taskToken.$': '$$.Task.Token',
                },
              },
              ResultPath: '$.infiniteTalkResult',
              TimeoutSeconds: 1800,
              Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.infiniteTalkError', Next: 'NarratorSegmentFailed' }],
              Next: 'BuildSegmentResult',
            },
            BuildSegmentResult: {
              Type: 'Pass',
              Comment: 'frameNumber aliases segmentIndex so this item is ALSO a valid concat-and-trim FrameVideo — ConcatenateNarrator feeds $.segmentResults straight in as `videos` with no reshaping.',
              Parameters: {
                'segmentIndex.$': '$.segmentIndex',
                'frameNumber.$': '$.segmentIndex',
                'audioUrl.$': '$.ttsResult.cdnUrl',
                'videoUrl.$': '$.infiniteTalkResult.cdnUrl',
                'actualDurationSeconds.$': '$.ttsResult.durationS',
              },
              End: true,
            },
            NarratorSegmentFailed: {
              Type: 'Pass',
              Comment: 'QM exhausted all rungs for this segment\'s TTS/InfiniteTalk — graceful degradation, mirrors QMFrameFailed.',
              Parameters: { failed: true, error: 'NarratorSegmentFailed', 'segmentIndex.$': '$.segmentIndex' },
              End: true,
            },
          },
        },
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'NarratorBranchFailed' }],
        End: true,
      },
      NarratorBranchFailed: {
        Type: 'Fail',
        Error: 'NarratorBranchFailed',
        Cause: 'Dialogue Basic narrator branch (persona or segment generation) failed unrecoverably',
      },
    },
  };
}

/**
 * Dialogue Basic's scenes branch: silent Wan2 clips only (image -> Wan2 i2v),
 * no merge — the narrator branch is the ONLY audio source (§4.6). videoPrompt
 * (not narrationText — dialogue-basic frames carry no narration at all)
 * drives the motion prompt (§3.6's core delta from the narration contract).
 * `duration` on each result is Wan2's RETURNED frame-derived value
 * ($.videoResult.durationS, surfaced automatically by runpod.ts's generic
 * duration_s digger — §4.4), never the requested integer.
 */
function dialogueBasicScenesBranch(qmGenerateArn: string): object {
  return {
    StartAt: 'GenerateScenes',
    States: {
      GenerateScenes: {
        Type: 'Map',
        Comment: 'Silent Wan2 scene clips, MaxConcurrency=15 (matches Narration-Basic-QM-New\'s per-frame Map; Wan2 itself is throttled independently via wan2-i2v\'s counterKey/fleet.ts).',
        ItemsPath: '$.frames',
        MaxConcurrency: 15,
        // ResultPath '$' (replace, not merge) — see GenerateNarratorSegments'
        // sibling comment in dialogueBasicNarratorBranch. Merging into
        // '$.sceneResults' carried all 18 frames' full imagePrompt/videoPrompt
        // text into this branch's output too, the other half of what pushed
        // GenerateNarratorAndScenes over the 256KB States.DataLimitExceeded
        // ceiling (confirmed live 2026-08-10, execution js7bd2ep...3l70g77m9).
        ResultPath: '$',
        Iterator: {
          StartAt: 'CheckSceneImageCache',
          States: {
            CheckSceneImageCache: {
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
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.cacheError', Next: 'RouteSceneImageGen' }],
              Next: 'CheckSceneImageCacheResult',
            },
            CheckSceneImageCacheResult: {
              Type: 'Choice',
              Choices: [{ Variable: '$.imageCacheResult.cached', BooleanEquals: true, Next: 'UseSceneImageCache' }],
              Default: 'RouteSceneImageGen',
            },
            UseSceneImageCache: {
              Type: 'Pass',
              Parameters: { 'cdnUrl.$': '$.imageCacheResult.cdnUrl' },
              ResultPath: '$.imageResult',
              Next: 'QMGenerateSceneVideo',
            },
            RouteSceneImageGen: {
              Type: 'Choice',
              Comment: 'Character reference present -> i2i; else t2i (image.dialogueBasic.*).',
              Choices: [{
                And: [
                  { Variable: '$.referenceImageUrl', IsPresent: true },
                  { Variable: '$.referenceImageUrl', IsString: true },
                  { Not: { Variable: '$.referenceImageUrl', StringEquals: '' } },
                ],
                Next: 'QMGenerateSceneImageI2I',
              }],
              Default: 'QMGenerateSceneImageT2I',
            },
            QMGenerateSceneImageT2I: {
              Type: 'Task',
              Resource: qmGenerateArn,
              Comment: 'Scene still via QM (image.dialogueBasic.t2i: self-hosted Qwen-Image-Gen -> nano-banana fallback).',
              Parameters: {
                assetType: 'image', tier: 'dialogueBasic', operation: 't2i', product: 'dialogue',
                queue: 'background', jobType: 'batch',
                'prompt.$': '$.imagePrompt',
                'aspectRatio.$': '$$.Execution.Input.aspectRatio',
                'projectId.$': '$$.Execution.Input.projectId',
                'frameId.$': '$.frameId',
                'userId.$': '$$.Execution.Input.userId',
              },
              ResultPath: '$.imageResult',
              TimeoutSeconds: 920,
              Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'SceneFailed' }],
              Next: 'QMGenerateSceneVideo',
            },
            QMGenerateSceneImageI2I: {
              Type: 'Task',
              Resource: qmGenerateArn,
              Comment: 'Scene still with character reference via QM (image.dialogueBasic.i2i: self-hosted Qwen-Image-Edit).',
              Parameters: {
                assetType: 'image', tier: 'dialogueBasic', operation: 'i2i', product: 'dialogue',
                queue: 'background', jobType: 'batch',
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
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'SceneFailed' }],
              Next: 'QMGenerateSceneVideo',
            },
            QMGenerateSceneVideo: {
              Type: 'Task',
              Resource: qmGenerateArn,
              Comment: 'Silent scene clip via QM (video.dialogueBasic.i2v: self-hosted Wan 2.2 I2V-A14B -> Replicate fallback). videoPrompt drives motion (NOT narrationText — §3.6). Server validates durationS against Wan2\'s legal {3,4,5,6,7} set.',
              Parameters: {
                assetType: 'video', tier: 'dialogueBasic', operation: 'i2v', product: 'dialogue',
                queue: 'background', jobType: 'batch',
                'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
                'prompt.$': '$.videoPrompt',
                'durationS.$': '$.duration',
                'aspectRatio.$': '$$.Execution.Input.aspectRatio',
                'projectId.$': '$$.Execution.Input.projectId',
                'frameId.$': '$.frameId',
                'userId.$': '$$.Execution.Input.userId',
              },
              ResultPath: '$.videoResult',
              TimeoutSeconds: 920,
              Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
              Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoError', Next: 'SceneFailed' }],
              Next: 'NormalizeSceneReferenceImageUrl',
            },
            // referenceImageUrl (2026-08-13) — now carried through the same
            // guarded normalize-then-BuildSceneResult pattern as sfxPrompt/
            // sfxAudioUrl below, so a scene originally anchored on a character
            // reference (RouteSceneImageGen's I2I branch) keeps that anchor
            // available for rework (RouteSceneReworkImageGen), instead of
            // rework silently falling back to an unanchored T2I regen and
            // risking a character-consistency drift from the rest of the
            // project. Still optional per-frame — same unguarded-`.$`-crash
            // risk as the others if defaulted incorrectly.
            NormalizeSceneReferenceImageUrl: {
              Type: 'Choice',
              Choices: [{ Variable: '$.referenceImageUrl', IsPresent: true, Next: 'NormalizeSceneSfxPrompt' }],
              Default: 'SetSceneReferenceImageUrlDefault',
            },
            SetSceneReferenceImageUrlDefault: {
              Type: 'Pass',
              Result: '',
              ResultPath: '$.referenceImageUrl',
              Next: 'NormalizeSceneSfxPrompt',
            },
            // sfxPrompt (2026-08-12, per storystudio-qm-sfx-vocal-audio-contract.md
            // §4) is optional per-frame, same as referenceImageUrl above — must be
            // defaulted to '' before BuildSceneResult's unguarded `.$` reference,
            // or a frame that omits it crashes this whole branch with States.Runtime.
            NormalizeSceneSfxPrompt: {
              Type: 'Choice',
              Choices: [{ Variable: '$.sfxPrompt', IsPresent: true, Next: 'NormalizeSceneSfxAudioUrl' }],
              Default: 'SetSceneSfxPromptDefault',
            },
            SetSceneSfxPromptDefault: {
              Type: 'Pass',
              Result: '',
              ResultPath: '$.sfxPrompt',
              Next: 'NormalizeSceneSfxAudioUrl',
            },
            // sfxAudioUrl (2026-08-13, storystudio-dialogue-sfx-url-integration-
            // request.md) — StoryStudio's pre-vetted SFX-library match, optional
            // per-frame same as sfxPrompt above. Same unguarded `.$` crash risk
            // in BuildSceneResult if left undefined on a frame that omits it.
            NormalizeSceneSfxAudioUrl: {
              Type: 'Choice',
              Choices: [{ Variable: '$.sfxAudioUrl', IsPresent: true, Next: 'NormalizeSceneSfxVolume' }],
              Default: 'SetSceneSfxAudioUrlDefault',
            },
            SetSceneSfxAudioUrlDefault: {
              Type: 'Pass',
              Result: '',
              ResultPath: '$.sfxAudioUrl',
              Next: 'NormalizeSceneSfxVolume',
            },
            // sfxVolume (2026-08-13, same request doc §4) — optional per-frame
            // linear gain applied to the SFX track in QMMixSceneSfx(FromUrl)
            // (merge.ts's ffmpeg `volume=` filter, same convention as dialogue-
            // mix's ambienceVolume). Defaulted to 1 (no-op) at launch, but that
            // meant every SFX played at raw generated/library amplitude summed
            // straight onto the dialogue track (merge.ts's amix uses
            // normalize=0, so nothing auto-attenuates it either) — reported
            // live as overpowering. Reset 2026-08-13 to 0.22, just above BGM's
            // 0.20 mix level, so SFX reads as a foreground accent without
            // burying dialogue.
            NormalizeSceneSfxVolume: {
              Type: 'Choice',
              Choices: [{ Variable: '$.sfxVolume', IsPresent: true, Next: 'BuildSceneResult' }],
              Default: 'SetSceneSfxVolumeDefault',
            },
            SetSceneSfxVolumeDefault: {
              Type: 'Pass',
              Result: 0.22,
              ResultPath: '$.sfxVolume',
              Next: 'BuildSceneResult',
            },
            BuildSceneResult: {
              Type: 'Pass',
              Comment: 'imageUrl/imagePrompt/videoPrompt/sfxPrompt/sfxAudioUrl/sfxVolume/referenceImageUrl carried through (not just videoUrl/duration) so a later QA/rework pass can re-evaluate and regenerate this scene without a separate lookup — safe to add: reconcile-segment-timing.ts spreads unknown fields through untouched, and dialogue-basic-qa-agent\'s reworkItems spreads **frame too, so these survive a rework round trip unchanged. referenceImageUrl (2026-08-13) is now guard-normalized the same way as sfxPrompt/sfxAudioUrl above (NormalizeSceneReferenceImageUrl), so it\'s safe to reference here unguarded — RouteSceneReworkImageGen uses it to pick i2i vs t2i for rework, mirroring RouteSceneImageGen\'s original-generation logic.',
              Parameters: {
                'frameId.$': '$.frameId',
                'frameNumber.$': '$.frameNumber',
                'segmentIndex.$': '$.segmentIndex',
                'isSegmentLastFrame.$': '$.isSegmentLastFrame',
                'videoUrl.$': '$.videoResult.cdnUrl',
                'duration.$': '$.videoResult.durationS',
                'imageUrl.$': '$.imageResult.cdnUrl',
                'imagePrompt.$': '$.imagePrompt',
                'videoPrompt.$': '$.videoPrompt',
                'sfxPrompt.$': '$.sfxPrompt',
                'sfxAudioUrl.$': '$.sfxAudioUrl',
                'referenceImageUrl.$': '$.referenceImageUrl',
                'sfxVolume.$': '$.sfxVolume',
              },
              End: true,
            },
            SceneFailed: {
              Type: 'Pass',
              Comment: 'QM exhausted all rungs for this scene\'s image/video — graceful degradation, mirrors QMFrameFailed.',
              Parameters: { failed: true, error: 'SceneFailed', 'frameId.$': '$.frameId', 'frameNumber.$': '$.frameNumber' },
              End: true,
            },
          },
        },
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'ScenesBranchFailed' }],
        End: true,
      },
      ScenesBranchFailed: {
        Type: 'Fail',
        Error: 'ScenesBranchFailed',
        Cause: 'Dialogue Basic scenes branch failed unrecoverably',
      },
    },
  };
}

/**
 * Builds a 4-state concat-and-trim invocation chain (Pass payload -> upload
 * -> ecs:runTask.sync -> deterministic-URL Pass), the exact pattern
 * buildQmNewDefinition's own ConcatenateVideos/UploadConcatPayload/
 * ConcatenateVideosTask/BuildConcatenatedVideoResult uses, parameterized so
 * Dialogue Basic can run it twice (scenes, narrator) under different names.
 */
function concatChain(opts: {
  namePrefix: string; ecs: ConcatTrimEcsConfig; videosPath: string; outputSubpath: string; next: string;
}): Record<string, unknown> {
  const { namePrefix, ecs, videosPath, outputSubpath, next } = opts;
  const videoUrlExpr = `States.Format('https://${ecs.outputBucket}.s3.us-east-1.amazonaws.com/projects/{}/${outputSubpath}.mp4', $.projectId)`;
  const audioUrlExpr = `States.Format('https://${ecs.outputBucket}.s3.us-east-1.amazonaws.com/projects/{}/${outputSubpath}.wav', $.projectId)`;
  return {
    [`${namePrefix}`]: {
      Type: 'Pass',
      Comment: `Build the concat-and-trim container payload for ${namePrefix} (trimSilence:false — see §7.6.6, neither dialogue tier needs it).`,
      Parameters: {
        'videos.$': videosPath,
        'aspectRatio.$': '$.aspectRatio',
        'outputKey.$': `States.Format('projects/{}/${outputSubpath}.mp4', $.projectId)`,
        'audioOutputKey.$': `States.Format('projects/{}/${outputSubpath}.wav', $.projectId)`,
        trimSilence: false,
      },
      ResultPath: '$.concatPayload',
      Next: `Upload${namePrefix}Payload`,
    },
    [`Upload${namePrefix}Payload`]: {
      Type: 'Task',
      Resource: 'arn:aws:states:::lambda:invoke',
      Comment: 'ecs:runTask\'s ContainerOverrides has a hard 8192-byte limit — upload the payload to S3 here and pass only the short key across that boundary.',
      Parameters: {
        FunctionName: ecs.uploadPayloadArn,
        Payload: {
          'key.$': `States.Format('projects/{}/payloads/${outputSubpath}.json', $.projectId)`,
          'body.$': 'States.JsonToString($.concatPayload)',
        },
      },
      ResultSelector: { 'key.$': '$.Payload.key' },
      ResultPath: '$.concatPayloadUpload',
      TimeoutSeconds: 60,
      Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2 }],
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
      Next: `${namePrefix}Task`,
    },
    [`${namePrefix}Task`]: {
      Type: 'Task',
      Resource: 'arn:aws:states:::ecs:runTask.sync',
      Comment: `Concat via QM's own Fargate task (${namePrefix}) — no Lambda timeout/memory ceiling.`,
      Parameters: {
        Cluster: ecs.clusterArn,
        TaskDefinition: ecs.taskDefinitionArn,
        LaunchType: 'FARGATE',
        NetworkConfiguration: {
          AwsvpcConfiguration: {
            Subnets: ecs.subnetIds,
            SecurityGroups: [ecs.securityGroupId],
            AssignPublicIp: 'ENABLED',
          },
        },
        Overrides: {
          ContainerOverrides: [{
            Name: ecs.containerName,
            Environment: [{ Name: 'PAYLOAD_S3_KEY', 'Value.$': '$.concatPayloadUpload.key' }],
          }],
        },
      },
      ResultPath: `$.${namePrefix}Ecs`,
      TimeoutSeconds: 1800,
      Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 1, BackoffRate: 2 }],
      Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
      Next: `Build${namePrefix}Result`,
    },
    [`Build${namePrefix}Result`]: {
      Type: 'Pass',
      Comment: 'Deterministic URLs — the ECS task writes to exactly these keys, no result read back.',
      Parameters: { 'videoUrl.$': videoUrlExpr, 'audioUrl.$': audioUrlExpr },
      ResultPath: `$.${namePrefix}Result`,
      Next: next,
    },
  };
}

/**
 * Both dialogue builders clone buildQmNewDefinition's ValidateInput verbatim
 * (see the big comment block above dialogueBasicNarratorBranch), which
 * inherits E2E-validate-input — the narration pipeline's own Lambda, which
 * requires voiceUrls/bgmUrl. Dialogue never sends either: the narrator's TTS
 * is generated inside this SFN (from narrator.voiceCloneArtifactUrl for
 * Basic, voiceBank for Premium), and BGM is generated via ACE-Step, also
 * inside this SFN. Every real dialogue execution has failed at ValidateInput
 * as a result (storystudio-reply-dialogue-validate-input-gap.md).
 * E2E-validate-input isn't defined in this repo (invoked by hardcoded
 * cross-account ARN, no local source to branch on projectType), so replace
 * the inherited ValidateInput Task outright with an in-ASL Choice that
 * checks the fields the calling builder's own contract actually requires
 * (handoff doc §3.2 for Basic, §7.2 for Premium — the two tiers don't share
 * a shape: Premium has no top-level narrator/segments/frames at all).
 *
 * `requireAllOf` are fields that must be IsPresent (ANDed together).
 * `requireAnyOf`, if given, adds one more ANDed condition requiring at least
 * one of its fields to be present — for Premium's shots-vs-shotsManifestUrl
 * fallback (§7.2), so ValidateInput doesn't reject the manifest-URL path
 * that RouteShotsSource downstream already handles.
 *
 * Reads CheckValidation's current success target so it keeps working
 * whichever state each builder has already repointed it to (plain
 * UpdateStatusGeneratingImages for Basic, RouteShotsSource for Premium) —
 * call this only after any such CheckValidation.Choices[0].Next rewrite.
 */
function overrideDialogueValidateInput(
  def: { States: Record<string, any> },
  requireAllOf: string[],
  requireAnyOf?: string[],
): void {
  const successNext = def.States.CheckValidation.Choices[0].Next;
  const conditions: unknown[] = requireAllOf.map((field) => ({ Variable: `$.${field}`, IsPresent: true }));
  if (requireAnyOf) {
    conditions.push({ Or: requireAnyOf.map((field) => ({ Variable: `$.${field}`, IsPresent: true })) });
  }
  def.States.ValidateInput = {
    Type: 'Choice',
    Comment: 'Dialogue-aware replacement for the inherited narration ValidateInput Lambda (which requires voiceUrls/bgmUrl, neither of which dialogue sends) — checks this tier\'s own required fields directly in ASL instead.',
    Choices: [{ And: conditions, Next: successNext }],
    Default: 'FailValidation',
  };
  // CheckValidation is now truly unreachable (ValidateInput routes around it
  // directly, and nothing else points to it) — unlike the fourLang
  // scaffolding elsewhere in these builders, which stays reachable through
  // other paths. AWS's own ASL validator rejects orphaned states at deploy
  // time ('MISSING_TRANSITION_TARGET: State "CheckValidation" is not
  // reachable', confirmed against the live API on the first deploy attempt
  // of this fix), so it must be deleted, not just left unreferenced.
  delete def.States.CheckValidation;
  def.States.FailValidation.Parameters.error = {
    Error: 'InvalidInput',
    Cause: `Dialogue input missing required fields: ${[...requireAllOf, ...(requireAnyOf ? [requireAnyOf.join(' or ')] : [])].join(', ')}`,
  };
}

function buildDialogueBasicQmNewDefinition(
  qmGenerateArn: string, brokerArn: string, shortsTriggerArn: string, remotionOverlayArn: string,
  concatTrimEcs: ConcatTrimEcsConfig, dialogueMixEcs: DialogueMixEcsConfig, reconcileSegmentTimingArn: string,
): object {
  const def = JSON.parse(JSON.stringify(buildQmNewDefinition(qmGenerateArn, brokerArn, shortsTriggerArn, remotionOverlayArn, '', concatTrimEcs))) as {
    Comment: string;
    States: Record<string, any>;
  };
  def.Comment = 'E2E Video Generation Pipeline - Dialogue-Basic-QM-New — narrator persona (RunComfy InfiniteTalk) PiP composited over silent Wan2 scenes via Quartermaster gateway.';

  // CheckValidation's success target is still the clone's default
  // (UpdateStatusGeneratingImages, untouched by this builder), so this can
  // run before any of the overrides below. Required fields per handoff §3.2.
  overrideDialogueValidateInput(def, ['narrator', 'narratorOverlay', 'segments', 'frames']);

  // Replace the per-frame Map with the two-branch Parallel (§4.1: scene
  // generation and narrator generation share no inputs and their latencies
  // are wildly different — 18 Wan2 clips at MaxConcurrency 15 vs 3
  // sequential-ish InfiniteTalk jobs at up to ~504s each).
  def.States.UpdateStatusGeneratingImages.Next = 'GenerateNarratorAndScenes';
  def.States.UpdateStatusGeneratingImages.Catch[0].Next = 'GenerateNarratorAndScenes';
  delete def.States.GenerateImages;

  // Step Functions validates EVERY Next/Default reference at deploy time,
  // even on states unreachable from StartAt — so the fourLang/localization
  // scaffolding this clone inherited (now unreferenced, since nothing routes
  // into RouteFrameGeneration/RouteConcatFourLang anymore) must be deleted
  // outright rather than just left orphaned, or CreateStateMachine rejects
  // the definition over RouteFrameGeneration's now-dangling reference to the
  // deleted GenerateImages state. Confirmed by a structural Next/Default
  // reachability check against this function's actual synth output.
  for (const deadState of [
    'RouteFrameGeneration', 'GenerateImagesFourLang', 'RouteConcatFourLang',
    'BuildLangVideoArrays', 'ComputeLanguageOmissions', 'ConcatenateVideosFourLang',
    'PrepareTranscribeFourLang', 'TranscribeAudioFourLang', 'BuildMergedVoiceResultFourLangEn',
    'FinalizeLocalizedVideos', 'ConcatenateVideos', 'UploadConcatPayload',
    'ConcatenateVideosTask', 'BuildConcatenatedVideoResult',
  ]) delete def.States[deadState];

  // Wire the inherited UpdateStatusConcatenating status update into the flow
  // (right before the concat chains) rather than leaving it orphaned too.
  def.States.UpdateStatusConcatenating.Next = 'ConcatenateScenes';
  def.States.UpdateStatusConcatenating.Catch[0].Next = 'ConcatenateScenes';
  // The inherited Parameters block still references narration's $.videoResults
  // (there is no such field on dialogue-basic's state — this point in the flow
  // carries sceneResults/reconcileResult instead). A bad `.$` field reference
  // in Parameters throws States.Runtime, which — unlike a normal Task error —
  // is NOT caught by this state's own Catch: [States.ALL] and fails the whole
  // execution outright (confirmed live 2026-08-09, first real execution to
  // reach this state: "The JSONPath '$.videoResults' ... could not be
  // found", uncaught despite the Catch clause). Point it at the corrected
  // (post-ReconcileSegmentTiming) scene clips instead.
  def.States.UpdateStatusConcatenating.Parameters.assets = { 'frames.$': '$.reconcileResult.sceneResults' };

  def.States.GenerateNarratorAndScenes = {
    Type: 'Parallel',
    Comment: 'Branch A: narrator persona + per-segment TTS/InfiniteTalk. Branch B: silent Wan2 scene clips. §4.1.',
    Branches: [dialogueBasicNarratorBranch(qmGenerateArn), dialogueBasicScenesBranch(qmGenerateArn)],
    ResultPath: '$.parallelResult',
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'MergeParallelResults',
  };
  def.States.MergeParallelResults = {
    Type: 'Pass',
    Comment: 'Destructure the Parallel state\'s [branchA, branchB] result array into $.segmentResults/$.sceneResults — Parallel branch outputs are only ever addressable by array index, not by name. Each branch\'s Map now uses ResultPath \'$\' (replace), so parallelResult[0]/[1] ARE the bare result arrays directly, not nested under .segmentResults/.sceneResults.',
    Parameters: {
      'jobId.$': '$.jobId',
      'projectId.$': '$.projectId',
      'projectType.$': '$.projectType',
      'aspectRatio.$': '$.aspectRatio',
      'narrator.$': '$.narrator',
      'narratorOverlay.$': '$.narratorOverlay',
      'bgmPrompt.$': '$.bgmPrompt',
      'textOverlayEnabled.$': '$.textOverlayEnabled',
      'apiKey.$': '$.apiKey',
      'jwtToken.$': '$.jwtToken',
      'convexEndpoint.$': '$.convexEndpoint',
      'userId.$': '$.userId',
      'admissionId.$': '$.admissionId',
      'segmentResults.$': '$.parallelResult[0]',
      'sceneResults.$': '$.parallelResult[1]',
    },
    Next: 'ReconcileSegmentTiming',
  };

  def.States.ReconcileSegmentTiming = {
    Type: 'Task',
    Resource: reconcileSegmentTimingArn,
    Comment: 'Trim/extend each segment\'s last scene clip so its scenes sum to that segment\'s actual narrator duration (§4.5). One invocation covers every segment (groups internally by segmentIndex — ASL has no JSONPath filter/group-by).',
    Parameters: {
      'sceneResults.$': '$.sceneResults',
      'segmentResults.$': '$.segmentResults',
      'outputKeyPrefix.$': "States.Format('projects/{}/dialogue-basic/reconcile', $.projectId)",
    },
    ResultPath: '$.reconcileResult',
    TimeoutSeconds: 600,
    Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'DropStaleSceneResults',
  };
  def.States.DropStaleSceneResults = {
    Type: 'Pass',
    Comment: 'Drop the pre-reconcile $.sceneResults — superseded by $.reconcileResult.sceneResults and unread by anything from here through the QA/rework loop and RestoreContextDialogueBasic. Leaving both alive doubled the payload and, combined with PrepareQAPayloadDialogueBasic\'s own qaInput.frames copy, tripled it — pushing a 78-frame execution over the 256KB States.DataLimitExceeded ceiling (confirmed live 2026-08-12, execution js70vdbsee...xi2pcko5t). Same class of bug as the GenerateScenes ResultPath \'$\' fix above, resurfaced in the QA-payload states added 2026-08-10.',
    Parameters: {
      'jobId.$': '$.jobId',
      'projectId.$': '$.projectId',
      'projectType.$': '$.projectType',
      'aspectRatio.$': '$.aspectRatio',
      'narrator.$': '$.narrator',
      'narratorOverlay.$': '$.narratorOverlay',
      'bgmPrompt.$': '$.bgmPrompt',
      'textOverlayEnabled.$': '$.textOverlayEnabled',
      'apiKey.$': '$.apiKey',
      'jwtToken.$': '$.jwtToken',
      'convexEndpoint.$': '$.convexEndpoint',
      'userId.$': '$.userId',
      'admissionId.$': '$.admissionId',
      'segmentResults.$': '$.segmentResults',
      'reconcileResult.$': '$.reconcileResult',
    },
    Next: 'NormalizeCharacterBible',
  };

  // ── QA + rework (2026-08-10) ─────────────────────────────────────────────
  // Catches hallucination/anatomy defects in Wan2 scene clips (two-headed and
  // five-body duplicate-character defects found live in project
  // js7bd2ep1edm9d4zqxvkg6sz458c6cg5) before they get baked into the
  // composite. Sits between ReconcileSegmentTiming and UpdateStatusConcatenating
  // — every scene is generated and duration-corrected, nothing expensive
  // (concat, PiP composite) has run yet. dialogue-basic-qa-agent/
  // dialogue-basic-rework-prompts are new Lambdas (storystudio-unified repo,
  // NOT CDK-managed here, same as narration-premium-qa-agent) — adapted from
  // narration-premium's QA+rework pair but: (1) reads inline `frames` (no
  // S3 frames-store — dialogue-basic has no such step), (2) scoring rubric
  // rebuilt around silent-scene hallucination/anatomy checks instead of
  // narration-alignment, (3) rework regenerates via qm-generate as native
  // SFN Tasks below (NOT a Lambda-to-Lambda E2E-generate-* call the way
  // narration-premium's rework agent does) — qm-generate can take up to
  // ~850s per call, and narration-premium's pattern loops several such calls
  // sequentially inside one Lambda, which risks stacking past Lambda's 900s
  // hard ceiling.
  def.States.NormalizeCharacterBible = {
    Type: 'Choice',
    Comment: 'Guarantee $.characterBible is a real object before QA/rework references it — dialogue-basic\'s ValidateInput only requires narrator/narratorOverlay/segments/frames, so characterBible may be entirely absent. IsPresent-guarded to avoid the States.Runtime (\'Invalid path\') crash this file has hit before on unguarded optional-field references (see NormalizeFourLang above).',
    Choices: [{ Variable: '$$.Execution.Input.characterBible', IsPresent: true, Next: 'SetCharacterBibleFromInput' }],
    Default: 'SetCharacterBibleDefault',
  };
  def.States.SetCharacterBibleFromInput = {
    Type: 'Pass',
    InputPath: '$$.Execution.Input.characterBible',
    ResultPath: '$.characterBible',
    Next: 'PrepareQAPayloadDialogueBasic',
  };
  def.States.SetCharacterBibleDefault = {
    Type: 'Pass',
    Result: {},
    ResultPath: '$.characterBible',
    Next: 'PrepareQAPayloadDialogueBasic',
  };
  def.States.PrepareQAPayloadDialogueBasic = {
    Type: 'Pass',
    Comment: 'Assemble QA agent input from pipeline state.',
    Parameters: {
      'projectId.$': '$.projectId',
      'jobId.$': '$.jobId',
      'characterBible.$': '$.characterBible',
      mode: 'review-and-rework',
      auditPercent: 100,
      reworkAttempt: 1,
      _pipelineContext: {
        'jobId.$': '$.jobId',
        'projectId.$': '$.projectId',
        'projectType.$': '$.projectType',
        'aspectRatio.$': '$.aspectRatio',
        'narrator.$': '$.narrator',
        'narratorOverlay.$': '$.narratorOverlay',
        'bgmPrompt.$': '$.bgmPrompt',
        'textOverlayEnabled.$': '$.textOverlayEnabled',
        'apiKey.$': '$.apiKey',
        'jwtToken.$': '$.jwtToken',
        'convexEndpoint.$': '$.convexEndpoint',
        'userId.$': '$.userId',
        'admissionId.$': '$.admissionId',
        'segmentResults.$': '$.segmentResults',
      },
    },
    ResultPath: '$.qaInput',
    Next: 'QaAgentDialogueBasic',
  };
  def.States.QaAgentDialogueBasic = {
    Type: 'Task',
    Resource: 'arn:aws:lambda:us-east-1:929075264324:function:dialogue-basic-qa-agent',
    Comment: 'Run QA on all generated scene images/videos. frames reads $.reconcileResult.sceneResults directly (not a qaInput.frames copy) — see PrepareQAPayloadDialogueBasic\'s DataLimitExceeded comment.',
    Parameters: {
      'projectId.$': '$.qaInput.projectId',
      'jobId.$': '$.qaInput.jobId',
      'frames.$': '$.reconcileResult.sceneResults',
      'characterBible.$': '$.qaInput.characterBible',
      'mode.$': '$.qaInput.mode',
      'auditPercent.$': '$.qaInput.auditPercent',
      'reworkAttempt.$': '$.qaInput.reworkAttempt',
    },
    TimeoutSeconds: 1800,
    ResultPath: '$.qaAgentResult',
    Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 15, MaxAttempts: 1, BackoffRate: 1.5 }],
    Catch: [{ ErrorEquals: ['States.ALL'], Comment: 'QA agent failure is non-fatal — proceed to concat with best-available scenes', ResultPath: '$.qaError', Next: 'QAResultFallbackDialogueBasic' }],
    Next: 'CheckQAResultDialogueBasic',
  };
  def.States.QAResultFallbackDialogueBasic = {
    Type: 'Pass',
    Comment: 'QA agent errored — treat as pass to avoid blocking pipeline',
    Parameters: { passStatus: 'PASS', overallScore: 0, totalIssues: 0, framesNeedingRework: [], reworkItems: [], reportS3Key: null },
    ResultPath: '$.qaAgentResult',
    Next: 'RestoreContextDialogueBasic',
  };
  def.States.CheckQAResultDialogueBasic = {
    Type: 'Choice',
    Comment: 'Route based on QA result: pass -> concat, scenes flagged -> rework Map.',
    Choices: [
      { Variable: '$.qaAgentResult.passStatus', StringEquals: 'PASS', Next: 'RestoreContextDialogueBasic' },
      { And: [{ Variable: '$.qaAgentResult.reworkItems[0]', IsPresent: true }, { Variable: '$.qaInput.reworkAttempt', NumericLessThan: 3 }], Next: 'ReworkScenesMap' },
    ],
    Default: 'RestoreContextDialogueBasic',
  };
  def.States.ReworkScenesMap = {
    Type: 'Map',
    Comment: 'Regenerate every QA-flagged scene. Iterates dialogue-basic-qa-agent\'s own reworkItems (full scene data + issues, already joined server-side — ASL has no array-join intrinsic to do this from framesNeedingRework + sceneResults itself).',
    ItemsPath: '$.qaAgentResult.reworkItems',
    MaxConcurrency: 5,
    ResultPath: '$.reworkScenesResult',
    Iterator: {
      StartAt: 'CheckReworkVideoCache',
      States: {
        // Rework-scoped cache (2026-08-13, per user: re-triggering a new
        // execution for the same project was re-running rework from scratch
        // on frames that had already been successfully reworked in a PRIOR
        // execution). Deliberately keyed on `{frameId}-rework{reworkAttempt}`
        // — NOT the bare frameId the original scene's own CheckSceneImageCache
        // uses — so this can never cache-hit on the original, QA-flagged
        // asset rework exists to replace. reworkAttempt resets to 1 at the
        // start of every execution's first QA/rework pass, so two separate
        // executions reworking the same frame land on the same key, which is
        // exactly the reuse this is for.
        CheckReworkVideoCache: {
          Type: 'Task',
          Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-asset-cache-check',
          Comment: 'Check S3 metadata cache before regenerating this rework — skip straight to the previously reworked asset if this exact frame+reworkAttempt was already fixed in an earlier execution.',
          Parameters: {
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': "States.Format('{}-rework{}', $.frameId, $.reworkAttempt)",
            assetType: 'video',
          },
          ResultPath: '$.reworkVideoCacheResult',
          TimeoutSeconds: 10,
          Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 2, MaxAttempts: 1, BackoffRate: 1.5 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.reworkCacheError', Next: 'RewritePromptsTask' }],
          Next: 'CheckReworkVideoCacheResult',
        },
        CheckReworkVideoCacheResult: {
          Type: 'Choice',
          Choices: [{ Variable: '$.reworkVideoCacheResult.cached', BooleanEquals: true, Next: 'UseReworkVideoCache' }],
          Default: 'RewritePromptsTask',
        },
        UseReworkVideoCache: {
          Type: 'Pass',
          Comment: 'Already reworked in a prior execution — skip prompt rewrite + image/video regeneration entirely and reuse it, same output shape as BuildReworkedSceneResult.',
          Parameters: {
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            'segmentIndex.$': '$.segmentIndex',
            'isSegmentLastFrame.$': '$.isSegmentLastFrame',
            'videoUrl.$': '$.reworkVideoCacheResult.cdnUrl',
            'duration.$': '$.reworkVideoCacheResult.durationS',
            'imageUrl.$': '$.reworkVideoCacheResult.imageUrl',
            'imagePrompt.$': '$.reworkVideoCacheResult.imagePrompt',
            'videoPrompt.$': '$.reworkVideoCacheResult.videoPrompt',
            'sfxPrompt.$': '$.sfxPrompt',
            'sfxAudioUrl.$': '$.sfxAudioUrl',
            'sfxVolume.$': '$.sfxVolume',
            'referenceImageUrl.$': '$.referenceImageUrl',
          },
          End: true,
        },
        RewritePromptsTask: {
          Type: 'Task',
          Resource: 'arn:aws:lambda:us-east-1:929075264324:function:dialogue-basic-rework-prompts',
          Comment: 'LLM-only prompt rewrite for this flagged scene — regeneration itself happens via native qm-generate Tasks below, not inside this Lambda.',
          Parameters: {
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            'imagePrompt.$': '$.imagePrompt',
            'videoPrompt.$': '$.videoPrompt',
            'qaIssues.$': '$.qaIssues',
            'characterBible.$': '$.characterBible',
            'reworkAttempt.$': '$.reworkAttempt',
          },
          ResultPath: '$.reworkPromptResult',
          TimeoutSeconds: 180,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.reworkError', Next: 'ReworkSceneFailed' }],
          Next: 'RouteSceneReworkImageGen',
        },
        RouteSceneReworkImageGen: {
          Type: 'Choice',
          Comment: 'Character reference present -> i2i rework (preserve the identity anchor); else t2i rework — mirrors RouteSceneImageGen\'s original-generation logic (2026-08-13, per user: rework was always regenerating unanchored via T2I even for scenes originally anchored on a reference image, risking character-consistency drift).',
          Choices: [{
            And: [
              { Variable: '$.referenceImageUrl', IsPresent: true },
              { Variable: '$.referenceImageUrl', IsString: true },
              { Not: { Variable: '$.referenceImageUrl', StringEquals: '' } },
            ],
            Next: 'QMReworkImageI2I',
          }],
          Default: 'QMReworkImageT2I',
        },
        QMReworkImageI2I: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Regenerate this scene\'s still image via QM, anchored on the original character referenceImageUrl (image.dialogueBasic.i2i: self-hosted Qwen-Image-Edit -> KIE google/nano-banana-edit fallback) — same ladder QMGenerateSceneImageI2I uses for the original generation, so a rework attempt on an I2I-anchored scene keeps the same identity anchor instead of drifting via an unanchored T2I regen. jobType:\'batch\' (see QMReworkImageT2I\'s note) so a cold self-hosted qwen-image-edit pod is waited out rather than routing straight to KIE.',
          Parameters: {
            assetType: 'image', tier: 'dialogueBasic', operation: 'i2i', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.reworkPromptResult.imagePrompt',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'initImageUrls.$': 'States.Array($.referenceImageUrl)',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
            'requestId.$': "States.Format('{}-rework{}-{}-img', $.frameId, $.reworkAttempt, $$.Execution.Name)",
          },
          ResultPath: '$.imageResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.reworkError', Next: 'ReworkSceneFailed' }],
          Next: 'QMReworkVideo',
        },
        QMReworkImageT2I: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Regenerate this scene\'s still image via QM (no character reference on this frame — see RouteSceneReworkImageGen). jobType:\'batch\' (2026-08-13, reversing the earlier 2026-08-10 \'realtime\' decision) — router.ts leads batch jobs with the internal rung (self-hosted qwen-image-gen) unconditionally, waiting out a cold RunPod start rather than routing straight to the KIE google/nano-banana fallback the way \'realtime\' does when that endpoint has 0 in-flight jobs. Root-caused 2026-08-13: a real rework burst hit exactly that cold-endpoint case, landed on KIE, and got permanently stuck — KIE\'s webhook signature check (webhook.ts) rejects every callback, and kie.ts\'s poll() fallback hits the wrong endpoint too, so there was no recovery path. KIE remains the fallback rung if qwen-image-gen itself fails; QM_GENERATE_DEADLINE_MS (850s) comfortably covers a cold start (~2.5-4min per executor.ts) plus generation.',
          Parameters: {
            assetType: 'image', tier: 'dialogueBasic', operation: 't2i', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.reworkPromptResult.imagePrompt',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
            'requestId.$': "States.Format('{}-rework{}-{}-img', $.frameId, $.reworkAttempt, $$.Execution.Name)",
          },
          ResultPath: '$.imageResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.reworkError', Next: 'ReworkSceneFailed' }],
          Next: 'QMReworkVideo',
        },
        QMReworkVideo: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Regenerate this scene\'s video from the fresh image via QM. operation:\'i2vRework\' (not the normal \'i2v\') routes to video.dialogueBasic.i2vRework — a dedicated ladder containing ONLY Replicate wan-2.2-i2v-fast, deliberately excluding the self-hosted Wan2 4-step Lightning pod. Root-caused 2026-08-12: that pod\'s Lightning distillation runs with prompt conformity effectively off, causing most of a real run\'s QA findings (195/269, PROMPT_VISUAL_MISMATCH on video) — the ~90s self-hosted generation just isn\'t reliable enough for scenes already known to need a fix. jobType:\'realtime\' kept for intent/consistency though it\'s a no-op now (single-rung ladder, no ordering to influence).',
          Parameters: {
            assetType: 'video', tier: 'dialogueBasic', operation: 'i2vRework', product: 'dialogue',
            queue: 'background', jobType: 'realtime',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'prompt.$': '$.reworkPromptResult.videoPrompt',
            'durationS.$': '$.duration',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
            'requestId.$': "States.Format('{}-rework{}-{}-vid', $.frameId, $.reworkAttempt, $$.Execution.Name)",
          },
          ResultPath: '$.videoResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.reworkError', Next: 'ReworkSceneFailed' }],
          Next: 'StoreReworkVideoMeta',
        },
        StoreReworkVideoMeta: {
          Type: 'Task',
          Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-store-asset-meta',
          Comment: 'Persist this rework\'s result under the rework-scoped key (CheckReworkVideoCache) so a future execution reworking the same frame+reworkAttempt reuses it instead of regenerating. Non-fatal: a store failure just means the next execution won\'t get a cache hit, not that this one fails.',
          Parameters: {
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': "States.Format('{}-rework{}', $.frameId, $.reworkAttempt)",
            assetType: 'video',
            'cdnUrl.$': '$.videoResult.cdnUrl',
            's3Key.$': '$.videoResult.s3Key',
            'durationS.$': '$.videoResult.durationS',
            'imageUrl.$': '$.imageResult.cdnUrl',
            'imagePrompt.$': '$.reworkPromptResult.imagePrompt',
            'videoPrompt.$': '$.reworkPromptResult.videoPrompt',
          },
          ResultPath: null,
          TimeoutSeconds: 10,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.reworkMetaStoreError', Next: 'BuildReworkedSceneResult' }],
          Next: 'BuildReworkedSceneResult',
        },
        BuildReworkedSceneResult: {
          Type: 'Pass',
          Comment: 'sfxPrompt/sfxAudioUrl/sfxVolume/referenceImageUrl (2026-08-12/13) carried through unchanged from the original scene — rework only touches image/video, never the SFX moment, and reworkItems always has these present (spread from BuildSceneResult\'s already-normalized fields), so no IsPresent guard needed here unlike the scenes branch.',
          Parameters: {
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            'segmentIndex.$': '$.segmentIndex',
            'isSegmentLastFrame.$': '$.isSegmentLastFrame',
            'videoUrl.$': '$.videoResult.cdnUrl',
            'duration.$': '$.videoResult.durationS',
            'imageUrl.$': '$.imageResult.cdnUrl',
            'imagePrompt.$': '$.reworkPromptResult.imagePrompt',
            'videoPrompt.$': '$.reworkPromptResult.videoPrompt',
            'sfxPrompt.$': '$.sfxPrompt',
            'sfxAudioUrl.$': '$.sfxAudioUrl',
            'sfxVolume.$': '$.sfxVolume',
            'referenceImageUrl.$': '$.referenceImageUrl',
          },
          End: true,
        },
        ReworkSceneFailed: {
          Type: 'Pass',
          Comment: 'Rework failed for this scene — keep its ORIGINAL (still-flawed but valid) asset rather than dropping it, so ReReconcileAfterRework\'s merge always has something to fall back to.',
          Parameters: {
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            'segmentIndex.$': '$.segmentIndex',
            'isSegmentLastFrame.$': '$.isSegmentLastFrame',
            'videoUrl.$': '$.videoUrl',
            'duration.$': '$.duration',
            'imageUrl.$': '$.imageUrl',
            'imagePrompt.$': '$.imagePrompt',
            'videoPrompt.$': '$.videoPrompt',
            'sfxPrompt.$': '$.sfxPrompt',
            'sfxAudioUrl.$': '$.sfxAudioUrl',
            'sfxVolume.$': '$.sfxVolume',
            'referenceImageUrl.$': '$.referenceImageUrl',
          },
          End: true,
        },
      },
    },
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'ReReconcileAfterRework',
  };
  def.States.ReReconcileAfterRework = {
    Type: 'Task',
    Resource: reconcileSegmentTimingArn,
    Comment: 'Re-run reconcile after rework, merging ReworkScenesMap\'s output back into sceneResults by frameId (reconcile-segment-timing.ts\'s new reworkedScenes param). Required, not optional: a freshly regenerated last-of-segment clip won\'t already match its previously-reconciled trimmed/extended length.',
    Parameters: {
      'sceneResults.$': '$.reconcileResult.sceneResults',
      'reworkedScenes.$': '$.reworkScenesResult',
      'segmentResults.$': '$.qaInput._pipelineContext.segmentResults',
      'outputKeyPrefix.$': "States.Format('projects/{}/dialogue-basic/reconcile-rework{}', $.qaInput.projectId, $.qaInput.reworkAttempt)",
    },
    ResultPath: '$.reconcileResult',
    TimeoutSeconds: 600,
    Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'PrepareReQAPayloadDialogueBasic',
  };
  def.States.PrepareReQAPayloadDialogueBasic = {
    Type: 'Pass',
    Comment: 'Second-pass QA input using the re-reconciled scene results.',
    Parameters: {
      'projectId.$': '$.qaInput.projectId',
      'jobId.$': '$.qaInput.jobId',
      'characterBible.$': '$.qaInput.characterBible',
      mode: 'review',
      auditPercent: 100,
      reworkAttempt: 2,
      '_pipelineContext.$': '$.qaInput._pipelineContext',
    },
    ResultPath: '$.qaInput',
    Next: 'ReQaAgentDialogueBasic',
  };
  def.States.ReQaAgentDialogueBasic = {
    Type: 'Task',
    Resource: 'arn:aws:lambda:us-east-1:929075264324:function:dialogue-basic-qa-agent',
    Comment: 'Second-pass QA on reworked scenes — results are logged but the pipeline always proceeds after this (no further rework loop, matches narration-premium\'s ReQaAgentNarrationPremium). frames reads $.reconcileResult.sceneResults directly, same reasoning as QaAgentDialogueBasic.',
    Parameters: {
      'projectId.$': '$.qaInput.projectId',
      'jobId.$': '$.qaInput.jobId',
      'frames.$': '$.reconcileResult.sceneResults',
      'characterBible.$': '$.qaInput.characterBible',
      'mode.$': '$.qaInput.mode',
      'auditPercent.$': '$.qaInput.auditPercent',
      'reworkAttempt.$': '$.qaInput.reworkAttempt',
    },
    TimeoutSeconds: 1800,
    ResultPath: '$.qaAgentResult',
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.qaError', Next: 'RestoreContextDialogueBasic' }],
    Next: 'RestoreContextDialogueBasic',
  };
  def.States.RestoreContextDialogueBasic = {
    Type: 'Pass',
    Comment: 'Restore the full pipeline context for the concatenation step.',
    Parameters: {
      'jobId.$': '$.qaInput._pipelineContext.jobId',
      'projectId.$': '$.qaInput._pipelineContext.projectId',
      'projectType.$': '$.qaInput._pipelineContext.projectType',
      'aspectRatio.$': '$.qaInput._pipelineContext.aspectRatio',
      'narrator.$': '$.qaInput._pipelineContext.narrator',
      'narratorOverlay.$': '$.qaInput._pipelineContext.narratorOverlay',
      'bgmPrompt.$': '$.qaInput._pipelineContext.bgmPrompt',
      'textOverlayEnabled.$': '$.qaInput._pipelineContext.textOverlayEnabled',
      'apiKey.$': '$.qaInput._pipelineContext.apiKey',
      'jwtToken.$': '$.qaInput._pipelineContext.jwtToken',
      'convexEndpoint.$': '$.qaInput._pipelineContext.convexEndpoint',
      'userId.$': '$.qaInput._pipelineContext.userId',
      'admissionId.$': '$.qaInput._pipelineContext.admissionId',
      'segmentResults.$': '$.qaInput._pipelineContext.segmentResults',
      'reconcileResult.$': '$.reconcileResult',
    },
    Next: 'ApplySceneSfxMap',
  };

  // ── Per-frame spot SFX (2026-08-12, storystudio-qm-sfx-vocal-audio-
  // contract.md §4/§7.1) ───────────────────────────────────────────────────
  // Runs AFTER ReconcileSegmentTiming/rework, once every scene clip is at
  // its FINAL duration — applying earlier would risk retarget()'s extend
  // path (reconcile-segment-timing.ts, hardcoded `-an`) silently stripping a
  // freshly-baked-in SFX track, since that path assumes scene clips are
  // silent. Reuses dialoguePremium's proven bgm-mode-trick pattern
  // (sfx.dialogueBasic catalog key) rather than a new RunPod mode, per §7.1's
  // recommendation.
  def.States.ApplySceneSfxMap = {
    Type: 'Map',
    Comment: 'Per-scene: generate + mix a spot SFX for any scene whose frame carried a non-empty sfxPrompt (BuildSceneResult/BuildReworkedSceneResult). No sfxPrompt, or generation/mix failure -> scene passes through unchanged (graceful degrade, matches dialoguePremium\'s RouteShotSfx Catch behavior). MaxConcurrency capped well under bgm-s2t\'s 4 physical workers (fleet.ts BGM_S2T) — that pod is shared with once-per-project BGM + dialoguePremium\'s own spot SFX, so bursting all of a project\'s scenes at once queues most of them past QMGenerateSceneSfx\'s own TimeoutSeconds even though the underlying generation is fast once a worker is free (live incident 2026-08-12: MaxConcurrency 15 against 4 workers timed out most scenes at 300s despite jobs completing ~7min later).',
    ItemsPath: '$.reconcileResult.sceneResults',
    MaxConcurrency: 3,
    ResultPath: '$.reconcileResult.sceneResults',
    Iterator: {
      StartAt: 'RouteSceneSfx',
      States: {
        RouteSceneSfx: {
          Type: 'Choice',
          Comment: 'sfxAudioUrl (2026-08-13, storystudio-dialogue-sfx-url-integration-request.md §3) — StoryStudio\'s pre-vetted SFX-library match — takes priority over sfxPrompt-driven ACE-Step generation when present. Falls back to the sfxPrompt branch on an empty/absent URL, or (via QMMixSceneSfxFromUrl\'s Catch below) on an unreachable one.',
          Choices: [
            {
              And: [
                { Variable: '$.sfxAudioUrl', IsPresent: true },
                { Variable: '$.sfxAudioUrl', IsString: true },
                { Not: { Variable: '$.sfxAudioUrl', StringEquals: '' } },
              ],
              Next: 'AdoptSceneSfxAudioUrl',
            },
            {
              And: [
                { Variable: '$.sfxPrompt', IsPresent: true },
                { Variable: '$.sfxPrompt', IsString: true },
                { Not: { Variable: '$.sfxPrompt', StringEquals: '' } },
              ],
              Next: 'QMGenerateSceneSfx',
            },
          ],
          Default: 'PassthroughScene',
        },
        AdoptSceneSfxAudioUrl: {
          Type: 'Pass',
          Comment: 'Library SFX match found — skip QMGenerateSceneSfx/ACE-Step entirely and go straight to mixing exactly as a generated clip would (merge.ts already downloads whatever audioUrl it\'s given, generated or not).',
          Parameters: { 'cdnUrl.$': '$.sfxAudioUrl' },
          ResultPath: '$.sfxResult',
          Next: 'QMMixSceneSfxFromUrl',
        },
        QMMixSceneSfxFromUrl: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Mix the library SFX asset onto this scene\'s own clip (video.dialogueBasic.merge -> qm-merge Lambda, handlers/merge.ts). Same shape as QMMixSceneSfx below, kept as a separate state so a download/mix failure here can fall back to sfxPrompt-driven generation (RouteSceneSfxFallback) instead of passing the scene through untouched.',
          Parameters: {
            assetType: 'video', tier: 'dialogueBasic', operation: 'merge', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.videoUrl)',
            'audioUrl.$': '$.sfxResult.cdnUrl',
            mixMode: 'additive',
            'durationS.$': '$.duration',
            'sfxVolume.$': '$.sfxVolume',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.sfxMixResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.sfxUrlMixError', Next: 'RouteSceneSfxFallback' }],
          Next: 'SetSceneAfterSfx',
        },
        RouteSceneSfxFallback: {
          Type: 'Choice',
          Comment: 'sfxAudioUrl was present but unreachable/failed to mix — fall back to sfxPrompt-driven ACE-Step generation, same as if the URL had been absent (storystudio-dialogue-sfx-url-integration-request.md §3).',
          Choices: [{
            And: [
              { Variable: '$.sfxPrompt', IsPresent: true },
              { Variable: '$.sfxPrompt', IsString: true },
              { Not: { Variable: '$.sfxPrompt', StringEquals: '' } },
            ],
            Next: 'QMGenerateSceneSfx',
          }],
          Default: 'PassthroughScene',
        },
        QMGenerateSceneSfx: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Spot SFX via QM (sfx.dialogueBasic: self-hosted ACE-Step, bgm-mode trick — same physical rung as sfx.dialoguePremium). Fixed short default duration, same reasoning as dialoguePremium\'s QMGenerateShotSfx: the scene object carries no explicit SFX-length field, this is an authored moment, not a gap-filler.',
          Parameters: {
            assetType: 'sfx', tier: 'dialogueBasic', operation: 'generate', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.sfxPrompt',
            durationS: 3,
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.sfxResult',
          // 600s, not the usual 300s — ApplySceneSfxMap's MaxConcurrency is
          // capped at 3 to protect bgm-s2t's 4 real workers, but that pod is
          // shared with once-per-project BGM + dialoguePremium's own spot SFX,
          // so a scene can still queue for several minutes before a worker
          // frees up even under this lower concurrency (2026-08-12 incident).
          TimeoutSeconds: 600,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.sfxError', Next: 'PassthroughScene' }],
          Next: 'QMMixSceneSfx',
        },
        QMMixSceneSfx: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Mix the SFX onto this scene\'s own clip (video.dialogueBasic.merge -> qm-merge Lambda, handlers/merge.ts). durationS MUST be the scene\'s own final duration: Wan2 clips carry no audio stream at all, so mixMode:"additive" always falls through merge.ts\'s replace path there (hasAudioStream() false) — omitting durationS would default target to min(video,audio) and truncate the VIDEO down to the short SFX clip\'s length instead of padding the SFX with trailing silence.',
          Parameters: {
            assetType: 'video', tier: 'dialogueBasic', operation: 'merge', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.videoUrl)',
            'audioUrl.$': '$.sfxResult.cdnUrl',
            mixMode: 'additive',
            'durationS.$': '$.duration',
            'sfxVolume.$': '$.sfxVolume',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.frameId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.sfxMixResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.sfxMixError', Next: 'PassthroughScene' }],
          Next: 'SetSceneAfterSfx',
        },
        SetSceneAfterSfx: {
          Type: 'Pass',
          Parameters: {
            'frameId.$': '$.frameId',
            'frameNumber.$': '$.frameNumber',
            'segmentIndex.$': '$.segmentIndex',
            'isSegmentLastFrame.$': '$.isSegmentLastFrame',
            'videoUrl.$': '$.sfxMixResult.cdnUrl',
            'duration.$': '$.sfxMixResult.durationS',
            'imageUrl.$': '$.imageUrl',
            'imagePrompt.$': '$.imagePrompt',
            'videoPrompt.$': '$.videoPrompt',
            'sfxPrompt.$': '$.sfxPrompt',
          },
          End: true,
        },
        PassthroughScene: {
          Type: 'Pass',
          Comment: 'No sfxPrompt, or SFX gen/mix failed — keep the scene exactly as reconcile/rework left it rather than failing the whole execution over one spot effect.',
          End: true,
        },
      },
    },
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'UpdateStatusConcatenating',
  };

  Object.assign(def.States, concatChain({
    namePrefix: 'ConcatenateScenes', ecs: concatTrimEcs,
    videosPath: '$.reconcileResult.sceneResults', outputSubpath: 'dialogue-basic/scenes-concatenated',
    next: 'ConcatenateNarrator',
  }));
  Object.assign(def.States, concatChain({
    namePrefix: 'ConcatenateNarrator', ecs: concatTrimEcs,
    videosPath: '$.segmentResults', outputSubpath: 'dialogue-basic/narrator-concatenated',
    next: 'CompositeNarratorOverlay',
  }));

  // CompositeNarratorOverlay — new QM-owned Fargate step (qm-dialogue-mix,
  // mode:"pip-composite"), the doc's own named fallback (§3.4/§10 Q3) for
  // "inside finalize," since e2e-finalize isn't part of this repo.
  def.States.CompositeNarratorOverlay = {
    Type: 'Pass',
    Comment: 'Build the dialogue-mix container payload (mode:"pip-composite").',
    Parameters: {
      mode: 'pip-composite',
      'sceneTrackUrl.$': '$.ConcatenateScenesResult.videoUrl',
      'narratorTrackUrl.$': '$.ConcatenateNarratorResult.videoUrl',
      'narratorOverlay.$': '$.narratorOverlay',
      'segmentBoundariesSeconds.$': '$.reconcileResult.segmentBoundariesSeconds',
      'aspectRatio.$': '$.aspectRatio',
      'outputKey.$': "States.Format('projects/{}/dialogue-basic/composite.mp4', $.projectId)",
      'audioOutputKey.$': "States.Format('projects/{}/dialogue-basic/composite.wav', $.projectId)",
    },
    ResultPath: '$.compositePayload',
    Next: 'UploadCompositePayload',
  };
  def.States.UploadCompositePayload = {
    Type: 'Task',
    Resource: 'arn:aws:states:::lambda:invoke',
    Comment: 'Same 8192-byte ContainerOverrides workaround as concat-and-trim.',
    Parameters: {
      FunctionName: dialogueMixEcs.uploadPayloadArn,
      Payload: {
        'key.$': "States.Format('projects/{}/payloads/composite.json', $.projectId)",
        'body.$': 'States.JsonToString($.compositePayload)',
      },
    },
    ResultSelector: { 'key.$': '$.Payload.key' },
    ResultPath: '$.compositePayloadUpload',
    TimeoutSeconds: 60,
    Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'CompositeNarratorOverlayTask',
  };
  def.States.CompositeNarratorOverlayTask = {
    Type: 'Task',
    Resource: 'arn:aws:states:::ecs:runTask.sync',
    Comment: 'PiP composite via QM\'s own Fargate task (qm-dialogue-mix). Composite audio = narrator track only — Wan2\'s scene track has no audio at all (§4.6).',
    Parameters: {
      Cluster: dialogueMixEcs.clusterArn,
      TaskDefinition: dialogueMixEcs.taskDefinitionArn,
      LaunchType: 'FARGATE',
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          Subnets: dialogueMixEcs.subnetIds,
          SecurityGroups: [dialogueMixEcs.securityGroupId],
          AssignPublicIp: 'ENABLED',
        },
      },
      Overrides: {
        ContainerOverrides: [{
          Name: dialogueMixEcs.containerName,
          Environment: [{ Name: 'PAYLOAD_S3_KEY', 'Value.$': '$.compositePayloadUpload.key' }],
        }],
      },
    },
    ResultPath: '$.compositeEcs',
    TimeoutSeconds: 1800,
    Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 1, BackoffRate: 2 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'BuildCompositeResult',
  };
  def.States.BuildCompositeResult = {
    Type: 'Pass',
    Comment: 'Deterministic URLs — the ECS task writes to exactly these keys.',
    Parameters: {
      'videoUrl.$': `States.Format('https://${dialogueMixEcs.outputBucket}.s3.us-east-1.amazonaws.com/projects/{}/dialogue-basic/composite.mp4', $.projectId)`,
      'audioUrl.$': `States.Format('https://${dialogueMixEcs.outputBucket}.s3.us-east-1.amazonaws.com/projects/{}/dialogue-basic/composite.wav', $.projectId)`,
    },
    ResultPath: '$.compositeResult',
    Next: 'TranscribeAudio',
  };

  // SRT off the composited audio (Whisper — same rung as narration, tier
  // dropped to 'narration' since srt.dialogueBasic aliases srt.narration).
  def.States.TranscribeAudio = {
    Type: 'Task',
    Resource: qmGenerateArn,
    Comment: 'SRT via QM (srt.dialogueBasic, alias of srt.narration -> self-hosted RunPod Whisper large-v3-turbo), transcribing the PiP composite\'s audio.',
    Parameters: {
      assetType: 'srt',
      tier: 'dialogueBasic',
      operation: 'transcribe',
      product: 'dialogue',
      queue: 'background',
      jobType: 'batch',
      'audioUrl.$': '$.compositeResult.audioUrl',
      'projectId.$': '$.projectId',
    },
    ResultPath: '$.transcribeResult',
    TimeoutSeconds: 920,
    Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.transcribeError', Next: 'SkipSrt' }],
    Next: 'BuildMergedVoiceResult',
  };
  def.States.BuildMergedVoiceResult.Parameters = {
    'mergedVideoUrl.$': '$.compositeResult.videoUrl',
    'audioUrl.$': '$.compositeResult.audioUrl',
    'srtUrl.$': '$.transcribeResult.cdnUrl',
    'captionsUrl.$': '$.transcribeResult.cdnUrl',
  };
  // BuildMergedVoiceResult.Next stays 'SetNoLocalizedAssets' (inherited) —
  // harmless static {} localizedAssets, keeps the same execution-output
  // shape every other QM-New pipeline produces. Retarget its OWN Next to
  // BGM (doc §4's exact ordering: composite -> transcribe -> BGM -> drop).
  def.States.SetNoLocalizedAssets.Next = 'RouteBGM';

  Object.assign(def.States, bgmStates(qmGenerateArn, 'dialogueBasic'));
  def.States.QMGenerateBGM.Comment = 'Generate background music via QM (bgm.dialogueBasic, alias of bgm.narration). Duration = Σ ACTUAL segment durations (§3.2), not Σ frame durations — the narrator track\'s real length.';
  def.States.QMGenerateBGM.Parameters = {
    assetType: 'bgm',
    tier: 'dialogueBasic',
    operation: 'generate',
    product: 'dialogue',
    queue: 'background',
    jobType: 'batch',
    'prompt.$': '$.bgmPrompt',
    'segments.$': '$.segmentResults',
    'projectId.$': '$.projectId',
    'userId.$': '$.userId',
  };
  // RouteBGM/SkipBgm/QMGenerateBGM/BgmGenerationFailed all still Next to the
  // inherited 'NormalizeFourLang' chain by default (untouched) — it's a
  // generic optional-field normalizer that terminates at 'DropFrameData',
  // which is redefined immediately below.

  def.States.DropFrameData = {
    Type: 'Pass',
    Comment: 'Allowlist per §9: segmentResults (BGM duration already consumed, kept for the status write-back below) + mergedVoiceResult (carries the composite video/audio/SRT URLs) + bgmResult.',
    Parameters: {
      'jobId.$': '$.jobId',
      'projectId.$': '$.projectId',
      'projectType.$': '$.projectType',
      'aspectRatio.$': '$.aspectRatio',
      'mergedVoiceResult.$': '$.mergedVoiceResult',
      'bgmResult.$': '$.bgmResult',
      'segmentResults.$': '$.segmentResults',
      'localizedAssets.$': '$.localizedAssets',
      'jwtToken.$': '$.jwtToken',
      'convexEndpoint.$': '$.convexEndpoint',
      'apiKey.$': '$.apiKey',
      'userId.$': '$.userId',
      'admissionId.$': '$.admissionId',
      'generateShorts.$': '$.generateShorts',
      'shortsOptions.$': '$.shortsOptions',
    },
    Next: 'UpdateStatusApplyingBgm',
  };
  def.States.UpdateStatusApplyingBgm.Parameters.assets = {
    'mergedVideoUrl.$': '$.mergedVoiceResult.mergedVideoUrl',
    'segments.$': '$.segmentResults',
    'localizedAssets.$': '$.localizedAssets',
  };

  // Rename the Basic-named finalize cluster to DialogueBasic — same rename
  // pattern buildNarrationPremiumQmNewDefinition uses for Premium. No
  // targetResolution: concat-and-trim and the PiP composite both already
  // render at the project's full target resolution (their own aspect-ratio
  // canvas scale+pad), matching narration-basic's own no-upscale convention.
  def.States.ValidateFinalizeInputsDialogueBasic = {
    Type: 'Choice',
    Comment: 'Verify required fields exist AND are non-empty before finalize (qm-concat-trim-ecs-migration memory).',
    Choices: [{
      And: [
        { Variable: '$.mergedVoiceResult.mergedVideoUrl', IsPresent: true },
        { Not: { Variable: '$.mergedVoiceResult.mergedVideoUrl', StringEquals: '' } },
      ],
      Next: 'PrepareFinalizeDialogueBasic',
    }],
    Default: 'FinalizeInputsMissingDialogueBasic',
  };
  delete def.States.ValidateFinalizeInputsBasic;
  def.States.UpdateStatusApplyingBgm.Next = 'ValidateFinalizeInputsDialogueBasic';
  def.States.UpdateStatusApplyingBgm.Catch = [
    { ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'FinalizeVideoDialogueBasic' },
  ];

  def.States.FinalizeInputsMissingDialogueBasic = {
    Type: 'Fail', Error: 'FinalizeInputsMissing', Cause: 'Required finalize input(s) missing: $.mergedVoiceResult.mergedVideoUrl',
  };
  delete def.States.FinalizeInputsMissingBasic;

  def.States.PrepareFinalizeDialogueBasic = {
    Type: 'Pass',
    Comment: 'Prepare a small payload for the Fargate finalize task.',
    Parameters: {
      mode: 'basic',
      'jobId.$': '$.jobId',
      'projectId.$': '$.projectId',
      'projectType.$': '$.projectType',
      'aspectRatio.$': '$.aspectRatio',
      'videoUrl.$': '$.mergedVoiceResult.mergedVideoUrl',
      'voiceAudioUrl.$': '$.mergedVoiceResult.audioUrl',
      'captionsUrl.$': '$.mergedVoiceResult.captionsUrl',
      'bgmUrl.$': '$.bgmResult.cdnUrl',
      'jwtToken.$': '$.jwtToken',
      'convexEndpoint.$': '$.convexEndpoint',
    },
    ResultPath: '$.finalizeTaskInput',
    Next: 'NormalizeShortsOptions',
  };
  delete def.States.PrepareFinalizeBasic;

  def.States.FinalizeVideoDialogueBasic = {
    Type: 'Task',
    Resource: 'arn:aws:states:::ecs:runTask.sync',
    Comment: 'Finalize on Fargate (unmodified e2e-finalize): captions + BGM overlay/duck.',
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

  Object.assign(def.States, shortsTriggerStates(shortsTriggerArn, 'FinalizeVideoDialogueBasic'));

  return def;
}

/**
 * Dialogue Premium's per-shot Map. Not a variant of Basic's per-frame Maps —
 * three different generators chosen per shot by an explicit `kind` field
 * StoryStudio has already resolved (§1/§6): `action` (Wan2 i2v, optional VO),
 * `monologue` (RunComfy mono, no trim — §7.6.5), `dialogue` (RunComfy multi,
 * trimmed to left+right — the endpoint's fixed +1.00s pad, §7.4/§7.6.6).
 * `kind`/`imageModel` are routed on directly, never re-derived (§7.3's own
 * "resolve on our side, send an explicit value" convention).
 *
 * TTS is per TURN (QM-build-turn-tracks), not per line (§7.4/§7.9.2 — half
 * the calls, 12% shorter audio, better prosody). The "common tail" (spot
 * SFX, authored tail beat, text overlay) runs after any of the three kind
 * branches converge on a common `{shotVideoUrl, shotDurationSeconds}` shape.
 */
function dialoguePremiumShotMap(opts: {
  qmGenerateArn: string; remotionOverlayArn: string; buildTurnTracksArn: string;
  trimClipArn: string; appendTailBeatArn: string;
  /** Default 'inline': today's shape, shots already sitting in `$.shots`.
   * 's3': 2026-08-16 fix for films whose shots manifest is too large for
   * Step Functions' 256KB state ceiling (a real 132-shot/565KB project hit
   * this live) — shots are read directly off S3 via a Distributed Map
   * ItemReader (`Mode:'INLINE'`, iterations still run in this execution,
   * only the ITEM SOURCE moves off in-state) instead of `ItemsPath`, so the
   * full array never has to land in execution state at all. Same Iterator
   * body either way — only the item-source wrapper differs. */
  itemSource?: 's3';
}): object {
  const {
    qmGenerateArn, remotionOverlayArn, buildTurnTracksArn, trimClipArn, appendTailBeatArn,
    itemSource,
  } = opts;
  const iteratorBody = {
      StartAt: 'CheckShotImageCache',
      States: {
        CheckShotImageCache: {
          Type: 'Task',
          Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-asset-cache-check',
          Comment: 'Check S3 metadata cache — skip image generation if it already exists',
          Parameters: {
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            assetType: 'image',
          },
          ResultPath: '$.imageCacheResult',
          TimeoutSeconds: 10,
          Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 2, MaxAttempts: 1, BackoffRate: 1.5 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.cacheError', Next: 'RouteShotImageGen' }],
          Next: 'CheckShotImageCacheResult',
        },
        CheckShotImageCacheResult: {
          Type: 'Choice',
          Choices: [{ Variable: '$.imageCacheResult.cached', BooleanEquals: true, Next: 'UseShotImageCache' }],
          Default: 'RouteShotImageGen',
        },
        UseShotImageCache: {
          Type: 'Pass',
          Parameters: { 'cdnUrl.$': '$.imageCacheResult.cdnUrl' },
          ResultPath: '$.imageResult',
          Next: 'NormalizeShotSfxPrompt',
        },
        RouteShotImageGen: {
          Type: 'Choice',
          Comment: 'Route on the explicit imageModel value StoryStudio already resolved — do not re-derive from referenceImageUrl presence (§7.3).',
          Choices: [{ Variable: '$.imageModel', StringEquals: 'qwen-image-edit', Next: 'QMGenerateShotImageI2I' }],
          Default: 'QMGenerateShotImageT2I',
        },
        QMGenerateShotImageI2I: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Shot still via QM (image.dialoguePremium.i2i: self-hosted Qwen-Image-Edit), anchored on the character referenceImageUrl — coverage singles are i2i-dominant (§7.10.2: the identity anchor is the character reference image, never a previous shot\'s rendered frame).',
          Parameters: {
            assetType: 'image', tier: 'dialoguePremium', operation: 'i2i', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.imagePrompt',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'initImageUrls.$': 'States.Array($.referenceImageUrl)',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.imageResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'ShotFailed' }],
          Next: 'StoreShotImageMeta',
        },
        QMGenerateShotImageT2I: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Shot still via QM (image.dialoguePremium.t2i: self-hosted Qwen-Image-Gen -> nano-banana fallback).',
          Parameters: {
            assetType: 'image', tier: 'dialoguePremium', operation: 't2i', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.imagePrompt',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.imageResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.imageError', Next: 'ShotFailed' }],
          Next: 'StoreShotImageMeta',
        },
        StoreShotImageMeta: {
          Type: 'Task',
          Resource: 'arn:aws:lambda:us-east-1:929075264324:function:E2E-store-asset-meta',
          Comment: 'Persist image metadata to S3 for cache reuse',
          Parameters: {
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            assetType: 'image',
            'cdnUrl.$': '$.imageResult.cdnUrl',
            's3Key.$': '$.imageResult.s3Key',
            'width.$': '$.imageResult.width',
            'height.$': '$.imageResult.height',
          },
          ResultPath: null,
          TimeoutSeconds: 10,
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.metaStoreError', Next: 'NormalizeShotSfxPrompt' }],
          Next: 'NormalizeShotSfxPrompt',
        },

        // ── normalize optional per-shot fields (2026-08-17 fix) ──────────
        // sfxPrompt/tailBeatSeconds/textManifest are all genuinely optional
        // on a shot (most shots have none — §7.3/§7.7). RouteShotSfx/
        // RouteTailBeat/RouteShotTextOverlay below tolerate that fine (a
        // Choice's Variable check just falls to Default when the path is
        // absent — no error). But the "SetXAsIs"-family Pass states further
        // down need to explicitly carry these fields forward (see their own
        // comments), and Parameters — unlike Choice Variable — throws
        // States.Runtime on a missing path. So, exactly mirroring dialogue-
        // basic's proven live pattern (GenerateScenes' NormalizeSceneSfxPrompt
        // / SetSceneSfxPromptDefault / etc., storystudio-dialogue-qm-sfn-
        // handoff.md's sibling pipeline), normalize each optional field to a
        // default ONCE here, before any generation happens, so every later
        // reference to $.sfxPrompt/$.tailBeatSeconds/$.textManifest is always
        // safe.
        NormalizeShotSfxPrompt: {
          Type: 'Choice',
          Choices: [{ Variable: '$.sfxPrompt', IsPresent: true, Next: 'NormalizeShotTailBeatSeconds' }],
          Default: 'SetShotSfxPromptDefault',
        },
        SetShotSfxPromptDefault: {
          Type: 'Pass', Result: '', ResultPath: '$.sfxPrompt', Next: 'NormalizeShotTailBeatSeconds',
        },
        NormalizeShotTailBeatSeconds: {
          Type: 'Choice',
          Choices: [{ Variable: '$.tailBeatSeconds', IsPresent: true, Next: 'NormalizeShotTextManifest' }],
          Default: 'SetShotTailBeatSecondsDefault',
        },
        SetShotTailBeatSecondsDefault: {
          Type: 'Pass', Result: 0, ResultPath: '$.tailBeatSeconds', Next: 'NormalizeShotTextManifest',
        },
        NormalizeShotTextManifest: {
          Type: 'Choice',
          Choices: [{ Variable: '$.textManifest', IsPresent: true, Next: 'RouteShotKind' }],
          Default: 'SetShotTextManifestDefault',
        },
        SetShotTextManifestDefault: {
          Type: 'Pass', Result: '', ResultPath: '$.textManifest', Next: 'RouteShotKind',
        },

        RouteShotKind: {
          Type: 'Choice',
          Comment: 'kind is a required field, already resolved by StoryStudio\'s planner — route on it directly, never re-derive (§7.3).',
          Choices: [
            { Variable: '$.kind', StringEquals: 'action', Next: 'QMGenerateActionVideo' },
            { Variable: '$.kind', StringEquals: 'monologue', Next: 'QMBuildMonologueTurn' },
            { Variable: '$.kind', StringEquals: 'dialogue', Next: 'QMBuildDialogueTurns' },
            { Variable: '$.kind', StringEquals: 'narration', Next: 'QMGenerateNarrationVideo' },
          ],
          Default: 'ShotFailed',
        },

        // ── action ──────────────────────────────────────────────────────
        QMGenerateActionVideo: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Action shot via QM (video.dialoguePremium.i2v: self-hosted Wan 2.2 I2V-A14B -> Replicate fallback). No on-screen speech — motion/reaction shots only. Reaction shots must carry an explicit "mouth closed, lips together, not speaking" videoPrompt (§7.11.1) — StoryStudio\'s responsibility, not QM\'s.',
          Parameters: {
            assetType: 'video', tier: 'dialoguePremium', operation: 'i2v', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'prompt.$': '$.videoPrompt',
            'durationS.$': '$.durationSeconds',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.actionVideoResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoError', Next: 'ShotFailed' }],
          Next: 'RouteShotNarration',
        },
        RouteShotNarration: {
          Type: 'Choice',
          Comment: 'VO/internal-monologue over an action shot, when authored.',
          Choices: [{
            And: [
              { Variable: '$.narrationText', IsPresent: true },
              { Variable: '$.narrationText', IsString: true },
              { Not: { Variable: '$.narrationText', StringEquals: '' } },
            ],
            Next: 'QMGenerateShotNarrationTTS',
          }],
          Default: 'SetActionVideoAsIs',
        },
        // 2026-08-17 fix: this Pass state's Parameters, with no ResultPath,
        // defaults to ResultPath:'$' — REPLACING the whole working state
        // with just its own Parameters output, not merging. Confirmed live
        // (first real 132-shot execution): every one of these "SetXAsIs"-
        // family states was silently wiping shotId/shotNumber/sfxPrompt/
        // tailBeatSeconds/textManifest, which RouteShotSfx/RouteTailBeat/
        // RouteShotTextOverlay/BuildShotVideo further down still need —
        // BuildShotVideo's own `$.shotId` reference was crashing 100% of
        // real shots with States.Runtime. Fix (mirrors dialogue-basic's
        // GenerateScenes→BuildSceneResult, the proven working reference
        // pattern for this exact problem): every field still needed by the
        // shared tail must be explicitly carried forward here, same as
        // dialogue-basic's SetPersonaFromResult/BuildSceneResult already do.
        // sfxPrompt/tailBeatSeconds/textManifest are guaranteed present by
        // this point (NormalizeShotSfxPrompt et al, above) so referencing
        // them here is always safe, never a missing-path crash.
        SetActionVideoAsIs: {
          Type: 'Pass',
          Parameters: {
            'shotVideoUrl.$': '$.actionVideoResult.cdnUrl', 'shotDurationSeconds.$': '$.actionVideoResult.durationS',
            'shotId.$': '$.shotId', 'shotNumber.$': '$.shotNumber',
            'sfxPrompt.$': '$.sfxPrompt', 'tailBeatSeconds.$': '$.tailBeatSeconds', 'textManifest.$': '$.textManifest',
          },
          Next: 'RouteShotSfx',
        },
        QMGenerateShotNarrationTTS: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'VO/internal-monologue TTS via QM (voice.dialoguePremium.tts). Voice = the voiceBank entry for narrationKind\'s characterId, or the project narrator voice if absent — StoryStudio resolves which voiceBank entry to reference; this call trusts whatever the shot\'s own fields already carry.',
          Parameters: {
            assetType: 'voice', tier: 'dialoguePremium', operation: 'tts', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.narrationText',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.narrationTtsResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'ShotFailed' }],
          Next: 'QMMergeShotNarration',
        },
        QMMergeShotNarration: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Merge VO onto the action clip via QM (video.dialoguePremium.merge, alias of the generic Lambda mux).',
          Parameters: {
            assetType: 'video', tier: 'dialoguePremium', operation: 'merge', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.actionVideoResult.cdnUrl)',
            'audioUrl.$': '$.narrationTtsResult.cdnUrl',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.narrationMergeResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.mergeError', Next: 'ShotFailed' }],
          Next: 'SetActionVideoWithNarration',
        },
        SetActionVideoWithNarration: {
          Type: 'Pass',
          Parameters: {
            'shotVideoUrl.$': '$.narrationMergeResult.cdnUrl', 'shotDurationSeconds.$': '$.narrationMergeResult.durationS',
            'shotId.$': '$.shotId', 'shotNumber.$': '$.shotNumber',
            'sfxPrompt.$': '$.sfxPrompt', 'tailBeatSeconds.$': '$.tailBeatSeconds', 'textManifest.$': '$.textManifest',
          },
          Next: 'RouteShotSfx',
        },

        // ── narration (2026-08-16 addendum) — narrator-voiced VO over a
        // silent Wan2 visual; narrator never on-screen, so no lip sync —
        // just TTS + a plain audio merge, same engines as action/monologue.
        QMGenerateNarrationVideo: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Narration shot\'s silent visual via QM (video.dialoguePremium.i2v: self-hosted Wan 2.2 I2V-A14B -> Replicate fallback) — identical wire shape to an action shot (storystudio-dialogue-premium-narration-addendum-2026-08-16.md §2): the narrator is never depicted on screen.',
          Parameters: {
            assetType: 'video', tier: 'dialoguePremium', operation: 'i2v', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'prompt.$': '$.videoPrompt',
            'durationS.$': '$.durationSeconds',
            'aspectRatio.$': '$$.Execution.Input.aspectRatio',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.narrationVideoResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoError', Next: 'ShotFailed' }],
          Next: 'QMGenerateNarratorTTS',
        },
        QMGenerateNarratorTTS: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Narrator-voiced TTS via QM (voice.dialoguePremium.tts) — narrator-scoped clone artifact. StoryStudio resolves narratorVoiceCloneArtifactUrl the same way dialogue-basic\'s narrator voice is resolved (gender-matched against the Qwen voice-clone catalog); QM just passes it straight through as cloneArtifactUrl, same fast-path runpod.ts already takes whenever cloneArtifactUrl is non-empty.',
          Parameters: {
            assetType: 'voice', tier: 'dialoguePremium', operation: 'tts', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.narrationText',
            'cloneArtifactUrl.$': '$.narratorVoiceCloneArtifactUrl',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.narratorTtsResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'ShotFailed' }],
          Next: 'QMMergeNarrationAudio',
        },
        QMMergeNarrationAudio: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Merge narrator TTS onto the silent visual via QM (video.dialoguePremium.merge). No lip sync — the narrator is never on-screen (addendum §3).',
          Parameters: {
            assetType: 'video', tier: 'dialoguePremium', operation: 'merge', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.narrationVideoResult.cdnUrl)',
            'audioUrl.$': '$.narratorTtsResult.cdnUrl',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.narrationMergeResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.mergeError', Next: 'ShotFailed' }],
          Next: 'SetNarrationVideoWithNarration',
        },
        SetNarrationVideoWithNarration: {
          Type: 'Pass',
          Parameters: {
            'shotVideoUrl.$': '$.narrationMergeResult.cdnUrl', 'shotDurationSeconds.$': '$.narrationMergeResult.durationS',
            'shotId.$': '$.shotId', 'shotNumber.$': '$.shotNumber',
            'sfxPrompt.$': '$.sfxPrompt', 'tailBeatSeconds.$': '$.tailBeatSeconds', 'textManifest.$': '$.textManifest',
          },
          Next: 'RouteShotSfx',
        },

        // ── monologue ───────────────────────────────────────────────────
        QMBuildMonologueTurn: {
          Type: 'Task',
          Resource: buildTurnTracksArn,
          Comment: 'Join this shot\'s dialogueLines into one turn (§7.4/§7.9.2 — one TTS call, not one per line).',
          Parameters: { kind: 'monologue', 'dialogueLines.$': '$.dialogueLines', 'voiceBank.$': '$$.Execution.Input.voiceBank' },
          ResultPath: '$.turnResult',
          TimeoutSeconds: 30,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 3, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.turnError', Next: 'ShotFailed' }],
          Next: 'QMGenerateMonologueTTS',
        },
        QMGenerateMonologueTTS: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'TTS via QM (voice.dialoguePremium.tts).',
          Parameters: {
            assetType: 'voice', tier: 'dialoguePremium', operation: 'tts', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.turnResult.mono.text',
            'cloneArtifactUrl.$': '$.turnResult.mono.voiceCloneArtifactUrl',
            'language.$': '$.turnResult.mono.voiceLanguage',
            'instruct.$': '$.turnResult.mono.voiceInstruct',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.monologueTtsResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'ShotFailed' }],
          Next: 'QMGenerateTalkingHead',
        },
        QMGenerateTalkingHead: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Lip-sync via QM (video.dialoguePremium.monologue: RunComfy InfiniteTalk mono). No trim — mono endpoint has no trailing pad, output_duration == input audio duration exactly (§7.6.5).',
          Parameters: {
            assetType: 'video', tier: 'dialoguePremium', operation: 'monologue', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'audioUrl.$': '$.monologueTtsResult.cdnUrl',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.talkingHeadResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoError', Next: 'ShotFailed' }],
          Next: 'SetMonologueVideoAsIs',
        },
        SetMonologueVideoAsIs: {
          Type: 'Pass',
          Parameters: {
            'shotVideoUrl.$': '$.talkingHeadResult.cdnUrl', 'shotDurationSeconds.$': '$.monologueTtsResult.durationS',
            'shotId.$': '$.shotId', 'shotNumber.$': '$.shotNumber',
            'sfxPrompt.$': '$.sfxPrompt', 'tailBeatSeconds.$': '$.tailBeatSeconds', 'textManifest.$': '$.textManifest',
          },
          Next: 'RouteShotSfx',
        },

        // ── dialogue (two-hander) ───────────────────────────────────────
        QMBuildDialogueTurns: {
          Type: 'Task',
          Resource: buildTurnTracksArn,
          Comment: 'Join left/right speaker lines into two turns (§7.4/§7.5 — StoryStudio guarantees at most 2 speakerSlots, no interleaving, left always opens).',
          Parameters: { kind: 'dialogue', 'dialogueLines.$': '$.dialogueLines', 'voiceBank.$': '$$.Execution.Input.voiceBank' },
          ResultPath: '$.turnResult',
          TimeoutSeconds: 30,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 3, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.turnError', Next: 'ShotFailed' }],
          Next: 'QMGenerateLeftTTS',
        },
        QMGenerateLeftTTS: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Camera-left speaker\'s turn TTS via QM (voice.dialoguePremium.tts).',
          Parameters: {
            assetType: 'voice', tier: 'dialoguePremium', operation: 'tts', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.turnResult.left.text',
            'cloneArtifactUrl.$': '$.turnResult.left.voiceCloneArtifactUrl',
            'language.$': '$.turnResult.left.voiceLanguage',
            'instruct.$': '$.turnResult.left.voiceInstruct',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': "States.Format('{}-left', $.shotId)",
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.leftTtsResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'ShotFailed' }],
          Next: 'QMGenerateRightTTS',
        },
        QMGenerateRightTTS: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Camera-right speaker\'s turn TTS via QM (voice.dialoguePremium.tts).',
          Parameters: {
            assetType: 'voice', tier: 'dialoguePremium', operation: 'tts', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.turnResult.right.text',
            'cloneArtifactUrl.$': '$.turnResult.right.voiceCloneArtifactUrl',
            'language.$': '$.turnResult.right.voiceLanguage',
            'instruct.$': '$.turnResult.right.voiceInstruct',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': "States.Format('{}-right', $.shotId)",
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.rightTtsResult',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ttsError', Next: 'ShotFailed' }],
          Next: 'QMGenerateTalkingHead2',
        },
        QMGenerateTalkingHead2: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Lip-sync via QM (video.dialoguePremium.dialogue: RunComfy InfiniteTalk fast/multi). output_duration = left+right+1.00s exactly (§7.4/§7.6.4) — trimmed next.',
          Parameters: {
            assetType: 'video', tier: 'dialoguePremium', operation: 'dialogue', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'leftAudioUrl.$': '$.leftTtsResult.cdnUrl',
            'rightAudioUrl.$': '$.rightTtsResult.cdnUrl',
            'initImageUrls.$': 'States.Array($.imageResult.cdnUrl)',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.talkingHead2Result',
          TimeoutSeconds: 920,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.videoError', Next: 'ShotFailed' }],
          Next: 'ComputeDialogueTrimTarget',
        },
        ComputeDialogueTrimTarget: {
          Type: 'Pass',
          Comment: 'Trim target = left_duration + right_duration, known at BuildTurnTracks time — not detected (§7.6.6).',
          Parameters: { 'value.$': 'States.MathAdd($.leftTtsResult.durationS, $.rightTtsResult.durationS)' },
          ResultPath: '$.trimTarget',
          Next: 'QMTrimDialogueClip',
        },
        QMTrimDialogueClip: {
          Type: 'Task',
          Resource: trimClipArn,
          Comment: 'Remove RunComfy fast/multi\'s fixed +1.00s trailing pad (§7.4/§7.6.6) — plain -t cut, no silencedetect.',
          Parameters: {
            'videoUrl.$': '$.talkingHead2Result.cdnUrl',
            'targetDurationSeconds.$': '$.trimTarget.value',
            'outputKey.$': "States.Format('projects/{}/dialogue-premium/trim/{}.mp4', $$.Execution.Input.projectId, $.shotId)",
          },
          ResultPath: '$.trimResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.trimError', Next: 'ShotFailed' }],
          Next: 'SetDialogueVideoTrimmed',
        },
        SetDialogueVideoTrimmed: {
          Type: 'Pass',
          Parameters: {
            'shotVideoUrl.$': '$.trimResult.cdnUrl', 'shotDurationSeconds.$': '$.trimResult.durationS',
            'shotId.$': '$.shotId', 'shotNumber.$': '$.shotNumber',
            'sfxPrompt.$': '$.sfxPrompt', 'tailBeatSeconds.$': '$.tailBeatSeconds', 'textManifest.$': '$.textManifest',
          },
          Next: 'RouteShotSfx',
        },

        // ── common tail: spot SFX, authored tail beat, text overlay ─────
        RouteShotSfx: {
          Type: 'Choice',
          Choices: [{
            And: [
              { Variable: '$.sfxPrompt', IsPresent: true },
              { Variable: '$.sfxPrompt', IsString: true },
              { Not: { Variable: '$.sfxPrompt', StringEquals: '' } },
            ],
            Next: 'QMGenerateShotSfx',
          }],
          Default: 'RouteTailBeat',
        },
        QMGenerateShotSfx: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Spot SFX via QM (sfx.dialoguePremium: self-hosted ACE-Step). Authored moment, not a gap-filler (§7.7 rule 2) — a short, fixed default duration, since the shot object carries no explicit SFX-length field.',
          Parameters: {
            assetType: 'sfx', tier: 'dialoguePremium', operation: 'generate', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.sfxPrompt',
            durationS: 3,
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.sfxResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.sfxError', Next: 'RouteTailBeat' }],
          Next: 'QMMixShotSfx',
        },
        QMMixShotSfx: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Mix the SFX ONTO the shot\'s existing audio (video.dialoguePremium.merge, mixMode:"additive" — adapters/lambdamerge.ts/merge.ts) rather than replacing it. Falls back to plain replace if the clip turns out to have no audio at all (a silent action shot with no VO).',
          Parameters: {
            assetType: 'video', tier: 'dialoguePremium', operation: 'merge', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'initImageUrls.$': 'States.Array($.shotVideoUrl)',
            'audioUrl.$': '$.sfxResult.cdnUrl',
            mixMode: 'additive',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': '$.shotId',
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.sfxMixResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.sfxMixError', Next: 'RouteTailBeat' }],
          Next: 'SetVideoAfterSfx',
        },
        SetVideoAfterSfx: {
          Type: 'Pass',
          Parameters: {
            'shotVideoUrl.$': '$.sfxMixResult.cdnUrl', 'shotDurationSeconds.$': '$.sfxMixResult.durationS',
            'shotId.$': '$.shotId', 'shotNumber.$': '$.shotNumber',
            'sfxPrompt.$': '$.sfxPrompt', 'tailBeatSeconds.$': '$.tailBeatSeconds', 'textManifest.$': '$.textManifest',
          },
          Next: 'RouteTailBeat',
        },
        RouteTailBeat: {
          Type: 'Choice',
          Comment: 'Authored hold after this shot\'s last line (§7.3) — default 0, a hard cut.',
          Choices: [{
            And: [
              { Variable: '$.tailBeatSeconds', IsPresent: true },
              { Variable: '$.tailBeatSeconds', IsNumeric: true },
              { Variable: '$.tailBeatSeconds', NumericGreaterThan: 0 },
            ],
            Next: 'QMAppendTailBeat',
          }],
          Default: 'RouteShotTextOverlay',
        },
        QMAppendTailBeat: {
          Type: 'Task',
          Resource: appendTailBeatArn,
          Comment: 'Frozen-last-frame hold (ffmpeg tpad) — filled by the ambience bed at mix time, so it reads as a beat, not dead air (§7.3/§7.7).',
          Parameters: {
            'videoUrl.$': '$.shotVideoUrl',
            'tailBeatSeconds.$': '$.tailBeatSeconds',
            'outputKey.$': "States.Format('projects/{}/dialogue-premium/tailbeat/{}.mp4', $$.Execution.Input.projectId, $.shotId)",
          },
          ResultPath: '$.tailBeatResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.tailBeatError', Next: 'RouteShotTextOverlay' }],
          Next: 'SetVideoAfterTailBeat',
        },
        SetVideoAfterTailBeat: {
          Type: 'Pass',
          Parameters: {
            'shotVideoUrl.$': '$.tailBeatResult.cdnUrl', 'shotDurationSeconds.$': '$.tailBeatResult.durationS',
            'shotId.$': '$.shotId', 'shotNumber.$': '$.shotNumber',
            'sfxPrompt.$': '$.sfxPrompt', 'tailBeatSeconds.$': '$.tailBeatSeconds', 'textManifest.$': '$.textManifest',
          },
          Next: 'RouteShotTextOverlay',
        },
        RouteShotTextOverlay: {
          Type: 'Choice',
          Choices: [{
            And: [
              { Variable: '$.textManifest', IsPresent: true },
              { Variable: '$.textManifest', IsString: true },
              { Not: { Variable: '$.textManifest', StringEquals: '' } },
              { Variable: '$$.Execution.Input.textOverlayEnabled', IsPresent: true },
              { Variable: '$$.Execution.Input.textOverlayEnabled', BooleanEquals: true },
            ],
            Next: 'RenderShotTextOverlay',
          }],
          Default: 'BuildShotVideo',
        },
        RenderShotTextOverlay: {
          Type: 'Task',
          Resource: remotionOverlayArn,
          Comment: 'Per-shot Remotion text-overlay render (same Lambda narration uses, direct invoke). Passthrough failure policy — an overlay failure degrades to the un-overlaid clip rather than failing the shot.',
          Parameters: {
            'clipUrl.$': '$.shotVideoUrl',
            'textManifest.$': '$.textManifest',
            'frameId.$': '$.shotId',
            'duration.$': '$.shotDurationSeconds',
          },
          ResultPath: '$.overlayResult',
          TimeoutSeconds: 180,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.overlayError', Next: 'BuildShotVideo' }],
          Next: 'ApplyShotTextOverlay',
        },
        ApplyShotTextOverlay: {
          Type: 'Pass',
          Comment: 'Same fix as the "SetXAsIs" family above — this one was the worst case: it didn\'t even carry shotDurationSeconds forward (only shotVideoUrl), so BuildShotVideo\'s actualDurationSeconds would have been undefined too, not just shotId/shotNumber.',
          Parameters: {
            'shotVideoUrl.$': '$.overlayResult.overlayRenderedUrl', 'shotDurationSeconds.$': '$.shotDurationSeconds',
            'shotId.$': '$.shotId', 'shotNumber.$': '$.shotNumber',
            'sfxPrompt.$': '$.sfxPrompt', 'tailBeatSeconds.$': '$.tailBeatSeconds', 'textManifest.$': '$.textManifest',
          },
          Next: 'BuildShotVideo',
        },
        BuildShotVideo: {
          Type: 'Pass',
          Comment: 'frameNumber aliases shotNumber so this item is ALSO a valid concat-and-trim FrameVideo — ConcatenateShots feeds $.shotResults straight in.',
          Parameters: {
            'shotId.$': '$.shotId',
            'shotNumber.$': '$.shotNumber',
            'frameNumber.$': '$.shotNumber',
            'videoUrl.$': '$.shotVideoUrl',
            'actualDurationSeconds.$': '$.shotDurationSeconds',
          },
          End: true,
        },
        ShotFailed: {
          Type: 'Pass',
          Comment: 'QM exhausted all rungs for this shot — graceful degradation, mirrors QMFrameFailed.',
          Parameters: { failed: true, error: 'ShotFailed', 'shotId.$': '$.shotId', 'shotNumber.$': '$.shotNumber' },
          End: true,
        },
      },
  };

  const base = {
    Type: 'Map',
    Comment: 'Per-shot via Quartermaster gateway + RunComfy InfiniteTalk (Dialogue Premium). MaxConcurrency=12, lower than Basic\'s 15 — a "dialogue" shot fans out into 2 TTS calls plus one RunComfy job, so 12 concurrent shots is materially more load than 12 concurrent frames (§8.1).',
    MaxConcurrency: 12,
    ResultPath: '$.shotResults',
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: itemSource === 's3' ? 'GenerateAmbienceBedSpecsFromS3' : 'GenerateAmbienceBedSpecs',
  };

  if (itemSource === 's3') {
    // AWS's deploy-time changeset validation (NOT caught by local `cdk synth`
    // — found this the hard way) requires state names to be unique across
    // the ENTIRE state machine once a Map becomes a Distributed Map
    // (triggered by ItemReader's presence), unlike a standard Map's Iterator,
    // which is its own independent naming scope. Since this reuses the exact
    // same iteratorBody as the untouched inline Map (GenerateShots), every
    // state name here collides with that Map's — so give this variant's
    // states a distinct suffix and rewrite every internal Next/Default/
    // Choices[].Next reference to match. Cross-boundary references (e.g. the
    // Map-level Catch's 'HandleFailure', outside iteratorBody) are untouched
    // since they're not in the rename map.
    const renameMap = Object.fromEntries(
      Object.keys(iteratorBody.States).map((name) => [name, `${name}S3`]),
    );
    const renameRefs = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(renameRefs);
      if (node && typeof node === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          out[k] = (k === 'Next' || k === 'Default') && typeof v === 'string' && renameMap[v]
            ? renameMap[v]
            : renameRefs(v);
        }
        return out;
      }
      return node;
    };
    // 2026-08-17, second live-execution finding: a Distributed Map's
    // ItemProcessor states run as their OWN CHILD EXECUTION, each with its
    // OWN `$$.Execution.Input` — NOT the parent pipeline's original
    // top-level input. Every `$$.Execution.Input.X` reference in
    // iteratorBody (written for the inline/standard-Map case, where
    // iterations share the parent's execution context) breaks here
    // ("$$.Execution.Input.projectId could not be found in the input",
    // confirmed live). Fix: an `ItemSelector` builds each child's actual
    // input explicitly — the raw shot item nested under `shot`, plus the
    // handful of parent-level fields the iterator body actually needs
    // pulled to the child's root.
    //
    // 2026-08-17, FOURTH live-execution finding (a real project, not a
    // synthetic test — real cost): `$$.Execution.Input.X` for these
    // parent-level fields must be left COMPLETELY UNREWRITTEN, not converted
    // to plain `$.X`. `$$.Execution.Input` is an IMMUTABLE snapshot of the
    // child execution's own starting input (exactly what ItemSelector
    // produced) — valid for that child's ENTIRE lifetime regardless of how
    // many times a Pass state replaces the working `$`. An earlier version
    // of this fix converted `$$.Execution.Input.projectId` to plain
    // `$.projectId`, which put it at the mercy of the exact same "SetXAsIs"
    // whole-state-replace Pass states that were ALREADY known to wipe
    // shotId/sfxPrompt/etc (see the fix two blocks up) — QMGenerateShotSfx
    // crashed on `$.projectId` after SetActionVideoAsIs ran, on a real
    // customer project. Bare shot fields (`$.shotId` etc, below) DO need the
    // `.shot.` treatment, because unlike the exec-level fields they're
    // sometimes genuinely optional (sfxPrompt/tailBeatSeconds/textManifest)
    // and need a MUTABLE default written into them (NormalizeShotSfxPrompt
    // et al, which write into `$`, not `$$.Execution.Input` — you can't
    // mutate the latter) — so those still flow through the working state and
    // still need the TAIL_STATES-aware treatment below. Computed/
    // intermediate fields the iterator sets on ITSELF as it runs
    // (imageResult, turnResult, shotVideoUrl, the various *Error fields,
    // etc.) are untouched either way — those live in the child's own working
    // state regardless of the parent/child boundary, so `$.imageResult`
    // stays exactly `$.imageResult`. The SHOT_FIELDS list is the complete,
    // exact set actually referenced in iteratorBody (verified by grepping
    // this function's own source for every bare `$.<word>` token) — if a
    // future edit adds a new shot field reference to iteratorBody, it must
    // be added here too, or the S3/distributed branch will silently read
    // that field as null.
    const SHOT_FIELDS = new Set([
      'shotId', 'shotNumber', 'kind', 'imagePrompt', 'imageModel', 'referenceImageUrl',
      'videoPrompt', 'durationSeconds', 'dialogueLines', 'narrationText',
      'narratorVoiceCloneArtifactUrl', 'sfxPrompt', 'tailBeatSeconds', 'textManifest',
    ]);
    // 2026-08-17, third live-execution-adjacent finding (caught by inspecting
    // synth output before deploying, not another real-execution round trip):
    // shotId/sfxPrompt/tailBeatSeconds/textManifest/shotNumber mean TWO
    // different things depending on where in the flow a reference sits.
    // Before the "SetXAsIs"-family Pass states (the fix two blocks up), they
    // ARE the original shot's own fields (`.shot.` prefix correct). AFTER
    // one of those states runs, the fix explicitly re-flattens them to
    // top-level copies (`'shotId.$': '$.shot.shotId'` writing out a bare
    // `shotId` key) — so every state in the shared tail from RouteShotSfx
    // onward reads the FLAT copy, not the original nested shot object, and
    // must NOT get the `.shot.` treatment for these 5 field names, even
    // though the field names are identical. A single stateless token rewrite
    // can't tell these apart, so the whitelist is applied per-state instead.
    const TAIL_STATES = new Set([
      'RouteShotSfx', 'QMGenerateShotSfx', 'QMMixShotSfx', 'SetVideoAfterSfx',
      'RouteTailBeat', 'QMAppendTailBeat', 'SetVideoAfterTailBeat',
      'RouteShotTextOverlay', 'RenderShotTextOverlay', 'ApplyShotTextOverlay',
      'BuildShotVideo',
    ]);
    const FLATTENED_IN_TAIL = new Set(['shotId', 'shotNumber', 'sfxPrompt', 'tailBeatSeconds', 'textManifest']);
    const rewritePathTokens = (s: string, shotFields: Set<string>): string => s.replace(
      /\$\.(\w+)/g,
      (match: string, shotField: string) => (shotFields.has(shotField) ? `$.shot.${shotField}` : match),
    );
    const rewriteForDistributed = (node: unknown, shotFields: Set<string>): unknown => {
      if (Array.isArray(node)) return node.map((n) => rewriteForDistributed(n, shotFields));
      if (node && typeof node === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          out[k] = (k === 'Variable' || k === 'ResultPath' || k.endsWith('.$')) && typeof v === 'string'
            ? rewritePathTokens(v, shotFields)
            : rewriteForDistributed(v, shotFields);
        }
        return out;
      }
      return node;
    };

    const renamedStates = Object.fromEntries(
      Object.entries(iteratorBody.States).map(([name, state]) => {
        const shotFields = TAIL_STATES.has(name)
          ? new Set([...SHOT_FIELDS].filter((f) => !FLATTENED_IN_TAIL.has(f)))
          : SHOT_FIELDS;
        return [renameMap[name], rewriteForDistributed(renameRefs(state), shotFields)];
      }),
    );

    return {
      ...base,
      Comment: `${base.Comment} Items read via S3 ItemReader (Distributed Map) from the manifest FetchShotsManifest mirrored there — 2026-08-16 fix, see fetch-shots-manifest.ts's header comment. State names suffixed 'S3' — Distributed Map requires state-machine-wide-unique names, unlike a standard Map's Iterator. Mode:'DISTRIBUTED' — confirmed live 2026-08-17 that AWS rejects ItemReader on Mode:'INLINE' at RUNTIME ("ItemReader, ItemBatcher and ResultWriter fields are not supported for INLINE maps" — not caught by cdk synth/deploy, only a real execution surfaces it), so each shot iteration runs as its own child execution of this state machine; requires states:StartExecution/DescribeExecution/StopExecution + iam:PassRole granted directly on E2E-StepFunction-Role (see the inline policy added after this stack's state machines, DialoguePremiumDistributedMapPolicy) — the one deliberate exception to this codebase's usual resource-side-grant-only convention for that shared/externally-managed role, because Distributed Map's self-child-execution permissions have no resource-policy equivalent. ItemSelector + shot./exec-field rewrite added same day (second live finding): child executions don't inherit the parent's $$.Execution.Input.`,
      ItemReader: {
        Resource: 'arn:aws:states:::s3:getObject',
        ReaderConfig: { InputType: 'JSON' },
        Parameters: {
          'Bucket.$': '$.manifestLocation.bucket',
          'Key.$': '$.manifestLocation.key',
        },
      },
      ItemSelector: {
        'shot.$': '$$.Map.Item.Value',
        'aspectRatio.$': '$$.Execution.Input.aspectRatio',
        'projectId.$': '$$.Execution.Input.projectId',
        'textOverlayEnabled.$': '$$.Execution.Input.textOverlayEnabled',
        'userId.$': '$$.Execution.Input.userId',
        'voiceBank.$': '$$.Execution.Input.voiceBank',
      },
      ItemProcessor: {
        ProcessorConfig: { Mode: 'DISTRIBUTED', ExecutionType: 'STANDARD' },
        StartAt: renameMap[iteratorBody.StartAt],
        States: renamedStates,
      },
    };
  }

  return {
    ...base,
    ItemsPath: '$.shots',
    Iterator: iteratorBody,
  };
}

function buildDialoguePremiumQmNewDefinition(opts: {
  qmGenerateArn: string; brokerArn: string; shortsTriggerArn: string; remotionOverlayArn: string;
  concatTrimEcs: ConcatTrimEcsConfig; dialogueMixEcs: DialogueMixEcsConfig;
  buildTurnTracksArn: string; trimClipArn: string; appendTailBeatArn: string;
  buildAmbienceBedSpecsArn: string; fetchShotsManifestArn: string;
}): object {
  const {
    qmGenerateArn, brokerArn, shortsTriggerArn, remotionOverlayArn, concatTrimEcs, dialogueMixEcs,
    buildTurnTracksArn, trimClipArn, appendTailBeatArn, buildAmbienceBedSpecsArn, fetchShotsManifestArn,
  } = opts;

  const def = JSON.parse(JSON.stringify(buildQmNewDefinition(qmGenerateArn, brokerArn, shortsTriggerArn, remotionOverlayArn, '', concatTrimEcs))) as {
    Comment: string;
    States: Record<string, any>;
  };
  def.Comment = 'E2E Video Generation Pipeline - Dialogue-Premium-QM-New — per-shot screenplay (Wan2 action / RunComfy InfiniteTalk monologue+dialogue) via Quartermaster gateway.';

  // Inline shots vs shotsManifestUrl fallback (§7.2 — "cheap now, painful
  // later"). Spliced between CheckValidation and UpdateStatusGeneratingImages.
  def.States.CheckValidation.Choices[0].Next = 'RouteShotsSource';
  def.States.RouteShotsSource = {
    Type: 'Choice',
    Comment: 'shots sent inline (the common case) vs a shotsManifestUrl (R2 JSON URL) for large films approaching the 256KB SFN input limit (§7.2).',
    Choices: [{ Variable: '$.shots', IsPresent: true, Next: 'UpdateStatusGeneratingImages' }],
    Default: 'FetchShotsManifest',
  };
  // Runs after the CheckValidation.Choices[0].Next rewrite just above, so
  // ValidateInput's success branch inherits 'RouteShotsSource' rather than
  // the clone's original 'UpdateStatusGeneratingImages'. Required fields per
  // handoff §7.2 — no top-level narrator/segments/frames on this tier, and
  // 'shots' is satisfied by either the inline array or shotsManifestUrl,
  // same fallback RouteShotsSource itself checks just above.
  overrideDialogueValidateInput(def, ['shotCounts', 'voiceBank'], ['shots', 'shotsManifestUrl']);

  def.States.FetchShotsManifest = {
    Type: 'Task',
    Resource: fetchShotsManifestArn,
    Comment: '2026-08-16: fetches shotsManifestUrl (R2, plain HTTPS GET) and mirrors it into S3 itself — returns only {bucket,key}, never the shots array, so this task\'s own output never risks the 256KB ceiling the array blew past live on a real 132-shot/565KB project (see fetch-shots-manifest.ts header). Downstream reads shots directly off S3 (RouteGenerateShots\' S3 branch) instead of via $.shots.',
    Parameters: { 'shotsManifestUrl.$': '$.shotsManifestUrl', 'projectId.$': '$.projectId', 'jobId.$': '$.jobId' },
    ResultPath: '$.manifestLocation',
    TimeoutSeconds: 60,
    Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'UpdateStatusGeneratingImages',
  };

  def.States.UpdateStatusGeneratingImages.Next = 'RouteGenerateShots';
  def.States.UpdateStatusGeneratingImages.Catch[0].Next = 'RouteGenerateShots';
  def.States.RouteGenerateShots = {
    Type: 'Choice',
    Comment: 'Same fork RouteShotsSource made earlier, re-checked here since UpdateStatusGeneratingImages is shared by both branches (inline shots vs FetchShotsManifest\'s S3 mirror, 2026-08-16 fix).',
    Choices: [{ Variable: '$.shots', IsPresent: true, Next: 'GenerateShots' }],
    Default: 'GenerateShotsFromS3',
  };
  delete def.States.GenerateImages;

  // Same reasoning as buildDialogueBasicQmNewDefinition above: delete the
  // now-unreferenced fourLang/localization scaffolding outright rather than
  // leaving it orphaned, since Step Functions validates every Next/Default
  // reference regardless of reachability.
  for (const deadState of [
    'RouteFrameGeneration', 'GenerateImagesFourLang', 'RouteConcatFourLang',
    'BuildLangVideoArrays', 'ComputeLanguageOmissions', 'ConcatenateVideosFourLang',
    'PrepareTranscribeFourLang', 'TranscribeAudioFourLang', 'BuildMergedVoiceResultFourLangEn',
    'FinalizeLocalizedVideos', 'ConcatenateVideos', 'UploadConcatPayload',
    'ConcatenateVideosTask', 'BuildConcatenatedVideoResult',
  ]) delete def.States[deadState];

  def.States.GenerateShots = dialoguePremiumShotMap({
    qmGenerateArn, remotionOverlayArn, buildTurnTracksArn, trimClipArn, appendTailBeatArn,
  });
  def.States.GenerateShotsFromS3 = dialoguePremiumShotMap({
    qmGenerateArn, remotionOverlayArn, buildTurnTracksArn, trimClipArn, appendTailBeatArn,
    itemSource: 's3',
  });

  def.States.GenerateAmbienceBedSpecs = {
    Type: 'Task',
    Resource: buildAmbienceBedSpecsArn,
    Comment: 'Group shots by sceneNumber into one ambience-bed spec per scene (§7.7) — pure grouping/summing, no ffmpeg; ASL has no group-by/dedup to do this in-line.',
    Parameters: { 'shots.$': '$.shots', 'shotResults.$': '$.shotResults' },
    ResultPath: '$.ambienceBedSpecsResult',
    TimeoutSeconds: 60,
    Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'GenerateAmbienceBeds',
  };
  def.States.GenerateAmbienceBedSpecsFromS3 = {
    Type: 'Task',
    Resource: buildAmbienceBedSpecsArn,
    Comment: '2026-08-16 S3-manifest-path sibling of GenerateAmbienceBedSpecs — passes manifestLocation instead of the full shots array (build-ambience-bed-specs.ts reads shots from S3 itself when shots is absent), same reasoning as GenerateShotsFromS3\'s ItemReader: the full array must never land in execution state for a large film.',
    Parameters: { 'manifestLocation.$': '$.manifestLocation', 'shotResults.$': '$.shotResults' },
    ResultPath: '$.ambienceBedSpecsResult',
    TimeoutSeconds: 60,
    Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'GenerateAmbienceBeds',
  };
  def.States.GenerateAmbienceBeds = {
    Type: 'Map',
    Comment: 'One ACE-Step bed per SCENE (not per shot) — an empty ambienceBedSpecs array (no shot in the project set an ambiencePrompt) just produces zero iterations, no Choice needed.',
    ItemsPath: '$.ambienceBedSpecsResult.ambienceBedSpecs',
    MaxConcurrency: 5,
    ResultPath: '$.ambienceBeds',
    Iterator: {
      StartAt: 'QMGenerateAmbience',
      States: {
        QMGenerateAmbience: {
          Type: 'Task',
          Resource: qmGenerateArn,
          Comment: 'Ambience bed via QM (bgm.dialoguePremium, operation:"ambience" — same physical ACE-Step rung as the project BGM call below, split by operation for attribution). Generated at the scene\'s full length directly — no looping (§7.7.1).',
          Parameters: {
            assetType: 'bgm', tier: 'dialoguePremium', operation: 'ambience', product: 'dialogue',
            queue: 'background', jobType: 'batch',
            'prompt.$': '$.ambiencePrompt',
            'durationS.$': '$.totalDurationSeconds',
            'projectId.$': '$$.Execution.Input.projectId',
            'frameId.$': "States.Format('scene-{}', $.sceneNumber)",
            'userId.$': '$$.Execution.Input.userId',
          },
          ResultPath: '$.ambienceResult',
          TimeoutSeconds: 300,
          Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
          Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ambienceError', Next: 'AmbienceBedFailed' }],
          Next: 'BuildAmbienceBedResult',
        },
        BuildAmbienceBedResult: {
          Type: 'Pass',
          Parameters: { 'sceneNumber.$': '$.sceneNumber', 'audioUrl.$': '$.ambienceResult.cdnUrl' },
          End: true,
        },
        AmbienceBedFailed: {
          Type: 'Pass',
          Comment: 'A missing bed just means that scene\'s silences are unfilled at mix time (§7.7\'s ffmpeg task tolerates a shorter/absent bed) — not worth failing the whole film over.',
          Parameters: { failed: true, 'sceneNumber.$': '$.sceneNumber', audioUrl: '' },
          End: true,
        },
      },
    },
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'RouteBGM',
  };

  Object.assign(def.States, bgmStates(qmGenerateArn, 'dialoguePremium'));
  def.States.QMGenerateBGM.Parameters = {
    assetType: 'bgm', tier: 'dialoguePremium', operation: 'generate', product: 'dialogue',
    queue: 'background', jobType: 'batch',
    'prompt.$': '$.bgmPrompt',
    'segments.$': '$.shotResults',
    'projectId.$': '$.projectId',
    'userId.$': '$.userId',
  };
  // RouteBGM/SkipBgm/QMGenerateBGM/BgmGenerationFailed all still Next to the
  // inherited 'NormalizeFourLang' -> ... -> 'DropFrameData' chain, untouched
  // (same reasoning as Dialogue Basic's builder above).

  // 2026-08-17 fix, found live on the first real non-fourLang execution ever
  // to get this far (163/163 shots + all ambience beds + BGM succeeded,
  // crashed one state later): DropFrameData's allowlist references
  // `$.localizedAssets` unconditionally, same as generateShorts/shortsOptions
  // above it (both already guarded by Normalize*/Set*Default pairs) — but
  // localizedAssets had no such guard. In dialogue-basic/other tiers this is
  // safe because their own SetNoLocalizedAssets (inherited from the shared
  // template, defaults to `{}`) runs BEFORE their DropFrameData. Dialogue
  // Premium's flow is ordered the other way — DropFrameData here runs BEFORE
  // ConcatenateShots/BuildMergedVoiceResult/SetNoLocalizedAssets (see
  // SetNoLocalizedAssets.Next = 'MixAmbienceBeds' below) — so that guarantee
  // never actually holds by the time this DropFrameData runs. Mirrors the
  // exact same Normalize/Default pattern as NormalizeShortsOptionsField
  // immediately above.
  def.States.NormalizeShortsOptionsField.Choices[0].Next = 'NormalizeLocalizedAssets';
  def.States.SetShortsOptionsFieldDefault.Next = 'NormalizeLocalizedAssets';
  def.States.NormalizeLocalizedAssets = {
    Type: 'Choice',
    Comment: 'Guarantee $.localizedAssets is a real value before DropFrameData\'s Parameters allowlist would otherwise silently drop it if fourLang processing never ran (the common case — no real fourLang branch is wired for this tier yet, so this is currently always the path taken).',
    Choices: [{ Variable: '$.localizedAssets', IsPresent: true, Next: 'DropFrameData' }],
    Default: 'SetLocalizedAssetsDefaultBeforeDrop',
  };
  def.States.SetLocalizedAssetsDefaultBeforeDrop = {
    Type: 'Pass',
    Comment: 'Matches SetNoLocalizedAssets\' own {} shape below (StoryStudio\'s existing consumer expects {} not [] for a non-fourLang project) — a distinct state since SetNoLocalizedAssets itself runs later in this tier\'s flow (after concat) and can\'t serve both positions.',
    Result: {},
    ResultPath: '$.localizedAssets',
    Next: 'DropFrameData',
  };

  def.States.DropFrameData = {
    Type: 'Pass',
    Comment: 'Allowlist per §9: shotResults[], bgmResult, ambienceBeds[] — §9 names ambienceBeds as exactly the kind of field this allowlist has silently dropped before (generateShorts/shortsOptions, fourLang).',
    Parameters: {
      'jobId.$': '$.jobId',
      'projectId.$': '$.projectId',
      'projectType.$': '$.projectType',
      'aspectRatio.$': '$.aspectRatio',
      'shotResults.$': '$.shotResults',
      'bgmResult.$': '$.bgmResult',
      'ambienceBeds.$': '$.ambienceBeds',
      'localizedAssets.$': '$.localizedAssets',
      'jwtToken.$': '$.jwtToken',
      'convexEndpoint.$': '$.convexEndpoint',
      'apiKey.$': '$.apiKey',
      'userId.$': '$.userId',
      'admissionId.$': '$.admissionId',
      'generateShorts.$': '$.generateShorts',
      'shortsOptions.$': '$.shortsOptions',
    },
    Next: 'UpdateStatusConcatenating',
  };
  delete def.States.UpdateStatusApplyingBgm.Catch; // reinstated below, retargeted

  def.States.UpdateStatusConcatenating.Next = 'ConcatenateShots';
  def.States.UpdateStatusConcatenating.Catch[0].Next = 'ConcatenateShots';
  // Same latent bug as Dialogue Basic's builder above (see that comment) —
  // this tier's DropFrameData allowlists shotResults, not videoResults, so
  // the inherited Parameters.assets.frames.$ would throw an uncatchable
  // States.Runtime the first time a real premium execution reached here.
  def.States.UpdateStatusConcatenating.Parameters.assets = { 'frames.$': '$.shotResults' };

  Object.assign(def.States, concatChain({
    namePrefix: 'ConcatenateShots', ecs: concatTrimEcs,
    videosPath: '$.shotResults', outputSubpath: 'dialogue-premium/shots-concatenated',
    next: 'TranscribeAudio',
  }));

  def.States.TranscribeAudio = {
    Type: 'Task',
    Resource: qmGenerateArn,
    Comment: 'SRT via QM (srt.dialoguePremium, alias of srt.narration -> self-hosted RunPod Whisper).',
    Parameters: {
      assetType: 'srt', tier: 'dialoguePremium', operation: 'transcribe', product: 'dialogue',
      queue: 'background', jobType: 'batch',
      'audioUrl.$': '$.ConcatenateShotsResult.audioUrl',
      'projectId.$': '$.projectId',
    },
    ResultPath: '$.transcribeResult',
    TimeoutSeconds: 920,
    Retry: [{ ErrorEquals: ['Lambda.ServiceException', 'Lambda.TooManyRequestsException', 'Lambda.SdkClientException'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2.0 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.transcribeError', Next: 'SkipSrt' }],
    Next: 'BuildMergedVoiceResult',
  };
  def.States.BuildMergedVoiceResult.Parameters = {
    'mergedVideoUrl.$': '$.ConcatenateShotsResult.videoUrl',
    'audioUrl.$': '$.ConcatenateShotsResult.audioUrl',
    'srtUrl.$': '$.transcribeResult.cdnUrl',
    'captionsUrl.$': '$.transcribeResult.cdnUrl',
  };
  def.States.SetNoLocalizedAssets.Next = 'MixAmbienceBeds';

  // MixAmbienceBeds — new QM-owned Fargate step (qm-dialogue-mix,
  // mode:"ambience-mix"). Runs BEFORE PrepareFinalizeDialoguePremium so its
  // output can be used as voiceAudioUrl directly, with no post-hoc overwrite.
  def.States.MixAmbienceBeds = {
    Type: 'Pass',
    Comment: 'Build the dialogue-mix container payload (mode:"ambience-mix").',
    Parameters: {
      mode: 'ambience-mix',
      'mainAudioUrl.$': '$.mergedVoiceResult.audioUrl',
      'ambienceBeds.$': '$.ambienceBeds',
      crossfadeSeconds: 0.5,
      ambienceVolume: 0.04,
      'outputKey.$': "States.Format('projects/{}/dialogue-premium/mixed-audio.wav', $.projectId)",
    },
    ResultPath: '$.mixPayload',
    Next: 'UploadMixPayload',
  };
  def.States.UploadMixPayload = {
    Type: 'Task',
    Resource: 'arn:aws:states:::lambda:invoke',
    Comment: 'Same 8192-byte ContainerOverrides workaround as concat-and-trim.',
    Parameters: {
      FunctionName: dialogueMixEcs.uploadPayloadArn,
      Payload: {
        'key.$': "States.Format('projects/{}/payloads/ambience-mix.json', $.projectId)",
        'body.$': 'States.JsonToString($.mixPayload)',
      },
    },
    ResultSelector: { 'key.$': '$.Payload.key' },
    ResultPath: '$.mixPayloadUpload',
    TimeoutSeconds: 60,
    Retry: [{ ErrorEquals: ['States.ALL'], IntervalSeconds: 5, MaxAttempts: 2, BackoffRate: 2 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'MixAmbienceBedsTask',
  };
  def.States.MixAmbienceBedsTask = {
    Type: 'Task',
    Resource: 'arn:aws:states:::ecs:runTask.sync',
    Comment: 'Ambience-bed mix via QM\'s own Fargate task (qm-dialogue-mix). Output becomes voiceAudioUrl at finalize — e2e-finalize\'s existing BGM overlay/duck then layers project BGM on top of it unchanged (§7.7).',
    Parameters: {
      Cluster: dialogueMixEcs.clusterArn,
      TaskDefinition: dialogueMixEcs.taskDefinitionArn,
      LaunchType: 'FARGATE',
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          Subnets: dialogueMixEcs.subnetIds,
          SecurityGroups: [dialogueMixEcs.securityGroupId],
          AssignPublicIp: 'ENABLED',
        },
      },
      Overrides: {
        ContainerOverrides: [{
          Name: dialogueMixEcs.containerName,
          Environment: [{ Name: 'PAYLOAD_S3_KEY', 'Value.$': '$.mixPayloadUpload.key' }],
        }],
      },
    },
    ResultPath: '$.mixEcs',
    TimeoutSeconds: 1800,
    Retry: [{ ErrorEquals: ['States.TaskFailed', 'States.Timeout'], IntervalSeconds: 30, MaxAttempts: 1, BackoffRate: 2 }],
    Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.error', Next: 'HandleFailure' }],
    Next: 'BuildMixedAudioResult',
  };
  def.States.BuildMixedAudioResult = {
    Type: 'Pass',
    Comment: 'Deterministic URL — the ECS task writes to exactly this key.',
    Parameters: {
      'cdnUrl.$': `States.Format('https://${dialogueMixEcs.outputBucket}.s3.us-east-1.amazonaws.com/projects/{}/dialogue-premium/mixed-audio.wav', $.projectId)`,
    },
    ResultPath: '$.mixedAudioResult',
    Next: 'UpdateStatusApplyingBgm',
  };

  def.States.UpdateStatusApplyingBgm.Next = 'ValidateFinalizeInputsDialoguePremium';
  def.States.UpdateStatusApplyingBgm.Catch = [
    { ErrorEquals: ['States.ALL'], ResultPath: '$.statusError', Next: 'FinalizeVideoDialoguePremium' },
  ];
  def.States.UpdateStatusApplyingBgm.Parameters.assets = {
    'mergedVideoUrl.$': '$.mergedVoiceResult.mergedVideoUrl',
    'shots.$': '$.shotResults',
    'localizedAssets.$': '$.localizedAssets',
  };

  def.States.ValidateFinalizeInputsDialoguePremium = {
    Type: 'Choice',
    Comment: 'Verify required fields exist AND are non-empty before finalize (qm-concat-trim-ecs-migration memory).',
    Choices: [{
      And: [
        { Variable: '$.mergedVoiceResult.mergedVideoUrl', IsPresent: true },
        { Not: { Variable: '$.mergedVoiceResult.mergedVideoUrl', StringEquals: '' } },
      ],
      Next: 'PrepareFinalizeDialoguePremium',
    }],
    Default: 'FinalizeInputsMissingDialoguePremium',
  };
  delete def.States.ValidateFinalizeInputsBasic;

  def.States.FinalizeInputsMissingDialoguePremium = {
    Type: 'Fail', Error: 'FinalizeInputsMissing', Cause: 'Required finalize input(s) missing: $.mergedVoiceResult.mergedVideoUrl',
  };
  delete def.States.FinalizeInputsMissingBasic;

  def.States.PrepareFinalizeDialoguePremium = {
    Type: 'Pass',
    Comment: 'Prepare a small payload for the Fargate finalize task. targetResolution upscale is MANDATORY — RunComfy\'s fixed 624x352 output is a resolution floor below even Wan2\'s 480p (§7.6.4).',
    Parameters: {
      mode: 'premium',
      'jobId.$': '$.jobId',
      'projectId.$': '$.projectId',
      'projectType.$': '$.projectType',
      'aspectRatio.$': '$.aspectRatio',
      'videoUrl.$': '$.mergedVoiceResult.mergedVideoUrl',
      'voiceAudioUrl.$': '$.mixedAudioResult.cdnUrl',
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

  def.States.FinalizeVideoDialoguePremium = {
    Type: 'Task',
    Resource: 'arn:aws:states:::ecs:runTask.sync',
    Comment: 'Finalize on Fargate (unmodified e2e-finalize): 480p->1080p upscale + captions + BGM overlay/duck (over the ambience-mixed voice track).',
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

  Object.assign(def.States, shortsTriggerStates(shortsTriggerArn, 'FinalizeVideoDialoguePremium'));

  return def;
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
        Comment: 'Verify required fields exist AND are non-empty before finalize; fail fast rather than launching a doomed Fargate finalize against an empty videoUrl. Non-empty check matters for fourLang\'s English branch (BuildMergedVoiceResultFourLangEn): IsPresent alone is true even when concat/trim failed and left mergedVideoUrl as \'\' (the key is always present, just empty) — see qm-concat-trim-ecs-migration memory.',
        Choices: [{
          And: [
            { Variable: '$.mergedVoiceResult.mergedVideoUrl', IsPresent: true },
            { Not: { Variable: '$.mergedVoiceResult.mergedVideoUrl', StringEquals: '' } },
          ],
          Next: 'PrepareFinalizeBasic',
        }],
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
