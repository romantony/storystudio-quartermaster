import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';

interface SchedulerStackProps extends StackProps {
  apiFunction: nodejs.NodejsFunction;
  apiBaseUrl: string;
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
          headers: {},
          body: '{}',
          isBase64Encoded: false,
        }),
      },
    });
  }
}
