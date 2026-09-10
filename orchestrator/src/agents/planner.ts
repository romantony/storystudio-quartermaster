/**
 * Planning agent (impl plan §6.2). Runs synchronously inside POST
 * /v1/requests so a malformed request fails fast (spec §2.2) rather than six
 * hours later.
 *
 * plan(request) ->
 *   1. validate (zod) against the §9.1 schema; reject on failure
 *   2. resolve tier+product -> the full spec step set
 *   3. filter to steps present in steps/catalog.ts (M2: only 1-3 — see the
 *      M2 plan's decision 1; this is what makes "steps 1->3 only" fall out
 *      naturally instead of needing a test-only flag)
 *   4. expand frames[] -> job rows, one per (frame, step), deps_remaining
 *      precomputed from the catalog's dependsOn intersected with the
 *      actually-planned step set
 *   5. compute drainAfter via the endpoint-affinity rule
 *   6. write cohort/project/steps/jobs in ONE transaction
 *   7. return the §9.2 acknowledgement
 */
import { z } from 'zod';
import type { Pool } from 'pg';
import type { Config } from '../config';
import { log } from '../telemetry/log';
import { ensureCohort } from '../db/repo/cohorts';
import { insertProject, getProject } from '../db/repo/projects';
import { insertSteps, type NewStep } from '../db/repo/steps';
import { insertJobs, type NewJob } from '../db/repo/jobs';
import { STEP_CATALOG, catalogEntry } from '../steps/catalog';
import type { FrameJobInput } from '../steps/builders/types';
import { estimateMinutes } from '../telemetry/ledger';

// ── §9.1 request schema ──────────────────────────────────────────────────
const FrameSchema = z
  .object({
    frameId: z.string().min(1),
    imagePrompt: z.string().min(1),
    narration: z.string().min(1),
    durationS: z.number().positive(),
    motionPrompt: z.string().optional(),
    textManifest: z.object({ elements: z.array(z.unknown()), fps: z.number() }).optional(),
  })
  .strict();

