/**
 * Programming-ligature support, without `@xterm/addon-ligatures`.
 *
 * That addon parses font files to discover ligatures, which needs Node's font
 * probing and cannot run in a webview. This module takes the pragmatic route:
 * a curated list of the operator sequences that every popular coding font
 * (Cascadia Code, Fira Code, JetBrains Mono, Iosevka) ligates. A character
 * joiner hands each matched run to the renderer as one unit; the DOM renderer
 * puts the run in a single span, and the *browser's* text shaping applies the
 * font's own calt rules. A font without ligatures renders the same characters
 * unchanged — joining is visually inert then.
 */

/** Longest first, so `===` wins over `==` at the same position. */
const SEQUENCES = [
  "<=>", "<->", "-->", "<--", "==>", "<==", "->>", "<<-", ">>=", "=<<",
  "===", "!==", "...", "..=", "::=", ":::", ">>>", "<<<", "|||", "<|>",
  "~~>", "<~~", "<$>", "<*>", "<+>",
  "=>", "->", "<-", "<=", ">=", "==", "!=", "&&", "||", "??", "?.", "?:",
  "::", "..", "++", "--", "**", "//", "/*", "*/", "<<", ">>", "|>", "<|",
  "<>", "~>", "<~", "=~", "!~", ":=", "+=", "-=", "*=", "/=", "%=", "&=",
  "|=", "^=", ";;",
];

/** First character -> its sequences, longest first (list order preserved). */
const BY_FIRST = new Map<string, string[]>();
for (const seq of SEQUENCES) {
  const bucket = BY_FIRST.get(seq[0]);
  if (bucket === undefined) BY_FIRST.set(seq[0], [seq]);
  else bucket.push(seq);
}

/**
 * Character-joiner callback: ranges (start, end] of `text` to render as one
 * unit. Matches never overlap — the scan jumps past each hit.
 */
export function ligatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    const bucket = BY_FIRST.get(text[i]);
    if (bucket === undefined) {
      i++;
      continue;
    }
    let length = 0;
    for (const seq of bucket) {
      if (text.startsWith(seq, i)) {
        length = seq.length;
        break;
      }
    }
    if (length === 0) {
      i++;
      continue;
    }
    // A same-character run longer than the matched sequence is a divider
    // (`=====`, `----`, `....`): fonts only keep those plain via calt context
    // that per-range shaping cannot see, so chopping the run into ligature
    // blocks would render a line of mismatched glyphs. Leave the whole run
    // unjoined instead.
    const c = text[i];
    let same = true;
    for (let k = i + 1; k < i + length; k++) {
      if (text[k] !== c) {
        same = false;
        break;
      }
    }
    if (same && text[i + length] === c) {
      while (i < text.length && text[i] === c) i++;
      continue;
    }
    ranges.push([i, i + length]);
    i += length;
  }
  return ranges;
}
