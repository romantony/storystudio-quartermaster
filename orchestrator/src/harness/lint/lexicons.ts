/**
 * Word/phrase lists referenced by `LexiconDetector.list` (prompt harness
 * plan §5.0). Plain regex, case-insensitive — no LLM, no dependency.
 */

export const LEXICONS: Record<string, RegExp> = {
  // I-NEG-01 / V-NEG-01: the (avoid: ...) suffix, and any bare negation of
  // a defect. Matches the exact shape quality/rewrite.ts's old
  // correctedPrompt() produced, plus generic "no X"/"without X" phrasing.
  negation: /\(avoid:[^)]*\)|\bavoid(ing)?\b|\bwithout\b|\bno\s+(extra|duplicate|additional)\b|\bnot\s+\w+ing\b/i,

  // I-TRANS-01: a full state transformation named directly, rather than
  // shown as its visible mid-state.
  vanishTransform: /\b(disappears?|vanishes?|dissolves?|turns? into|transforms? into|melts? away)\b/i,

  // V-CAM-05: a camera move that needs content outside the source frame.
  reveal: /\b(reveal(ing|s)?|comes? into view|comes? into frame)\b/i,

  // V-DIR-01: relative (not screen-space) direction language.
  relativeDirection: /\b(forward|backward|past (her|him|them)|behind (her|him|them)|ahead of (her|him|them))\b/i,

  // V-LEX-01: metaphor / abstract language Movie Gen's §3.4.1 rewrite
  // guidance explicitly avoids ("replacing complex vocabulary with more
  // accessible and straightforward terminology").
  metaphor: /\b(impossible|towers? above|swallow(s|ed)? whole|dance(s|d)? with|embrace(s|d)? the|whisper(s|ed)? of)\b/i,
};

export function lexiconMatch(text: string, listName: string): RegExpMatchArray | null {
  const re = LEXICONS[listName];
  if (!re) return null;
  return text.match(re);
}
