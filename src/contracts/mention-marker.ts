/**
 * The mention marker `{{mention:type:id:label}}` that a picked mention
 * becomes in a sent message, and its canonical profile: a canonical label
 * has nothing the chat bubble hides and the model still reads (no comment
 * delimiters, no braces that end the marker, no control or format
 * characters), so what the model gets is what the chip shows. The grammar
 * is the one every SDK version reads; a canonical marker is a valid marker
 * for older readers too. No engine or provider imports.
 *
 * ```
 * marker = "{{mention:" type ":" id ":" label "}}"
 * type   = [a-z][a-z0-9_.-]{0,63}   (ENTITY_TYPE_PATTERN: every declared
 *          entity type, chat entity types and `command`)
 * id     = 1-200 code points (and UTF-16 units), without ":" "{" "}" "<" ">",
 *          whitespace, Cc, Cf, lone surrogates or any invisible character
 *          of the table below (an id is never cleaned: invalid, no marker)
 * label  = 1-120 code points, the character policy below applied
 * ```
 *
 * Character policy of a label (`cleanDisplayText`, then the delimiters):
 *
 * | Characters | In a label |
 * | --- | --- |
 * | lone surrogates (Cs) | removed |
 * | Cf: bidi controls, zero-width space, word joiner, BOM, soft hyphen, all others | removed |
 * | ZWJ / ZWNJ run between two emoji (before: Extended_Pictographic, emoji modifier or VS16; after: Extended_Pictographic), run contains a ZWJ | one ZWJ |
 * | ZWJ / ZWNJ run between two letters or marks (not variation selectors) | its first joiner |
 * | any other ZWJ / ZWNJ (edges, next to a removed character, emoji and letter) | removed |
 * | tag characters (U+E0000-E007F) | only the exact tags of 🏴 England, Scotland, Wales; all others removed, the 🏴 stays |
 * | VS15 / VS16 right after a character with the Emoji property (❤️, keycaps) | one kept |
 * | other variation selectors (U+FE00-FE0F, U+E0100-E01EF) | removed |
 * | U+034F, Hangul fillers U+115F U+1160 U+3164 U+FFA0, U+2800 | removed |
 * | private use (Co), unassigned and noncharacters (Cn) | removed |
 * | Cc, Zl, Zp, whitespace runs | one space; trimmed |
 * | (after the above) | NFC |
 * | `{` `}` `<!` `-->` `--!>` | `｛` `｝` `‹!` `--›` `--!›` (single `<` `>` stay) |
 * | nothing left | the canonical id |
 * | over 120 (or `maxLength`) code points | cut to at most 119 and `…`, never inside a joined emoji, flag, conjunct or combining sequence |
 *
 * Unassigned (Cn) follows the Unicode version of the JavaScript engine.
 *
 * @module
 */

import { ENTITY_TYPE_PATTERN } from './entity-declaration.js';

/** Upper bound of a canonical label, in code points. */
export const MENTION_MARKER_MAX_LABEL_LENGTH = 120;
/** Upper bound of a marker id, in code points and UTF-16 units. */
export const MENTION_MARKER_MAX_ID_LENGTH = 200;
/**
 * A marker type: the entity type pattern of entity declarations, so every
 * declared entity type, every chat entity type and `command` is one.
 */
export const MENTION_MARKER_TYPE_PATTERN: RegExp = ENTITY_TYPE_PATTERN;

const MARKER_OPEN = '{{mention:';
/** Bounds of the reader every SDK version used, in UTF-16 units. */
const READ_MAX_PART = 200;
const READ_MAX_LABEL = 1_000;

const LONE_SURROGATE = /\p{Cs}/gu;
/**
 * Invisible code points that can carry a hidden payload besides Cc and Cf:
 * variation selectors, the combining grapheme joiner, the Hangul fillers,
 * the braille blank, private use and unassigned code points (noncharacters
 * included).
 */
