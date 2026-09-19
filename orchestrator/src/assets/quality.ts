/**
 * The QA agent for the asset pipeline (2026-09-19).
 *
 * Judges the three kinds worth judging — `qwen-image-gen`, `qwen-edit` and
 * `wan2-i2v` — and sends a bad one back for another attempt with a corrected
 * input. Everything downstream of them is ffmpeg, which either works or
 * errors, so nothing else is gated.
 *
 * ── Can it run locally? ──────────────────────────────────────────────────
 * Half of it, and that half is on by default.
 *
 *   * **Local tier (`quality/local.ts`)** — no model, no API, no GPU. ffmpeg
 *     decodes a tiny thumbnail strip and the statistics are computed in
 *     process. It catches blank frames, frozen clips, wrong aspect ratios,
 *     truncated files and clips that don't match their narration: every one
 *     a defect class this pipeline has actually shipped. Free, and it runs on
 *     every gated asset.
 *   * **VLM tier (`quality/rubric.ts` + `quality/replicate.ts`, reused
 *     unchanged)** — whether the picture shows what the prompt asked for.
 *     That needs a vision-language model; the VPS has no GPU and the fleet
 *     has no self-hosted VLM, so it stays a Replicate call and is opt-in
 *     (`ORCH_ASSET_QA=full` plus a REPLICATE_API_TOKEN).
 *
 * Both produce a 0-10 score and an issue list, and the verdict is the WORSE
 * of the two — a picture that is semantically perfect and structurally blank
 * is still blank.
 *
 * ── What a rejection does ────────────────────────────────────────────────
 * It patches the SAME asset row and puts it back in its own agent's queue.
 * The correction depends on what was wrong, which matters: a frozen or blank
 * sample is a sampling problem, and rewriting the prompt to fix it is the
 * cargo-cult move this project already tested and rejected
 * (docs/qm-video-conformity-prompt-testing.md). So structural issues step the
 * seed; only issues a VLM actually saw get a prompt rewrite.
 *
 * ── Note on the standing preference ──────────────────────────────────────
 * `feedback-prompt-harness-over-llm-rework` says defects should be prevented
 * with structured scenes and capability profiles rather than per-failure LLM
 * QA. This agent does not replace that: the local tier is deterministic rules
 * (exactly that philosophy, applied to output instead of input), and the LLM
 * tier is off unless asked for.
 */
import type { Pool } from 'pg';
import type { Config } from '../config';
import { log } from '../telemetry/log';
import { assetSpec, type AssetKind } from './kinds';
import { resolveHandoffs } from './agent';
import type { AssetPlan } from './plan';
import { getPipelineProject, setProjectQa, type ProjectQaStatus } from '../db/repo/pipeline';
import { getProject } from '../db/repo/projects';
import {
  gateAssetPass,
  gateAssetRework,
  gateAssetSkipped,
  listUngatedAssets,
  projectGateState,
  resetDescendants,
  ASSET_QUALITY_ATTEMPTS_HARD_CAP,
  type AssetRow,
} from '../db/repo/assets';
import {
  checkImageLocally,
  checkVideoLocally,
  correctionFor,
  defaultFfmpeg,
  type FfmpegTransport,
  type LocalCheckResult,
} from '../quality/local';
import {
  IMAGE_QA_SYSTEM_PROMPT,
  VIDEO_QA_SYSTEM_PROMPT,
  scoreImage,
  scoreVideo,
  type GateResult,
  type Issue,
} from '../quality/rubric';
import { callVisionJson, type ReplicateDeps } from '../quality/replicate';
import { shouldSampleForVlm, type SampleDecision } from '../quality/sampling';
import { descendantsOf } from './plan';
import { rewritePrompt } from '../quality/rewrite';
import type { FrameJobInput } from '../steps/builders/types';

