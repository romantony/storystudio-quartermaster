/**
 * POST /v1/webhooks/asset/:assetToken — the asset pipeline's completion
 * receiver (2026-09-19).
 *
 * Separate from `/v1/webhooks/runpod/:jobToken` on purpose: that route
 * resolves the payload's RunPod id against the `jobs` table and applies a
 * cohort-model transition (step counters, quality gates). An asset row has
 * none of that. Keeping them apart means a token minted for one model can
 * never validate against the other — `assets/agent.ts`'s token is namespaced
 * `asset:<id>`, this route only ever looks in `assets`, and neither route can
 * mis-transition the other's rows.
 *
 * Same two contracts the cohort receiver settled on:
 *   * answer 200 immediately, before doing real work, so RunPod does not
 *     retry-storm a slow receiver;
 *   * be idempotent — `webhook_receipts` (migration 003) makes a duplicate
 *     delivery a no-op, and `applyAssetSuccess`/`applyAssetFailure` re-check
 *     the row's status under lock anyway, so a webhook racing the reconcile
 *     scan is safe with or without the receipt.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config';
import type { RunpodClient } from '../../runpod/client';
import { log } from '../../telemetry/log';
import { getAssetByProviderJobId } from '../../db/repo/assets';
import { applyAssetSuccess, applyAssetFailure, assetWebhookToken, type AssetAgentDeps } from '../../assets/agent';
import { isTerminal, extractErrorText } from '../../runpod/types';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function assetWebhookRoutes(
  app: FastifyInstance,
  opts: { pool: Pool; cfg: Config; runpod: RunpodClient; publicBaseUrl: string },
): Promise<void> {
  const deps: AssetAgentDeps = {
    pool: opts.pool,
    runpod: opts.runpod,
    cfg: opts.cfg,
    publicBaseUrl: opts.publicBaseUrl,
    webhookSecret: opts.cfg.webhookSecret,
  };

  app.post<{
    Params: { assetToken: string };
    Body: { id?: string; status?: string; output?: unknown; error?: unknown; executionTime?: number; delayTime?: number };
  }>('/v1/webhooks/asset/:assetToken', async (req, reply) => {
    reply.code(200);
    reply.send({ ok: true });

    const { assetToken } = req.params;
    const body = req.body ?? {};
    const providerJobId = body.id;
    if (!providerJobId) {
      log().warn({ assetToken }, 'asset-webhook: no provider job id in payload, ignoring');
      return;
    }

    try {
      const row = await getAssetByProviderJobId(opts.pool, providerJobId);
      if (!row) {
        log().warn({ providerJobId }, 'asset-webhook: unknown provider job id, ignoring');
        return;
      }
      if (!safeEqual(assetWebhookToken(opts.cfg.webhookSecret, row.id), assetToken)) {
        log().warn({ assetId: row.id, providerJobId }, 'asset-webhook: token mismatch, ignoring');
        return;
      }

      const receipt = await opts.pool.query(
        `INSERT INTO webhook_receipts (runpod_job_id, status, body)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING runpod_job_id`,
        [providerJobId, body.status ?? 'unknown', body],
      );
      if (receipt.rowCount === 0) {
        log().info({ providerJobId }, 'asset-webhook: duplicate delivery, no-op');
        return;
      }

      if (body.status === 'COMPLETED') {
        await applyAssetSuccess(deps, row.id, row.kind, body.output, {
          executionMs: body.executionTime ?? null,
          delayMs: body.delayTime ?? null,
        });
      } else if (body.status && isTerminal(body.status)) {
        const errorText = extractErrorText(body.error, body.output);
        await applyAssetFailure(deps, row.id, row.kind, { status: body.status, error: errorText?.slice(0, 500) });
      }
      // IN_QUEUE / IN_PROGRESS deliveries are not expected here; doing
      // nothing is better than mis-transitioning the row.
    } catch (err) {
      log().error({ providerJobId, err }, 'asset-webhook: failed to apply');
    }
  });
}
