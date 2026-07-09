import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
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
  modeslabKeySecretArn: string;
  replicateKeySecretArn: string;
  kieKeySecretArn: string;
  runpodKeySecretArn: string;
  anthropicKeySecretArn: string;
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

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const providerSecretArns = [
      props.modeslabKeySecretArn,
      props.replicateKeySecretArn,
      props.kieKeySecretArn,
      props.runpodKeySecretArn,
      props.anthropicKeySecretArn,
    ];
    const providerSecretEnv = {
      MODELSLAB_API_KEY_ARN: props.modeslabKeySecretArn,
      REPLICATE_API_TOKEN_ARN: props.replicateKeySecretArn,
      KIE_AI_API_KEY_ARN: props.kieKeySecretArn,
      RUNPOD_API_KEY_ARN: props.runpodKeySecretArn,
      ANTHROPIC_API_KEY_ARN: props.anthropicKeySecretArn,
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
      timeout: Duration.seconds(600),
      memorySize: 512,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: {
        TABLE_NAME: props.table.tableName,
        WEBHOOK_BASE_URL: props.webhookBaseUrl,
        ...providerSecretEnv,
      },
    });
    props.table.grantReadWriteData(this.executorFunction);
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
        MODELSLAB_API_KEY_ARN: props.modeslabKeySecretArn,
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
        props.modeslabKeySecretArn,
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
    new cloudwatch.Alarm(this, 'HighInflightAlarm', {
      alarmName: 'quartermaster-high-inflight',
      metric: new cloudwatch.Metric({
        namespace: 'Quartermaster',
        metricName: 'modelslab_inflight',
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 12,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

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
