/**
 * Guardrail lint tests (prompt harness plan §5, §6.2). Fixtures reproduce
 * the real win_2026_09_15_06 (Maya) cohort failures listed in
 * docs/qm-orchestrator-prompt-harness-implementation-plan.md §1 — each test
 * asserts the RIGHT guardrail fires for the RIGHT reason.
 */
import { lintImage, type ImageLintContext } from '../src/harness/lint/image';
import { lintVideo, type VideoLintContext } from '../src/harness/lint/video';
import { seedGuardrails } from '../src/harness/guardrails/store';
import { validContract } from './helpers/harness-fixtures';

const IMAGE_GUARDRAILS = seedGuardrails('image', 'any');
const VIDEO_GUARDRAILS = seedGuardrails('video', 'wan2-lightning');

function ids(violations: { guardrailId: string }[]): string[] {
  return violations.map((v) => v.guardrailId);
}

describe('lintImage', () => {
  it('f12: flags an uncounted secondary prop (I-CNT-01)', () => {
    const contract = validContract({
      subjects: [
        { id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera' },
        { id: 'crystal', kind: 'prop', count: 3, position: 'foreground', detail: 'glowing crystals' },
      ],
    });
    const ctx: ImageLintContext = { contract, imagePrompt: 'Maya sits with the crystal beside her.' };
    const result = lintImage(ctx, IMAGE_GUARDRAILS);
    expect(ids(result.violations)).toContain('I-CNT-01');
  });

  it('f12: a single-character contract requires "alone in frame" (I-CNT-02)', () => {
    const contract = validContract();
    const ctx: ImageLintContext = { contract, imagePrompt: 'Maya sits on the floor.' };
    const result = lintImage(ctx, IMAGE_GUARDRAILS);
    expect(ids(result.violations)).toContain('I-CNT-02');
  });

  it('f13: hand contact at close range flags I-HAND-01', () => {
    const contract = validContract({
      camera: { ...validContract().camera, shotSize: 'close_up' },
      subjects: [{ id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera', handContact: true }],
    });
    const ctx: ImageLintContext = { contract, imagePrompt: 'one maya, alone in frame, pressing her hand against the door.' };
    const result = lintImage(ctx, IMAGE_GUARDRAILS);
    expect(ids(result.violations)).toContain('I-HAND-01');
    const guardrail = IMAGE_GUARDRAILS.find((g) => g.id === 'I-HAND-01')!;
    expect(guardrail.corrective[0]).toEqual({ type: 'route', to: 'flux-4b' });
  });

  it('a missing-kitten style secondary subject with no grounding flags I-SUB-01', () => {
    const contract = validContract({
      subjects: [
        { id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera' },
        { id: 'kitten', kind: 'animal', count: 1, position: 'background' }, // no `detail`
      ],
    });
    const ctx: ImageLintContext = { contract, imagePrompt: 'one maya, alone in frame, the tiny kitten' };
    const result = lintImage(ctx, IMAGE_GUARDRAILS);
    expect(ids(result.violations)).toContain('I-SUB-01');
  });

  it('the (avoid: ...) suffix flags I-NEG-01', () => {
    const contract = validContract();
    const ctx: ImageLintContext = { contract, imagePrompt: 'one maya, alone in frame (avoid: two right hands)' };
    const result = lintImage(ctx, IMAGE_GUARDRAILS);
    expect(ids(result.violations)).toContain('I-NEG-01');
  });
});

describe('lintVideo', () => {
  it('f18: reversed direction/side is caught structurally (V-DIR-02), independent of wording', () => {
    // The real f18 bug: she should walk AWAY from the camera (down the
    // stairs, back to camera) but the contract/image had her facing the
    // camera — this is a pure CONTRACT check, no text involved.
    const contract = validContract({
      camera: { ...validContract().camera, side: 'front', move: 'tracking' },
      subjects: [{ id: 'maya', kind: 'character', count: 1, position: 'center', facing: 'camera' }],
      action: { subjectId: 'maya', verb: 'walks down the stairs', screenDirection: 'away_from_camera', motionLevel: 'low', ambient: [] },
    });
    const ctx: VideoLintContext = { contract, motionPrompt: 'x', imagePrompt: 'x', profile: 'wan2-lightning' };
    const result = lintVideo(ctx, VIDEO_GUARDRAILS);
    expect(ids(result.violations)).toEqual(expect.arrayContaining(['V-DIR-02', 'V-CAM-02']));
  });

  it('f21: a banned move (pedestal_up / crane) flags V-CAM-02, downgrading to static', () => {
    const contract = validContract({ camera: { ...validContract().camera, move: 'pedestal_up' } });
    const ctx: VideoLintContext = { contract, motionPrompt: 'x', imagePrompt: 'x', profile: 'wan2-lightning' };
    const result = lintVideo(ctx, VIDEO_GUARDRAILS);
    const v = result.violations.find((x) => x.guardrailId === 'V-CAM-02')!;
    expect(v).toBeDefined();
    expect(v.detail).toMatchObject({ status: 'banned', downgradeTo: 'static' });
  });

  it('f21 on the replicate-wan22-fast fallback profile: the same move is only on probation', () => {
    const contract = validContract({ camera: { ...validContract().camera, move: 'tracking' } });
    const replicateGuardrails = seedGuardrails('video', 'replicate-wan22-fast');
    const ctx: VideoLintContext = { contract, motionPrompt: 'x', imagePrompt: 'x', profile: 'replicate-wan22-fast' };
    const result = lintVideo(ctx, replicateGuardrails);
    const v = result.violations.find((x) => x.guardrailId === 'V-CAM-02')!;
    expect(v.detail).toMatchObject({ status: 'probation' });
  });

  it('f19: an exposing move in a sparse/empty setting without the only-person clause flags V-HAL-02', () => {
    const contract = validContract({
      setting: { ...validContract().setting, place: 'an empty subway platform', population: 'empty' },
      camera: { ...validContract().camera, move: 'pull_out' },
    });
    const ctx: VideoLintContext = { contract, motionPrompt: 'the platform stretches out', imagePrompt: 'x', profile: 'wan2-lightning' };
    const result = lintVideo(ctx, VIDEO_GUARDRAILS);
    expect(ids(result.violations)).toContain('V-HAL-02');
  });

  it('f19: the same shot passes once the only-person clause is present', () => {
    const contract = validContract({
      setting: { ...validContract().setting, place: 'an empty subway platform', population: 'empty' },
      camera: { ...validContract().camera, move: 'pull_out' },
    });
    const ctx: VideoLintContext = {
      contract,
      motionPrompt: 'the platform stretches out; she stays the only person in the scene.',
      imagePrompt: 'x',
      profile: 'wan2-lightning',
    };
    const result = lintVideo(ctx, VIDEO_GUARDRAILS);
    expect(ids(result.violations)).not.toContain('V-HAL-02');
  });

  it('f20: a state-change transformation flags V-ACT-02', () => {
    const contract = validContract({ transformation: 'state_change' });
    const ctx: VideoLintContext = { contract, motionPrompt: 'x', imagePrompt: 'x', profile: 'wan2-lightning' };
    const result = lintVideo(ctx, VIDEO_GUARDRAILS);
    expect(ids(result.violations)).toContain('V-ACT-02');
  });

  it('f23: a combined "tilt + follow" prompt with two move phrases flags V-CAM-01', () => {
    const contract = validContract({ camera: { ...validContract().camera, move: 'tilt_down' } });
    const ctx: VideoLintContext = {
      contract,
      motionPrompt: 'camera tilts down following the spiral staircase, tracks her descent',
      imagePrompt: 'x',
      profile: 'wan2-lightning',
    };
    const result = lintVideo(ctx, VIDEO_GUARDRAILS);
    expect(ids(result.violations)).toContain('V-CAM-01');
  });

  it('scene continuity: a direction flip within the same scene flags V-DIR-04', () => {
    const prev = validContract({ sceneId: 'chase', action: { ...validContract().action, screenDirection: 'screen_left' }, camera: { ...validContract().camera, side: 'left_profile' } });
    const current = validContract({ sceneId: 'chase', action: { ...validContract().action, screenDirection: 'screen_right' }, camera: { ...validContract().camera, side: 'right_profile' } });
    const ctx: VideoLintContext = { contract: current, motionPrompt: 'x', imagePrompt: 'x', profile: 'wan2-lightning', previousInScene: prev };
    const result = lintVideo(ctx, VIDEO_GUARDRAILS);
    expect(ids(result.violations)).toContain('V-DIR-04');
  });

  it('scene continuity: no violation across a DIFFERENT scene', () => {
    const prev = validContract({ sceneId: 'bedroom', action: { ...validContract().action, screenDirection: 'screen_left' } });
    const current = validContract({ sceneId: 'kitchen', action: { ...validContract().action, screenDirection: 'screen_right' } });
    const ctx: VideoLintContext = { contract: current, motionPrompt: 'x', imagePrompt: 'x', profile: 'wan2-lightning', previousInScene: prev };
    const result = lintVideo(ctx, VIDEO_GUARDRAILS);
    expect(ids(result.violations)).not.toContain('V-DIR-04');
  });
});
