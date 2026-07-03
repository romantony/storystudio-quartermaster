import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';

interface SchedulerStackProps extends StackProps {
  apiFunction: nodejs.NodejsFunction;
  apiBaseUrl: string;
  /**
   * Same secret api.ts checks on every request (`x-gateway-key`). The
   * scheduler's Target.Input is a static payload with no way to attach a
   * per-invocation header dynamically, so the resolved plaintext value is
   * embedded directly in the synthesized template at deploy time via
   * `unsafeUnwrap()` — this is the accepted tradeoff (see commit message):
   * the gateway key becomes visible to anyone with read access to the
   * CloudFormation template/stack, in exchange for not special-casing
   * `/sweeper`'s auth in api.ts. Without this, EventBridge always sends
   * `headers: {}`, so the request 401s before ever reaching handleSweeper()
   * — confirmed in production: zero RUNPODENDPOINT items and zero
   * `[sweeper]`/`[provisioner]` log lines ever, despite firing every 2 min
   * since 2026-06-09.
   */
  gatewayKeySecretArn: string;
}

export class SchedulerStack extends Stack {
  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    schedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [props.apiFunction.functionArn],
    }));

    const gatewayKey = secretsmanager.Secret
      .fromSecretCompleteArn(this, 'GatewayKeySecret', props.gatewayKeySecretArn)
      .secretValue.unsafeUnwrap();

    // POST /sweeper every 2 minutes — reclaimExpired() finds PROCESSING jobs past leaseExpiry
    new scheduler.CfnSchedule(this, 'SweeperSchedule', {
      name: 'quartermaster-sweeper',
      scheduleExpression: 'rate(2 minutes)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.apiFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({
          rawPath: '/sweeper',
          requestContext: { http: { method: 'POST', path: '/sweeper' } },
          headers: { 'x-gateway-key': gatewayKey },
          body: '{}',
          isBase64Encoded: false,
        }),
      },
    });
  }
}