export interface AssetQualityDeps {
  pool: Pool;
  cfg: Pick<
    Config,
    | 'assetQa'
    | 'assetQaBatchSize'
    | 'assetQaSampleRate'
    | 'assetQaMotionWeight'
    | 'assetQaStaticWeight'
    | 'qualityImagePassThreshold'
    | 'qualityImageReviewThreshold'
    | 'qualityVideoPassThreshold'
    | 'qualityVideoReviewThreshold'
    | 'replicateRewriteModel'
    | 'replicateRewriteReasoning'
  >;
  /** Only needed for the VLM tier and the prompt rewriter. */
  replicate?: ReplicateDeps;
  /** Injectable so tests never spawn a real ffmpeg. */
  ffmpeg?: FfmpegTransport;
}

export interface Verdict {
  score: number;
  issues: Issue[];
  passStatus: 'PASS' | 'REWORK' | 'FAIL';
  /** Where each half of the verdict came from, for the log and the record. */
  tiers: { local: number | null; vlm: number | null };
  facts: Record<string, unknown>;
}

/** The worse of the two tiers wins, and their issues are unioned. A
 * semantically perfect blank frame is still blank. */
export function combineVerdicts(local: LocalCheckResult, vlm: GateResult | null, reviewThreshold: number): Verdict {
  const scores = [local.score, ...(vlm?.weightedScore !== null && vlm?.weightedScore !== undefined ? [vlm.weightedScore] : [])];
  const score = Math.min(...scores);
  const issues = [...local.issues, ...(vlm?.issues ?? [])];
  // A P0 is blocking whatever the arithmetic says — that is the rubric's own
  // rule, applied to the local tier too.
  const hasP0 = issues.some((i) => i.priority === 'P0');
  const passStatus = hasP0 || score < reviewThreshold ? 'REWORK' : 'PASS';
  return { score, issues, passStatus, tiers: { local: local.score, vlm: vlm?.weightedScore ?? null }, facts: local.facts };
}

async function scoreWithVlm(
  deps: AssetQualityDeps,
  row: AssetRow,
  gate: 'image' | 'motion',
  sample: SampleDecision,
): Promise<GateResult | null> {
  if (deps.cfg.assetQa !== 'full' || !deps.replicate?.apiToken || !sample.sampled) return null;
  const input = row.input as FrameJobInput;
  const assetUrl = row.assetUrl as string;
  try {
    const raw = (await callVisionJson(deps.replicate, {
      systemPrompt: gate === 'image' ? IMAGE_QA_SYSTEM_PROMPT : VIDEO_QA_SYSTEM_PROMPT,
      userMsg: [
        `Image prompt: ${input.imagePrompt ?? ''}`,
        input.motionPrompt ? `Motion prompt: ${input.motionPrompt}` : '',
        input.narration ? `Narration for this shot: ${input.narration}` : '',
        `Reference image used: ${input.referenceImageUrl ? 'yes' : 'no'}`,
      ]
        .filter(Boolean)
        .join('\n'),
      // The rubric's video prompt expects the clip; its image prompt expects
      // the still. Same call shape the cohort gate uses.
      ...(gate === 'image' ? { imageUrls: [assetUrl] } : { videoUrls: [assetUrl] }),
    })) as { scores?: Record<string, number>; issues?: Issue[]; summary?: string };

    return gate === 'image'
      ? scoreImage(raw, {
          passThreshold: deps.cfg.qualityImagePassThreshold,
          reviewThreshold: deps.cfg.qualityImageReviewThreshold,
        })
      : scoreVideo(raw, {
          passThreshold: deps.cfg.qualityVideoPassThreshold,
          reviewThreshold: deps.cfg.qualityVideoReviewThreshold,
          // The cohort path skips the (costly) video call when the SOURCE
          // image already scored too low. Here the image was gated before its
          // clip was ever generated, so a bad source never reaches this
          // point — the pre-gate has nothing left to do.
          gateThreshold: 0,
        });
  } catch (err) {
    // A VLM outage must never block the pipeline — it has happened
    // (E001, 2026-09-15). Fall back to the local tier's verdict alone.
    log().warn({ assetId: row.id, kind: row.kind, err }, 'asset-qa: VLM scoring failed, using the local tier only');
    return null;
  }
}

