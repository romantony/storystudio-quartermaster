/** Image-domain corrective ladder (prompt harness plan §5.1 correctives). Thin
 * wrapper over correct/ladder.ts's shared engine — see that file for the
 * fix-selection logic. */
import { runLadder, type LadderContext, type LadderOutcome } from './ladder';

export type ImageLadderContext = Omit<LadderContext, 'domain'>;

export async function runImageLadder(ctx: ImageLadderContext): Promise<LadderOutcome> {
  return runLadder({ ...ctx, domain: 'image' });
}
