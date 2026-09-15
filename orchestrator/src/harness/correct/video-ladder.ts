/** Video-domain corrective ladder for Wan2 Lightning / Replicate Wan 2.2
 * fast (prompt harness plan §7.6). Thin wrapper over correct/ladder.ts's
 * shared engine. */
import { runLadder, type LadderContext, type LadderOutcome } from './ladder';

export type VideoLadderContext = Omit<LadderContext, 'domain'>;

export async function runVideoLadder(ctx: VideoLadderContext): Promise<LadderOutcome> {
  return runLadder({ ...ctx, domain: 'video' });
}
