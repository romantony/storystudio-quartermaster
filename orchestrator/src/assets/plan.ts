/**
 * Compiling a request into an asset plan (2026-09-19).
 *
 * This is the whole "no dependency on project sequence" claim made concrete.
 * The plan is a set of asset kinds plus, for each, the kinds whose output it
 * needs — nothing else. There is no order in it, no step numbers, no cohort.
 * Execution order is whatever the data allows at the moment an agent looks:
 * a frame-scoped row becomes runnable when every kind in its `requires` has
 * written a url into its `sources`, and that is the ONLY scheduling rule among
 * the per-frame agents.
 *
 * Handoff edges are derived, never authored twice: `handoffTargets()` is just
 * `requires` read backwards. That is what makes "the qwen agent knows the
 * next table" true without any agent hard-coding a successor — an agent asks
 * the plan who required it, and writes there.
 *
 * The two PROJECT-scoped kinds sit outside that mechanism on purpose:
 *
 *   * `bgm` has no per-frame input at all, so it is runnable from the moment
 *     the project is submitted and generates in parallel with everything else.
 *   * `postprod-lite` fans in on every frame at once, which a `sources` map
 *     keyed by asset kind cannot express — so the project compiler arms it,
 *     with the manifest, once the project is whole. That is the division the
 *     design asks for: agents own per-frame handoff, the compiler owns the
 *     project.
 *
 * Pure: no DB, no clock, no I/O. The result is persisted on
 * `pipeline_projects.plan` at submission time so a later deploy or options
 * change cannot re-route a project that is already half generated.
 */
import type { OrchestratorRequest } from '../agents/planner';
import { ASSET_SPECS, assetSpec, type AssetKind, type AssetStage } from './kinds';

export interface AssetPlan {
  /** Every kind this project will generate, frame- and project-scoped. */
  kinds: AssetKind[];
  /** The frame-scoped subset — what the compiler checks per frame. */
  frameKinds: AssetKind[];
  /** kind -> the kinds whose url it needs before it can run. Project-scoped
   * kinds are absent from the handoff graph entirely (see the header). */
  requires: Record<string, AssetKind[]>;
  /** Reserved for a multi-call kind; empty today. */
  stages: Record<string, AssetStage[]>;
  imageKind: AssetKind;
  /** The kind that produces each frame's clip, or null when the project has
   * no motion model at all and the tail Ken Burns the still instead. */
  motionKind: AssetKind | null;
  /** What the compiler tells the one-shot to do after the per-frame work. */
  tail: TailSteps;
  /**
   * This product's frames are not quality-gated AT ALL (operator, 2026-09-19).
   *
   * Explainer and educational videos are a deterministic Remotion composition
   * over a background: there is no diffusion sampler to misbehave, so neither
   * the VLM tier nor the free local checks have anything to catch that is
   * worth delaying assembly for. Gated kinds complete as `ungated`, never
   * enter the QA queue, and the project verdict is `bypassed` — so the
   * compiler can assemble the moment generation finishes.
   *
   * Decided at submission and persisted with the plan, so a later deploy or
   * product rename cannot change the rules under a project already running.
   */
  qaExempt: boolean;
  frameCount: number;
}

/** Products whose frames Remotion renders deterministically. */
export const QA_EXEMPT_PRODUCTS = /\b(explainer|educational|education)\b/i;

/** The `steps` block of the manifest — flags on one call, not a call chain.
 * `upscale` is Real-ESRGAN on the finished video and is normally false: with
 * `upscaleEngine: 'dreamx'` (the default) every frame is already upscaled
 * before it reaches the tail. */
export interface TailSteps {
  removeSilence: boolean;
  burnCaptions: boolean;
  upscale: boolean;
  bgm: boolean;
  /** Not a tail step — `remotion` is a per-frame agent that runs before the
   * tail. Carried here so the QA sampler and the manifest can tell this is a
   * Remotion product without re-deriving it from the request. */
  textOverlay: boolean;
}

