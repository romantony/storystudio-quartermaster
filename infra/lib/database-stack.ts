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
      timeToLiveAttribute: 'ttl',
    });

    // GSI for FIFO queue: query by lane, sorted by enqueueSeq
    this.table.addGlobalSecondaryIndex({
      indexName: 'queue-index',
      partitionKey: { name: 'lane', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'enqueueSeq', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Sparse GSI over LEASE# items only (every lease has sk:'LEASE' + leaseExpiry;
    // no other item type sets both). Replaces the full-table Scans in
    // reclaimExpiredLeases()/reconcileCounter() with a targeted Query — those Scans
    // were billed for every item in the table, not just the handful of live leases,
    // and ran every 2 minutes via the sweeper regardless of actual traffic.
    this.table.addGlobalSecondaryIndex({
      indexName: 'lease-index',
      partitionKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'leaseExpiry', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Sparse GSI over ReservationItem (RESERVATION#*) records only — sk:'META' +
    // status is only ever set together on those; the RESERVATIONREQ# pointer items
    // share sk:'META' but never have `status`, so they're naturally excluded.
    // Replaces the full-table Scan in listActiveReservations().
    this.table.addGlobalSecondaryIndex({
      indexName: 'reservation-status-index',
      partitionKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Seed COUNTER#modelslab — semaphore item with zero inflight counters.
    // DynamoDB TTL cannot decrement counters itself, so the sweeper still does the
    // real-time reclaim; the `ttl` set on LeaseItem (dynamo-gate.ts) is only a
    // backstop so leases the sweeper already marked `deleted` don't pile up forever.
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
