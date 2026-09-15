const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** True if `text` states `count` either as a digit or as its English word
 * ("2" or "two"), or — for count===1 — as "a single"/"alone"/"only one". */
export function countStated(text: string, count: number): boolean {
  const lower = text.toLowerCase();
  const word = NUMBER_WORDS[count];
  if (word && new RegExp(`\\b${word}\\b`).test(lower)) return true;
  if (new RegExp(`\\b${count}\\b`).test(lower)) return true;
  if (count === 1 && /\b(a single|alone|only one|by herself|by himself)\b/.test(lower)) return true;
  return false;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
