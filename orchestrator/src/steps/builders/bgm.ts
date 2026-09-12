/**
 * Step 5 (bgm generation) payload builder. Targets the standalone `bgm-s2t`
 * endpoint (ACE-Step), ported from src/adapters/runpod.ts's `bgm` case:
 * `{mode:'bgm', prompt, duration_s, steps, guidance}` -> an audio URL (dug
 * out generically by runpod/output.ts's runpodOutUrl, same as every other
 * step's output).
 *
 * A singleJobPerProject step (agents/planner.ts's buildStepsAndJobs()) with
 * `dependsOn: []` — unlike every other such step, it has no prior job's
 * output to read via `ctx.perFrameOutputs`, so its prompt and target
 * duration travel through `ctx.job.bgmPrompt`/`ctx.job.totalDurationS`
 * instead (see steps/builders/types.ts). Runs bulk-scope (scope:'bulk' in
 * steps/catalog.ts), alongside steps 0-3, not in the assembly tail — it has
 * nothing to wait on, so there's no reason to delay it until step 6+.
 *
 * ACE-Step reliably generates ~120-180s max — cap at 120s and let step 12
 * (mix_bgm) loop/trim to match the final video's real length, matching the
 * real system's "generate short, loop downstream" convention
 * (docs/quartermaster.md).
 */
import type { BuildContext, PayloadBuilder } from './types';

const MAX_DURATION_S = 120;
const DEFAULT_DURATION_S = 30;

export const buildBgmInput: PayloadBuilder = (ctx: BuildContext): Record<string, unknown> => {
  if (!ctx.job.bgmPrompt) {
    throw new Error(`bgm builder: no bgmPrompt for project ${ctx.projectId}`);
  }
  const requested = ctx.job.totalDurationS ?? DEFAULT_DURATION_S;
  return {
    mode: 'bgm',
    prompt: ctx.job.bgmPrompt,
    duration_s: Math.min(requested, MAX_DURATION_S),
    steps: 20,
    guidance: 7.0,
    project_id: ctx.projectId,
  };
};