const INVISIBLE_CLASS = String.raw`\p{Co}\p{Cn}\u034F\u115F\u1160\u3164\uFFA0\u2800\uFE00-\uFE0F\u{E0100}-\u{E01EF}`;
const HAS_HIDDEN_CHAR = new RegExp(`[\\p{Cf}${INVISIBLE_CLASS}]`, 'u');
const HIDDEN_CHAR = new RegExp(`^[\\p{Cf}${INVISIBLE_CLASS}]$`, 'u');
const EMOJI = /^\p{Emoji}$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const REGIONAL_INDICATOR = /^\p{Regional_Indicator}$/u;
/** Code points that belong to the one before them: a cut never falls in front of one. */
const ATTACHED = /^[\p{M}\p{Emoji_Modifier}\u200C\u200D\u{E0020}-\u{E007F}]$/u;
const ZWJ = '\u200D';
const ZWNJ = '\u200C';
const TEXT_PRESENTATION = '\uFE0E';
const EMOJI_PRESENTATION = '\uFE0F';
const BLACK_FLAG = '\u{1F3F4}';
/** The tag sequences after 🏴 of the three RGI subdivision flags (England, Scotland, Wales). */
const RGI_FLAG_TAGS = ['gbeng', 'gbsct', 'gbwls'].map((code) =>
  `${Array.from(code, (char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join('')}\u{E007F}`);
const RGI_FLAG_TAG_LENGTH = 6;
const SPACE_RUNS = /[\p{Cc}\p{Zl}\p{Zp}\p{Zs}\p{White_Space}]+/gu;
const DELIMITERS = /[{}]|<!|--!?>/g;
const DELIMITER_REPLACEMENTS: Readonly<Record<string, string>> = {
  '{': '｛',
  '}': '｝',
  '<!': '‹!',
  '-->': '--›',
  '--!>': '--!›',
};
const INVALID_ID_CHAR = new RegExp(`[:{}<>\\s\\p{Cc}\\p{Cf}\\p{Cs}${INVISIBLE_CLASS}]`, 'u');

export interface CanonicalMentionLabelOptions {
  /** Used (canonical) when nothing visible is left of the label. */
  id?: string;
  /** Code points kept, at most 120 (the default); a longer label ends in `…`. */
  maxLength?: number;
}

function clampLabelLength(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MENTION_MARKER_MAX_LABEL_LENGTH;
  return Math.min(MENTION_MARKER_MAX_LABEL_LENGTH, Math.max(1, Math.floor(value)));
}

const survives = (cp: string | undefined): cp is string => cp !== undefined && !HIDDEN_CHAR.test(cp);
const isEmojiBeforeJoiner = (cp: string) =>
  PICTOGRAPHIC.test(cp) || EMOJI_MODIFIER.test(cp) || cp === EMOJI_PRESENTATION;
const isEmojiAfterJoiner = (cp: string | undefined) => survives(cp) && PICTOGRAPHIC.test(cp);
const isLetterLike = (cp: string | undefined) => survives(cp) && LETTER_OR_MARK.test(cp);

/**
 * Removes hidden characters (Cf and `INVISIBLE_CLASS`) except those ordinary
 * names need. A neighbour counts only if it is kept itself, so a joiner or
 * selector next to any removed character goes too. One pass, linear.
 */
function withoutHiddenChars(text: string): string {
  if (!HAS_HIDDEN_CHAR.test(text)) return text;
  const points = Array.from(text);
  let out = '';
  /** Index of the last code point written, to tell whether `points[i - 1]` was kept. */
  let kept = -1;
  const keep = (from: number, to: number) => {
    for (let j = from; j < to; j += 1) out += points[j]!;
    kept = to - 1;
  };
  for (let i = 0; i < points.length;) {
    const cp = points[i]!;
    const before = kept === i - 1 ? points[i - 1] : undefined;
    if (cp === BLACK_FLAG) {
      const tags = points.slice(i + 1, i + 1 + RGI_FLAG_TAG_LENGTH).join('');
      const end = RGI_FLAG_TAGS.includes(tags) ? i + 1 + RGI_FLAG_TAG_LENGTH : i + 1;
      keep(i, end);
      i = end;
      continue;
    }
    if (!HIDDEN_CHAR.test(cp)) {
      keep(i, i + 1);
      i += 1;
      continue;
    }
    if (cp === ZWJ || cp === ZWNJ) {
      let end = i;
      let hasZwj = false;
      while (end < points.length && (points[end] === ZWJ || points[end] === ZWNJ)) {
        if (points[end] === ZWJ) hasZwj = true;
        end += 1;
      }
      const after = points[end];
      if (before !== undefined && hasZwj && isEmojiBeforeJoiner(before) && isEmojiAfterJoiner(after)) {
        out += ZWJ;
        kept = end - 1;
      } else if (before !== undefined && LETTER_OR_MARK.test(before) && before !== EMOJI_PRESENTATION && before !== TEXT_PRESENTATION && isLetterLike(after)) {
        out += cp;
        kept = end - 1;
      }
      i = end;
      continue;
    }
    // One text or emoji presentation selector right after a character that has both presentations.
    if ((cp === EMOJI_PRESENTATION || cp === TEXT_PRESENTATION) && before !== undefined && EMOJI.test(before)) {
      keep(i, i + 1);
    }
    i += 1;
  }
  return out;
}

