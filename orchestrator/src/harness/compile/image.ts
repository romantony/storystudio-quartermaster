/**
 * Deterministic image-prompt compiler (prompt harness plan §6.3). Guaranteed
 * lint-clean by construction: every "contract" check in lint/image.ts that
 * reads the compiled TEXT (counts stated, shot size/angle lead, camera side,
 * population, reference anchor, length) is satisfied by this template for
 * any contract that already passed lint/image.ts's CONTRACT-level checks.
 * Verified by __tests__/harness-compile.test.ts's property-style check:
 * compile(fixCandidate(contract)) always re-lints clean.
 */
import { primarySubject, secondarySubjects, type ShotContract, type ShotSubject } from '../contract';
import { CAMERA_ANGLE_PHRASE, CAMERA_SIDE_PHRASE, SHOT_SIZE_PHRASE } from './vocab';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

const PUBLIC_PLACE = /\b(street|platform|corridor|hallway|station|subway|plaza|sidewalk|square|alley|lobby|stairwell)\b/i;

function subjectPhrase(s: ShotSubject, isPrimary: boolean, singleCharacter: boolean): string {
  const anchor = s.ref === 'reference_image' ? 'from the reference image' : '';
  if (isPrimary) {
    const countClause = singleCharacter ? `one ${s.id}, alone in frame` : `${numberWord(s.count)} ${s.id}`;
    const parts = [countClause, anchor, s.pose, s.facing ? undefined : undefined].filter(Boolean);
    return parts.join(' ').trim();
  }
  const countClause = s.count > 1 ? `${numberWord(s.count)} ${s.detail ?? s.id}` : `${s.detail ?? s.id}`;
  return `${countClause}, ${(s.position ?? 'background').replace(/_/g, ' ')}`.trim();
}

/** True when this contract's setting is a public place with declared
 * population (I-EMP-01) — rendered into an explicit population clause. */
function populationClause(contract: ShotContract): string | undefined {
  const { place, population } = contract.setting;
  if (population === 'empty' && PUBLIC_PLACE.test(place)) return 'she is the only person there';
  if (population === 'empty') return 'empty, no one else in view';
  if (population === 'sparse') return 'a few people in the distance';
  return undefined;
}

export interface CompileImageOptions {
  aspectRatio?: string;
}

export function compileImagePrompt(contract: ShotContract, opts: CompileImageOptions = {}): string {
  const primary = primarySubject(contract);
  const characters = contract.subjects.filter((s) => s.kind === 'character');
  const singleCharacter = characters.length === 1;
  const cam = contract.camera;

  const needsSide = contract.action.screenDirection !== 'none';
  const lead = [
    `${SHOT_SIZE_PHRASE[cam.shotSize]} ${CAMERA_ANGLE_PHRASE[cam.angle]}${needsSide ? `, ${CAMERA_SIDE_PHRASE[cam.side]}` : ''}.`,
  ];

  const lightingBits = [contract.setting.lighting, contract.setting.timeOfDay].filter(Boolean);
  if (lightingBits.length) lead.push(`${lightingBits.join(', ')}.`);

  const subjectSentences: string[] = [];
  if (primary) subjectSentences.push(`${subjectPhrase(primary, true, singleCharacter)}${primary.pose ? '' : ''}.`.replace(/\s+\./, '.'));
  for (const s of secondarySubjects(contract)) {
    subjectSentences.push(`${subjectPhrase(s, false, singleCharacter)}.`);
  }

  const settingBits = [contract.setting.place, populationClause(contract), contract.transformation === 'continuation' ? undefined : undefined].filter(
    Boolean,
  );
  const settingSentence = settingBits.length ? `${settingBits.join(', ')}.` : undefined;

  const transformationSentence =
    contract.transformation === 'continuation'
      ? `${primary?.id ?? 'she'} already partway through the moment, mid-action.`
      : undefined;

  // NOT "consistent character from the reference image" here — the anchor
  // phrase is already rendered once, on the primary subject's own sentence
  // above; repeating "from the reference image" trips I-REF-01 ("appears
  // exactly once"), which exists because a GPT-5 mini rewrite duplicating
  // it read as confused, not reinforcing.
  const trailerBits = ['Photorealistic cinematic film still', opts.aspectRatio ?? '16:9'];
  if (contract.subjects.some((s) => s.ref === 'reference_image')) trailerBits.push('consistent character identity');
  const trailer = `${trailerBits.join(', ')}.`;

  return [...lead, ...subjectSentences, settingSentence, transformationSentence, trailer].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
