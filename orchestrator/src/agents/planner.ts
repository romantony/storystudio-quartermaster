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
import { STEP_CATALOG, catalogEntry, type CatalogEntry } from '../steps/catalog';
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
    // Narration Premium's reference-image flow (options.referenceImage) —
    // the caller (StoryStudio, in the real product flow) generates this
    // once and attaches it to every frame; see steps/builders/image-edit.ts.
    referenceImageUrl: z.string().url().optional(),
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
    // Narration Premium: run step 0 (image-i2i, qwen-image-edit) instead of
    // step 1 (t2i, qwen-image-gen) — see STEP_TOPOLOGY below. Defaults to
    // today's Basic-tier behavior.
    referenceImage: z.boolean().default(false),
    // Narration Premium: route step 2 (tts) to the Qwen3-TTS voice-design
    // payload instead of Kokoro's — see steps/builders/tts.ts.
    voiceEngine: z.enum(['kokoro', 'qwen']).default('kokoro'),
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
    // Qwen3-TTS voice-design fields (options.voiceEngine === 'qwen'),
    // request-level like the real AWS contract's §9.1 shape — mirrors
    // voiceSpeaker/voiceInstruct/voiceLanguage in
    // docs/storystudio-qm-new-sfn-trigger.md §9.2. Ignored for Kokoro.
    voiceSpeaker: z.string().optional(),
    voiceInstruct: z.string().optional(),
    voiceLanguage: z.string().optional(),
    // Step 5 (bgm generation, ACE-Step) — request-level like voiceSpeaker et
    // al., matches the real AWS contract's bgmPrompt. Required (checked
    // below, not by zod, so the error names the right field) whenever
    // options.bgm is true.
    bgmPrompt: z.string().optional(),
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
  // seq 0 (image-i2i) and seq 1 (image t2i) are mutually exclusive — the
  // Narration Premium reference-image flow (options.referenceImage) runs
  // seq 0 instead of seq 1, never both. See steps/catalog.ts's header
  // comment on why seq 0 (not 14) — it must sort before seq 1/2/3/6.
  { seq: 0, gatedBy: (o) => o.referenceImage },
  { seq: 1, gatedBy: (o) => !o.referenceImage },
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

/** Pure step/job construction — no DB, no clock — so it's unit-testable via
 * `_internal` the same way resolveStepSet/computeDrainAfter already are.
 * Branches per catalogued step on `c.singleJobPerProject`
 * (steps/catalog.ts): unset/false plans one job per frame (unchanged
 * behavior); true plans exactly ONE project-scoped job (frameId: null),
 * fanned in on every frame's eventual completion of each dependency step —
 * see agents/generator.ts's resolveProjectDeps() and db/repo/jobs.ts's
 * markTerminal() for the runtime side that decrements it N times. */
/**
 * Filters a step's declared `dependsOn` down to what's actually catalogued
 * for this request, then collapses any entry that's ITSELF a dependency of
 * another surviving entry in the same list — e.g. step 11 (burn captions)
 * declares `dependsOn: [10, 8]` (prefer step 10/upscale's output, fall back
 * to step 8/concat's when upscale is off — steps/builders/caption.ts), but
 * concat and upscale are NOT mutually exclusive like image steps 0/1 are
 * (concat always runs; upscale is an independent options.upscale toggle) —
 * when upscale IS on, both 8 and 10 are catalogued, and since 10 already
 * depends on 8, counting 8 again here would double the fan-in and leave the
 * job stuck waiting on a second decrement that never comes (10's completion
 * only decrements ONCE). Not recursive — sufficient for today's chain depth
 * (8 -> 10 -> 11); a deeper chain would need this applied transitively. */
function resolveDirectDependencies(dependsOn: number[], catalogued: CatalogEntry[]): number[] {
  const planned = dependsOn.filter((d) => catalogued.some((cc) => cc.seq === d));
  return planned.filter(
    (d) => !planned.some((other) => other !== d && catalogued.find((cc) => cc.seq === other)?.dependsOn.includes(d)),
  );
}

