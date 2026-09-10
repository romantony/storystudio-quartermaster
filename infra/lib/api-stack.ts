import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy, Size } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';

interface ApiStackProps extends StackProps {
  table: dynamodb.Table;
  gatewayKeySecretArn: string;
  jwtSecretArn: string;
  adminPasswordHashSecretArn: string;
  replicateKeySecretArn: string;
  kieKeySecretArn: string;
  runpodKeySecretArn: string;
  anthropicKeySecretArn: string;
  /** RunComfy InfiniteTalk (Dialogue Basic/Premium — adapters/runcomfy.ts).
   * Plumbing only as of this stack revision: wired the same way as every
   * other provider secret below, but no real secret has been created/
   * populated yet — ctx()'s placeholder fallback keeps `cdk synth` working
   * until one is. */
  runcomfyKeySecretArn: string;
  s3CacheBucket: string;
  webhookBaseUrl: string;
  /**
   * Capacity manager go-live switch (§WS-C3). When true, provisioner.ts PATCHes
   * RunPod's worker counts for real; when false/omitted, it only writes the
   * PROVISION_SHADOW audit trail. Defaults OFF — flip explicitly via
   * `cdk deploy --context RUNPOD_PROVISION_LIVE=true` once the shadow log is
   * trusted, so going live is one documented deploy-time flag, not a code change.
   */
  runpodProvisionLive?: boolean;
}

export class ApiStack extends Stack {
  public readonly apiFunction: nodejs.NodejsFunction;
  public readonly executorFunction: nodejs.NodejsFunction;
  public readonly distribution: cloudfront.Distribution;
  /** Public/permanent storage for re-hosted external-provider assets
   * (persistExternalAsset.ts) — reuses the same bucket QM-merge already
   * writes finished media to, exposed here so WebhookStack (a separate
   * stack, where external providers' webhook completions actually land)
   * can grant itself write access too. */
  public readonly externalAssetBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const providerSecretArns = [
      props.replicateKeySecretArn,
      props.kieKeySecretArn,
      props.runpodKeySecretArn,
      props.anthropicKeySecretArn,
      props.runcomfyKeySecretArn,
    ];
    const providerSecretEnv = {
      REPLICATE_API_TOKEN_ARN: props.replicateKeySecretArn,
      KIE_AI_API_KEY_ARN: props.kieKeySecretArn,
      RUNPOD_API_KEY_ARN: props.runpodKeySecretArn,
      ANTHROPIC_API_KEY_ARN: props.anthropicKeySecretArn,
      RUNCOMFY_API_KEY_ARN: props.runcomfyKeySecretArn,
    };

