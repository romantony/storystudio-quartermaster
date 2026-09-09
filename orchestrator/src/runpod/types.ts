/**
 * RunPod wire shapes the orchestrator depends on. Deliberately narrow — only
 * the fields §4/§6 of the spec actually read. The full responses carry more;
 * we do not model what we do not use.
 */

/** Terminal RunPod job statuses (mirrors src/adapters/runpod.ts TERMINAL_STATUSES). */
export const TERMINAL_STATUSES = ['FAILED', 'ERROR', 'CANCELLED', 'TIMED_OUT'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type JobStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | TerminalStatus | (string & {});

export interface RunResponse {
  id: string;
  status: JobStatus;
  /** Present when a warm endpoint completed the job synchronously on /run. */
  output?: unknown;
  /** RunPod top-level billed duration (ms). Not output.gen_time_s — see runpod.ts. */
  executionTime?: number;
  /** Queue wait (ms). NOT billed. */
  delayTime?: number;
}

export interface StatusResponse extends RunResponse {}

export interface HealthResponse {
  workers: {
    ready?: number;
    running?: number;
    idle?: number;
    throttled?: number;
    initializing?: number;
  };
  jobs?: {
    completed?: number;
    failed?: number;
    inProgress?: number;
    inQueue?: number;
    retried?: number;
  };
}

export interface PatchWorkersBody {
  workersMin: number;
  workersMax: number;
}

/** Same taxonomy as src/adapters/runpod.ts classifyError. */
export type ErrClass = 'Transient' | 'TerminalProvider' | 'TerminalRetryable';

export class RunpodError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly klass: ErrClass,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'RunpodError';
  }
}

export function classifyError(code: number): ErrClass {
  if (code === 429) return 'Transient';
  if (code === 401) return 'TerminalProvider';
  if (code >= 500) return 'Transient';
  return 'TerminalRetryable';
}

export function isTerminal(status: string): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status.toUpperCase());
}
