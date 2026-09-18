/**
 * Compiler guarantee tests (prompt harness plan §6.3): for any contract
 * that already satisfies the CONTRACT-level guardrail checks, the compiled
 * prompt must satisfy every TEXT-level check too — this is what lets
 * harness/prepare.ts trust the compiled draft without re-running the GPT-5
 * mini tool. Exercised across a spread of shot sizes/angles/sides/moves/
 * directions/populations, including the exact Maya frames once their
 * contracts have been fixed (align_facing / downgrade_move applied).
 */
import { compileImagePrompt } from '../src/harness/compile/image';
import { compileMotionPrompt } from '../src/harness/compile/motion';
import { lintImage } from '../src/harness/lint/image';
import { lintVideo } from '../src/harness/lint/video';
import { seedGuardrails } from '../src/harness/guardrails/store';
import { applyEdit } from '../src/harness/correct/edits';
import type { CameraMove, Facing, ScreenDir, ShotContract } from '../src/harness/contract';
import { validContract } from './helpers/harness-fixtures';

const IMAGE_GUARDRAILS = seedGuardrails('image', 'any');
const VIDEO_GUARDRAILS = seedGuardrails('video', 'wan2-lightning');
const DUMMY = { guardrailId: '', severity: 'fix' as const, fixTarget: 'contract' as const, message: '' };

/** Runs the same normalization harness/prepare.ts's normalizeContractForCompile
 * does, inline, so this test doesn't depend on that private function. */
function normalize(contract: ShotContract): ShotContract {
  let c = contract;
  const bump = (name: string) => {
    const u = applyEdit(name, c, DUMMY, 'wan2-lightning');
    if (u) c = u;
  };
  bump('align_facing');
  bump('lead_room');
  bump('ground_secondary');
  bump('downgrade_move');
  bump('downgrade_motion_level');
  if (c.transformation === 'state_change') bump('continuation_beat');
  return c;
}

function blockOrFix(violations: { severity: string }[]): number {
  return violations.filter((v) => v.severity !== 'warn').length;
}

const DIRECTIONS: ScreenDir[] = ['toward_camera', 'away_from_camera', 'screen_left', 'screen_right', 'none'];
const MOVES: CameraMove[] = ['static', 'push_in', 'pan_left', 'zoom_out'];
const FACINGS: Facing[] = ['camera', 'away', 'screen_left', 'screen_right'];

