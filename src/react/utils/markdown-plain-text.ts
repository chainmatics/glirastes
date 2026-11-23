/**
 * Markdown source as readable plain text: the fallback when the Markdown
 * renderer cannot be loaded, and the measure of the loading placeholder.
 * Best effort, not a Markdown parser: block markers, emphasis, code spans,
 * links and backslash escapes are removed; code keeps its lines and
 * indentation. Every pass is linear in the input (no backtracking regex).
 */

export type PlainBlock = { kind: 'text' | 'code'; text: string };

/** Lines longer than this keep their inline syntax (also escapes): a bound on the work per line. */
export const INLINE_SYNTAX_LINE_LIMIT = 10_000;

/** A mention marker inside Markdown (`markdownWithMentionMarkers`): edge, index bits, separator, label, edge. */
const MARKER_SPAN = /\u2060[\u200B\u200C]+\u2063([^\u2060]*)\u2060/g;
const MARKER_CHARS = /[\u2060\u2063]/g;
/**
 * Escaped characters (and every noncharacter U+FDD0–U+FDEF already in the
 * text) are parked while the syntax is removed: U+FDD0, the index in
 * U+FDE0–U+FDEF hex digits, U+FDD1. Nothing of the text can collide with it.
 */
const PARK = /\\([!-/:-@[-`{-~])|[\uFDD0-\uFDEF]/g;
const PARKED = /\uFDD0([\uFDE0-\uFDEF]+)\uFDD1/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const THEMATIC_BREAK = /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}=+[ \t]*$/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const LIST_ITEM = /^\s*(?:[*+-]|\d{1,9}[.)])\s/;

function park(text: string, store: string[]): string {
  return text.replace(PARK, (match: string, escaped: string | undefined) => {
    const index = store.push(escaped ?? match) - 1;
    const digits = index.toString(16).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(0xfde0 + Number.parseInt(digit, 16)));
    return `\uFDD0${digits}\uFDD1`;
  });
}

function unpark(text: string, store: readonly string[]): string {
  return text.replace(PARKED, (_, digits: string) => {
    const hex = [...digits].map((char) => (char.charCodeAt(0) - 0xfde0).toString(16)).join('');
    return store[Number.parseInt(hex, 16)] ?? '';
  });
}

function blockText(line: string): string {
  let text = line
    .replace(/^ {0,3}(>[ \t]?)+/, '')
    .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '')
    .replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/^(\s*)[*+-][ \t]+(\[[ xX]\][ \t]+)?/, '$1• ');
  if (/^\s*\|.*\|\s*$/.test(text)) {
    text = text.trim().slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim()).join(' · ');
  }
  return text;
}

/** Links, emphasis and the like of a text without code spans; linear (every class excludes its opener). */
function inlineText(text: string): string {
  return text
    .replace(/!\[([^[\]]*)\]\([^()\s]*\)/g, '$1')
    .replace(/\[([^[\]]+)\]\([^()\s]*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^[\]]+)\]\[[^[\]]*\]/g, '$1')
    .replace(/<((?:https?|mailto):[^<>\s]+)>/g, '$1')
    // Emphasis delimiters at a word edge: `*`, `_`, up to three, and `~~`. Unpaired ones go too.
    .replace(/(?<!\w)(?:[*_]{1,3}|~~)(?=\S)/g, '')
    .replace(/(?<=\S)(?:[*_]{1,3}|~~)(?!\w)/g, '');
}

/**
 * The code spans of a line (backslashes inside stay) and its other text
 * (cleaned). Backtick runs pair with the next run of the same length; a
 * backslash before a backtick makes it literal. Linear: one pass to find the
 * runs, one from the right for each run's next partner.
 */
function lineText(line: string): string {
  const runs: Array<{ start: number; length: number }> = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '`') continue;
    let end = index;
    while (end < line.length && line[end] === '`') end += 1;
    let backslashes = 0;
    for (let back = index - 1; back >= 0 && line[back] === '\\'; back -= 1) backslashes += 1;
    // An escaped first backtick is text; the rest of the run still counts.
    const start = backslashes % 2 === 1 ? index + 1 : index;
    if (end > start) runs.push({ start, length: end - start });
    index = end - 1;
  }
  const partner = new Array<number>(runs.length).fill(-1);
  const nextOfLength = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    partner[index] = nextOfLength.get(runs[index]!.length) ?? -1;
    nextOfLength.set(runs[index]!.length, index);
  }
  let out = '';
  let cursor = 0;
  const text = (end: number) => {
    const store: string[] = [];
    out += unpark(inlineText(park(line.slice(cursor, end), store)), store);
  };
  for (let index = 0; index < runs.length; index += 1) {
    const close = partner[index]!;
    if (close < 0) continue;
    const open = runs[index]!;
    text(open.start);
    const code = line.slice(open.start + open.length, runs[close]!.start);
    out += /^ .*[^ ].* $/.test(code) ? code.slice(1, -1) : code;
    cursor = runs[close]!.start + runs[close]!.length;
    index = close;
  }
  text(line.length);
  return out;
}

