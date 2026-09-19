/**
 * Environment parsing, fail-fast. Nothing else in the orchestrator reads
 * process.env directly — it calls loadConfig() once at boot and passes the
 * frozen result down. An invalid or missing value is a startup crash with a
 * readable list of what is wrong, never a `undefined` that surfaces three
 * steps into a cohort.
 *
 * Defaults mirror impl plan §17 (Appendix — configuration). Only the three
 * secrets have no default; everything operational has one so a dev box runs
 * with just DATABASE_URL + the two tokens set.
 */
import { z } from 'zod';

const numeric = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const ConfigSchema = z.object({
  // ── runtime ────────────────────────────────────────────────────────────
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  port: numeric(8080).pipe(z.number().int().positive()),

  // ── datastore ──────────────────────────────────────────────────────────
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
  pgPoolMax: numeric(20).pipe(z.number().int().positive()),
  pgStatementTimeoutMs: numeric(15_000).pipe(z.number().int().nonnegative()),

  // ── ingress auth ───────────────────────────────────────────────────────
  ingestToken: z.string().min(1, 'ORCH_INGEST_TOKEN is required'),
  webhookSecret: z.string().min(1, 'ORCH_WEBHOOK_SECRET is required'),
  // Admin dashboard + fleet/cohort/rework routes (http/routes/admin.ts,
  // 2026-09-16) — deliberately its own secret, not ingestToken, so a
  // credential StoryStudio holds (for POST /v1/requests) can't also trigger
  // a rework or read cost data. GET /v1/fleet and /v1/cohorts/:id had no
  // auth at all before this — closed while adding the rest of this surface.
  adminToken: z.string().min(1, 'ORCH_ADMIN_TOKEN is required'),
  // Spec §11: "hostname stability is now a correctness requirement, not a
  // convenience" — every submitted job's webhook URL is built from this. No
  // default; a wrong or missing value breaks every callback for the cohort
  // that started while it was wrong, silently (the generator's reconcile
  // tick is the only thing that would eventually notice).
  publicBaseUrl: z.string().url('ORCH_PUBLIC_BASE_URL is required, e.g. https://orchestrator.ai-storystudio.com'),

  // ── RunPod ─────────────────────────────────────────────────────────────
  // Optional in M0 — no milestone before M2 makes a RunPod call, and M0's
  // exit criterion is DB + /v1/health only.
  runpodApiKey: z.string().optional(),
  runpodApiBase: z.string().url().default('https://api.runpod.ai/v2'),
  runpodRestBase: z.string().url().default('https://rest.runpod.io/v1'),
  runpodMaxRetries: numeric(5).pipe(z.number().int().nonnegative()),
  runpodTimeoutMs: numeric(30_000).pipe(z.number().int().positive()),

  // ── fleet / window (impl plan §17) ─────────────────────────────────────
  fleetLive: bool(false), // ORCH_FLEET_LIVE — false = log PATCHes, never send
  windowCron: z.string().default('0 0,6,12,18 * * *'),
  // Two ingestion modes (2026-09-16) — deliberately named apart from
  // StoryStudio's OWN, unrelated QM_ORCH_MODE (off/shadow/live, their
  // routing switch): this is purely QM's internal ingestion behavior.
  // 'project' (default): POST /v1/requests plans and drives each request
  // immediately on arrival — today's exact behavior. 'batch': requests are
  // queued (request_outbox) and only planned together, once, when
  // windowCron fires — see agents/batch-window.ts.
  schedulingMode: z.enum(['project', 'batch']).default('project'),
  // Requests received within this many minutes of a window boundary roll to
  // the NEXT window's batch rather than this one's — gives stragglers a
  // clean home instead of racing the boundary.
  windowCutoffMinutes: numeric(15).pipe(z.number().int().nonnegative()),
  workersHead: numeric(25).pipe(z.number().int().positive()),
  // Lowered 10→4 (2026-09-17, fixed-pool migration — see agents/fleet.ts's
  // header comment): postprod-lite's real dashboard pod count is 4, so this
  // now matches it exactly instead of over-dispatching by more than double.
  workersTail: numeric(4).pipe(z.number().int().positive()),
  // 2026-09-16: lets the bulk/generation dispatch loop submit up to this
  // many MORE jobs than workersHead's real worker count, so they sit queued
  // inside RunPod itself rather than waiting on our own next poll tick — no
  // idle GPU time between one job finishing and the next being noticed.
  // Deliberately only applied at the bulk runStep() call site
  // (agents/orchestrator.ts), never to allocate()'s real workersMax PATCH
  // (that stays at workersHead — no extra real GPU spend) and never to the
  // assembly tail (workersTail) — postprod-lite's real deployed capacity is
  // small, and over-queuing there risks a job's RunPod queue wait pushing
  // past its own execution timeout.
  queueBufferWorkers: numeric(10).pipe(z.number().int().nonnegative()),
  // 2026-09-16, post-incident (docs/qm-orchestrator-incident-report-2026-09-16-runpod-capacity.md):
  // runStep() used to submit its full dispatch target (workersHead +
  // queueBufferWorkers, e.g. 35) in one burst the moment a step started,
  // against an endpoint allocate() had JUST raised workersMax on — 0 real
  // workers up yet. Ramps the INITIAL fill instead: dispatchRampBatchSize
  // jobs go out immediately, then that many more every
  // dispatchRampIntervalMs, until the full target is reached (5 every 5s ->
  // 35 by 30s) — RunPod's autoscaler gets a chance to grow real capacity
  // into a climbing curve instead of a step function. Purely an initial-fill
  // shape: once the ramp reaches targetWorkers it's mathematically
  // identical to the steady-state "top back up to targetWorkers as jobs
  // complete" behavior already in place, no special-casing needed.
  dispatchRampBatchSize: numeric(5).pipe(z.number().int().positive()),
  dispatchRampIntervalMs: numeric(5_000).pipe(z.number().int().positive()),
  liveReserveWorkers: numeric(8).pipe(z.number().int().nonnegative()),
  accountCap: numeric(40).pipe(z.number().int().positive()),
  warmTimeoutMs: numeric(480_000).pipe(z.number().int().positive()),
  drainTimeoutMs: numeric(300_000).pipe(z.number().int().positive()),
  reconcileIntervalMs: numeric(60_000).pipe(z.number().int().positive()),
  maxAttempts: numeric(2).pipe(z.number().int().positive()),
  // Real incident, 2026-09-16 (this orchestrator's first live StoryStudio
  // request): 5/18 image jobs hit "CUDA out of memory" and both exhausted
  // maxAttempts=2 permanently, dropping those frames from the final video.
  // The failure wasn't a defect in the request — a retry has a real chance
  // of landing on a different, adequately-sized RunPod worker (see
  // runpod/types.ts's isResourceExhaustionError() header comment) — so
  // this class of failure gets a higher ceiling than a generic one.
  maxResourceAttempts: numeric(5).pipe(z.number().int().positive()),
  qualityGates: z.enum(['full', 'sampled', 'image-only', 'off']).default('full'),
  workerRateUsdS: numeric(0.00021).pipe(z.number().positive()),

  // ── watchdog (impl plan §6.9 / M3) ────────────────────────────────────
  // Runs as its own process (watchdog.ts), own pg.Pool, own RunpodClient —
  // deliberately not sharing this config object's constructed instances, so
  // it survives the main orchestrator process's death, which is the entire
  // point. No DynamoDB/AWS SDK here: MCP-originated traffic never touches
  // the AWS Lambda live-path provisioner, so endpoint_state (Postgres,
  // already in 001_init.sql) is the only source of truth it needs.
  watchdogIntervalMs: numeric(60_000).pipe(z.number().int().positive()),
  watchdogAutodrain: bool(false), // alert-only until proven false-positive-free (§16 q10)
  orphanGraceMs: numeric(600_000).pipe(z.number().int().positive()),
  watchdogAlertWebhookUrl: z.string().url().optional(), // unset = log-only, no-op

  // ── diagnostics (read-only Sonnet assistant, 2026-09-17) ──────────────
  // Fires only on an existing failure signal (watchdog orphan, a project
  // finalizing failed/partial, a generator stall timeout) — never a poll.
  // Same env var / adapter pattern as src/adapters/anthropic.ts (the 4lang
  // translation Lambda adapter) — one Anthropic account, two call sites.
  // Unset = the whole feature is a no-op (mirrors watchdogAlertWebhookUrl).
  anthropicApiKey: z.string().optional(),
  anthropicModel: z.string().default('claude-sonnet-5'),
  // The read-only diagnostic assistant (diagnostics/diagnose.ts) reaches
  // Sonnet 5 through REPLICATE, not the Anthropic API — changed 2026-09-19
  // after the direct account ran out of credit and every diagnostic on the
  // VPS failed with "Your credit balance is too low". It now rides the same
  // token/transport the quality gate and prompt rewriter use, so the
  // orchestrator has one LLM billing relationship, not two.
  // `replicateApiToken` unset = the feature is off, the same way
  // watchdogAlertWebhookUrl works.
  diagnosticsModel: z.string().default('anthropic/claude-sonnet-5'),
  // 'low' (the model's own default) disables thinking. This is a short,
  // structured-JSON judgement over a snapshot the orchestrator already
  // assembled — an alerting path should be fast and cheap, not thoughtful.
  diagnosticsEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),

  // ── quality gates (impl plan §6.5 / M4) ───────────────────────────────
  // Replicate-hosted VLM, ported from the AWS-side dialogue-basic-qa-agent
  // (image_evaluator.py/video_evaluator.py/llm_client.py/config.py) — same
  // model, same thresholds, same weights, just called directly instead of
  // through that Lambda. No new credential: REPLICATE_API_TOKEN already
  // exists in AWS Secrets Manager (quartermaster/replicate-api-token) and
  // this is the same env var name the Python config.py already uses.
  replicateApiToken: z.string().optional(),
  replicateApiBase: z.string().url().default('https://api.replicate.com/v1'),
  replicateVisionModel: z.string().default('google/gemini-2.5-flash'),
  replicateVisionModelFallback: z.string().default('google/gemini-3-pro'),
  replicatePollIntervalMs: numeric(3_000).pipe(z.number().int().positive()),
  replicateMaxPollAttempts: numeric(80).pipe(z.number().int().positive()), // ~4min max, matches the Python original
  replicateTimeoutMs: numeric(120_000).pipe(z.number().int().positive()),
  // Replicate's prediction response has no reliable per-call cost field —
  // same situation WORKER_RATE_USD_S already solved for RunPod. A clearly-
  // labeled estimate, not a measurement (telemetry/ledger.ts's own
  // precedent: "an estimate labelled measured that is actually a guess is
  // worse than no estimate").
  qualityVlmCostUsd: numeric(0.002).pipe(z.number().nonnegative()),
  qualityImagePassThreshold: numeric(8.0).pipe(z.number()),
  qualityImageReviewThreshold: numeric(7.0).pipe(z.number()),
  qualityVideoGateThreshold: numeric(7.5).pipe(z.number()),
  qualityVideoPassThreshold: numeric(5.0).pipe(z.number()),
  // Equal to qualityVideoPassThreshold by design, not an oversight — ported
  // verbatim from config.py's QA_VIDEO_REVIEW_THRESHOLD comment: the video
  // evaluator checks PASS before REWORK, so a REVIEW threshold above PASS
  // would never fire; this collapses the REWORK tier deliberately rather
  // than leaving it dead code above an unreachable band.
  qualityVideoReviewThreshold: numeric(5.0).pipe(z.number()),
  // Consecutive evaluation-call failures (Replicate errors, not verdicts)
  // before an asset is passed through unevaluated (verdict EVAL_ERROR).
  qualityEvalMaxFailures: numeric(3).pipe(z.number().int().positive()),
  // QA rework prompt rewriter (2026-09-15): Replicate-hosted LLM that
  // rewrites a rejected image/motion prompt from the evaluator's issues.
  replicateRewriteModel: z.string().default('openai/gpt-5-mini'),
  replicateRewriteReasoning: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),

  // ── prompt harness (docs/qm-orchestrator-prompt-harness-implementation-plan.md) ──
  // Bounded concurrency for harness/index.ts's prepareCohort() — how many
  // projects' GPT-5 mini extract/regenerate calls run at once. Per-request
  // rollout is options.promptHarness (planner.ts); this has no off switch
  // of its own — 'off' is set per-request, not per-account, since a single
  // account-wide kill switch would fight the milestone-by-milestone rollout
  // the implementation plan describes (§0, §12).
  harnessToolConcurrency: numeric(8).pipe(z.number().int().positive()),

  // ── result callback (impl plan §6.7 / M5) ─────────────────────────────
  // Optional HMAC key for X-QM-Signature on the §9.6 result POST. Its own
  // secret, not ORCH_WEBHOOK_SECRET: the receiver (Convex) must be able to
  // verify callbacks without also being able to mint RunPod webhook tokens.
  // Unset = unsigned.
  callbackSecret: z.string().min(1).optional(),
  callbackMaxAttempts: numeric(8).pipe(z.number().int().positive()),
  callbackBaseDelayMs: numeric(1_000).pipe(z.number().int().positive()),
  callbackMaxDelayMs: numeric(300_000).pipe(z.number().int().positive()),
  callbackTimeoutMs: numeric(15_000).pipe(z.number().int().positive()),

  // ── Remotion text overlay (step 16, steps/catalog.ts's `source: 'lambda'`) ──
  // The one deliberate AWS SDK exception (2026-09-16) — see
  // src/lambda/client.ts's header comment. Credentials come from the
  // default AWS SDK provider chain (env/instance role), not from this
  // config — the VPS box needs `lambda:InvokeFunction` on this function.
  remotionLambdaFunctionName: z.string().default('QM-remotion-overlay'),
  remotionLambdaRegion: z.string().default('us-east-1'),
  // Same "clearly-labeled estimate, not a measurement" precedent as
  // qualityVlmCostUsd above: Lambda's job_costs row is computed the same
  // way as RunPod's (execution_ms * rate), but this rate is derived from
  // one live-tested render (~$0.00146 over ~11.46s wrapper execution ≈
  // $0.000127/s), not Remotion's own real per-chunk billing (which isn't
  // perfectly linear in wall time) — right order of magnitude, correctable
  // later from real job_costs data.
  lambdaRenderRateUsdS: numeric(0.000127).pipe(z.number().positive()),

  // ── R2 persistence for step 16's Lambda output (src/r2/client.ts) ──────
  // Remotion Lambda's own output lives on ITS S3 bucket, not QM's — same
  // "external providers return ephemeral delivery URLs" risk the top-level
  // repo's src/shared/persistExternalAsset.ts exists for (real incident,
  // 2026-08-17: 103/122 shots lost to dead replicate.delivery links). This
  // orchestrator's whole ecosystem already stores permanent output in R2
  // (postprod-lite etc.), so step 16 re-hosts there instead of AWS S3 — same
  // bucket/account every other QM service already writes to. Account/bucket/
  // public-URL defaults are that shared, non-secret `e2e-storystudio`
  // config (orchestrator/containers/media.md); access key/secret have no
  // default, same as replicateApiToken above.
  r2AccountId: z.string().default('620baa808df08b1a30d448989365f7dd'),
  r2Bucket: z.string().default('e2e-storystudio'),
  r2PublicUrl: z.string().url().default('https://pub-bce4924e66d944668be30268ccf4492c.r2.dev'),
  r2AccessKeyId: z.string().optional(),
  r2SecretAccessKey: z.string().optional(),

  // ── asset pipeline (src/assets/, migration 013) ────────────────────────
  // Which model a request is executed under. 'cohort' is the window/step
  // graph that has run every live project to date and stays the default —
  // flipping this is the rollout switch for the per-asset generator agents,
  // nothing else changes. 'assets' routes POST /v1/requests to
  // assets/submit.ts and starts the eight agents plus the project compiler.
  pipelineMode: z.enum(['cohort', 'assets']).default('cohort'),
  // How often each generator agent polls its own table. Short on purpose:
  // the whole point of the model is that a finished asset releases the next
  // one immediately, and a tick with nothing to do is two indexed queries.
  assetTickMs: numeric(5_000).pipe(z.number().int().positive()),
  // How often the project compiler sweeps live projects. Longer than an
  // agent tick — it is a fan-in check and a repair pass, not a dispatcher.
  compilerTickMs: numeric(30_000).pipe(z.number().int().positive()),
  // Most an agent will dispatch in one tick, on top of its endpoint's pod
  // ceiling. Keeps a 74-frame project from bursting an endpoint's whole
  // queue in one go right as it comes out of a drift-to-zero (the
  // dispatch-ramp lesson of 2026-09-16).
  assetDispatchBatchSize: numeric(4).pipe(z.number().int().positive()),
  // How long a submitted asset may go without news before the reconcile
  // scan polls RunPod for it. The webhook is the fast path; this is the
  // fallback for one that never arrives.
  assetReconcileAfterMs: numeric(60_000).pipe(z.number().int().positive()),
  // Quality gating for the gated generation kinds (src/assets/quality.ts).
  // 'full'   (default) local structural checks on EVERY asset, plus the
  //          Replicate VLM semantic score on a sampled fraction of them.
  // 'local'  structural checks only — free, no API. What 'full' degrades to
  //          when REPLICATE_API_TOKEN is unset.
  // 'off'    no gate — a completed asset hands off immediately.
  assetQa: z.enum(['off', 'local', 'full']).default('full'),
  assetQaBatchSize: numeric(8).pipe(z.number().int().positive()),
  assetQaTickMs: numeric(10_000).pipe(z.number().int().positive()),
  // What fraction of assets get the PAID VLM check. The free local tier always
  // runs at 100%; this is only the Replicate call. 0.3 today; the target is
  // 0.1 once the prompt harness describes movement and direction well enough
  // that the remaining failures are predictable. 0 disables the VLM tier
  // without turning the local one off.
  assetQaSampleRate: numeric(0.3).pipe(z.number().min(0).max(1)),
  // Multipliers on the rate. A shot that asks for movement and direction is
  // where a VLM earns its keep; a static portrait rarely surprises anyone.
  // At rate 0.3 these give ~75% and ~12% respectively.
  assetQaMotionWeight: numeric(2.5).pipe(z.number().positive()),
  assetQaStaticWeight: numeric(0.4).pipe(z.number().min(0)),
});

