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
}

/** Populated by the generator from the same-frame job's `output` in every
 * step named in this step's `dependsOn`. Keyed by step seq. */
export type ResolvedDeps = Record<number, { url?: string } | undefined>;

export interface BuildContext {
  job: FrameJobInput;
  resolvedDeps: ResolvedDeps;
  projectId: string;
  frameId: string | null;
}

export type PayloadBuilder = (ctx: BuildContext) => Record<string, unknown>;
