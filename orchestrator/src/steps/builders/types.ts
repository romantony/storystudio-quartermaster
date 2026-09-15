/**
 * Shared shapes for the pure payload builders (impl plan §9): "no I/O, no
 * DB, no clock." A step whose `dependsOn` is non-empty (e.g. step 3 needs
 * step 1's generated image) cannot resolve that from the request alone —
 * `agents/generator.ts` looks up the dependency's completed job output and
 * passes it in as `resolvedDeps` right before calling the builder, so the
 * builder itself never touches the database.
 */
import type { ShotContract } from '../../harness/contract';

/** Per-frame fields the planner writes into `jobs.input` at plan time,
 * pulled straight off the §9.1 request's `frames[]` entry. */
export interface FrameJobInput {
  frameId: string;
  imagePrompt: string;
  narration: string;
  durationS: number;
  motionPrompt?: string;
  /** Step 15's MMAudio prompt (SFX/ambience/environmental sound). Optional;
   * builders/sfx.ts derives one from imagePrompt when absent. */
  audioPrompt?: string;
  aspectRatio?: string;
  language?: string;
  /** Per-project voice selection, if the request carries one (not in the
   * §9.1 example but mirrors src/adapters/runpod.ts's tts case). */
  voiceId?: string;
  /** Narration Premium reference-image flow (options.referenceImage): the
   * single shared reference image URL the caller (StoryStudio, in the real
   * flow) generated up front and attaches to every frame. Consumed by
   * builders/image-edit.ts (seq 0), which the planner resolves INSTEAD OF
   * seq 1 (t2i) when options.referenceImage is true. */
  referenceImageUrl?: string;
  /** TTS engine selection (options.voiceEngine, default 'kokoro'). 'qwen'
   * routes buildTtsInput to the Qwen3-TTS voice-design payload shape
   * instead of Kokoro's. */
  voiceEngine?: 'kokoro' | 'qwen';
  /** Qwen3-TTS voice-design fields (request-level, copied onto every frame
   * like aspectRatio/language already are) — mirrors the real AWS
   * contract's top-level voiceSpeaker/voiceInstruct/voiceLanguage
   * (docs/storystudio-qm-new-sfn-trigger.md §9.1). Only meaningful when
   * voiceEngine === 'qwen'; no clone_artifact_url/voice_url support yet —
   * this is the voice-design branch, not literal voice cloning. */
  voiceSpeaker?: string;
  voiceInstruct?: string;
  voiceLanguage?: string;
  /** Step 5 (bgm generation) only — this job has no dependsOn to resolve an
   * output URL from, so its prompt/target duration travel here instead of
   * through `resolvedDeps`/`perFrameOutputs` like every other
   * singleJobPerProject step. See agents/planner.ts's buildStepsAndJobs(). */
  bgmPrompt?: string;
  totalDurationS?: number;
  /** singleJobPerProject jobs only: every frame's narration in request order.
   * Step 11 (captions) turns it into word timestamps instead of re-running
   * Whisper (builders/caption.ts). */
  narrations?: Array<{ frameId: string; narration: string }>;
  /** Request-level (like voiceSpeaker et al) precomputed Qwen3-TTS voice
   * clone artifact (.pt) — the real product's `storystudio-qm-new-sfn-
   * trigger.md` §9.2 `cloneArtifactUrl`; StoryStudio picks the voice_id and
   * resolves it to this URL before calling the orchestrator (see
   * /home/roman-antony/qwen-voice-clone/docs/voice-catalog.json for the
   * catalog StoryStudio picks from). Takes priority over
   * voiceSpeaker/voiceInstruct design mode — see steps/builders/tts.ts. */
  cloneArtifactUrl?: string;
  /** True when step 14 (per-frame DreamX upscale) was planned for this
   * request. Lets steps/builders/merge.ts tell "upscale wasn't requested"
   * (use step 3's clip) apart from "upscale was requested but this frame's
   * job failed" (throw — never silently merge a 464p clip into a 1056p
   * project). */
  upscaleFrames?: boolean;
  /** True when step 15 (per-frame MMAudio SFX) was planned — same purpose
   * as upscaleFrames: merge throws on a missing SFX track instead of
   * silently shipping that frame without one. */
  sfx?: boolean;
  /** Set by the quality gate on a frame's last rework (agents/quality.ts):
   * route the next attempt to a different model — steps/catalog.ts's
   * `fallbacks` maps it to an endpoint/provider and payload builder. */
  fallbackRung?: FallbackRung;
  /** The prompts as first requested, kept once a QA rewrite replaces
   * imagePrompt/motionPrompt, so later rewrites still see the original. */
  originalImagePrompt?: string;
  originalMotionPrompt?: string;

  // ── prompt harness (docs/qm-orchestrator-prompt-harness-implementation-plan.md) ──
  /** The frame's shot contract, written by harness/prepare.ts at plan time
   * (or by the quality-gate ladder on a rework). Absent = the harness was
   * off, or extraction/validation failed for this frame — every consumer
   * (agents/quality.ts's harness branch) falls back to the pre-harness
   * behavior when this is undefined. */
  contract?: ShotContract;
  /** Hash of the active guardrail set (image ∪ video) this frame's prompts
   * were produced against — see harness/guardrails/store.ts's
   * guardrailSetVersion(). Stamped so a later finding/correction is
   * attributable to an exact rule set. */
  harnessVersion?: string;
  /** options.promptHarness === 'lint': the harness-compiled prompts,
   * recorded alongside the caller's own imagePrompt/motionPrompt (which
   * stay live) for offline comparison — never read by any builder. */
  harnessImagePrompt?: string;
  harnessMotionPrompt?: string;
  /** Set when the contract's transformation is 'state_change' (V-ACT-02) —
   * this beat genuinely needs two frames on a 4-step model. Report-only:
   * the orchestrator still submits a best-effort single-frame prompt (a
   * 'continuation' rewrite of the same contract) rather than blocking, and
   * surfaces this flag in the §9.6 result callback for the caller to act on. */
  splitShot?: boolean;
}

export type FallbackRung = 'flux-4b' | 'replicate-wan22-fast';

/** Populated by the generator from the same-frame job's `output` in every
 * step named in this step's `dependsOn`. Keyed by step seq. `durationS` is
 * only ever populated for step 2 (tts)'s output — see
 * agents/generator.ts's resolveDeps() and steps/builders/i2v.ts, which reads
 * it to size the video to the ACTUAL generated audio rather than the
 * caller's pre-estimated frame.durationS. */
export type ResolvedDeps = Record<number, { url?: string; durationS?: number } | undefined>;

export interface BuildContext {
  job: FrameJobInput;
  resolvedDeps: ResolvedDeps;
  projectId: string;
  frameId: string | null;
  /** Populated only for a `singleJobPerProject` step's one job (frameId is
   * null) — every frame's completed-or-failed output URL for each step in
   * `dependsOn`, ordered by the frame's original narrative position (jobs.seq
   * at plan time). Keyed by step seq, same key space as `resolvedDeps` but
   * one array per step instead of one URL — see agents/generator.ts's
   * resolveProjectDeps(). Per-frame builders never see this populated. */
  perFrameOutputs?: Record<number, string[]>;
  /** Same population rule as perFrameOutputs, but one entry per frame job
   * (failed frames included, `url` undefined) with its frame id and the
   * output's `duration_s` when it reported one. */
  perFrameDetails?: Record<number, Array<{ frameId: string | null; url?: string; durationS?: number }>>;
}

export type PayloadBuilder = (ctx: BuildContext) => Record<string, unknown>;