export type Config = Readonly<z.infer<typeof ConfigSchema>>;

const ENV_KEYS: Record<keyof z.infer<typeof ConfigSchema>, string> = {
  nodeEnv: 'NODE_ENV',
  logLevel: 'LOG_LEVEL',
  port: 'ORCH_PORT',
  databaseUrl: 'DATABASE_URL',
  pgPoolMax: 'PG_POOL_MAX',
  pgStatementTimeoutMs: 'PG_STATEMENT_TIMEOUT_MS',
  ingestToken: 'ORCH_INGEST_TOKEN',
  adminToken: 'ORCH_ADMIN_TOKEN',
  webhookSecret: 'ORCH_WEBHOOK_SECRET',
  publicBaseUrl: 'ORCH_PUBLIC_BASE_URL',
  runpodApiKey: 'RUNPOD_API_KEY',
  runpodApiBase: 'RUNPOD_API_BASE',
  runpodRestBase: 'RUNPOD_REST_BASE',
  runpodMaxRetries: 'RUNPOD_MAX_RETRIES',
  runpodTimeoutMs: 'RUNPOD_TIMEOUT_MS',
  fleetLive: 'ORCH_FLEET_LIVE',
  windowCron: 'ORCH_WINDOW_CRON',
  schedulingMode: 'ORCH_SCHEDULING_MODE',
  windowCutoffMinutes: 'ORCH_WINDOW_CUTOFF_MINUTES',
  workersHead: 'ORCH_WORKERS_HEAD',
  workersTail: 'ORCH_WORKERS_TAIL',
  queueBufferWorkers: 'ORCH_QUEUE_BUFFER_WORKERS',
  dispatchRampBatchSize: 'ORCH_DISPATCH_RAMP_BATCH_SIZE',
  dispatchRampIntervalMs: 'ORCH_DISPATCH_RAMP_INTERVAL_MS',
  liveReserveWorkers: 'QM_LIVE_RESERVE_WORKERS',
  accountCap: 'RUNPOD_ACCOUNT_CAP',
  warmTimeoutMs: 'ORCH_WARM_TIMEOUT_MS',
  drainTimeoutMs: 'ORCH_DRAIN_TIMEOUT_MS',
  reconcileIntervalMs: 'ORCH_RECONCILE_INTERVAL_MS',
  maxAttempts: 'ORCH_MAX_ATTEMPTS',
  maxResourceAttempts: 'ORCH_MAX_RESOURCE_ATTEMPTS',
  qualityGates: 'ORCH_QUALITY_GATES',
  workerRateUsdS: 'WORKER_RATE_USD_S',
  watchdogIntervalMs: 'WATCHDOG_INTERVAL_MS',
  watchdogAutodrain: 'WATCHDOG_AUTODRAIN',
  orphanGraceMs: 'ORPHAN_GRACE_MS',
  watchdogAlertWebhookUrl: 'WATCHDOG_ALERT_WEBHOOK_URL',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  anthropicModel: 'ANTHROPIC_MODEL',
  diagnosticsModel: 'ORCH_DIAGNOSTICS_MODEL',
  diagnosticsEffort: 'ORCH_DIAGNOSTICS_EFFORT',
  replicateApiToken: 'REPLICATE_API_TOKEN',
  replicateApiBase: 'REPLICATE_API_BASE',
  replicateVisionModel: 'REPLICATE_VISION_MODEL',
  replicateVisionModelFallback: 'REPLICATE_VISION_MODEL_FALLBACK',
  replicatePollIntervalMs: 'REPLICATE_POLL_INTERVAL_MS',
  replicateMaxPollAttempts: 'REPLICATE_MAX_POLL_ATTEMPTS',
  replicateTimeoutMs: 'REPLICATE_TIMEOUT_MS',
  qualityVlmCostUsd: 'QUALITY_VLM_COST_USD',
  qualityImagePassThreshold: 'QA_IMAGE_PASS_THRESHOLD',
  qualityImageReviewThreshold: 'QA_IMAGE_REVIEW_THRESHOLD',
  qualityVideoGateThreshold: 'QA_VIDEO_GATE_THRESHOLD',
  qualityVideoPassThreshold: 'QA_VIDEO_PASS_THRESHOLD',
  qualityVideoReviewThreshold: 'QA_VIDEO_REVIEW_THRESHOLD',
  qualityEvalMaxFailures: 'QA_EVAL_MAX_FAILURES',
  replicateRewriteModel: 'REPLICATE_REWRITE_MODEL',
  replicateRewriteReasoning: 'REPLICATE_REWRITE_REASONING',
  harnessToolConcurrency: 'ORCH_HARNESS_TOOL_CONCURRENCY',
  callbackSecret: 'ORCH_CALLBACK_SECRET',
  callbackMaxAttempts: 'ORCH_CALLBACK_MAX_ATTEMPTS',
  callbackBaseDelayMs: 'ORCH_CALLBACK_BASE_DELAY_MS',
  callbackMaxDelayMs: 'ORCH_CALLBACK_MAX_DELAY_MS',
  callbackTimeoutMs: 'ORCH_CALLBACK_TIMEOUT_MS',
  remotionLambdaFunctionName: 'REMOTION_LAMBDA_FUNCTION_NAME',
  remotionLambdaRegion: 'REMOTION_LAMBDA_REGION',
  lambdaRenderRateUsdS: 'LAMBDA_RENDER_RATE_USD_S',
  r2AccountId: 'R2_ACCOUNT_ID',
  r2Bucket: 'R2_BUCKET_NAME',
  r2PublicUrl: 'R2_PUBLIC_URL',
  r2AccessKeyId: 'R2_ACCESS_KEY_ID',
  r2SecretAccessKey: 'R2_SECRET_ACCESS_KEY',
  pipelineMode: 'ORCH_PIPELINE_MODE',
  assetTickMs: 'ORCH_ASSET_TICK_MS',
  compilerTickMs: 'ORCH_COMPILER_TICK_MS',
  assetDispatchBatchSize: 'ORCH_ASSET_DISPATCH_BATCH_SIZE',
  assetReconcileAfterMs: 'ORCH_ASSET_RECONCILE_AFTER_MS',
  assetQa: 'ORCH_ASSET_QA',
  assetQaBatchSize: 'ORCH_ASSET_QA_BATCH_SIZE',
  assetQaTickMs: 'ORCH_ASSET_QA_TICK_MS',
  assetQaSampleRate: 'ORCH_ASSET_QA_SAMPLE_RATE',
  assetQaMotionWeight: 'ORCH_ASSET_QA_MOTION_WEIGHT',
  assetQaStaticWeight: 'ORCH_ASSET_QA_STATIC_WEIGHT',
};

/**
 * Parse `env` (defaults to process.env) into a frozen Config, or throw with
 * every problem listed at once. `estimateBasis`-style guesswork has no place
 * here: if a value is set but unparseable, that is an error, not a fallback.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = Object.fromEntries(
    (Object.entries(ENV_KEYS) as [keyof z.infer<typeof ConfigSchema>, string][]).map(
      ([field, key]) => [field, env[key]],
    ),
  );

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const field = i.path[0] as keyof z.infer<typeof ConfigSchema>;
      return `  - ${ENV_KEYS[field] ?? String(field)}: ${i.message}`;
    });
    throw new Error(`invalid orchestrator configuration:\n${lines.join('\n')}`);
  }
  return Object.freeze(parsed.data);
}
