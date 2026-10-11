/**
 * Documentary requests (doc-gen path), the StoryStudio-facing surface:
 *
 *   POST /v1/documentaries              ORCH_INGEST_TOKEN   queue a request
 *   GET  /v1/documentaries/:requestId   ORCH_INGEST_TOKEN   status while it waits / runs
 *   GET  /v1/admin/docgen               ORCH_ADMIN_TOKEN    queue, instance, recent jobs
 *
 * Intake validates synchronously (a bad request fails in seconds, not after a
 * 40-minute queue) and only queues: the dispatcher starts the instance. The
 * 202 is idempotent on `requestId`, like POST /v1/requests.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config';
import { log } from '../../telemetry/log';
import { buildDocgenPayload, docgenRequestIdFor, validateIntake, DocgenValidationError } from '../../docgen/request';
import { docgenEnabled } from '../../docgen/setup';
import { describeInstance, type Ec2Transport } from '../../docgen/ec2';
import {
  enqueueDocgenJob,
  getDocgenJob,
  docgenJobsAhead,
  getActiveDocgenJob,
  listQueuedDocgenJobs,
  listRecentFinishedDocgenJobs,
  type DocgenJobRow,
} from '../../db/repo/docgen';

/**
 * Wall-clock for one documentary, for `estimatedResultAt` only. Measured: 38 min
 * for a 240 s, no-Shorts job; the design document expects 60-90 min for a full
 * episode with Shorts. Clearly an estimate — `estimateBasis` says so.
 */
export const ESTIMATE_MINUTES_PER_JOB = 75;

const FINAL = new Set(['succeeded', 'failed', 'cancelled']);

function summary(row: DocgenJobRow, ahead: number) {
  return {
    requestId: row.requestId,
    projectId: row.projectId,
    state: row.state,
    stage: row.stage,
    progress: row.progress,
    message: row.message,
    warnings: (row.status?.warnings as string[] | undefined) ?? [],
    outputs: Array.isArray(row.outputs) ? row.outputs : [],
    error: row.error,
    jobsAhead: ahead,
    attempts: row.attempts,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    callbackStatus: row.callbackStatus,
  };
}

export async function docgenRoutes(
  app: FastifyInstance,
  opts: { pool: Pool; cfg: Config; ec2?: Ec2Transport },
): Promise<void> {
  const unauthorized = (reply: FastifyReply) => {
    reply.code(401);
    return { error: 'unauthorized' };
  };
  const off = (reply: FastifyReply) => {
    reply.code(503);
    return { error: 'docgen_not_configured' };
  };
  const ingestAuth = (req: FastifyRequest) => req.headers.authorization === `Bearer ${opts.cfg.ingestToken}`;
  const adminAuth = (req: FastifyRequest) => req.headers.authorization === `Bearer ${opts.cfg.adminToken}`;

  app.post('/v1/documentaries', async (req, reply) => {
    if (!ingestAuth(req)) return unauthorized(reply);
    if (!docgenEnabled(opts.cfg)) return off(reply);

    try {
      const intake = validateIntake(req.body);
      const payload = buildDocgenPayload(intake, docgenRequestIdFor(intake.requestId, 1), {
        reviewMode: opts.cfg.docgenReviewMode,
        model: opts.cfg.docgenModel,
        publicBaseUrl: opts.cfg.publicBaseUrl,
      });
      const { row, created } = await enqueueDocgenJob(opts.pool, {
        requestId: intake.requestId,
        docgenRequestId: payload.request_id,
        projectId: intake.projectId,
        callbackUrl: intake.callbackUrl,
        request: payload,
      });
      const ahead = await docgenJobsAhead(opts.pool, row.requestId);
      const waiting = FINAL.has(row.state) ? null : new Date(Date.now() + (ahead + 1) * ESTIMATE_MINUTES_PER_JOB * 60_000).toISOString();
      reply.code(202);
      log().info({ requestId: row.requestId, projectId: row.projectId, created, ahead }, 'docgen: request accepted');
      return {
        requestId: row.requestId,
        accepted: true,
        queued: row.state === 'queued',
        state: row.state,
        jobsAhead: ahead,
        estimatedResultAt: waiting,
        estimateBasis: 'default',
      };
    } catch (err) {
      if (err instanceof DocgenValidationError) {
        reply.code(400);
        return { error: err.message, issues: err.issues };
      }
      log().error({ err }, 'docgen: intake failed');
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get<{ Params: { requestId: string } }>('/v1/documentaries/:requestId', async (req, reply) => {
    if (!ingestAuth(req)) return unauthorized(reply);
    const row = await getDocgenJob(opts.pool, req.params.requestId);
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return summary(row, await docgenJobsAhead(opts.pool, row.requestId));
  });

  app.get('/v1/admin/docgen', async (req, reply) => {
    if (!adminAuth(req)) return unauthorized(reply);
    const [active, queued, recent] = await Promise.all([
      getActiveDocgenJob(opts.pool),
      listQueuedDocgenJobs(opts.pool),
      listRecentFinishedDocgenJobs(opts.pool, 5),
    ]);
    const instance = opts.ec2 ? await describeInstance(opts.ec2).catch((e) => `error: ${String(e?.message ?? e)}`) : null;
    return {
      enabled: docgenEnabled(opts.cfg),
      instance: opts.ec2 ? { id: opts.ec2.instanceId, state: instance } : null,
      active: active && { ...summary(active, 0), instanceStartedAt: active.instanceStartedAt, lastPolledAt: active.lastPolledAt },
      queued: queued.map((r, i) => summary(r, i + (active ? 1 : 0))),
      recent: recent.map((r) => summary(r, 0)),
    };
  });
}