/**
 * `options.motionEngine` is read here and nowhere in the cohort path — the
 * step graph always plans seq 3 (wan2-i2v). A request that sets it while
 * ORCH_PIPELINE_MODE is still 'cohort' is accepted and ignored, which is why
 * the schema keeps it optional with a 'wan2' default.
 *
 * `'animate'` plans NO motion asset: Ken Burns is something the postprod-lite
 * one-shot does to the still as part of assembly, not a separate generation.
 * For narration-basic that reduces the whole per-frame chain to image + TTS.
 */
export function compilePlan(req: OrchestratorRequest): AssetPlan {
  const o = req.options;
  const imageKind: AssetKind = o.referenceImage ? 'qwen-edit' : 'qwen-image-gen';
  const motionKind: AssetKind | null = o.motionEngine === 'animate' ? null : 'wan2-i2v';
  // DreamX-refine is Wan2's upscale: whatever wan2-i2v generates (native
  // 832x464) needs it to reach a deliverable resolution, independent of
  // `options.upscale` (docs/qm-orchestrator-three-project-run-analysis-
  // 2026-09-19.md §3/§6 P1-5 — resolved 2026-09-20: educational/explainer's
  // "no DreamX" design assumed Remotion covers every frame at 1080p, but
  // real coverage was ~15%; the other ~85% shipped native 832x464, upscaled
  // ~2.3x by nothing but the final concat, visibly soft). `upscaleEngine:
  // 'realesrgan'` is still the caller's opt-in alternative (a whole-video
  // pass instead of DreamX's per-frame one) via `tail.upscale` below.
  const refine = motionKind && o.upscaleEngine === 'dreamx' ? ('dreamx-refine' as const) : undefined;
  const sfx = motionKind && o.sfx ? ('mmaudio' as const) : undefined;

  const requires: Record<string, AssetKind[]> = {
    [imageKind]: [],
    tts: [],
  };
  if (motionKind) {
    // Motion needs the still AND the narration — not for the audio, but for
    // its real generated length. builders/i2v.ts sizes the clip to it; the
    // caller's estimate and the real narration routinely diverge and merge's
    // `-shortest` silently clips the difference.
    requires[motionKind] = [imageKind, 'tts'];
  }
  if (refine) requires[refine] = [motionKind as AssetKind];
  if (sfx) requires[sfx] = [refine ?? (motionKind as AssetKind)];

  // On-screen text (educational/explainer). It renders onto the frame's clip
  // BEFORE the tail, because the tail's merge/trim/concat all happen inside
  // one postprod-lite call — there is no gap between merge and concat to slot
  // it into, the way the cohort model has. With no motion model at all it has
  // nothing to render over: the still is animated inside the one-shot, so
  // there is no clip yet, and the overlay is skipped.
  const overlay = o.textOverlay && motionKind ? ('remotion' as const) : undefined;
  if (overlay) requires[overlay] = [sfx ?? refine ?? (motionKind as AssetKind)];

  // Merge (clip + narration -> one clip) moved OUT of the postprod-lite
  // one-shot tail into its own parallel per-frame agent (2026-09-20 —
  // docs/qm-orchestrator-three-project-run-analysis-2026-09-19.md's merge-
  // parallelization follow-up): it used to run serially, one frame at a
  // time, inside ONE pod, only after every other per-frame asset was
  // already done. It needs only this frame's clip and its narration, same
  // as wan2-i2v/dreamx-refine/mmaudio already run in parallel across pods
  // DURING generation. Only when there's a clip to merge at all — an
  // `motionEngine:'animate'` project has none yet (Ken Burns happens inside
  // the tail itself), so those keep merging there, same as before this
  // kind existed.
  const merge = motionKind ? ('merge' as const) : undefined;
  if (merge) requires[merge] = [overlay ?? sfx ?? refine ?? (motionKind as AssetKind), 'tts'];

  const frameKinds = Object.keys(requires) as AssetKind[];
  const kinds: AssetKind[] = [...frameKinds, 'postprod-lite'];
  if (o.bgm) kinds.push('bgm');

  return {
    kinds,
    frameKinds,
    requires,
    stages: {},
    imageKind,
    motionKind,
    tail: {
      removeSilence: o.removeSilence,
      burnCaptions: o.burnCaptions,
      // Reported, not a tail step: the overlay is a per-frame agent that runs
      // before the tail. Kept on the plan so the QA sampler and the manifest
      // can see that this project is a Remotion product without re-deriving it.
      textOverlay: o.textOverlay,
      // Only when the caller explicitly asked for the whole-video Real-ESRGAN
      // pass instead of the per-frame DreamX one. Off in every default path.
      upscale: o.upscale && o.upscaleEngine === 'realesrgan',
      bgm: o.bgm,
    },
    qaExempt: QA_EXEMPT_PRODUCTS.test(req.product ?? ''),
    frameCount: req.frames.length,
  };
}

