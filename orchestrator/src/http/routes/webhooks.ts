/**
 * POST /v1/webhooks/runpod/:jobToken (impl plan §7.2).
 *
 * `jobToken` is not decoded — it's a per-job HMAC (agents/generator.ts's
 * `webhookToken`), verified by looking the job up via RunPod's own job id
 * in the payload body (already stored as `jobs.runpod_job_id` at submission
 * time), then recomputing the expected token from that job's id and
 * comparing. A mismatch or unknown RunPod job id is rejected.
 *
 * Always answers 200 fast, before doing real work, so RunPod does not
 * retry-storm a slow receiver. Idempotent via `webhook_receipts` — a
 * duplicate delivery becomes a no-op plus a 200.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config';
import { log } from '../../telemetry/log';
import { getJobByRunpodId, markTerminal } from '../../db/repo/jobs';
import { incrementStepCounters } from '../../db/repo/steps';
import { recordJobCost } from '../../db/repo/costs';
import { webhookToken } from '../../agents/generator';
import { runpodOutUrl } from '../../runpod/output';
import { isTerminal } from '../../runpod/types';
import { catalogEntry } from '../../steps/catalog';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function webhookRoutes(app: FastifyInstance, opts: { pool: Pool; cfg: Config }): Promise<void> {
  app.post<{ Params: { jobToken: string }; Body: { id?: string; status?: string; output?: unknown; executionTime?: number; delayTime?: number } }>(
    '/v1/webhooks/runpod/:jobToken',
    async (req, reply) => {
      // Answer fast — see the module docstring.
      reply.code(200);
      reply.send({ ok: true });

      const { jobToken } = req.params;
      const body = req.body ?? {};
      const runpodJobId = body.id;
      if (!runpodJobId) {
        log().warn({ jobToken }, 'webhook: no RunPod job id in payload, ignoring');
        return;
      }

      try {
        const job = await getJobByRunpodId(opts.pool, runpodJobId);
        if (!job) {
          log().warn({ runpodJobId }, 'webhook: unknown RunPod job id, ignoring');
          return;
        }
        const expected = webhookToken(opts.cfg.webhookSecret, job.id);
        if (!safeEqual(expected, jobToken)) {
          log().warn({ jobId: job.id, runpodJobId }, 'webhook: token mismatch, ignoring');
          return;
        }

        const receipt = await opts.pool.query(
          `INSERT INTO webhook_receipts (runpod_job_id, status, body)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING
           RETURNING runpod_job_id`,
          [runpodJobId, body.status ?? 'unknown', body],
        );
        if (receipt.rowCount === 0) {
          log().info({ runpodJobId }, 'webhook: duplicate delivery, no-op');
          return;
        }

        if (job.status !== 'submitted') {
          // Already resolved (e.g. by the reconcile tick racing this
          // webhook) — the receipt insert above still records it for
          // idempotency bookkeeping, but there's no transition left to apply.
          return;
        }

        const client = await opts.pool.connect();
        try {
          await client.query('BEGIN');
          if (body.status === 'COMPLETED') {
            await markTerminal(client, job.id, { status: 'complete', output: body.output });
            await recordJobCost(client, {
              jobId: job.id,
              endpointId: catalogEntry(job.stepSeq)?.endpointId ?? 'unknown',
              executionMs: body.executionTime ?? null,
              delayMs: body.delayTime ?? null,
              workerRateUsdS: opts.cfg.workerRateUsdS,
            });
          } else if (body.status && isTerminal(body.status)) {
            await markTerminal(client, job.id, { status: 'failed', error: { status: body.status } });
          } else {
            // IN_QUEUE / IN_PROGRESS deliveries shouldn't normally arrive on
            // this endpoint, but do nothing rather than mis-transition.
            await client.query('ROLLBACK');
            return;
          }
          await client.query('COMMIT');
          await incrementStepCounters(
            opts.pool,
            job.cohortId,
            job.stepSeq,
            body.status === 'COMPLETED' ? 'job_completed' : 'job_failed',
          );
          log().info({ jobId: job.id, status: body.status, url: runpodOutUrl(body.output) }, 'webhook: applied terminal state');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        log().error({ err, runpodJobId }, 'webhook: failed to process (already answered 200)');
      }
    },
  );
}
