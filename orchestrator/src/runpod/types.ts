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
  /** RunPod top-level error string on a FAILED job — not always populated;
   * a worker crash often only surfaces its error inside `output` instead. */
  error?: unknown;
  /** RunPod top-level billed duration (ms). Not output.gen_time_s — see runpod.ts. */
  executionTime?: number;
  /** Queue wait (ms). NOT billed. */
  delayTime?: number;
}

/** Best-effort text extraction from whatever shape a failure's error/output
 * came back as — a bare string, `{error}`/`{message}`, or worst case the
 * whole thing JSON-stringified. Used only for `isResourceExhaustionError()`
 * classification below, never stored as-is (callers still truncate/shape
 * what actually gets written to `jobs.error`). */
export function extractErrorText(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (typeof obj.error === 'string' && obj.error) return obj.error;
      if (typeof obj.message === 'string' && obj.message) return obj.message;
    }
  }
  for (const v of values) {
    if (v !== undefined && v !== null) {
      try {
        return JSON.stringify(v);
      } catch {
        // fall through
      }
    }
  }
  return undefined;
}

/** A worker ran out of a physical resource (GPU VRAM, disk, etc.) rather
 * than the job itself being unrunnable — real incident 2026-09-16: the
 * orchestrator's very first live StoryStudio request hit "CUDA out of
 * memory" on 5/18 image jobs (qwen-image-gen's endpoint mixes A40/A6000
 * ~44GB cards with 80GB A100s in its allowed GPU pool; the workload's peak
 * VRAM sits right at the smaller cards' ceiling). This is transient and
 * worker-assignment-dependent, not a defect in the request — a retry has a
 * real chance of landing on a different, adequately-sized worker, unlike a
 * genuine content/validation failure. See agents/generator.ts's/
 * http/routes/webhooks.ts's retryCeiling() for where this raises the retry
 * budget above the default `maxAttempts`. */
export function isResourceExhaustionError(text: string | undefined): boolean {
  if (!text) return false;
  return /out of memory|out-of-memory\b/i.test(text);
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
  // Optional: agents/fleet.ts's allocate() only ever raises workersMax now
  // (M3 fix, 2026-09-10 — see docs/qm-orchestrator-implementation-plan.md).
  // workersMin should never leave 0 anywhere in this codebase; release()
  // and watchdog.ts's autodrain path still pass it explicitly as 0.
  workersMin?: number;
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