const OptionsSchema = z
  .object({
    bgm: z.boolean().default(false),
    subtitles: z.boolean().default(false),
    upscale: z.boolean().default(false),
    burnCaptions: z.boolean().default(false),
    removeSilence: z.boolean().default(false),
    textOverlay: z.boolean().default(false),
    qualityGates: z.enum(['full', 'sampled', 'image-only', 'off']).default('full'),
    shorts: z
      .object({
        enabled: z.boolean().default(false),
        numClips: z.number().int().positive().optional(),
        segmentsSource: z.string().optional(),
        passthrough: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .default({ enabled: false }),
  })
  .strict()
  .default({});

export const RequestSchema = z
  .object({
    requestId: z.string().min(1),
    projectId: z.string().min(1),
    source: z.literal('mcp'),
    tier: z.string().min(1),
    product: z.string().min(1),
    language: z.string().min(1),
    aspectRatio: z.string().min(1),
    resolution: z.string().min(1),
    callbackUrl: z.string().url(),
    options: OptionsSchema,
    frames: z.array(FrameSchema).min(1),
  })
  .strict();

export type OrchestratorRequest = z.infer<typeof RequestSchema>;

export interface PlanAck {
  requestId: string;
  accepted: true;
  cohortId: string;
  windowClosesAt: string;
  estimatedRunMinutes: number;
  estimatedResultAt: string;
  estimateBasis: 'measured' | 'default';
  jobCount: number;
  cohortProjects: number;
}

export class PlanValidationError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    super(`invalid request: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    this.name = 'PlanValidationError';
  }
}

/** The full spec step topology (§3), independent of what's catalogued today.
 * Used only to resolve WHICH steps a request wants; step 7 (Remotion) is
 * deliberately absent — it stays on the existing AWS Lambda, not part of the
 * orchestrator's own plan (impl plan §13 M1 note). */
const STEP_TOPOLOGY: ReadonlyArray<{ seq: number; dialogueOnly?: boolean; gatedBy?: (o: OrchestratorRequest['options']) => boolean }> = [
  { seq: 1 },
  { seq: 2 },
  { seq: 3 },
  { seq: 4, dialogueOnly: true },
  { seq: 5, gatedBy: (o) => o.bgm },
  { seq: 6 },
  { seq: 8 },
  { seq: 9, gatedBy: (o) => o.subtitles },
  { seq: 10, gatedBy: (o) => o.upscale },
  { seq: 11, gatedBy: (o) => o.burnCaptions },
  { seq: 12, gatedBy: (o) => o.bgm }, // overlays step 5's output; same flag
  { seq: 13, gatedBy: (o) => o.shorts.enabled },
];

function resolveStepSet(req: OrchestratorRequest): number[] {
  const isDialogue = req.tier.toLowerCase().includes('dialogue');
  return STEP_TOPOLOGY.filter((s) => {
    if (s.dialogueOnly && !isDialogue) return false;
    if (s.gatedBy && !s.gatedBy(req.options)) return false;
    return true;
  }).map((s) => s.seq);
}

/** Impl plan §6.2's endpoint-affinity rule, verbatim. Steps here are already
 * in dependency/seq order (the catalog is authored that way). */
function computeDrainAfter(steps: NewStep[]): void {
  for (let i = 0; i < steps.length - 1; i++) {
    steps[i].drainAfter = steps[i].endpointId !== steps[i + 1].endpointId;
  }
  if (steps.length > 0) steps[steps.length - 1].drainAfter = true;
}

export async function plan(pool: Pool, cfg: Pick<Config, 'workersHead'>, rawRequest: unknown): Promise<PlanAck> {
  const parsed = RequestSchema.safeParse(rawRequest);
  if (!parsed.success) throw new PlanValidationError(parsed.error.issues);
  const req = parsed.data;

  // §10.1 request-level idempotency: a replayed requestId returns the
  // original acknowledgement, never a second plan.
  const client = await pool.connect();
  try {
    const existing = await getProject(client, req.projectId);
    if (existing && existing.requestId === req.requestId) {
      log().info({ requestId: req.requestId }, 'plan: replay, returning existing acknowledgement');
      return ackFromExisting(client, existing.cohortId!, req.projectId, req.requestId);
    }

    const resolvedSeqs = resolveStepSet(req);
    const uncatalogued = resolvedSeqs.filter((s) => !catalogEntry(s));
    if (uncatalogued.length > 0) {
      log().warn(
        { requestId: req.requestId, uncatalogued },
        'plan: resolved steps have no catalog entry yet (builder lands in a later milestone) — skipping them',
      );
    }
    const catalogued = resolvedSeqs
      .map((s) => catalogEntry(s))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);

    if (catalogued.length === 0) {
      throw new Error(`plan: no catalogued steps resolved for tier=${req.tier} options=${JSON.stringify(req.options)}`);
    }

    await client.query('BEGIN');
    try {
      const cohort = await ensureCohort(client);
      const { project, wasNew } = await insertProject(client, {
        id: req.projectId,
        cohortId: cohort.id,
        requestId: req.requestId,
        tier: req.tier,
        language: req.language,
        request: req,
        callbackUrl: req.callbackUrl,
      });

      if (!wasNew) {
        // A different requestId lost a race against an already-planned
        // project id — surface it rather than silently double-planning.
        await client.query('ROLLBACK');
        throw new Error(`plan: project ${req.projectId} already exists under a different requestId`);
      }

      const newSteps: NewStep[] = catalogued.map((c) => ({
        seq: c.seq,
        name: c.name,
        endpointId: c.endpointId,
        workersTarget: cfg.workersHead,
        gate: c.gate,
        drainAfter: true, // overwritten by computeDrainAfter below
        dependsOn: c.dependsOn.filter((d) => catalogued.some((cc) => cc.seq === d)),
        jobTotal: req.frames.length,
      }));
      computeDrainAfter(newSteps);
      await insertSteps(client, cohort.id, newSteps);

      const newJobs: NewJob[] = [];
      for (const c of catalogued) {
        const dependsOnPlanned = c.dependsOn.filter((d) => catalogued.some((cc) => cc.seq === d));
        req.frames.forEach((frame, idx) => {
          const input: FrameJobInput = {
            frameId: frame.frameId,
            imagePrompt: frame.imagePrompt,
            narration: frame.narration,
            durationS: frame.durationS,
            motionPrompt: frame.motionPrompt,
            aspectRatio: req.aspectRatio,
            language: req.language,
          };
          newJobs.push({
            projectId: project.id,
            stepSeq: c.seq,
            seq: idx,
            frameId: frame.frameId,
            depsRemaining: dependsOnPlanned.length,
            input,
          });
        });
      }
      await insertJobs(client, cohort.id, newJobs);

      await client.query('COMMIT');

      const jobCount = newJobs.length;
      const est = estimateMinutes(catalogued.map((c) => ({ name: c.name, jobs: req.frames.length, workers: cfg.workersHead })));
      const closesAt = cohort.closesAt;

      log().info(
        { requestId: req.requestId, cohortId: cohort.id, steps: catalogued.map((c) => c.seq), jobCount },
        'plan: committed',
      );

      return {
        requestId: req.requestId,
        accepted: true,
        cohortId: cohort.id,
        windowClosesAt: closesAt.toISOString(),
        estimatedRunMinutes: est.minutes,
        estimatedResultAt: new Date(Date.now() + est.minutes * 60_000).toISOString(),
        estimateBasis: est.basis,
        jobCount,
        cohortProjects: 1, // M2 has no multi-project cohorts yet (window scheduler is M6)
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

async function ackFromExisting(
  client: import('pg').PoolClient,
  cohortId: string,
  projectId: string,
  requestId: string,
): Promise<PlanAck> {
  const { rows } = await client.query<{ closes_at: Date }>('SELECT closes_at FROM cohorts WHERE id = $1', [
    cohortId,
  ]);
  const { rows: jobRows } = await client.query<{ n: string }>(
    'SELECT count(*) AS n FROM jobs WHERE project_id = $1',
    [projectId],
  );
  return {
    requestId,
    accepted: true,
    cohortId,
    windowClosesAt: rows[0].closes_at.toISOString(),
    estimatedRunMinutes: 0,
    estimatedResultAt: new Date().toISOString(),
    estimateBasis: 'default',
    jobCount: Number(jobRows[0]?.n ?? 0),
    cohortProjects: 1,
  };
}

/** Exposed for tests — the affinity rule and step-set resolution are pure. */
export const _internal = { computeDrainAfter, resolveStepSet, STEP_TOPOLOGY };

export const _catalogSize = STEP_CATALOG.length;