function buildStepsAndJobs(
  catalogued: CatalogEntry[],
  req: OrchestratorRequest,
  projectId: string,
  workersTarget: number,
): { steps: NewStep[]; jobs: NewJob[] } {
  const steps: NewStep[] = catalogued.map((c) => ({
    seq: c.seq,
    name: c.name,
    endpointId: c.endpointId,
    workersTarget,
    gate: c.gate,
    drainAfter: true, // overwritten by computeDrainAfter below
    dependsOn: resolveDirectDependencies(c.dependsOn, catalogued),
    jobTotal: c.singleJobPerProject ? 1 : req.frames.length,
  }));
  computeDrainAfter(steps);

  const jobs: NewJob[] = [];
  for (const c of catalogued) {
    const dependsOnPlanned = resolveDirectDependencies(c.dependsOn, catalogued);

    if (c.singleJobPerProject) {
      // Each dependency step contributes one decrement per producer job it
      // actually plans: req.frames.length for an ordinary per-frame step
      // (e.g. step 6/merge), or exactly 1 for another singleJobPerProject
      // step (e.g. step 10/upscale depending on step 8/concat's one output)
      // — a project-scoped producer only ever completes once. Widened
      // 2026-09-12 alongside db/repo/jobs.ts's markTerminal(), which now
      // fires this decrement on 'failed' too, so one bad frame (or a failed
      // upstream singleJobPerProject job) can't stall this forever.
      const depsRemaining = dependsOnPlanned.reduce((sum, depSeq) => {
        const depEntry = catalogued.find((cc) => cc.seq === depSeq);
        return sum + (depEntry?.singleJobPerProject ? 1 : req.frames.length);
      }, 0);
      jobs.push({
        projectId,
        stepSeq: c.seq,
        seq: 0,
        frameId: null,
        depsRemaining,
        // Most singleJobPerProject builders (concat, upscale, caption) never
        // read ctx.job — they only need ctx.perFrameOutputs — but step 5
        // (bgm generation) has no dependsOn to resolve outputs from at all,
        // so its prompt/target duration have to travel here instead. Cheap
        // to include unconditionally rather than special-casing bgm.
        input: {
          bgmPrompt: req.bgmPrompt,
          totalDurationS: req.frames.reduce((sum, f) => sum + f.durationS, 0),
        },
      });
      continue;
    }

    req.frames.forEach((frame, idx) => {
      const input: FrameJobInput = {
        frameId: frame.frameId,
        imagePrompt: frame.imagePrompt,
        narration: frame.narration,
        durationS: frame.durationS,
        motionPrompt: frame.motionPrompt,
        aspectRatio: req.aspectRatio,
        language: req.language,
        referenceImageUrl: frame.referenceImageUrl,
        voiceEngine: req.options.voiceEngine,
        voiceSpeaker: req.voiceSpeaker,
        voiceInstruct: req.voiceInstruct,
        voiceLanguage: req.voiceLanguage,
      };
      jobs.push({
        projectId,
        stepSeq: c.seq,
        seq: idx,
        frameId: frame.frameId,
        depsRemaining: dependsOnPlanned.length,
        input,
      });
    });
  }

  return { steps, jobs };
}

export async function plan(pool: Pool, cfg: Pick<Config, 'workersHead'>, rawRequest: unknown): Promise<PlanAck> {
  const parsed = RequestSchema.safeParse(rawRequest);
  if (!parsed.success) throw new PlanValidationError(parsed.error.issues);
  const req = parsed.data;

  // options.referenceImage routes every frame through step 0 (image-i2i),
  // which throws at build time if referenceImageUrl is missing — fail fast
  // here instead, with a clear message, rather than mid-run per frame.
  if (req.options.referenceImage) {
    const missing = req.frames.filter((f) => !f.referenceImageUrl).map((f) => f.frameId);
    if (missing.length > 0) {
      throw new PlanValidationError([
        {
          code: z.ZodIssueCode.custom,
          path: ['frames'],
          message: `options.referenceImage is true but these frames have no referenceImageUrl: ${missing.join(', ')}`,
        },
      ]);
    }
  }

  // options.bgm plans step 5 (bgm generation), which throws at build time
  // without a prompt to generate from — fail fast here instead.
  if (req.options.bgm && !req.bgmPrompt) {
    throw new PlanValidationError([
      { code: z.ZodIssueCode.custom, path: ['bgmPrompt'], message: 'options.bgm is true but bgmPrompt is missing' },
    ]);
  }

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

      const { steps: newSteps, jobs: newJobs } = buildStepsAndJobs(catalogued, req, project.id, cfg.workersHead);
      await insertSteps(client, cohort.id, newSteps);
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
export const _internal = { computeDrainAfter, resolveStepSet, STEP_TOPOLOGY, buildStepsAndJobs };

export const _catalogSize = STEP_CATALOG.length;
