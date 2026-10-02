/**
 * `sfn-tail` payload — the input of one Step Functions execution (the
 * assembly tail, docs/qm-sfn-ecs-tail-implementation-2026-10-02.md §3).
 *
 * Asset REFERENCES only. Every URL travels inside the manifest FILE on R2, and
 * this input carries just the pointer plus the few scalars the state machine
 * branches on — Step Functions caps an execution's input/state at 256KB, a
 * limit that has already broken this pipeline twice (2026-08-12, 2026-08-17).
 * That is why, unlike the postprod-lite builder it replaces, there is NO
 * inline-manifest fallback: a project whose manifest could not be written to
 * R2 is refused instead of sent.
 *
 * `assets/compiler.ts` arms the project-scoped `sfn-tail` row with the
 * `SfnTailRowInput` below; `assets/agent.ts` adds the execution name (it needs
 * the row's attempt number, which a pure builder does not have).
 */
import type { BuildContext, PayloadBuilder } from './types';

/** What the compiler writes into the armed row's `input`. */
export interface SfnTailRowInput {
  manifestUrl: string;
  aspectRatio: string;
  /** The narration language (`request.language`). Whisper must be told: left
   * to guess, it transcribes e.g. Hindi narration as English phonetics. */
  language: string;
  /** The decisions the state machine branches on — also in the manifest, but
   * repeated here so a Choice state never has to read the file. */
  options: {
    removeSilence: boolean;
    captions: boolean;
    bgm: boolean;
    bgmPrompt?: string;
    sfx: boolean;
  };
  /** Total narration length the caller estimated; BGM is generated to the
   * REAL probed duration, this only seeds the first guess. */
  totalDurationS: number;
}

/** The execution input sent to Step Functions. */
export interface SfnTailExecutionInput extends SfnTailRowInput {
  projectId: string;
  /** Where the ECS tasks write this execution's outputs. */
  outputPrefix: string;
}

export const buildSfnTailInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  const input = ctx.job as unknown as Partial<SfnTailRowInput>;

  if (!input.manifestUrl) {
    throw new Error(
      `sfn-tail builder: project ${ctx.projectId} has no manifestUrl — the compiler arms this row with one; ` +
        `an inline manifest is not an option (Step Functions' 256KB limit), so configure R2`,
    );
  }
  if (!input.aspectRatio) {
    throw new Error(`sfn-tail builder: project ${ctx.projectId} has no aspectRatio`);
  }

  const out: SfnTailExecutionInput = {
    projectId: ctx.projectId,
    manifestUrl: input.manifestUrl,
    aspectRatio: input.aspectRatio,
    language: input.language ?? 'en',
    options: input.options ?? { removeSilence: false, captions: false, bgm: false, sfx: false },
    totalDurationS: input.totalDurationS ?? 0,
    outputPrefix: `projects/${ctx.projectId}/tail/`,
  };
  return out as unknown as Record<string, unknown>;
};
