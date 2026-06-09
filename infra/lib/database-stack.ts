import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cr from 'aws-cdk-lib/custom-resources';

export class DatabaseStack extends Stack {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.table = new dynamodb.Table(this, 'JobsTable', {
      tableName: 'quartermaster-jobs',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // GSI for FIFO queue: query by lane, sorted by enqueueSeq
    this.table.addGlobalSecondaryIndex({
      indexName: 'queue-index',
      partitionKey: { name: 'lane', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'enqueueSeq', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Seed COUNTER#modelslab — semaphore item with zero inflight counters.
    // DynamoDB TTL cannot decrement counters, so no TTL on leases; sweeper handles reclaim.
    new cr.AwsCustomResource(this, 'SeedCounter', {
      onCreate: {
        service: 'DynamoDB',
        action: 'putItem',
        parameters: {
          TableName: this.table.tableName,
          Item: {
            pk: { S: 'COUNTER#modelslab' },
            sk: { S: 'SEMAPHORE' },
            video_inflight: { N: '0' },
            rest_inflight: { N: '0' },
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
        physicalResourceId: cr.PhysicalResourceId.of('SeedCounter'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.table.tableArn] }),
    });

    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'TableArn', { value: this.table.tableArn });
  }
}
