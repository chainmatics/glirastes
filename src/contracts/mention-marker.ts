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
 *          whitespace, Cc, Cf, lone surrogates
 * label  = 1-120 code points (NFC), without "{" "}" Cc Cf Zl Zp,
 *          without "<!" "-->" "--!>", no whitespace at the edges or twice
 * ```
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
const FORMAT_CHARS = /\p{Cf}+/gu;
const SPACE_RUNS = /[\p{Cc}\p{Zl}\p{Zp}\p{Zs}\p{White_Space}]+/gu;
const DELIMITERS = /[{}]|<!|--!?>/g;
const DELIMITER_REPLACEMENTS: Readonly<Record<string, string>> = {
  '{': '｛',
  '}': '｝',
  '<!': '‹!',
  '-->': '--›',
  '--!>': '--!›',
};
const INVALID_ID_CHAR = /[:{}<>\s\p{Cc}\p{Cf}\p{Cs}]/u;

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

function visibleLabel(label: string): string {
  return label
    .replace(LONE_SURROGATE, '�')
    // Format characters go first: removed later, they could leave two spaces
    // next to each other, or a base and a combining mark that NFC composes.
    .replace(FORMAT_CHARS, '')
    .normalize('NFC')
    .replace(SPACE_RUNS, ' ')
    .replace(DELIMITERS, (found) => DELIMITER_REPLACEMENTS[found]!)
    .trim();
}

/**
 * The canonical form of a mention label: lone surrogates become U+FFFD;
 * format characters (Cf: zero-width, bidi, tag characters, soft hyphen) are
 * removed; NFC; runs of control, line/paragraph separator and whitespace
 * characters become one space; `{` `}` `<!` `-->` `--!>` become `｛` `｝`
 * `‹!` `--›` `--!›`; trimmed; empty becomes the canonical `id`; over
 * `maxLength` code points it is cut to `maxLength - 1` code points and `…`.
 * Single `<` and `>` stay. Idempotent, linear in the label's length.
 */
export function canonicalMentionLabel(label: string, options?: CanonicalMentionLabelOptions): string {
  let visible = visibleLabel(typeof label === 'string' ? label : '');
  if (!visible && typeof options?.id === 'string') visible = visibleLabel(options.id);
  const max = clampLabelLength(options?.maxLength);
  // Compare UTF-16 units first: only a label that long can have too many code points.
  if (visible.length <= max) return visible;
  const points = Array.from(visible);
  if (points.length <= max) return visible;
  return `${points.slice(0, max - 1).join('')}…`;
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
