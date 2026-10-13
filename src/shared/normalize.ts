/**
 * Word-cloud answer normalization (SPEC.md "Answer normalization").
 *
 * Shared by the server (which is authoritative) and the audience page (which
 * uses it only to spot duplicates before sending). Pure, no runtime APIs.
 */
import { LIMITS } from "./protocol";

export interface NormalizedAnswer {
  /** Display form: the voter's own spelling after normalization. */
  text: string;
  /** Matching key: `text` lowercased. */
  key: string;
}

// Punctuation stripped from both ends of an answer. Symbols such as `+` and
// `#` are deliberately absent so `C++` and `C#` survive.
const EDGE_CHARS = `.,;:!?"'()[]{}…“”‘’„‚«»‹›`;
const EDGE = new RegExp(
  `^[\\s${escapeClass(EDGE_CHARS)}]+|[\\s${escapeClass(EDGE_CHARS)}]+$`,
  "gu",
);
// Control characters (Cc) plus invisible zero-width characters that would
// otherwise make visually identical answers distinct.
const INVISIBLE = /[\p{Cc}​‌⁠﻿]/gu;
const WHITESPACE = /\s+/gu;

function escapeClass(chars: string): string {
  return chars.replace(/[\\\]\[^-]/g, "\\$&");
}

function strip(text: string): string {
  return text.replace(INVISIBLE, "").replace(WHITESPACE, " ").replace(EDGE, "");
}

/**
 * Normalize one answer. Returns null when nothing is left.
 *
 * 1. NFKC, control characters removed, whitespace collapsed, trimmed.
 * 2. Leading/trailing punctuation and quotes stripped.
 * 3. First `maxWords` words kept, then cut to `LIMITS.answerChars`
 *    characters (code points), and stripped again so a cut never leaves a
 *    dangling comma or space.
 */
export function normalizeAnswer(raw: string, maxWords: number): NormalizedAnswer | null {
  // Whitespace (including \n and \t, which are Cc) becomes a space before
  // the remaining control characters are dropped, so "a\nb" stays two words.
  let text = strip(raw.normalize("NFKC").replace(WHITESPACE, " "));
  if (!text) return null;
  text = text.split(" ").slice(0, Math.max(1, maxWords)).join(" ");
  const chars = Array.from(text);
  if (chars.length > LIMITS.answerChars) text = chars.slice(0, LIMITS.answerChars).join("");
  text = strip(text);
  if (!text) return null;
  return { text, key: text.toLowerCase() };
}
