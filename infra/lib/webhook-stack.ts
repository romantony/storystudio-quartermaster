import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

import * as path from 'path';

interface WebhookStackProps extends StackProps {
  table: dynamodb.Table;
  gatewayKeySecretArn: string;
  kieWebhookSecretArn: string;
  replicateWebhookSecretArn: string;
}

export class WebhookStack extends Stack {
  constructor(scope: Construct, id: string, props: WebhookStackProps) {
    super(scope, id, props);

    const webhookFn = new nodejs.NodejsFunction(this, 'WebhookFunction', {
      functionName: 'quartermaster-webhook',
      entry: path.join(__dirname, '../../src/handlers/webhook.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
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
      },
    });

    props.table.grantReadWriteData(webhookFn);

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
