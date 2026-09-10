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
  workersHead: numeric(25).pipe(z.number().int().positive()),
  workersTail: numeric(10).pipe(z.number().int().positive()),
  liveReserveWorkers: numeric(8).pipe(z.number().int().nonnegative()),
  accountCap: numeric(40).pipe(z.number().int().positive()),
  warmTimeoutMs: numeric(480_000).pipe(z.number().int().positive()),
  drainTimeoutMs: numeric(300_000).pipe(z.number().int().positive()),
  reconcileIntervalMs: numeric(60_000).pipe(z.number().int().positive()),
  maxAttempts: numeric(2).pipe(z.number().int().positive()),
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
  webhookSecret: 'ORCH_WEBHOOK_SECRET',
  publicBaseUrl: 'ORCH_PUBLIC_BASE_URL',
  runpodApiKey: 'RUNPOD_API_KEY',
  runpodApiBase: 'RUNPOD_API_BASE',
  runpodRestBase: 'RUNPOD_REST_BASE',
  runpodMaxRetries: 'RUNPOD_MAX_RETRIES',
  runpodTimeoutMs: 'RUNPOD_TIMEOUT_MS',
  fleetLive: 'ORCH_FLEET_LIVE',
  windowCron: 'ORCH_WINDOW_CRON',
  workersHead: 'ORCH_WORKERS_HEAD',
  workersTail: 'ORCH_WORKERS_TAIL',
  liveReserveWorkers: 'QM_LIVE_RESERVE_WORKERS',
  accountCap: 'RUNPOD_ACCOUNT_CAP',
  warmTimeoutMs: 'ORCH_WARM_TIMEOUT_MS',
  drainTimeoutMs: 'ORCH_DRAIN_TIMEOUT_MS',
  reconcileIntervalMs: 'ORCH_RECONCILE_INTERVAL_MS',
  maxAttempts: 'ORCH_MAX_ATTEMPTS',
  qualityGates: 'ORCH_QUALITY_GATES',
  workerRateUsdS: 'WORKER_RATE_USD_S',
  watchdogIntervalMs: 'WATCHDOG_INTERVAL_MS',
  watchdogAutodrain: 'WATCHDOG_AUTODRAIN',
  orphanGraceMs: 'ORPHAN_GRACE_MS',
  watchdogAlertWebhookUrl: 'WATCHDOG_ALERT_WEBHOOK_URL',
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
