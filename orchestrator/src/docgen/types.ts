/**
 * Wire types for the doc-gen service (the EC2-hosted documentary generator).
 * Contract: ~/local-gen-documentary/docs/ORCHESTRATOR_INTEGRATION.md.
 */

export type DocgenState = 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'cancelled';
export const DOCGEN_TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

export interface DocgenOutput {
  kind: string;
  path: string;
  bytes?: number;
  bucket?: string;
  key?: string;
  /** Absent when the upload of this file failed — see `warnings`. */
  url?: string;
}

export interface DocgenError {
  code: string;
  stage?: string;
  message?: string;
  retryable?: boolean;
}

/** The status object: returned by GET /v1/documentaries/{id} and carried in every webhook. */
export interface DocgenStatus {
  job_id: string;
  request_id: string;
  seq: number;
  state: DocgenState;
  stage: string;
  stages_done?: string[];
  progress: number;
  message?: string;
  next_steps?: string[];
  awaiting?: { checkpoint_id: string; question?: string; review_files?: string[] } | null;
  warnings?: string[];
  outputs?: DocgenOutput[];
  costs?: Record<string, number>;
  error?: DocgenError | null;
  created_at?: string;
  stage_started_at?: string;
  updated_at?: string;
}

export type DocgenEventName =
  | 'job.accepted'
  | 'stage.started'
  | 'stage.completed'
  | 'status.updated'
  | 'checkpoint.awaiting_input'
  | 'job.heartbeat'
  | 'job.succeeded'
  | 'job.failed'
  | 'job.cancelled';

export interface DocgenWebhookBody {
  event: DocgenEventName | string;
  job_id: string;
  request_id: string;
  seq: number;
  sent_at?: string;
  status?: DocgenStatus;
}

export interface DocgenHealth {
  ready: boolean;
  image?: string;
  runner?: string;
  busy: boolean;
  current_job_id: string | null;
  checks: Record<string, string | number>;
  uptime_seconds?: number;
  idle_seconds?: number;
}

/** The body POSTed to /v1/documentaries. Only the four required fields have no default on the instance. */
export interface DocgenStartPayload {
  request_id: string;
  topic: string;
  synopsis: string;
  series?: Record<string, string | number | null>;
  long?: { enabled?: boolean; target_seconds?: number; narrator_voice?: string };
  shorts?: { count?: number; angles?: string[] };
  visuals?: Record<string, boolean | number>;
  review_mode: 'checkpoints' | 'auto';
  model: string;
  output: { prefix: string };
  callback: { url: string };
}
