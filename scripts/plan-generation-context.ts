/**
 * Gathers live QM fleet/queue state into one JSON blob for the `/plan-generation`
 * Claude Code skill (.claude/skills/plan-generation/SKILL.md). Read-only — makes
 * no admission decisions itself, just assembles the same inputs admission.ts's
 * decide() uses (plus static model/GPU reference data) so an LLM (or a human)
 * can reason about a generation plan with real numbers instead of guessing.
 *
 * Usage:
 *   npx ts-node scripts/plan-generation-context.ts [projectType] [durationSeconds]
 *
 * projectType/durationSeconds are optional — when given, also prints the
 * projected per-endpoint job load for that project (via projectAssetLoad),
 * so the plan can be sized against a specific incoming request.
 */

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { getInflight } from '../src/gate/dynamo-gate';
import { listActiveReservations } from '../src/gate/reservation-gate';
import { ENDPOINTS, gatherQueuedByEndpoint, getEndpointWorkersMax } from '../src/handlers/provisioner';
import { projectAssetLoad } from '../src/shared/assetLoad';

const TABLE = process.env.TABLE_NAME ?? 'quartermaster-jobs';
const db = new DynamoDBClient({});

// Kept in sync by hand with admission.ts's own module-level consts (same env
// vars, same defaults) — this script only reads state, it doesn't decide.
const ACCOUNT_CAP = Number(process.env.RUNPOD_ACCOUNT_CAP ?? 10);
const JOBS_PER_WORKER = Number(process.env.RUNPOD_JOBS_PER_WORKER ?? 4);
const SFN_MAP_MAX_CONCURRENCY = Number(process.env.ADMISSION_MAP_CONCURRENCY ?? 15);
// narration-premium touches 3 endpoints/frame, so it gets its own (lower) ceiling
// — see admission.ts's PREMIUM_MAP_CONCURRENCY for the full reasoning (a solo
// premium project at the basic ceiling of 15 alone exceeds ACCOUNT_CAP).
const PREMIUM_MAP_CONCURRENCY = Number(process.env.ADMISSION_PREMIUM_MAP_CONCURRENCY ?? 8);
const MAX_DRAIN_MS = Number(process.env.ADMISSION_MAX_DRAIN_MS ?? 30 * 60_000);

const SEED_MS: Record<string, number> = {
  'runpod:flux-tts-s2t': 12_500,
  'runpod:qwen-image-gen': 8_000,
  'runpod:qwen-image-edit': 15_000,
  'runpod:wan2-i2v': 92_000,
};
const DEFAULT_SEED_MS = 15_000;

// Static reference: what's hosted where + real-world GPU/cold-start facts a
// pure DB query can't tell you. Update when runpod/API.md's endpoint set changes.
const MODEL_CATALOG: Record<string, { gpu: string; coldStartS: string; models: string[] }> = {
  'runpod:flux-tts-s2t': {
    gpu: 'A40/A6000 24-48GB',
    coldStartS: '~150-210s (loads Flux+Kokoro+Qwen-TTS+Whisper+ACE-Step together — shared worker)',
    models: [
      'FLUX.2 klein 4B — image t2i/i2i (narration-basic)',
      'Kokoro-82M — TTS (narration-basic, 54 voices)',
      'Qwen3-TTS-1.7B CustomVoice — TTS voice design (narration-premium, 9 speakers)',
      'Whisper large-v3-turbo — transcription/SRT',
      'ACE-Step 1.5 — BGM (both tiers)',
      'Flux animate/merge/concat/caption/mix_bgm — post-production',
    ],
  },
  'runpod:qwen-image-gen': {
    gpu: 'A40/A6000/A100',
    coldStartS: '~150-210s',
    models: ['Qwen-Image (FP8 + LightX2V 4-step Lightning) — text-to-image (t2i)'],
  },
  'runpod:qwen-image-edit': {
    gpu: 'A40/A6000/A100',
    coldStartS: '~150-210s',
    models: ['Qwen-Image-Edit — image-to-image (i2i, character reference — narration-premium\'s real usage)'],
  },
  'runpod:wan2-i2v': {
    gpu: 'RTX6000 Ada/L40/L40S/H100',
    coldStartS: '~170-190s',
    models: ['Wan 2.2 I2V-A14B (4-step Lightning) — image-to-video (narration-premium)'],
  },
};

async function getBaselines(counterKey: string): Promise<{ ops: Record<string, { ewmaMs: number; samples: number }>; avgMs: number }> {
  const r = await db.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': { S: `BASELINE#${counterKey}` } },
  }));
  const items = (r.Items ?? []).map(i => unmarshall(i) as { sk: string; ewmaMs: number; samples: number });
  const ops: Record<string, { ewmaMs: number; samples: number }> = {};
  for (const it of items) ops[it.sk] = { ewmaMs: it.ewmaMs, samples: it.samples };
  const avgMs = items.length
    ? items.reduce((a, b) => a + b.ewmaMs, 0) / items.length
    : (SEED_MS[counterKey] ?? DEFAULT_SEED_MS);
  return { ops, avgMs };
}

async function main() {
  const [projectType, durationArg] = process.argv.slice(2);
  const duration = durationArg ? Number(durationArg) : undefined;

  const [queuedByEndpoint, activeReservations] = await Promise.all([
    gatherQueuedByEndpoint(),
    listActiveReservations(),
  ]);

  const endpoints = await Promise.all(ENDPOINTS.map(async (ep) => {
    const [inflight, workersMax, baselines] = await Promise.all([
      getInflight(ep.counterKey),
      getEndpointWorkersMax(ep.counterKey),
      getBaselines(ep.counterKey),
    ]);
    const queued = queuedByEndpoint[ep.counterKey] ?? 0;
    const reservedWorkers = activeReservations.reduce((sum, r) => sum + (r.neededWorkers[ep.counterKey] ?? 0), 0);
    const organicWorkers = (inflight + queued) > 0 ? Math.max(1, Math.ceil((inflight + queued) / JOBS_PER_WORKER)) : 0;
    const effectiveWorkers = Math.max(organicWorkers, reservedWorkers);
    return {
      counterKey: ep.counterKey,
      endpointId: ep.endpointId,
      idleFloorWorkers: ep.baselineMax,
      ...MODEL_CATALOG[ep.counterKey],
      live: {
        inflight,
        queued,
        workersMax_shadowLogged: workersMax,
        reservedWorkers,
        effectiveActiveWorkers: effectiveWorkers,
      },
      baselineGenTimeMs: Math.round(baselines.avgMs),
      baselineGenTimeByOp: baselines.ops,
    };
  }));

  const totalActiveWorkers = endpoints.reduce((a, e) => a + e.live.effectiveActiveWorkers, 0);

  const out: Record<string, unknown> = {
    fleet: {
      accountCap: ACCOUNT_CAP,
      jobsPerWorker: JOBS_PER_WORKER,
      sfnMapMaxConcurrency: SFN_MAP_MAX_CONCURRENCY,
      premiumMapConcurrency: PREMIUM_MAP_CONCURRENCY,
      maxDrainMs: MAX_DRAIN_MS,
      totalActiveWorkersNow: totalActiveWorkers,
      headroomWorkers: ACCOUNT_CAP - totalActiveWorkers,
    },
    endpoints,
    activeReservations: activeReservations.map(r => ({
      admissionId: r.admissionId,
      projectType: r.projectType,
      neededWorkers: r.neededWorkers,
      perEndpointJobs: r.perEndpointJobs,
      drainEstMs: r.drainEstMs,
    })),
  };

  if (projectType && duration) {
    out.requestedProject = projectAssetLoad(projectType, duration);
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