/** Build the input the next attempt will run with. */
export async function correctedInput(
  deps: AssetQualityDeps,
  row: AssetRow,
  verdict: Verdict,
  gate: 'image' | 'motion',
): Promise<{ input: FrameJobInput; correction: string }> {
  const input = { ...(row.input as FrameJobInput) };
  const correction = correctionFor(verdict.issues);

  if (correction === 'reseed') {
    // A structural defect is a sample, not a prompt. Step the seed so the
    // retry is guaranteed a different one; an absent seed means the worker
    // picks its own, which is already a different sample.
    if (typeof input.seed === 'number') input.seed = input.seed + 1 + row.qualityAttempts;
    return { input, correction: 'reseed' };
  }

  if (correction === 'rewrite' && deps.replicate?.apiToken) {
    const isImage = gate === 'image';
    const current = (isImage ? input.imagePrompt : input.motionPrompt) ?? '';
    const original = (isImage ? input.originalImagePrompt : input.originalMotionPrompt) ?? current;
    const rewritten = await rewritePrompt(
      deps.replicate,
      { model: deps.cfg.replicateRewriteModel, reasoningEffort: deps.cfg.replicateRewriteReasoning },
      {
        gate,
        originalPrompt: original,
        currentPrompt: current,
        issues: verdict.issues,
        imageUrl: row.assetUrl ?? undefined,
        narration: input.narration,
        imagePrompt: input.imagePrompt,
        targetModel: row.kind,
      },
    );
    if (rewritten) {
      if (isImage) {
        input.originalImagePrompt = original;
        input.imagePrompt = rewritten;
      } else {
        input.originalMotionPrompt = original;
        input.motionPrompt = rewritten;
      }
      return { input, correction: 'rewrite' };
    }
  }

  // No rewriter configured, or it failed: a fresh sample is still better than
  // the identical one that just failed.
  if (typeof input.seed === 'number') input.seed = input.seed + 1 + row.qualityAttempts;
  return { input, correction: 'reseed-fallback' };
}