/** Whether a cut in front of `points[k]` would split a sequence that belongs together. */
function splitsSequence(points: string[], k: number): boolean {
  if (ATTACHED.test(points[k]!)) return true;
  if (points[k - 1] === ZWJ || points[k - 1] === ZWNJ) return true;
  if (!REGIONAL_INDICATOR.test(points[k]!) || !REGIONAL_INDICATOR.test(points[k - 1]!)) return false;
  // Regional indicators pair up from the start of their run: an odd run before k ends mid-flag.
  let run = 0;
  for (let j = k - 1; j >= 0 && REGIONAL_INDICATOR.test(points[j]!); j -= 1) run += 1;
  return run % 2 === 1;
}

/**
 * Display text cleaned of everything a reader does not see but a model
 * reads (the character policy in the module doc, without the marker
 * delimiters): lone surrogates and hidden characters removed except the
 * joiners, presentation selectors and flag tags of ordinary names; NFC;
 * runs of control, line/paragraph separator and whitespace characters one
 * space; trimmed. Idempotent, linear. Not part of the public API; for
 * contracts that put display text into model-facing blocks.
 */
export function cleanDisplayText(text: string): string {
  // Hidden characters go before NFC: removed later, they could leave two
  // spaces next to each other, or a base and a combining mark NFC composes.
  // They are checked again after NFC, which can change a neighbour (`<` and
  // U+0338 become `≮`, no longer a letter or mark).
  const composed = withoutHiddenChars(text.replace(LONE_SURROGATE, '')).normalize('NFC');
  return withoutHiddenChars(composed)
    .normalize('NFC')
    .replace(SPACE_RUNS, ' ')
    .trim();
}

function visibleLabel(label: string): string {
  return cleanDisplayText(label).replace(DELIMITERS, (found) => DELIMITER_REPLACEMENTS[found]!);
}

/**
 * The canonical form of a mention label: `cleanDisplayText` (see the
 * character policy in the module doc); `{` `}` `<!` `-->` `--!>` become `｛`
 * `｝` `‹!` `--›` `--!›`; empty becomes the canonical `id`; over `maxLength`
 * code points it is cut to at most `maxLength - 1` code points and `…`,
 * before any joined sequence the cut would split. Single `<` and `>` stay.
 * Idempotent, linear in the label's length.
 */
export function canonicalMentionLabel(label: string, options?: CanonicalMentionLabelOptions): string {
  let visible = visibleLabel(typeof label === 'string' ? label : '');
  if (!visible && typeof options?.id === 'string') visible = visibleLabel(options.id);
  const max = clampLabelLength(options?.maxLength);
  // Compare UTF-16 units first: only a label that long can have too many code points.
  if (visible.length <= max) return visible;
  const points = Array.from(visible);
  if (points.length <= max) return visible;
  // Cut before a joined emoji, flag, conjunct or combining sequence, never inside it.
  let keep = max - 1;
  while (keep > 0 && splitsSequence(points, keep)) keep -= 1;
  return `${points.slice(0, keep).join('')}…`;
}

/** Whether `type` is a marker type (`[a-z][a-z0-9_.-]{0,63}`, `ENTITY_TYPE_PATTERN`). */
export function isMentionMarkerType(type: unknown): type is string {
  return typeof type === 'string' && MENTION_MARKER_TYPE_PATTERN.test(type);
}

/**
 * Whether `id` is a marker id: 1-200 code points that every marker reader
 * accepts (so also at most 200 UTF-16 units), without `:` `{` `}` `<` `>`,
 * whitespace, control, format characters or lone surrogates.
 */
export function isMentionMarkerId(id: unknown): id is string {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= MENTION_MARKER_MAX_ID_LENGTH
    && !INVALID_ID_CHAR.test(id);
}

