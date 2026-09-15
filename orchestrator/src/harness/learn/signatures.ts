/**
 * Finding signature classification (prompt harness plan §9.2, §7.6). Maps a
 * VLM issue (+ optional probe comparison) to a deterministic signature
 * string, and a signature to the guardrail whose corrective ladder handles
 * it. A signature with no mapped guardrail is `*.uncovered.<category>` —
 * the raw material harness/learn/promote.ts turns into new guardrails.
 */
import type { Issue } from '../../quality/rubric';
import type { ProbeComparison } from '../probe/motion-probe';

const CAMERA_WORDS = /\b(camera|crane|tilt|pan|track|zoom|push|pull|dolly|truck|pedestal|orbit|arc|static)\b/;
const REVERSAL_WORDS = /\b(revers|opposite|wrong direction|instead of)\b/;
const PERSON_ENTRY_WORDS = /\b(new (character|figure|person)|stranger|unprompted|enters? (the )?frame|walks? (in|into)|second person)\b/;
const WARP_WORDS = /\b(warps?\w*|stretch\w*|distort\w*|multipl\w*|duplicat\w* limbs?|extra limbs?)\b/;
const MISSING_SUBJECT_WORDS = /\b(missing|absent|not (present|visible) in (the )?(source|image)|no real .* to animate)\b/;
const FROZEN_WORDS = /\b(static|frozen|no motion|minimal motion|completely fails to execute)\b/;
const DUPLICATE_WORDS = /\b(duplicat\w*|two identical|extra (hand|arm|limb|copy|copies)|second (girl|person|body)|multiple copies)\b/;

export function classifyVideoSignature(issue: Issue, probe?: ProbeComparison): string {
  const text = `${issue.category} ${issue.description}`.toLowerCase();
  if (probe?.personEntry) return 'video.hallucination.person_entry';
  if (probe?.moveMatches === false) return 'video.camera.move_not_executed';
  if (REVERSAL_WORDS.test(text)) return 'video.direction.reversed';
  if (issue.category === 'PROMPT_VISUAL_MISMATCH' && CAMERA_WORDS.test(text)) return 'video.camera.move_not_executed';
  if (issue.category === 'HALLUCINATION_VISUAL' && PERSON_ENTRY_WORDS.test(text)) return 'video.hallucination.person_entry';
  if ((issue.category === 'ANATOMY_DEFECT' || issue.category === 'HALLUCINATION_VISUAL') && WARP_WORDS.test(text)) return 'video.anatomy.limb_warp';
  if (issue.category === 'HALLUCINATION_VISUAL' && MISSING_SUBJECT_WORDS.test(text)) return 'video.hallucination.missing_subject_motion';
  if (issue.category === 'MOTION_QUALITY' && FROZEN_WORDS.test(text)) return 'video.motion.frozen';
  return `video.uncovered.${issue.category.toLowerCase()}`;
}

export function classifyImageSignature(issue: Issue): string {
  const text = `${issue.category} ${issue.description}`.toLowerCase();
  if (issue.category === 'HALLUCINATION_VISUAL' && DUPLICATE_WORDS.test(text)) return 'image.hallucination.duplicate_or_extra';
  if (issue.category === 'HALLUCINATION_VISUAL' && MISSING_SUBJECT_WORDS.test(text)) return 'image.hallucination.missing_subject';
  if (issue.category === 'ANATOMY_DEFECT') return 'image.anatomy.defect';
  if (issue.category === 'PROMPT_VISUAL_MISMATCH') return 'image.contract.mismatch';
  if (issue.category === 'IDENTITY_MISMATCH') return 'image.identity.mismatch';
  return `image.uncovered.${issue.category.toLowerCase()}`;
}

/** Which observed-vs-contract field mismatch (plan §7.3) maps to which
 * signature — used by correct/image-ladder.ts when the image gate's
 * `observed` block disagrees with the planned contract. */
export function classifyObservedMismatch(field: 'facing' | 'camera_side' | 'camera_angle' | 'character_count'): string {
  return `image.contract.${field}_mismatch`;
}

export const VIDEO_SIGNATURE_GUARDRAIL: Record<string, string> = {
  'video.camera.move_not_executed': 'V-CAM-02',
  'video.direction.reversed': 'V-DIR-02',
  'video.hallucination.person_entry': 'V-HAL-02',
  'video.anatomy.limb_warp': 'V-ACT-03',
  'video.hallucination.missing_subject_motion': 'V-HAL-01',
  'video.motion.frozen': 'V-ACT-03',
};

export const IMAGE_SIGNATURE_GUARDRAIL: Record<string, string> = {
  'image.hallucination.duplicate_or_extra': 'I-CNT-02',
  'image.hallucination.missing_subject': 'I-SUB-01',
  'image.anatomy.defect': 'I-HAND-01',
  'image.contract.facing_mismatch': 'I-DIR-01',
  'image.contract.camera_side_mismatch': 'I-SIDE-01',
  'image.contract.character_count_mismatch': 'I-CNT-02',
  'image.contract.mismatch': 'I-CNT-01',
};

export function signatureToGuardrailId(domain: 'image' | 'video', signature: string): string | undefined {
  return domain === 'video' ? VIDEO_SIGNATURE_GUARDRAIL[signature] : IMAGE_SIGNATURE_GUARDRAIL[signature];
}
