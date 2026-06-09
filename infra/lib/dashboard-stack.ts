import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as path from 'path';

const DOMAIN = 'quartermaster.ai-storystudio.com';
const ZONE_NAME = 'ai-storystudio.com';
const ZONE_ID = 'Z0979315393R4P99R1E74';

interface DashboardStackProps extends StackProps {
  apiDistributionDomain: string;
}

export class DashboardStack extends Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: ZONE_ID,
      zoneName: ZONE_NAME,
    });

    const cert = new acm.Certificate(this, 'DashboardCert', {
      domainName: DOMAIN,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const bucket = new s3.Bucket(this, 'AdminSpaBucket', {
      bucketName: `quartermaster-admin-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const oac = new cloudfront.CfnOriginAccessControl(this, 'DashboardOAC', {
      originAccessControlConfig: {
        name: 'quartermaster-dashboard-oac',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    const distribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
      comment: 'Quartermaster Admin Dashboard',
      defaultRootObject: 'index.html',
      domainNames: [DOMAIN],
      certificate: cert,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    bucket.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [bucket.arnForObjects('*')],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        },
      },
    }));

    const cfnDist = distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDist.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', oac.attrId);
    cfnDist.addPropertyOverride('DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity', '');

    // Proxy /api/* to the API CloudFront distribution so all requests stay
    // same-origin (quartermaster.ai-storystudio.com), which is required for
    // SameSite=Strict JWT cookies to be forwarded back on each request.
    const apiProxyOrigin = new origins.HttpOrigin(props.apiDistributionDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    const passthrough = cloudfront.CachePolicy.CACHING_DISABLED;
    const allHeaders = cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;

    for (const pattern of ['/api/*', '/jobs*', '/acquire', '/release', '/heartbeat', '/sweeper']) {
      distribution.addBehavior(pattern, apiProxyOrigin, {
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: passthrough,
        originRequestPolicy: allHeaders,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      });
    }

    new route53.ARecord(this, 'DashboardAlias', {
      zone,
      recordName: 'quartermaster',
      target: route53.RecordTarget.fromAlias(new route53Targets.CloudFrontTarget(distribution)),
    });

    new s3deploy.BucketDeployment(this, 'DeployAdmin', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../admin/dist'))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new CfnOutput(this, 'DashboardUrl', { value: `https://${DOMAIN}` });
    new CfnOutput(this, 'DashboardBucketName', { value: bucket.bucketName });
  }
}
