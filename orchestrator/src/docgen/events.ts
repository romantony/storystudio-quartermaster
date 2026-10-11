/**
 * Applies one doc-gen webhook (or one event fetched by catch-up polling) to the
 * database. Shared by the webhook route and the dispatcher's
 * `GET .../events?after_seq=` catch-up, so both obey the same rules:
 *
 *  - delivery is at-least-once and unordered: record every event, but apply a
 *    status only if its `seq` is newer than the stored one;
 *  - a heartbeat only proves liveness — it never changes status;
 *  - a jump of more than one in `seq` is reported as a `gap`, so the caller can
 *    fetch what it missed.
 */
import type { Pool } from 'pg';
import type { DocgenWebhookBody } from './types';
import {
  applyDocgenStatus,
  getDocgenJobByDocgenId,
  recordDocgenEvent,
  touchDocgenHeartbeat,
} from '../db/repo/docgen';

export type ApplyOutcome =
  | { outcome: 'unknown_job' }
  | { outcome: 'heartbeat' }
  | { outcome: 'duplicate' }
  | { outcome: 'stale' }
  | { outcome: 'applied'; gap: boolean; prevSeq: number };

export async function applyDocgenEvent(pool: Pool, body: DocgenWebhookBody): Promise<ApplyOutcome> {
  const job = await getDocgenJobByDocgenId(pool, body.request_id);
  if (!job) return { outcome: 'unknown_job' };

  if (body.event === 'job.heartbeat') {
    await touchDocgenHeartbeat(pool, body.request_id);
    return { outcome: 'heartbeat' };
  }

  const isNew = await recordDocgenEvent(pool, { requestId: job.requestId, seq: body.seq, event: body.event, body });
  if (!body.status) return { outcome: isNew ? 'stale' : 'duplicate' };

  const r = await applyDocgenStatus(pool, body.request_id, body.status);
  if (!r.applied) return { outcome: isNew ? 'stale' : 'duplicate' };
  return { outcome: 'applied', prevSeq: r.prevSeq as number, gap: body.status.seq > (r.prevSeq as number) + 1 };
}
