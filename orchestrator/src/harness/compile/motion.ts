/**
 * Deterministic motion-prompt compiler (prompt harness plan §6.3, §7).
 * Guaranteed lint-clean by construction for any contract that already
 * passed lint/video.ts's contract-level checks — see
 * __tests__/harness-compile.test.ts.
 *
 * Deliberately short (target 12-45 words, V-LEN-01): in I2V the appearance
 * is already in the pixels, so the motion prompt restates only a brief
 * identity/position anchor, then camera, action, ambient motion, and the
 * direction/angle lock clause (plan §2.2, point 3).
 */
import { primarySubject, type ShotContract } from '../contract';
import { CAMERA_MOVE_PHRASE, FACING_PHRASE, screenDirectionPhrase } from './vocab';

function angleWord(angle: string): string {
  return angle.replace(/^(at |from )/, '').replace(/_/g, ' ');
}

export function compileMotionPrompt(contract: ShotContract): string {
  const primary = primarySubject(contract);
  const cam = contract.camera;
  const dirPhrase = screenDirectionPhrase(contract.action.screenDirection);
  const facingPhrase = primary?.facing ? FACING_PHRASE[primary.facing] : undefined;

  const openLead = `${CAMERA_MOVE_PHRASE[cam.move]}, ${cam.shotSize.replace(/_/g, ' ')} at ${angleWord(cam.angle)}.`;

  const subjectClause = primary
    ? `${primary.id}, ${facingPhrase ?? ''}, ${contract.action.verb}${dirPhrase ? ` ${dirPhrase}` : ''}.`.replace(/,\s*,/, ',')
    : `${contract.action.verb}${dirPhrase ? ` ${dirPhrase}` : ''}.`;

  const ambient = contract.action.ambient.slice(0, 2);
  const ambientClause = ambient.length ? `${ambient.join(', ')}.` : undefined;

  // Deliberately doesn't restate the direction phrase again here (already
  // in subjectClause above) — an earlier version did, and pushed several
  // contracts a few words past V-LEN-01's 45-word cap for no gain.
  // The only-person clause is V-HAL-02's defence against extras spawning at
  // the frame edges, but it is a factual claim about the shot — in a `crowd`
  // setting it contradicts the image the caller asked for, so it is dropped
  // there (V-HAL-02 exempts `crowd` for the same reason). `sparse` keeps it:
  // that is exactly the case the guard exists for.
  const onlyPerson =
    contract.setting.population === 'crowd' ? '' : ` ${primary?.id ?? 'the subject'} stays the only person in the scene.`;
  const lockClause = `${primary?.facing ? `${primary.id} keeps ${facingPhrase}; ` : ''}the camera stays ${angleWord(cam.angle)}.${onlyPerson}`;

  return [openLead, subjectClause, ambientClause, lockClause]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
