/**
 * AWS Step Functions transport — starts, polls and stops the assembly-tail
 * execution (assets/kinds.ts's `sfn-tail`). Mirrors src/lambda/client.ts: real
 * AWS calls by default, an injectable implementation for tests, credentials
 * from the default AWS SDK provider chain (the VPS forwards AWS_ACCESS_KEY_ID
 * / AWS_SECRET_ACCESS_KEY — deploy/docker-compose.yml).
 *
 * Least privilege: the credential needs `states:StartExecution`,
 * `states:DescribeExecution` and `states:StopExecution` on the ONE state
 * machine ARN, nothing else.
 */
import { createHash } from 'node:crypto';
import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
  StopExecutionCommand,
} from '@aws-sdk/client-sfn';

export type SfnExecutionStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED' | 'PENDING_REDRIVE';

export interface SfnExecution {
  status: SfnExecutionStatus;
  /** Parsed JSON output, present once SUCCEEDED. */
  output?: unknown;
  error?: string;
  cause?: string;
  startDate?: Date;
  stopDate?: Date;
}

/** The three calls the agent makes. Injectable so tests never touch AWS. */
export interface SfnImpl {
  start(stateMachineArn: string, name: string, input: unknown): Promise<{ executionArn: string }>;
  describe(executionArn: string): Promise<SfnExecution>;
  stop(executionArn: string, cause: string): Promise<void>;
}

export interface SfnTransport {
  stateMachineArn: string;
  region: string;
  impl?: SfnImpl;
}

/**
 * Execution names allow [A-Za-z0-9_-] only and at most 80 characters, and AWS
 * rejects a second start under a name it has seen (for 90 days).
 *
 * Deterministic on purpose: a start whose answer was lost (process died
 * between the AWS call and the row write) is replayed under the same name and
 * adopts the running execution instead of launching a duplicate. The suffix
 * is the attempt number plus a short hash of the manifest URL — a recompile
 * writes a NEW manifest file, so a genuinely new assembly never collides with
 * a finished execution from the old one.
 */
export function executionName(projectId: string, attempt: number, manifestUrl: string): string {
  const suffix = `-a${attempt}-${createHash('sha256').update(manifestUrl).digest('hex').slice(0, 8)}`;
  const safe = projectId.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.slice(0, 80 - suffix.length) + suffix;
}

/** `arn:...:stateMachine:Name` -> `arn:...:execution:Name:<executionName>`.
 * Used to recover the ARN when a start is replayed: AWS rejects a second
 * start under the same name, and the original execution is the one we want. */
export function executionArnFor(stateMachineArn: string, name: string): string {
  return stateMachineArn.replace(':stateMachine:', ':execution:') + ':' + name;
}

function defaultImpl(region: string): SfnImpl {
  const client = new SFNClient({ region });
  return {
    async start(stateMachineArn, name, input) {
      try {
        const res = await client.send(
          new StartExecutionCommand({ stateMachineArn, name, input: JSON.stringify(input) }),
        );
        return { executionArn: res.executionArn as string };
      } catch (err) {
        // Replay of a start whose answer was lost (crash between the AWS call
        // and the row write): the execution exists, adopt it.
        const e = err as { name?: string };
        if (e.name === 'ExecutionAlreadyExists') return { executionArn: executionArnFor(stateMachineArn, name) };
        throw err;
      }
    },
    async describe(executionArn) {
      const res = await client.send(new DescribeExecutionCommand({ executionArn }));
      let output: unknown;
      if (res.output) {
        try {
          output = JSON.parse(res.output);
        } catch {
          output = res.output;
        }
      }
      return {
        status: res.status as SfnExecutionStatus,
        output,
        error: res.error,
        cause: res.cause,
        startDate: res.startDate,
        stopDate: res.stopDate,
      };
    },
    async stop(executionArn, cause) {
      await client.send(new StopExecutionCommand({ executionArn, cause: cause.slice(0, 256) }));
    },
  };
}

function implOf(t: SfnTransport): SfnImpl {
  return t.impl ?? defaultImpl(t.region);
}

export async function startTailExecution(t: SfnTransport, name: string, input: unknown): Promise<string> {
  return (await implOf(t).start(t.stateMachineArn, name, input)).executionArn;
}

export async function describeTailExecution(t: SfnTransport, executionArn: string): Promise<SfnExecution> {
  return implOf(t).describe(executionArn);
}

export async function stopTailExecution(t: SfnTransport, executionArn: string, cause: string): Promise<void> {
  await implOf(t).stop(executionArn, cause);
}
