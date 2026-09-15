/**
 * Shared "no invented detail" check (I-REW-01 / V-REW-01). No LLM, no
 * lemmatizer — a plain word-diff against the contract's own vocabulary and
 * whatever draft the regenerate tool started from. Catches the concrete
 * failure this rule exists for: GPT-5 mini inventing "fingertips sinking
 * 5-8mm, hairline splits" that were never in the contract or the draft.
 */
import type { ShotContract } from '../contract';

const STOPWORDS = new Set(
  `a an the and or but of to from in on at by with without into onto for as is are was were be being been
   she he it they them her his their one two three alone only still keeps stays facing faces moves moving
   move camera shot angle level eye low high wide medium close up down left right front back side toward
   towards away screen frame scene person people girl reference image images photorealistic cinematic film
   consistent character film-still still-frame aspect ratio her his hers girl's the-girl this that these those
   slow slowly gentle gently pushes push pulls pull pans pan tilts tilt tracks tracking static push-in pull-out
   over under above below through into out of the-camera camera-stays keeps-facing while as-the whole time
   toward-the-camera away-from-the-camera not no never with-her behind-her ahead-of-her forward backward`
    .split(/\s+/)
    .filter(Boolean),
);

export function wordsOf(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z'-]*|\d+(\.\d+)?%?|\d+\s?(mm|cm|in|inches|degrees|seconds|s)\b/g) ?? []).map((w) => w.trim()),
  );
}

/** Every word the contract itself licenses: subject ids/kinds/poses/detail,
 * setting, camera fields, action verb/ambient. Anything outside this plus
 * the draft's own words is "invented". */
export function contractVocabulary(contract: ShotContract): Set<string> {
  const parts: string[] = [
    contract.setting.place,
    contract.setting.timeOfDay ?? '',
    contract.setting.lighting ?? '',
    contract.action.verb,
    ...contract.action.ambient,
    contract.camera.shotSize,
    contract.camera.angle,
    contract.camera.side,
    contract.camera.move,
  ];
  for (const s of contract.subjects) {
    parts.push(s.id, s.kind, s.pose ?? '', s.detail ?? '');
  }
  const vocab = new Set<string>();
  for (const p of parts) for (const w of wordsOf(p)) vocab.add(w);
  return vocab;
}

/** Words in `candidate` that appear in neither `draft` nor the contract's
 * own vocabulary nor the stopword list. A non-empty result means the
 * candidate invented detail — I-REW-01/V-REW-01's exact failure mode. */
export function newWords(candidate: string, draft: string, contract: ShotContract): string[] {
  const candidateWords = wordsOf(candidate);
  const licensed = new Set<string>([...wordsOf(draft), ...contractVocabulary(contract), ...STOPWORDS]);
  return [...candidateWords].filter((w) => !licensed.has(w) && w.length > 2);
}
