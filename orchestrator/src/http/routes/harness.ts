/**
 * Prompt harness observability routes (implementation plan §11).
 *
 * `POST /v1/harness/lint` is the dry run: same per-frame pipeline as
 * `prepareCohort()` (contract extraction/validation, deterministic lint +
 * fixes, compile, GPT-5 mini regenerate tool where a fix needs wording),
 * but no DB writes — for StoryStudio to pre-check a script, and for
 * iterating on guardrails offline. Same request body as `POST /v1/requests`
 * (an `OrchestratorRequest`), same Bearer auth.
 *
 * `GET /v1/harness/guardrails` lists the active seed + learned guardrail
 * set for a domain/profile — what a cohort would actually lint against
 * right now.
 */
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from '../../config';
import { log } from '../../telemetry/log';
import { RequestSchema } from '../../agents/planner';
import { lintRequest } from '../../harness';
import { loadActiveGuardrails } from '../../harness/guardrails/store';
import { upsertGuardrail } from '../../db/repo/harness';

export async function harnessRoutes(app: FastifyInstance, opts: { pool: Pool; cfg: Config }): Promise<void> {
  function authorized(auth: string | undefined): boolean {
    return auth === `Bearer ${opts.cfg.ingestToken}`;
  }

  app.post('/v1/harness/lint', async (req, reply) => {
    if (!authorized(req.headers.authorization)) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid request', issues: parsed.error.issues };
    }
    try {
      const results = await lintRequest(
        {
          replicate: {
            apiToken: opts.cfg.replicateApiToken,
            apiBase: opts.cfg.replicateApiBase,
            timeoutMs: opts.cfg.replicateTimeoutMs,
            visionModel: opts.cfg.replicateVisionModel,
            visionModelFallback: opts.cfg.replicateVisionModelFallback,
            pollIntervalMs: opts.cfg.replicatePollIntervalMs,
            maxPollAttempts: opts.cfg.replicateMaxPollAttempts,
          },
          extractCfg: { model: opts.cfg.replicateRewriteModel, reasoningEffort: opts.cfg.replicateRewriteReasoning },
          regenerateCfg: { model: opts.cfg.replicateRewriteModel, reasoningEffort: opts.cfg.replicateRewriteReasoning },
          pool: opts.pool,
        },
        parsed.data,
      );
      return {
        promptHarness: parsed.data.options.promptHarness,
        frames: results.map((r) => ({
          frameId: r.frameId,
          harnessError: r.output.harnessError,
          splitShot: r.output.splitShot,
          imageFallbackRung: r.output.imageFallbackRung,
          motionFallbackRung: r.output.motionFallbackRung,
          findings: r.output.findings,
          contract: r.output.contract,
          imagePrompt: r.output.imagePrompt,
          motionPrompt: r.output.motionPrompt,
        })),
      };
    } catch (err) {
      log().error({ err }, 'harness: POST /v1/harness/lint failed');
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get<{ Querystring: { domain?: string; profile?: string } }>('/v1/harness/guardrails', async (req, reply) => {
    if (!authorized(req.headers.authorization)) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const domain = req.query.domain === 'video' ? 'video' : 'image';
    const profile = req.query.profile ?? (domain === 'video' ? 'wan2-lightning' : 'any');
    const guardrails = await loadActiveGuardrails(opts.pool, domain, profile);
    return { domain, profile, guardrails };
  });

  // Operator activation for a proposed/probation guardrail (plan §9.4) —
  // 'warn'-severity rows with a clean replay are meant to auto-activate via
  // the (not yet built) promotion cron; this endpoint is the manual path
  // for everything else, matching the plan's "operator activates
  // everything else" rule.
  app.post<{ Params: { id: string; version: string } }>('/v1/harness/guardrails/:id/:version/activate', async (req, reply) => {
    if (!authorized(req.headers.authorization)) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const version = Number(req.params.version);
    if (!Number.isInteger(version)) {
      reply.code(400);
      return { error: 'version must be an integer' };
    }
    const { rows } = await opts.pool.query(
      `SELECT id, version, domain, profile, status, severity, title, detector, fix_target, corrective, instruction, evidence
         FROM harness_guardrails WHERE id = $1 AND version = $2`,
      [req.params.id, version],
    );
    if (rows.length === 0) {
      reply.code(404);
      return { error: 'guardrail not found' };
    }
    const row = rows[0];
    await upsertGuardrail(opts.pool, {
      id: row.id,
      version: row.version,
      domain: row.domain,
      profile: row.profile,
      status: 'active',
      severity: row.severity,
      title: row.title,
      detector: row.detector,
      fixTarget: row.fix_target,
      corrective: row.corrective,
      instruction: row.instruction,
      evidence: row.evidence,
    });
    return { activated: true, id: row.id, version: row.version };
  });
}