export interface MentionMarker {
  type: string;
  id: string;
  label: string;
}

export interface ParsedMentionMarker extends MentionMarker {
  /** Type and id valid and the label already canonical: what a current writer sends. */
  canonical: boolean;
  /** UTF-16 offsets of the whole marker in the text, `end` exclusive. */
  span: { start: number; end: number };
}

/** Next index at or after `from` of `char`, for queries whose `from` never decreases. */
function forwardFinder(text: string, char: string): (from: number) => number {
  let cachedFrom = -1;
  let cached = -1;
  return (from) => {
    if (cachedFrom >= 0 && from >= cachedFrom && (cached < 0 || cached >= from)) return cached;
    cachedFrom = from;
    cached = text.indexOf(char, from);
    return cached;
  };
}

function firstOf(a: number, b: number): number {
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/**
 * The markers of `text` in order, read exactly as every SDK version reads
 * them (type and id 1-200 UTF-16 units without `:` and `}`, label 1-1000
 * units without `}`), so old stored text gives the same matches. `canonical`
 * says whether a marker is in the canonical profile; a legacy or
 * model-written marker that is not keeps its label as written here.
 * Linear in the length of `text`, also on many unterminated markers.
 */
export function parseMentionMarkers(text: string): ParsedMentionMarker[] {
  const markers: ParsedMentionMarker[] = [];
  if (typeof text !== 'string' || !text.includes(MARKER_OPEN)) return markers;
  // Each part is found by its own finder: the starts of every part only move forward.
  const typeColon = forwardFinder(text, ':');
  const typeBrace = forwardFinder(text, '}');
  const idColon = forwardFinder(text, ':');
  const idBrace = forwardFinder(text, '}');
  const labelBrace = forwardFinder(text, '}');
  let from = 0;
  for (;;) {
    const start = text.indexOf(MARKER_OPEN, from);
    if (start < 0) break;
    from = start + 1;
    const typeStart = start + MARKER_OPEN.length;
    const typeEnd = firstOf(typeColon(typeStart), typeBrace(typeStart));
    if (typeEnd < 0 || text[typeEnd] !== ':' || typeEnd === typeStart || typeEnd - typeStart > READ_MAX_PART) continue;
    const idStart = typeEnd + 1;
    const idEnd = firstOf(idColon(idStart), idBrace(idStart));
    if (idEnd < 0 || text[idEnd] !== ':' || idEnd === idStart || idEnd - idStart > READ_MAX_PART) continue;
    const labelStart = idEnd + 1;
    const labelEnd = labelBrace(labelStart);
    if (labelEnd < 0 || labelEnd === labelStart || labelEnd - labelStart > READ_MAX_LABEL || text[labelEnd + 1] !== '}') continue;
    const type = text.slice(typeStart, typeEnd);
    const id = text.slice(idStart, idEnd);
    const label = text.slice(labelStart, labelEnd);
    const end = labelEnd + 2;
    markers.push({
      type,
      id,
      label,
      canonical: isMentionMarkerType(type) && isMentionMarkerId(id) && canonicalMentionLabel(label, { id }) === label,
      span: { start, end },
    });
    from = end;
  }
  return markers;
}

export interface SerializeMentionMarkerOptions {
  /**
   * `canonical` (default): the label in its canonical form; a mention whose
   * type or id is not a marker type / id gets no marker. `raw`: label, type
   * and id as given, the format of releases before (a label can then end
   * the marker or carry text the chat hides).
   */
  labels?: 'canonical' | 'raw';
  /** Code points of a canonical label, at most 120 (default). */
  maxLabelLength?: number;
}

/**
 * The marker text of one mention, or `undefined` when it cannot be written
 * canonically (invalid type or id).
 */
export function serializeMentionMarker(
  mention: MentionMarker,
  options?: SerializeMentionMarkerOptions,
): string | undefined {
  if (options?.labels === 'raw') return `${MARKER_OPEN}${mention.type}:${mention.id}:${mention.label}}}`;
  if (!isMentionMarkerType(mention.type) || !isMentionMarkerId(mention.id)) return undefined;
  const label = canonicalMentionLabel(mention.label, {
    id: mention.id,
    ...(options?.maxLabelLength === undefined ? {} : { maxLength: options.maxLabelLength }),
  });
  return `${MARKER_OPEN}${mention.type}:${mention.id}:${label}}}`;
}
