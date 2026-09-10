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

    // GSI for FIFO queue: query by lane, sorted by enqueueSeq.
    // NOT sparse — every JobItem keeps `lane`+`enqueueSeq` forever, so this
    // index has grown to contain the entire job history (42,845 items vs a
    // handful actually QUEUED at any moment) instead of just the live queue.
    // Every reader (queue-status-index below) has been repointed off this
    // index; kept only so nothing else breaks mid-migration. Safe to delete
    // in a follow-up once queue-status-index is confirmed load-bearing in prod.
    this.table.addGlobalSecondaryIndex({
      indexName: 'queue-index',
      partitionKey: { name: 'lane', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'enqueueSeq', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Sparse GSI over the live queue only: `queueLane` is set at job creation
    // (skipped entirely for lane:'none') and REMOVEd the moment a job leaves
    // QUEUED (claimed, inline-admitted, completed, failed, or reclaimed as
    // DEAD) — re-SET if it's ever requeued (capacity wait, lease-expiry
    // reclaim). Replaces the unbounded full-partition Query pagination against
    // `queue-index` (KeyConditionExpression only bound lane, so every reader
    // paged through the entire lane's history filtering for status:QUEUED)
    // that was still the dominant DynamoDB cost driver as of 2026-08-23,
    // months after that Scan-vs-Query fix. See qm-dynamodb-cost-fix memory.
    this.table.addGlobalSecondaryIndex({
      indexName: 'queue-status-index',
      partitionKey: { name: 'queueLane', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'enqueueSeq', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Sparse GSI over inline-admitted PROCESSING jobs holding a modelslab lease:
    // `leaseLane` mirrors `lane`, set alongside leaseId/leaseExpiry by inlineAdmit()
    // and REMOVEd the moment the lease is released (reclaimed as expired, or the
    // job completes/fails normally). Replaces reclaimExpired()'s unbounded
    // full-partition Query against `queue-index` (KeyConditionExpression only
    // bound lane, filtering client-side for status:PROCESSING AND leaseExpiry<now
    // across that lane's ENTIRE history) — this ran every 2 minutes via the
    // sweeper regardless of how many leases (if any) were actually outstanding,
    // same fixed-cadence cost pattern as the original queue-index/lease-index fix.
    this.table.addGlobalSecondaryIndex({
      indexName: 'lease-reclaim-index',
      partitionKey: { name: 'leaseLane', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'leaseExpiry', type: dynamodb.AttributeType.NUMBER },
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

    // Seed COUNTER#modelslab — the GLOBAL video/rest lane semaphore, with zero
    // inflight counters. The pk name is vestigial ModelsLab branding; the counter
    // is provider-agnostic and live (see acquire() in src/gate/dynamo-gate.ts).
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