/** Judge one completed asset and apply the verdict. */
export async function gateOneAsset(
  deps: AssetQualityDeps,
  row: AssetRow,
  plan: AssetPlan,
  project?: { product?: string },
): Promise<string> {
  const spec = assetSpec(row.kind);
  const gate = spec.gate;
  const handoffs = resolveHandoffs(plan, row.kind, row.input);
  const asset = { url: row.assetUrl as string, durationS: row.durationS ?? undefined };

  const release = async (status: 'pass' | 'exhausted', verdict: Verdict | null): Promise<string> => {
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const applied = verdict
        ? await gateAssetPass(client, row, { status, score: verdict.score, issues: verdict.issues }, asset, handoffs)
        : await gateAssetSkipped(client, row, asset, handoffs);
      await client.query('COMMIT');
      return applied ? status : 'raced';
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  if (!gate || deps.cfg.assetQa === 'off' || !row.assetUrl) return release('pass', null);

  const input = row.input as FrameJobInput;
  const local =
    gate === 'image'
      ? await checkImageLocally(deps.ffmpeg ?? defaultFfmpeg, row.assetUrl, { aspectRatio: input.aspectRatio })
      : await checkVideoLocally(deps.ffmpeg ?? defaultFfmpeg, row.assetUrl, {
          aspectRatio: input.aspectRatio,
          // The narration's real length, which is what the clip was sized to.
          durationS: row.sources.tts?.durationS ?? input.durationS,
        });

  // Which assets pay for a VLM opinion. The local tier above already ran on
  // this one — sampling is only about the Replicate call.
  const sample = shouldSampleForVlm(
    {
      projectId: row.projectId,
      frameId: row.frameId,
      kind: row.kind,
      imagePrompt: input.imagePrompt,
      motionPrompt: input.motionPrompt,
      contract: input.contract,
      product: project?.product,
      textOverlay: plan.tail.textOverlay,
    },
    { rate: deps.cfg.assetQaSampleRate, motionWeight: deps.cfg.assetQaMotionWeight, staticWeight: deps.cfg.assetQaStaticWeight },
  );
  const vlm = await scoreWithVlm(deps, row, gate, sample);
  const reviewThreshold = gate === 'image' ? deps.cfg.qualityImageReviewThreshold : deps.cfg.qualityVideoReviewThreshold;
  const verdict = combineVerdicts(local, vlm, reviewThreshold);

  if (verdict.passStatus === 'PASS') {
    log().info(
      {
        assetId: row.id,
        kind: row.kind,
        frameId: row.frameId,
        score: verdict.score,
        tiers: verdict.tiers,
        salience: sample.salience,
        vlmSampled: sample.sampled,
      },
      'asset-qa: pass',
    );
    return release('pass', verdict);
  }

  // Rejected. Out of budget means accept-and-flag: a project still delivers,
  // and the §9.6 result reports the flag rather than silently shipping it.
  if (row.qualityAttempts >= ASSET_QUALITY_ATTEMPTS_HARD_CAP) {
    log().warn(
      { assetId: row.id, kind: row.kind, frameId: row.frameId, score: verdict.score, issues: verdict.issues.length },
      'asset-qa: rework budget exhausted, accepting the asset flagged',
    );
    return release('exhausted', verdict);
  }

  const { input: patched, correction } = await correctedInput(deps, row, verdict, gate);
  const requeued = await gateAssetRework(deps.pool, row, { score: verdict.score, issues: verdict.issues }, patched);
  if (!requeued) return 'raced';

  // The handoff already happened — QA does not block the chain — so this
  // frame's clip may already exist, made from the asset just rejected.
  // Regenerating only the image would leave that clip in the manifest and
  // make the gate decorative, so the whole downstream chain for this frame
  // goes back to `blocked` and regenerates from the corrected input.
  const descendants = descendantsOf(plan, row.kind);
  const reset = await resetDescendants(deps.pool, row.projectId, row.frameId, descendants, row.kind);
  if (reset > 0) {
    log().warn(
      { assetId: row.id, kind: row.kind, frameId: row.frameId, reset, descendants },
      'asset-qa: rework reset this frame\u2019s downstream assets so they regenerate from the corrected input',
    );
  }

  log().warn(
    {
      assetId: row.id,
      kind: row.kind,
      frameId: row.frameId,
      score: verdict.score,
      tiers: verdict.tiers,
      facts: verdict.facts,
      salience: sample.salience,
      vlmSampled: sample.sampled,
      issues: verdict.issues.map((i) => `${i.priority} ${i.category}`),
      correction,
      attempt: row.qualityAttempts + 1,
    },
    'asset-qa: rejected, requeued for rework',
  );
  return 'rework';
}

/**
 * The project-level verdict the compiler reads (migration 016). Recomputed
 * from the asset rows after every gate decision rather than accumulated, so
 * it can never drift from them — and so a rework correctly re-opens a project
 * that had already passed.
 *
 *   bypassed  nothing to judge: gating off, no gated kinds in the plan, or a
 *             product Remotion renders deterministically
 *   pending   verdicts still outstanding
 *   failed    a gated asset exhausted its rework budget and is still bad
 *   passed    every gated asset judged and acceptable
 */
export async function refreshProjectQa(
  deps: AssetQualityDeps,
  projectId: string,
  plan: AssetPlan,
  opts: { sampledOut?: boolean } = {},
): Promise<ProjectQaStatus> {
  const gatedKinds = plan.frameKinds.filter((k) => assetSpec(k).gate !== null);
  if (deps.cfg.assetQa === 'off' || gatedKinds.length === 0) {
    await setProjectQa(deps.pool, projectId, 'bypassed', { reason: deps.cfg.assetQa === 'off' ? 'gating disabled' : 'no gated kinds' });
    return 'bypassed';
  }

  const st = await projectGateState(deps.pool, projectId, gatedKinds);
  if (st.total === 0) {
    await setProjectQa(deps.pool, projectId, 'bypassed', { reason: 'no gated assets survived generation' });
    return 'bypassed';
  }
  if (st.judged < st.total) {
    await setProjectQa(deps.pool, projectId, 'pending', { judged: st.judged, total: st.total, waitingOn: st.pendingKinds });
    return 'pending';
  }
  if (st.exhausted > 0) {
    await setProjectQa(deps.pool, projectId, 'failed', {
      reason: 'assets exhausted their rework budget and still fail the gate',
      exhausted: st.exhausted,
      total: st.total,
    });
    return 'failed';
  }
  await setProjectQa(deps.pool, projectId, 'passed', { judged: st.judged, total: st.total, ...(opts.sampledOut ? { note: 'some assets not VLM-sampled' } : {}) });
  return 'passed';
}

export interface QaTickSummary {
  kind: AssetKind;
  judged: number;
  passed: number;
  reworked: number;
  exhausted: number;
}

/** One pass over one kind's ungated queue. */
export async function runAssetQaTick(deps: AssetQualityDeps, kind: AssetKind): Promise<QaTickSummary> {
  const summary: QaTickSummary = { kind, judged: 0, passed: 0, reworked: 0, exhausted: 0 };
  const rows = await listUngatedAssets(deps.pool, kind, deps.cfg.assetQaBatchSize);
  const touched = new Set<string>();
  for (const row of rows) {
    try {
      const plan = (await getPipelineProject(deps.pool, row.projectId))?.plan;
      if (!plan) {
        log().warn({ assetId: row.id, projectId: row.projectId }, 'asset-qa: no plan for this project, skipping');
        continue;
      }
      // `product` decides whether this project is sampled at all — explainer
      // and educational frames are rendered by Remotion, not diffused.
      const project = await getProject(deps.pool, row.projectId);
      const request = project?.request as { product?: string } | undefined;
      const outcome = await gateOneAsset(deps, row, plan, { product: request?.product });
      summary.judged += 1;
      if (outcome === 'pass') summary.passed += 1;
      if (outcome === 'rework') summary.reworked += 1;
      if (outcome === 'exhausted') summary.exhausted += 1;
      touched.add(row.projectId);
    } catch (err) {
      // One unjudgeable asset must never stop the queue; it stays ungated and
      // comes round again next tick.
      log().error({ assetId: row.id, kind, err }, 'asset-qa: gating one asset crashed');
    }
  }
  // One recompute per project, after its assets are judged — never per asset.
  for (const projectId of touched) {
    try {
      const plan = (await getPipelineProject(deps.pool, projectId))?.plan;
      if (plan) await refreshProjectQa(deps, projectId, plan);
    } catch (err) {
      log().error({ projectId, err }, 'asset-qa: failed to refresh the project verdict');
    }
  }
  if (summary.judged > 0) log().info(summary, 'asset-qa: tick');
  return summary;
}

export function startAssetQa(deps: AssetQualityDeps, kinds: readonly AssetKind[], intervalMs: number): { stop(): void } {
  const gated = kinds.filter((k) => assetSpec(k).gate !== null);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void Promise.all(gated.map((k) => runAssetQaTick(deps, k)))
      .catch((err) => log().error({ err }, 'asset-qa: tick crashed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  log().info({ gated, intervalMs, mode: deps.cfg.assetQa }, 'asset-qa: started');
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
