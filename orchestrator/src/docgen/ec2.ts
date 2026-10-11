/**
 * Start / stop / describe the doc-gen EC2 instance. Mirrors src/aws/sfn.ts:
 * real AWS calls by default, an injectable implementation for tests,
 * credentials from the default SDK chain (the VPS forwards AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY — deploy/docker-compose.yml).
 *
 * Least privilege: the credential carries inline policy
 * QMOrchestratorDocgenInstanceControl — ec2:StartInstances/StopInstances on
 * this ONE instance, plus Describe*.
 */
import { EC2Client, StartInstancesCommand, StopInstancesCommand, DescribeInstancesCommand } from '@aws-sdk/client-ec2';

export type InstanceState = 'pending' | 'running' | 'shutting-down' | 'terminated' | 'stopping' | 'stopped' | string;

export interface Ec2Impl {
  start(instanceId: string): Promise<InstanceState>;
  stop(instanceId: string): Promise<InstanceState>;
  describe(instanceId: string): Promise<InstanceState>;
}

export interface Ec2Transport {
  instanceId: string;
  region: string;
  impl?: Ec2Impl;
}

/** AWS error names for "this zone has no capacity for this instance type right now". Retry with backoff. */
const CAPACITY_ERRORS = new Set(['InsufficientInstanceCapacity', 'InsufficientCapacity', 'Unsupported']);

export function isCapacityError(err: unknown): boolean {
  const e = err as { name?: string; Code?: string };
  return CAPACITY_ERRORS.has(e?.name ?? '') || CAPACITY_ERRORS.has(e?.Code ?? '');
}

/**
 * StartInstances on an instance that is still `stopping` (a request arriving
 * right after the previous job's stop) fails with this. Transient: the stop
 * finishes in under a minute, so retry shortly instead of alerting.
 */
export function isIncorrectStateError(err: unknown): boolean {
  const e = err as { name?: string; Code?: string };
  return e?.name === 'IncorrectInstanceState' || e?.Code === 'IncorrectInstanceState';
}

function defaultImpl(region: string): Ec2Impl {
  const client = new EC2Client({ region });
  return {
    async start(instanceId) {
      const res = await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
      return res.StartingInstances?.[0]?.CurrentState?.Name ?? 'unknown';
    },
    async stop(instanceId) {
      const res = await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
      return res.StoppingInstances?.[0]?.CurrentState?.Name ?? 'unknown';
    },
    async describe(instanceId) {
      const res = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      return res.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? 'unknown';
    },
  };
}

function implOf(t: Ec2Transport): Ec2Impl {
  return t.impl ?? defaultImpl(t.region);
}

export const startInstance = (t: Ec2Transport) => implOf(t).start(t.instanceId);
export const stopInstance = (t: Ec2Transport) => implOf(t).stop(t.instanceId);
export const describeInstance = (t: Ec2Transport) => implOf(t).describe(t.instanceId);