/** The source as text and code blocks without Markdown syntax. */
export function markdownToPlainBlocks(source: string): PlainBlock[] {
  const blocks: PlainBlock[] = [];
  let text: string[] = [];
  let code: string[] | null = null;
  let fence: string | null = null;
  let afterBlank = true;
  let inList = false;
  const flushText = () => {
    if (text.length > 0) blocks.push({ kind: 'text', text: text.join('\n') });
    text = [];
  };
  const flushCode = () => {
    if (code) {
      while (code.length > 0 && code[code.length - 1]!.trim() === '') code.pop();
      blocks.push({ kind: 'code', text: code.join('\n') });
    }
    code = null;
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(MARKER_SPAN, '$1').replace(MARKER_CHARS, '');
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length && !line.slice(fenceMatch[0].length).trim()) {
        fence = null;
        flushCode();
        afterBlank = true;
      } else code!.push(line);
      continue;
    }
    if (fenceMatch) {
      flushText();
      flushCode();
      fence = fenceMatch[1]!;
      code = [];
      continue;
    }
    if (line.trim() === '') {
      if (code) code.push('');
      else flushText();
      afterBlank = true;
      continue;
    }
    if (INDENTED_CODE.test(line) && (code || (afterBlank && !inList))) {
      if (!code) {
        flushText();
        code = [];
      }
      code.push(line.replace(INDENTED_CODE, ''));
      afterBlank = false;
      continue;
    }
    flushCode();
    afterBlank = false;
    if (LIST_ITEM.test(line)) inList = true;
    else if (!/^\s/.test(line)) inList = false;
    // Table delimiter rows, thematic breaks and setext underlines carry no text.
    if (THEMATIC_BREAK.test(line) || (line.includes('|') && TABLE_DELIMITER.test(line)) || (text.length > 0 && SETEXT_UNDERLINE.test(line))) continue;
    if (line.length > INLINE_SYNTAX_LINE_LIMIT) {
      text.push(line);
      continue;
    }
    // A backslash at the end is a hard line break.
    text.push(lineText(blockText(line)).replace(/\\$/, ''));
  }
  flushText();
  flushCode();
  return blocks;
}

/** The source's text without Markdown syntax; blank lines separate blocks. */
export function markdownToPlainText(source: string): string {
  return markdownToPlainBlocks(source).map((block) => block.text).join('\n\n');
}

const CHARS_PER_LINE = 60;
const MAX_LINES = 8;

/**
 * The size of the loading placeholder, estimated from the source: one line per
 * started 60 characters of each text line (at most 8), and the longest line in
 * characters (at most 60) for its width.
 */
export function markdownPlaceholderShape(source: string): { lines: number; chars: number } {
  let lines = 0;
  let chars = 1;
  for (const block of markdownToPlainBlocks(source)) {
    for (const line of block.text.split('\n')) {
      const length = line.trim().length;
      if (length === 0) continue;
      lines += Math.ceil(length / CHARS_PER_LINE);
      chars = Math.max(chars, Math.min(length, CHARS_PER_LINE));
      if (lines >= MAX_LINES) return { lines: MAX_LINES, chars };
    }
  }
  return { lines: Math.max(lines, 1), chars };
}