/** The tables `kind` writes its url into when it completes — `requires` read
 * backwards. An agent never names a successor; it asks this. Project-scoped
 * kinds are never a target: the compiler arms those. */
export function handoffTargets(plan: AssetPlan, kind: AssetKind): AssetKind[] {
  return (Object.entries(plan.requires) as Array<[AssetKind, AssetKind[]]>)
    .filter(([target, reqs]) => reqs.includes(kind) && assetSpec(target).scope === 'frame')
    .map(([target]) => target);
}

/**
 * Every frame-scoped kind downstream of `kind`, transitively.
 *
 * Needed because QA no longer gates the handoff: by the time a verdict
 * rejects an image, its clip may already exist — made from the rejected
 * image. Regenerating the image alone would leave that clip in the manifest
 * and the gate would be decorative. These are the rows that must be reset
 * with it.
 */
export function descendantsOf(plan: AssetPlan, kind: AssetKind): AssetKind[] {
  const out = new Set<AssetKind>();
  const walk = (k: AssetKind): void => {
    for (const child of handoffTargets(plan, k)) {
      if (out.has(child)) continue;
      out.add(child);
      walk(child);
    }
  };
  walk(kind);
  return [...out];
}

/** A row is runnable once every required kind has written into `sources`. */
export function inputsSatisfied(required: readonly string[], sources: Record<string, unknown>): boolean {
  return required.every((r) => sources[r] !== undefined && sources[r] !== null);
}

/** The stage a fresh row of this kind starts on (null for single-call kinds,
 * which is all of them today). */
export function firstStage(plan: AssetPlan, kind: AssetKind): AssetStage | null {
  return plan.stages[kind]?.[0] ?? null;
}

/** The stage after `stage`, or null when the row is finished. */
export function nextStage(plan: AssetPlan, kind: AssetKind, stage: string | null): AssetStage | null {
  const list = plan.stages[kind];
  if (!list || !stage) return null;
  const i = list.indexOf(stage);
  return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
}

/**
 * `steps/builders/*` read their inputs out of a seq-keyed ResolvedDeps map.
 * This is the only translation between the two models — it lets every builder
 * be reused untouched instead of reimplemented against `sources`.
 */
export function toResolvedDeps(
  sources: Record<string, { url?: string; durationS?: number } | undefined>,
): Record<number, { url?: string; durationS?: number } | undefined> {
  const out: Record<number, { url?: string; durationS?: number } | undefined> = {};
  for (const [kind, value] of Object.entries(sources)) {
    const spec = ASSET_SPECS[kind as AssetKind];
    if (!spec || !value) continue;
    out[spec.legacySeq] = { url: value.url, durationS: value.durationS };
  }
  return out;
}

/** Every row a project expects: one per frame-scoped kind per frame, plus one
 * for each project-scoped kind. */
export function expectedAssetCount(plan: AssetPlan): number {
  const projectScoped = plan.kinds.filter((k) => assetSpec(k).scope === 'project').length;
  return plan.frameKinds.length * plan.frameCount + projectScoped;
}

/** The kind whose output is a frame's finished clip, or null when the project
 * has no motion model and the tail animates the still instead. Ordered most-
 * processed first, the same precedence steps/builders/merge.ts applies. */
export function clipKind(plan: AssetPlan): AssetKind | null {
  if (!plan.motionKind) return null;
  for (const k of ['merge', 'remotion', 'mmaudio', 'dreamx-refine'] as const) {
    if (plan.frameKinds.includes(k)) return k;
  }
  return plan.motionKind;
}
