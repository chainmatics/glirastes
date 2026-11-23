/**
 * Markdown source as readable plain text: the fallback when the Markdown
 * renderer cannot be loaded, and the measure of the loading placeholder.
 * Best effort, not a Markdown parser: block markers, emphasis, code spans,
 * links and backslash escapes are removed; fenced code keeps its lines.
 */

/** A mention marker inside Markdown (`markdownWithMentionMarkers`): edge, index bits, separator, label, edge. */
const MARKER_SPAN = /\u2060[\u200B\u200C]+\u2063([^\u2060]*)\u2060/g;
const MARKER_CHARS = /[\u2060\u2063]/g;
/** A backslash escape of ASCII punctuation (CommonMark). */
const ESCAPE = /\\([!-/:-@[-`{-~])/g;
/** Escaped characters are parked in the Private Use Area while the syntax is removed. */
const PARKED = /[\uE000-\uE07F]/g;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const THEMATIC_BREAK = /^\s{0,3}([*_-])(\s*\1){2,}\s*$/;

function park(text: string): string {
  return text.replace(ESCAPE, (_, char: string) => String.fromCharCode(0xe000 + char.charCodeAt(0)));
}

function unpark(text: string): string {
  return text.replace(PARKED, (char) => String.fromCharCode(char.charCodeAt(0) - 0xe000));
}

function blockText(line: string): string {
  let text = line
    .replace(/^\s{0,3}(>\s?)+/, '')
    .replace(/^\s{0,3}#{1,6}(\s+|$)/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/^(\s*)[*+-]\s+(\[[ xX]\]\s+)?/, '$1• ');
  if (/^\s*\|.*\|\s*$/.test(text)) {
    text = text.trim().slice(1, -1).split('|').map((cell) => cell.trim()).join(' · ');
  }
  return text;
}

function inlineText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/(`+)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2');
}

/** The source's text without Markdown syntax; blank lines separate paragraphs. */
export function markdownToPlainText(source: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(MARKER_SPAN, '$1').replace(MARKER_CHARS, '');
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
      else lines.push(line);
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    // Table delimiter rows, thematic breaks and setext underlines carry no text.
    if (TABLE_DELIMITER.test(line) || THEMATIC_BREAK.test(line) || /^\s{0,3}=+\s*$/.test(line)) continue;
    lines.push(unpark(inlineText(blockText(park(line)))));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const CHARS_PER_LINE = 60;
const MAX_LINES = 8;

/**
 * The size of the loading placeholder, estimated from the source: one line per
 * started 60 characters of each text line (at most 8), and the longest line in
 * characters (at most 60) for its width.
 */
export function markdownPlaceholderShape(source: string): { lines: number; chars: number } {
  const textLines = markdownToPlainText(source).split('\n').filter((line) => line.trim().length > 0);
  let lines = 0;
  let chars = 1;
  for (const line of textLines) {
    const length = line.trim().length;
    lines += Math.ceil(length / CHARS_PER_LINE);
    chars = Math.max(chars, Math.min(length, CHARS_PER_LINE));
  }
  return { lines: Math.min(Math.max(lines, 1), MAX_LINES), chars };
}
