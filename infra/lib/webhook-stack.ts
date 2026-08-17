import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

import * as path from 'path';

interface WebhookStackProps extends StackProps {
  table: dynamodb.Table;
  gatewayKeySecretArn: string;
  kieWebhookSecretArn: string;
  replicateWebhookSecretArn: string;
  executorFunction: lambda.IFunction;
  /** persistExternalAsset.ts's re-host target — external providers'
   * (replicate/runcomfy/kie) async webhook completions land here, so this
   * function needs its own write grant (ApiStack's own executorFunction
   * grant, in the OTHER stack, only covers executor.ts's sync-completion
   * call site). */
  externalAssetBucket: s3.Bucket;
}

export class WebhookStack extends Stack {
  constructor(scope: Construct, id: string, props: WebhookStackProps) {
    super(scope, id, props);

    const webhookFn = new nodejs.NodejsFunction(this, 'WebhookFunction', {
      functionName: 'quartermaster-webhook',
      entry: path.join(__dirname, '../../src/handlers/webhook.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // Raised 10s->60s (2026-08-17): persistExternalAsset.ts now downloads
      // an external provider's asset and re-uploads it to S3 synchronously,
      // inline in this handler, before acking the webhook — 10s was never
      // enough headroom for a real video file. See that file's header for
      // why this happens here rather than async: it must complete before the
      // job is marked COMPLETE, or the whole point (never storing an
      // ephemeral URL as the permanent one) is lost.
      timeout: Duration.seconds(60),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: false,
        externalModules: [],
      },
      environment: {
        TABLE_NAME: props.table.tableName,
        GATEWAY_STATIC_KEY_ARN: props.gatewayKeySecretArn,
        KIE_WEBHOOK_SECRET_ARN: props.kieWebhookSecretArn,
        REPLICATE_WEBHOOK_SECRET_ARN: props.replicateWebhookSecretArn,
        EXECUTOR_FUNCTION_NAME: props.executorFunction.functionName,
        EXTERNAL_ASSET_BUCKET: props.externalAssetBucket.bucketName,
      },
    });

    props.table.grantReadWriteData(webhookFn);
    // On provider failure the webhook re-dispatches the executor to fail over.
    props.executorFunction.grantInvoke(webhookFn);
    props.externalAssetBucket.grantPut(webhookFn);

    webhookFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        props.gatewayKeySecretArn,
        props.kieWebhookSecretArn,
        props.replicateWebhookSecretArn,
      ],
    }));

    // Allow sending SFN task tokens (Phase 2 stub)
    webhookFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
      resources: ['*'],
    }));

    const fnUrl = webhookFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    const webhookOrigin = new origins.FunctionUrlOrigin(fnUrl);

    const webhookDistribution = new cloudfront.Distribution(this, 'WebhookDistribution', {
      comment: 'Quartermaster Webhooks',
      defaultBehavior: {
        origin: webhookOrigin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    new CfnOutput(this, 'WebhookDistributionDomain', { value: webhookDistribution.distributionDomainName });
    new CfnOutput(this, 'WebhookFunctionArn', { value: webhookFn.functionArn });
  }
}
