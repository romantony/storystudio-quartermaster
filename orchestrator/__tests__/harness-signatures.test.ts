/**
 * Finding-signature classification tests (prompt harness plan §9.2),
 * using the REAL issue text from win_2026_09_15_06's quality_verdicts rows
 * (docs/qm-orchestrator-prompt-harness-implementation-plan.md §1).
 */
import { classifyImageSignature, classifyVideoSignature, signatureToGuardrailId } from '../src/harness/learn/signatures';
import type { Issue } from '../src/quality/rubric';

function issue(category: string, description: string): Issue {
  return { category, priority: 'P0', description };
}

describe('classifyVideoSignature', () => {
  it('f18: "reverses the requested action and camera perspective" -> direction.reversed', () => {
    const sig = classifyVideoSignature(
      issue(
        'PROMPT_VISUAL_MISMATCH',
        'The clip completely reverses the requested action and camera perspective. The character walks up the stairs towards a static camera, instead of walking down the stairs with a tracking shot behind her.',
      ),
    );
    expect(sig).toBe('video.direction.reversed');
    expect(signatureToGuardrailId('video', sig)).toBe('V-DIR-02');
  });

  it('f19: "An unprompted new character appears" -> hallucination.person_entry', () => {
    const sig = classifyVideoSignature(
      issue('HALLUCINATION_VISUAL', 'An unprompted new character appears on the right side of the frame, walking into the shot, which is a critical hallucination.'),
    );
    expect(sig).toBe('video.hallucination.person_entry');
    expect(signatureToGuardrailId('video', sig)).toBe('V-HAL-02');
  });

  it('f20: "arms and legs severely warp, stretch" -> anatomy.limb_warp', () => {
    const sig = classifyVideoSignature(
      issue('HALLUCINATION_VISUAL', "The character's arms and legs severely warp, stretch, and appear to multiply or distort unnaturally, creating significant anatomical defects."),
    );
    expect(sig).toBe('video.anatomy.limb_warp');
    expect(signatureToGuardrailId('video', sig)).toBe('V-ACT-03');
  });

  it('f21: "completely fails to execute the requested crane up" -> camera.move_not_executed', () => {
    const sig = classifyVideoSignature(issue('PROMPT_VISUAL_MISMATCH', "The clip completely fails to execute the requested 'slow crane up' camera motion."));
    expect(sig).toBe('video.camera.move_not_executed');
    expect(signatureToGuardrailId('video', sig)).toBe('V-CAM-02');
  });

  it('an unmapped category falls back to video.uncovered.<category>', () => {
    const sig = classifyVideoSignature(issue('TEMPORAL_DRIFT', 'some unrelated drift'));
    expect(sig).toBe('video.uncovered.temporal_drift');
    expect(signatureToGuardrailId('video', sig)).toBeUndefined();
  });
});

describe('classifyImageSignature', () => {
  it('f12: "generated two identical girls" -> hallucination.duplicate_or_extra', () => {
    const sig = classifyImageSignature(issue('HALLUCINATION_VISUAL', 'The image generated two identical girls instead of a single girl as specified in the prompt.'));
    expect(sig).toBe('image.hallucination.duplicate_or_extra');
    expect(signatureToGuardrailId('image', sig)).toBe('I-CNT-02');
  });

  it('f13: "duplicated right hand" -> hallucination.duplicate_or_extra', () => {
    const sig = classifyImageSignature(issue('HALLUCINATION_VISUAL', 'The main character has a duplicated right hand, one of which is misplaced.'));
    expect(sig).toBe('image.hallucination.duplicate_or_extra');
  });
});