    // ── Executor: execute-with-failover loop. Longer timeout for RunPod cold
    //    starts (2.5–4 min) AND real queue wait when a burst of concurrent jobs
    //    (e.g. a Map wave) exceeds an endpoint's actual pod count — confirmed
    //    live 2026-07-04: Wan2 i2v genuinely completed on RunPod, but executor's
    //    pollInline (budget = Lambda's own getRemainingTimeInMillis(), see
    //    POLL_BUFFER_MS in executor.ts) gave up at the old 300s ceiling first,
    //    discarding a real success and cascading to an overwhelmed external
    //    fallback. Invoked asynchronously by the API Lambda.
    this.executorFunction = new nodejs.NodejsFunction(this, 'ExecutorFunction', {
      functionName: 'quartermaster-executor',
      entry: path.join(__dirname, '../../src/handlers/executor.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // Raised 600s→890s (2026-07-11) to match QM-generate's own ceiling
      // (pipeline-stack.ts) — confirmed live same day: a pt-BR ttsLocalizedQwen
      // job against the shared 6-worker rnqxi6c0mlq517 endpoint burned the full
      // 600s window mid-poll (588.8s billed) and was declared FAILED while
      // RunPod itself never reported an error, just hadn't finished. 890s (10s
      // under Lambda's hard 900s ceiling, same margin QM-generate uses) gives
      // pollInline's remaining()>POLL_BUFFER_MS loop (executor.ts) much more
      // runway before giving up on a slow-but-still-working generation.
      timeout: Duration.seconds(890),
      memorySize: 512,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        TABLE_NAME: props.table.tableName,
        WEBHOOK_BASE_URL: props.webhookBaseUrl,
        GATEWAY_STATIC_KEY_ARN: props.gatewayKeySecretArn,
        ...providerSecretEnv,
      },
    });
    props.table.grantReadWriteData(this.executorFunction);
    // getGatewayKey() (executor.ts) embeds this as the webhook callbackUrl's
    // `?key=` param — webhook.ts's coarse gate checks it there instead of a
    // header no provider can be told to send (fixes the live 2026-08-09
    // "every RunPod callback 401s" gap — see storystudio-reply-dialogue-
    // validate-input-gap.md's sibling investigation).
    this.executorFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.gatewayKeySecretArn],
    }));
    this.executorFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: providerSecretArns,
    }));
    // The executor self-invokes to pull the next QUEUED job for an endpoint the
    // moment a worker slot frees (dispatchNextForEndpoint) — feed the pod at
    // worker rate rather than waiting for the 2-min sweeper. Grant self-invoke
    // via the static ARN (the function name is fixed) rather than
    // grantInvoke(self), which wires a CloudFormation circular dependency.
    this.executorFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:quartermaster-executor`],
    }));

    // ── QM-merge: audio+video mux, moved off the RunPod GPU pod (2026-07-27)
    // ──────────────────────────────────────────────────────────────────────
    // video.narrationBasic.merge (background.json) is pure ffmpeg muxing, no
    // model inference — it only ever ran on flux-tts-s2t's 6 workers for
    // convenience, competing there with image/TTS/animate (merge x4-per-frame
    // in the fourLang per-frame flow was one of the two biggest concurrent
    // fan-outs against that pool, a real contributor to real execution
    // timeouts, see qm-4lang-fullvideo-perframe memory). Invoked directly by
    // executorFunction (adapters/lambdamerge.ts's `lambda:<fn>` pseudo-URL,
    // recognized by executor.ts's submit()) rather than through the
    // catalog's usual HTTP-fetch path — a same-account Lambda has no HTTP
    // endpoint of its own to hit. Also finally fixes the long-flagged
    // silence-padding gap (Bug #6): RunPod's merge hardcoded ffmpeg's
    // `-shortest` (always trims to the shorter of video/audio); this pads a
    // shorter language's audio to the frame's shared max-duration instead,
    // via ffmpeg's `apad=whole_dur` — see handlers/merge.ts's header comment.
    const mergeOutputBucket = new s3.Bucket(this, 'MergeOutputBucket', {
      bucketName: 'qm-merge-output',
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.externalAssetBucket = mergeOutputBucket;
    // 2026-08-17: persistExternalAsset.ts re-hosts external providers'
    // ephemeral delivery URLs (replicate.delivery/RunComfy/KIE — see that
    // file's header) onto this bucket before a job is ever marked COMPLETE.
    // Reached from executor.ts's own sync-completion path (this function)
    // directly, so it needs the grant/env var here too — WebhookStack (the
    // other call site, for async provider callbacks) grants itself
    // separately via the externalAssetBucket reference exported above.
    mergeOutputBucket.grantPut(this.executorFunction);
    this.executorFunction.addEnvironment('EXTERNAL_ASSET_BUCKET', mergeOutputBucket.bucketName);

    const mergeFunction = new nodejs.NodejsFunction(this, 'MergeFunction', {
      functionName: 'QM-merge',
      entry: path.join(__dirname, '../../src/handlers/merge.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(120),
      memorySize: 1024,
      ephemeralStorageSize: Size.mebibytes(1024),
      bundling: { minify: true, sourceMap: false, externalModules: [], nodeModules: ['@ffmpeg-installer/ffmpeg'] },
      environment: {
        OUTPUT_BUCKET: mergeOutputBucket.bucketName,
      },
    });
    mergeOutputBucket.grantPut(mergeFunction);
    mergeFunction.grantInvoke(this.executorFunction);

    this.apiFunction = new nodejs.NodejsFunction(this, 'ApiFunction', {
      functionName: 'quartermaster-api',
      entry: path.join(__dirname, '../../src/handlers/api.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(29),
      memorySize: 512,
      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: [],
      },
      environment: {
        TABLE_NAME: props.table.tableName,
        GATEWAY_STATIC_KEY_ARN: props.gatewayKeySecretArn,
        JWT_SECRET_ARN: props.jwtSecretArn,
        ADMIN_PASSWORD_HASH_ARN: props.adminPasswordHashSecretArn,
        REPLICATE_API_TOKEN_ARN: props.replicateKeySecretArn,
        KIE_AI_API_KEY_ARN: props.kieKeySecretArn,
        RUNPOD_API_KEY_ARN: props.runpodKeySecretArn,
        ANTHROPIC_API_KEY_ARN: props.anthropicKeySecretArn,
        S3_CACHE_BUCKET: props.s3CacheBucket,
        SAFE_LIMIT: '15',
        VIDEO_FLOOR: '8',
        REST_FLOOR: '7',
        MAX_ATTEMPTS: '5',
        EXECUTOR_FUNCTION_NAME: this.executorFunction.functionName,
        RUNPOD_PROVISION_LIVE: props.runpodProvisionLive ? 'true' : 'false',
      },
    });

    props.table.grantReadWriteData(this.apiFunction);
    // API Lambda dispatches jobs to the executor asynchronously.
    this.executorFunction.grantInvoke(this.apiFunction);

    this.apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        props.gatewayKeySecretArn,
        props.jwtSecretArn,
        props.adminPasswordHashSecretArn,
        props.replicateKeySecretArn,
        props.kieKeySecretArn,
        props.runpodKeySecretArn,
        props.anthropicKeySecretArn,
      ],
    }));

    // NONE auth: application-level auth (x-gateway-key header + JWT cookies) is the security boundary.
    // IAM/OAC was causing InvalidSignatureException on POST requests due to SigV4 body-hash issues.
    const fnUrl = this.apiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['*'],
      },
    });

    const apiOrigin = new origins.FunctionUrlOrigin(fnUrl);

    this.distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      comment: 'Quartermaster API',
      defaultBehavior: {
        origin: apiOrigin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    // CloudWatch alarms
    //
    // NOTE: a `HighInflightAlarm` used to live here, watching
    // `Quartermaster/modelslab_inflight` against a threshold of 12. Nothing in
    // the codebase has ever called PutMetricData, so that metric was never
    // emitted and the alarm sat in INSUFFICIENT_DATA for its whole life.
    // Removed rather than left as false assurance. The lane semaphore's
    // ceiling (SAFE_LIMIT=15, dynamo-gate.ts) is therefore UNMONITORED — to
    // restore real coverage, emit the counter's total_inflight from the
    // sweeper and re-add an alarm against that.

    new cloudwatch.Alarm(this, 'HighDeadRateAlarm', {
      alarmName: 'quartermaster-high-dead-rate',
      metric: new cloudwatch.Metric({
        namespace: 'Quartermaster',
        metricName: 'dead_rate',
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    new CfnOutput(this, 'ApiDistributionDomain', { value: this.distribution.distributionDomainName });
    new CfnOutput(this, 'ApiFunctionArn', { value: this.apiFunction.functionArn });
  }
}