describe('compile -> lint round trip', () => {
  it.each(DIRECTIONS)('screenDirection=%s: normalized contract compiles lint-clean (image+video)', (dir) => {
    const raw = validContract({ action: { subjectId: 'maya', verb: 'walks', screenDirection: dir, motionLevel: 'low', ambient: ['dust drifts'] } });
    const contract = normalize(raw);

    const imagePrompt = compileImagePrompt(contract, { aspectRatio: '16:9' });
    const imageLint = lintImage({ contract, imagePrompt }, IMAGE_GUARDRAILS);
    expect(blockOrFix(imageLint.violations)).toBe(0);

    const motionPrompt = compileMotionPrompt(contract);
    const videoLint = lintVideo({ contract, motionPrompt, imagePrompt, profile: 'wan2-lightning' }, VIDEO_GUARDRAILS);
    expect(blockOrFix(videoLint.violations)).toBe(0);
  });

  it.each(MOVES)('camera.move=%s compiles a motion prompt that lints clean', (move) => {
    const contract = normalize(validContract({ camera: { ...validContract().camera, move } }));
    const motionPrompt = compileMotionPrompt(contract);
    const videoLint = lintVideo({ contract, motionPrompt, imagePrompt: 'x', profile: 'wan2-lightning' }, VIDEO_GUARDRAILS);
    expect(blockOrFix(videoLint.violations)).toBe(0);
  });

  it.each(FACINGS)('subject facing=%s (with a matching screenDirection) compiles clean', (facing) => {
    const dirFor: Record<Facing, ScreenDir> = { camera: 'toward_camera', away: 'away_from_camera', screen_left: 'screen_left', screen_right: 'screen_right', three_quarter_left: 'toward_camera', three_quarter_right: 'toward_camera' };
    const raw = validContract({
      subjects: [{ id: 'maya', kind: 'character', count: 1, position: 'center', facing }],
      action: { subjectId: 'maya', verb: 'walks', screenDirection: dirFor[facing], motionLevel: 'low', ambient: [] },
    });
    const contract = normalize(raw);
    const imagePrompt = compileImagePrompt(contract);
    expect(blockOrFix(lintImage({ contract, imagePrompt }, IMAGE_GUARDRAILS).violations)).toBe(0);
  });

  it('a multi-subject contract with an ungrounded secondary subject is normalized before compiling', () => {
    const raw = validContract({
      subjects: [
        { id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera' },
        { id: 'kitten', kind: 'animal', count: 1, position: undefined as unknown as 'background', detail: 'a tabby kitten reaching up' },
      ],
    });
    const contract = normalize(raw);
    const imagePrompt = compileImagePrompt(contract);
    const lint = lintImage({ contract, imagePrompt }, IMAGE_GUARDRAILS);
    expect(blockOrFix(lint.violations)).toBe(0);
    expect(imagePrompt).toContain('tabby kitten');
  });

  it('f18 (reversed direction+side, banned tracking move): normalized contract compiles clean on both sides', () => {
    const raw = validContract({
      camera: { ...validContract().camera, side: 'front', move: 'tracking' },
      subjects: [{ id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera' }],
      action: { subjectId: 'maya', verb: 'walks down the stairs', screenDirection: 'away_from_camera', motionLevel: 'low', ambient: [] },
    });
    const contract = normalize(raw);
    expect(contract.subjects[0].facing).toBe('away');
    expect(contract.camera.side).toBe('back');
    expect(contract.camera.move).toBe('static'); // tracking downgraded

    const imagePrompt = compileImagePrompt(contract);
    expect(blockOrFix(lintImage({ contract, imagePrompt }, IMAGE_GUARDRAILS).violations)).toBe(0);
    const motionPrompt = compileMotionPrompt(contract);
    expect(blockOrFix(lintVideo({ contract, motionPrompt, imagePrompt, profile: 'wan2-lightning' }, VIDEO_GUARDRAILS).violations)).toBe(0);
  });

  it('f21 (banned crane/pedestal move + "reveal" framing): normalized contract compiles clean', () => {
    const contract = normalize(validContract({ camera: { ...validContract().camera, move: 'pedestal_up', shotSize: 'wide' } }));
    expect(contract.camera.move).toBe('static');
    const motionPrompt = compileMotionPrompt(contract);
    expect(motionPrompt.toLowerCase()).not.toMatch(/reveal/);
    expect(blockOrFix(lintVideo({ contract, motionPrompt, imagePrompt: 'x', profile: 'wan2-lightning' }, VIDEO_GUARDRAILS).violations)).toBe(0);
  });

  it('f19 (empty platform): the compiled motion prompt always states the only-person clause', () => {
    const contract = normalize(
      validContract({ setting: { ...validContract().setting, place: 'an empty subway platform', population: 'empty' }, camera: { ...validContract().camera, move: 'push_in' } }),
    );
    const motionPrompt = compileMotionPrompt(contract);
    expect(motionPrompt).toMatch(/only person in the scene/);
  });

  it('f20 (state change) is normalized to a continuation before compiling', () => {
    const contract = normalize(validContract({ transformation: 'state_change' }));
    expect(contract.transformation).toBe('continuation');
    const imagePrompt = compileImagePrompt(contract);
    expect(blockOrFix(lintImage({ contract, imagePrompt }, IMAGE_GUARDRAILS).violations)).toBe(0);
  });

  it('a crowd scene claims neither "alone in frame" nor the only-person clause — they contradict the shot', () => {
    // Found 2026-09-18 dry-running a real request: "one Maya, alone in frame"
    // inside "a crowded middle school hallway" is a prompt at war with itself.
    const crowd = normalize(
      validContract({ setting: { ...validContract().setting, place: 'a crowded middle school hallway', population: 'crowd' } }),
    );
    expect(compileImagePrompt(crowd)).not.toMatch(/alone in frame/);
    expect(compileMotionPrompt(crowd)).not.toMatch(/only person in the scene/);
    // and still lints clean without them (V-HAL-02 exempts crowd)
    expect(blockOrFix(lintVideo({ contract: crowd, motionPrompt: compileMotionPrompt(crowd), imagePrompt: compileImagePrompt(crowd), profile: 'wan2-lightning' }, VIDEO_GUARDRAILS).violations)).toBe(0);
  });

  it('a sparse scene KEEPS the only-person clause — that is the case V-HAL-02 exists for', () => {
    const sparse = normalize(
      validContract({ setting: { ...validContract().setting, place: 'a subway platform', population: 'sparse' }, camera: { ...validContract().camera, move: 'push_in' } }),
    );
    expect(compileMotionPrompt(sparse)).toMatch(/only person in the scene/);
  });

  it('medium motion survives normalization on a profile whose max IS medium', () => {
    // Regression: downgrade_motion_level used to flatten everything above
    // `low` unconditionally, disagreeing with V-ACT-03's own motionLevelAllowed.
    const medium = normalize(validContract({ action: { ...validContract().action, motionLevel: 'medium' } }));
    expect(medium.action.motionLevel).toBe('medium');
    const high = normalize(validContract({ action: { ...validContract().action, motionLevel: 'high' } }));
    expect(high.action.motionLevel).toBe('medium');
  });

  it('word counts stay within the guardrail bands', () => {
    const contract = normalize(validContract());
    const imagePrompt = compileImagePrompt(contract);
    const motionPrompt = compileMotionPrompt(contract);
    expect(imagePrompt.split(/\s+/).length).toBeLessThanOrEqual(110);
    const motionWords = motionPrompt.split(/\s+/).length;
    expect(motionWords).toBeGreaterThanOrEqual(12);
    expect(motionWords).toBeLessThanOrEqual(45);
  });
});
