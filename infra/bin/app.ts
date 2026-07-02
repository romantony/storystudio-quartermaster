#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/database-stack';
import { ApiStack } from '../lib/api-stack';
import { WebhookStack } from '../lib/webhook-stack';
import { SchedulerStack } from '../lib/scheduler-stack';
import { DashboardStack } from '../lib/dashboard-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Resolve ARNs from CDK context (--context KEY=arn:...) or environment variables.
// Falls back to a placeholder so `cdk synth` works without real credentials.
// Deployment requires real ARNs to be supplied.
function ctx(key: string): string {
  return app.node.tryGetContext(key) ?? process.env[key] ?? `arn:aws:secretsmanager:us-east-1:000000000000:secret:${key}-placeholder`;
}

// --- Database ---
const dbStack = new DatabaseStack(app, 'QMDatabaseStack', { env });

// --- API Lambda + CloudFront ---
const apiStack = new ApiStack(app, 'QMApiStack', {
  env,
  table: dbStack.table,
  gatewayKeySecretArn: ctx('GATEWAY_STATIC_KEY_ARN'),
  jwtSecretArn: ctx('JWT_SECRET_ARN'),
  adminPasswordHashSecretArn: ctx('ADMIN_PASSWORD_HASH_ARN'),
  modeslabKeySecretArn: ctx('MODELSLAB_API_KEY_ARN'),
  replicateKeySecretArn: ctx('REPLICATE_API_TOKEN_ARN'),
  kieKeySecretArn: ctx('KIE_AI_API_KEY_ARN'),
  runpodKeySecretArn: ctx('RUNPOD_API_KEY_ARN'),
  s3CacheBucket: app.node.tryGetContext('S3_CACHE_BUCKET') ?? process.env['S3_CACHE_BUCKET'] ?? '',
  // Base URL external providers call back to (set after the webhook stack's
  // first deploy, or a custom domain). Empty is fine for internal-only flows.
  webhookBaseUrl: app.node.tryGetContext('WEBHOOK_BASE_URL') ?? process.env['WEBHOOK_BASE_URL'] ?? '',
});
apiStack.addDependency(dbStack);

// --- Webhook Lambda + CloudFront ---
const webhookStack = new WebhookStack(app, 'QMWebhookStack', {
  env,
  table: dbStack.table,
  gatewayKeySecretArn: ctx('GATEWAY_STATIC_KEY_ARN'),
  kieWebhookSecretArn: ctx('KIE_WEBHOOK_SECRET_ARN'),
  replicateWebhookSecretArn: ctx('REPLICATE_WEBHOOK_SECRET_ARN'),
  executorFunction: apiStack.executorFunction,
});
webhookStack.addDependency(dbStack);
webhookStack.addDependency(apiStack);

// --- EventBridge Scheduler → /sweeper every 2 min ---
const schedulerStack = new SchedulerStack(app, 'QMSchedulerStack', {
  env,
  apiFunction: apiStack.apiFunction,
  apiBaseUrl: `https://${apiStack.distribution.distributionDomainName}`,
});
schedulerStack.addDependency(apiStack);

// --- Admin SPA (S3 + CloudFront) ---
const dashboardStack = new DashboardStack(app, 'QMDashboardStack', {
  env,
  apiDistributionDomain: apiStack.distribution.distributionDomainName,
});
dashboardStack.addDependency(apiStack);

// --- QM-broker-call Lambda + E2E-VideoGenerationPipeline-Basic-QM Step Function ---
const pipelineStack = new PipelineStack(app, 'QMPipelineStack', {
  env,
  gatewayKeySecretArn: ctx('GATEWAY_STATIC_KEY_ARN'),
  qmApiDomain: apiStack.distribution.distributionDomainName,
});
pipelineStack.addDependency(apiStack);

app.synth();
