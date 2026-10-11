/**
 * POST /v1/webhooks/docgen — status events from the doc-gen EC2 instance.
 *
 * The signature is an HMAC over the RAW body, so this plugin replaces the JSON
 * parser with a buffer one. Fastify scopes content-type parsers to the plugin
 * (and its children), so the rest of the server keeps its normal parsing.
 *
 * Contract (ORCHESTRATOR_INTEGRATION.md §6): verify before parsing and answer
 * 401 on a bad signature; otherwise answer 2xx fast and do the work after.
 * Delivery is retried by the instance (5, 15, 60, 180, 300 s) on non-2xx, so a
 * DB error here is logged but still answered 200 — catch-up polling
 * (`/events?after_seq=`) recovers anything missed, and a retry-storm against a
 * struggling database would not help.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config';
import { log } from '../../telemetry/log';
import { verifyDocgenSignature } from '../../docgen/signature';
import { applyDocgenEvent } from '../../docgen/events';
import type { DocgenWebhookBody } from '../../docgen/types';

export async function docgenWebhookRoutes(app: FastifyInstance, opts: { pool: Pool; cfg: Config }): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/v1/webhooks/docgen', async (req, reply) => {
    const secret = opts.cfg.docgenCallbackSecret;
    if (!secret) {
      reply.code(503);
      return { error: 'docgen_not_configured' };
    }
    const raw = req.body as Buffer;
    const sig = req.headers['x-docgen-signature'];
    if (!Buffer.isBuffer(raw) || !verifyDocgenSignature(raw, typeof sig === 'string' ? sig : undefined, secret)) {
      reply.code(401);
      return { error: 'bad_signature' };
    }

    let body: DocgenWebhookBody;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      reply.code(400);
      return { error: 'invalid_json' };
    }
    if (!body || typeof body.request_id !== 'string' || typeof body.seq !== 'number' || typeof body.event !== 'string') {
      reply.code(400);
      return { error: 'invalid_event' };
    }

    // Answer first; everything below is after the 2xx.
    reply.code(200);
    reply.send({ ok: true });

    try {
      const r = await applyDocgenEvent(opts.pool, body);
      if (r.outcome === 'unknown_job') {
        log().warn({ docgenRequestId: body.request_id, event: body.event }, 'docgen webhook: unknown request id, ignoring');
      } else if (r.outcome === 'applied') {
        log().info({ docgenRequestId: body.request_id, event: body.event, seq: body.seq, gap: r.gap }, 'docgen webhook: applied');
        // A gap is recovered by the dispatcher's catch-up poll (it reads seq from the row).
        if (r.gap) log().warn({ docgenRequestId: body.request_id, seq: body.seq, prevSeq: r.prevSeq }, 'docgen webhook: seq gap');
      }
    } catch (err) {
      log().error({ err, docgenRequestId: body.request_id, event: body.event }, 'docgen webhook: failed to apply (already answered 200)');
    }
  });
}
