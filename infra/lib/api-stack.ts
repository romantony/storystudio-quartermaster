import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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
  s3CacheBucket: string;
}

export class ApiStack extends Stack {
  public readonly apiFunction: nodejs.NodejsFunction;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

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
        S3_CACHE_BUCKET: props.s3CacheBucket,
        SAFE_LIMIT: '15',
        VIDEO_FLOOR: '8',
        REST_FLOOR: '7',
        MAX_ATTEMPTS: '5',
      },
    });

    props.table.grantReadWriteData(this.apiFunction);

    const secretArns = [
      props.gatewayKeySecretArn,
      props.jwtSecretArn,
      props.adminPasswordHashSecretArn,
      props.modeslabKeySecretArn,
      props.replicateKeySecretArn,
      props.kieKeySecretArn,
      props.runpodKeySecretArn,
    ];
    secretArns.forEach((arn, i) => {
      secretsmanager.Secret.fromSecretPartialArn(this, `SecretRef${i}`, arn)
        .grantRead(this.apiFunction);
    });

    const fnUrl = this.apiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['*'],
      },
    });

    const oac = new cloudfront.CfnOriginAccessControl(this, 'ApiOAC', {
      originAccessControlConfig: {
        name: 'quartermaster-api-oac',
        originAccessControlOriginType: 'lambda',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    const waf = new wafv2.CfnWebACL(this, 'ApiWAF', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      rules: [
        {
          name: 'RateLimit',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 1000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'QMApiRateLimit',
            sampledRequestsEnabled: true,
          },
        },
      ],
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'QMApiWAF',
        sampledRequestsEnabled: false,
      },
    });

    const apiOrigin = new origins.FunctionUrlOrigin(fnUrl);

    this.distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      comment: 'Quartermaster API',
      webAclId: waf.attrArn,
      defaultBehavior: {
        origin: apiOrigin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    // Allow CloudFront to invoke the Lambda URL via OAC
    this.apiFunction.addPermission('CloudFrontInvoke', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunctionUrl',
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${this.distribution.distributionId}`,
    });

    // Attach OAC to origin (L1 escape hatch — CDK doesn't have L2 support for Lambda OAC yet)
    const cfnDistribution = this.distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', oac.attrId);
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.CustomOriginConfig.OriginSSLProtocols', ['TLSv1.2']);

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
