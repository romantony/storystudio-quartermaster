/**
 * Shared shapes for the pure payload builders (impl plan §9): "no I/O, no
 * DB, no clock." A step whose `dependsOn` is non-empty (e.g. step 3 needs
 * step 1's generated image) cannot resolve that from the request alone —
 * `agents/generator.ts` looks up the dependency's completed job output and
 * passes it in as `resolvedDeps` right before calling the builder, so the
 * builder itself never touches the database.
 */

/** Per-frame fields the planner writes into `jobs.input` at plan time,
 * pulled straight off the §9.1 request's `frames[]` entry. */
export interface FrameJobInput {
  frameId: string;
  imagePrompt: string;
  narration: string;
  durationS: number;
  motionPrompt?: string;
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
}

/** Populated by the generator from the same-frame job's `output` in every
 * step named in this step's `dependsOn`. Keyed by step seq. */
export type ResolvedDeps = Record<number, { url?: string } | undefined>;

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
}

export type PayloadBuilder = (ctx: BuildContext) => Record<string, unknown>;
