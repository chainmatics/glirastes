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
 * type   = what every reader reads as a type (1-200 UTF-16 units without
 *          ":" and "}"), without hostile characters
 * id     = not empty, without hostile characters; never cleaned (a hostile
 *          id gets no marker). Spaces, single "<" ">" "{", "/", "@", "+"
 *          and ":" are fine. Known limit: every reader splits an id at its
 *          first ":" ({{mention:customer:tenant:42:Acme}} reads as type
 *          customer, id tenant, label "42:Acme"; the model still gets the
 *          whole text), and an id over 200 UTF-16 units is not read back
 * label  = 1-120 code points, the character policy below applied
 * hostile = Cc (also tab and newline), Zl, Zp, lone surrogates, Cf,
 *          Default_Ignorable_Code_Point, private use, unassigned and
 *          noncharacters, U+2800, "}", "{{", "<!", "-->", "--!>"
 * ```
 *
 * Character policy of a label (`cleanDisplayText`, then the delimiters):
 *
 * | Characters | In a label |
 * | --- | --- |
 * | lone surrogates (Cs) | removed |
 * | Cf and Default_Ignorable_Code_Point (bidi controls, zero-width space, word joiner, BOM, soft hyphen, U+034F, Hangul fillers, Khmer U+17B4/17B5, tags, variation selectors …) | removed, except the rows below |
 * | ZWJ / ZWNJ run between two emoji (before: Extended_Pictographic, emoji modifier or VS16; after: Extended_Pictographic), run contains a ZWJ | one ZWJ |
 * | ZWJ / ZWNJ run between two letters or marks of a joining script (Script_Extensions Arabic, Syriac, N'Ko, Mandaic, Mongolian, Brahmic scripts such as Devanagari, Bengali, Tamil, Sinhala, Khmer, Myanmar, Tibetan …; not Latin, Greek, Cyrillic, Han, Kana, Hangul) | its first joiner |
 * | any other ZWJ / ZWNJ (edges, next to a removed character, emoji and letter, other scripts) | removed |
 * | tag characters (U+E0000-E007F) | only the exact tags of 🏴 England, Scotland, Wales; all others removed, the 🏴 stays |
 * | VS15 / VS16 right after a character with the Emoji property (❤, ☺, ©); after 0-9 # * only before U+20E3 (keycap) | one kept |
 * | IVS (U+E0100-E01EF) right after a Han ideograph (Japanese name variants) | one kept |
 * | Mongolian FVS (U+180B-180D, U+180F) right after a Mongolian letter; MVS (U+180E) between two Mongolian letters | one kept |
 * | private use (Co, icon fonts), noncharacters, U+2800 | removed |
 * | unassigned (Cn) | kept: the engine's Unicode version decides what is unassigned, so removing it would remove new emoji in older browsers, and a current model cannot read it reliably |
 * | (then) | NFC |
 * | each run of Cc, Zl, Zp | one space |
 * | whitespace at the edges | trimmed; other whitespace (NBSP, U+202F, U+3000, runs of spaces) stays |
 * | `{` `}` `<!` `-->` `--!>` | `｛` `｝` `‹!` `--›` `--!›` (single `<` `>` stay) |
 * | nothing left | the canonical id |
 * | over 120 (or `maxLength`) code points | cut at a grapheme boundary (`Intl.Segmenter`; without it, before any joined emoji, flag, keycap, conjunct or combining sequence) to at most 119 and `…`; a bare `…` becomes the id |
 *
 * No NFKC: look-alikes such as `｛` or fullwidth letters stay as they are.
 * They are visible to the user, so the chip still shows what the model reads.
 *
 * @module
 */

/** Upper bound of a canonical label, in code points. */
export const MENTION_MARKER_MAX_LABEL_LENGTH = 120;

const MARKER_OPEN = '{{mention:';
/** Bounds of the reader every SDK version used, in UTF-16 units. */
const READ_MAX_PART = 200;
const READ_MAX_LABEL = 1_000;

const LONE_SURROGATE = /\p{Cs}/gu;
/**
 * Hidden code points: format characters, default ignorables (joiners,
 * variation selectors, tags, Hangul fillers, Mongolian FVS, Khmer
 * inherent vowels, U+034F …), private use, noncharacters and the braille
 * blank. Unassigned code points (Cn) are not in it: the engine's Unicode
 * version decides what is unassigned, so removing them would remove new
 * emoji in older browsers, and a current model cannot read them reliably.
 */
const HIDDEN_CLASS = String.raw`\p{Cf}\p{Default_Ignorable_Code_Point}\p{Co}\p{Noncharacter_Code_Point}\u2800`;
const HAS_HIDDEN_CHAR = new RegExp(`[${HIDDEN_CLASS}]`, 'u');
const HIDDEN_CHAR = new RegExp(`^[${HIDDEN_CLASS}]$`, 'u');
/** Characters a type or id must not carry: they can hide text or end a marker or comment. */
const HOSTILE = new RegExp(String.raw`[\p{Cc}\p{Zl}\p{Zp}\p{Cs}\p{Cn}}${HIDDEN_CLASS}]|\{\{|<!|--!?>`, 'u');
/** The type part of the reader every SDK version used. */
const READ_TYPE = /^[^:}]{1,200}$/;
const EMOJI = /^\p{Emoji}$/u;
const KEYCAP_BASE = /^[0-9#*]$/;
const KEYCAP = '\u20E3';
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const IDEOGRAPH = /^\p{Ideographic}$/u;
const IVS = /^[\u{E0100}-\u{E01EF}]$/u;
const MONGOLIAN_LETTER = /^(?=\p{L})\p{scx=Mong}$/u;
const MONGOLIAN_FVS = /^[\u180B-\u180D\u180F]$/u;
const MONGOLIAN_VOWEL_SEPARATOR = '\u180E';
/**
 * Letters and marks of scripts whose words need ZWJ/ZWNJ (cursive joining
 * and Brahmic conjuncts). Not Latin, Greek, Cyrillic, Han, Kana or Hangul.
 */
const JOINING_LETTER = new RegExp(`^(?=[\\p{L}\\p{M}])[${[
  'Arab', 'Syrc', 'Nkoo', 'Mand', 'Mani', 'Phlp', 'Rohg', 'Sogd', 'Ougr', 'Chrs', 'Adlm', 'Mong', 'Phag',
  'Deva', 'Beng', 'Guru', 'Gujr', 'Orya', 'Taml', 'Telu', 'Knda', 'Mlym', 'Sinh', 'Khmr', 'Mymr', 'Tibt',
  'Gran', 'Shrd', 'Tirh', 'Kthi', 'Modi', 'Takr', 'Khoj', 'Sind', 'Mahj', 'Bali', 'Java',
].map((script) => `\\p{scx=${script}}`).join('')}]$`, 'u');
const REGIONAL_INDICATOR = /^\p{Regional_Indicator}$/u;
/** Code points that belong to the one before them: a cut never falls in front of one. */
const ATTACHED = /^[\p{M}\p{Emoji_Modifier}\u200C\u200D\u180B-\u180F\u{E0020}-\u{E007F}\u{E0100}-\u{E01EF}]$/u;
const ZWJ = '\u200D';
const ZWNJ = '\u200C';
const TEXT_PRESENTATION = '\uFE0E';
const EMOJI_PRESENTATION = '\uFE0F';
const BLACK_FLAG = '\u{1F3F4}';
/** The tag sequences after 🏴 of the three RGI subdivision flags (England, Scotland, Wales). */
const RGI_FLAG_TAGS = ['gbeng', 'gbsct', 'gbwls'].map((code) =>
  `${Array.from(code, (char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join('')}\u{E007F}`);
const RGI_FLAG_TAG_LENGTH = 6;
/** Control characters and line/paragraph separators; other whitespace (NBSP, U+3000 …) stays. */
const LINE_BREAKING_RUNS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const DELIMITERS = /[{}]|<!|--!?>/g;
const DELIMITER_REPLACEMENTS: Readonly<Record<string, string>> = {
  '{': '｛',
  '}': '｝',
  '<!': '‹!',
  '-->': '--›',
  '--!>': '--!›',
};

export interface CanonicalMentionLabelOptions {
  /** Used (canonical) when nothing visible is left of the label. */
  id?: string;
  /**
   * Code points kept, 1-120 (default 120); a longer label ends in `…`. A
   * value that is not a positive integer means the default; above 120, 120.
   */
  maxLength?: number;
}

function labelLength(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return MENTION_MARKER_MAX_LABEL_LENGTH;
  return Math.min(MENTION_MARKER_MAX_LABEL_LENGTH, value);
}

const isEmojiBeforeJoiner = (cp: string) =>
  PICTOGRAPHIC.test(cp) || EMOJI_MODIFIER.test(cp) || cp === EMOJI_PRESENTATION;
const survives = (cp: string | undefined): cp is string => cp !== undefined && !HIDDEN_CHAR.test(cp);

/**
 * Removes hidden characters except those ordinary names need (see the table
 * in the module doc). A neighbour counts only if it is kept itself, so a
 * joiner or selector next to any removed character goes too. One pass,
 * linear.
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
    const after = points[i + 1];
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
      const next = points[end];
      if (before !== undefined && hasZwj && isEmojiBeforeJoiner(before) && survives(next) && PICTOGRAPHIC.test(next)) {
        out += ZWJ;
        kept = end - 1;
      } else if (before !== undefined && JOINING_LETTER.test(before) && survives(next) && JOINING_LETTER.test(next)) {
        out += cp;
        kept = end - 1;
      }
      i = end;
      continue;
    }
    let keepIt = false;
    if (before !== undefined) {
      if (cp === EMOJI_PRESENTATION || cp === TEXT_PRESENTATION) {
        // After an emoji-capable character; after 0-9 # * only as part of a keycap.
        keepIt = EMOJI.test(before) && (!KEYCAP_BASE.test(before) || after === KEYCAP);
      } else if (IVS.test(cp)) {
        keepIt = IDEOGRAPH.test(before);
      } else if (MONGOLIAN_FVS.test(cp)) {
        keepIt = MONGOLIAN_LETTER.test(before);
      } else if (cp === MONGOLIAN_VOWEL_SEPARATOR) {
        keepIt = MONGOLIAN_LETTER.test(before) && survives(after) && MONGOLIAN_LETTER.test(after);
      }
    }
    if (keepIt) keep(i, i + 1);
    i += 1;
  }
  return out;
}

/**
 * Display text cleaned of everything a reader does not see but a model
 * reads (the character policy in the module doc, without the marker
 * delimiters): lone surrogates and hidden characters removed except those
 * of ordinary names; NFC; each run of control characters and line or
 * paragraph separators one space; trimmed. Other whitespace (NBSP, U+202F,
 * U+3000, runs of spaces) stays as it is. Idempotent, linear. Not part of
 * the public API; for contracts that put display text into model-facing
 * blocks.
 */
export function cleanDisplayText(text: string): string {
  // Hidden characters go before NFC: removed later, they could leave a base
  // and a combining mark that NFC composes. They are checked again after
  // NFC, which can change a neighbour (`<` and U+0338 become `≮`).
  const composed = withoutHiddenChars(text.replace(LONE_SURROGATE, '')).normalize('NFC');
  return withoutHiddenChars(composed)
    .normalize('NFC')
    .replace(LINE_BREAKING_RUNS, ' ')
    .trim();
}

function visibleLabel(label: string): string {
  return cleanDisplayText(label).replace(DELIMITERS, (found) => DELIMITER_REPLACEMENTS[found]!);
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

type GraphemeSegmenter = { segment(text: string): Iterable<{ segment: string }> };
let graphemes: GraphemeSegmenter | null | undefined;

function graphemeSegmenter(): GraphemeSegmenter | null {
  if (graphemes === undefined) {
    const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => GraphemeSegmenter }).Segmenter;
    graphemes = typeof Segmenter === 'function' ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  }
  return graphemes;
}

/**
 * The first at most `budget` code points of `visible`, ending at a grapheme
 * boundary (`Intl.Segmenter`; without it, before any joined sequence by the
 * code point rule of `splitsSequence`), never after a joiner.
 */
function cutAtBoundary(visible: string, budget: number): string {
  const segmenter = graphemeSegmenter();
  let prefix: string[] = [];
  if (segmenter) {
    for (const { segment } of segmenter.segment(visible)) {
      const points = Array.from(segment);
      if (prefix.length + points.length > budget) break;
      prefix.push(...points);
    }
  } else {
    const points = Array.from(visible);
    let keep = budget;
    while (keep > 0 && splitsSequence(points, keep)) keep -= 1;
    prefix = points.slice(0, keep);
  }
  while (prefix.length > 0 && (prefix[prefix.length - 1] === ZWJ || prefix[prefix.length - 1] === ZWNJ)) prefix.pop();
  return prefix.join('');
}

function truncated(visible: string, max: number): string {
  // Compare UTF-16 units first: only a label that long can have too many code points.
  if (visible.length <= max) return visible;
  if (Array.from(visible).length <= max) return visible;
  const prefix = cutAtBoundary(visible, max - 1);
  return prefix ? `${prefix}…` : '';
}

/**
 * The canonical form of a mention label: `cleanDisplayText` (see the
 * character policy in the module doc); `{` `}` `<!` `-->` `--!>` become `｛`
 * `｝` `‹!` `--›` `--!›`; empty becomes the canonical `id`; over `maxLength`
 * code points it is cut at a grapheme boundary to at most `maxLength - 1`
 * code points and `…` (a label that would be a bare `…` becomes the id).
 * Single `<` and `>` stay. Idempotent, linear in the label's length.
 */
export function canonicalMentionLabel(label: string, options?: CanonicalMentionLabelOptions): string {
  const max = labelLength(options?.maxLength);
  const fromId = () => (typeof options?.id === 'string' ? truncated(visibleLabel(options.id), max) : '');
  const visible = visibleLabel(typeof label === 'string' ? label : '');
  if (!visible) return fromId();
  return truncated(visible, max) || fromId() || '…';
}

/**
 * Whether `type` can be written into a marker: what the reader of every
 * SDK version reads as a type (1-200 UTF-16 units without `:` and `}`),
 * without characters that can hide text or end a marker or comment
 * (control, format, line/paragraph separators, default ignorables, private
 * use, unassigned and noncharacters, lone surrogates, `{{`, `<!`, `-->`,
 * `--!>`).
 */
export function isMentionMarkerType(type: unknown): type is string {
  return typeof type === 'string' && READ_TYPE.test(type) && !HOSTILE.test(type);
}

/**
 * Whether `id` can be written into a marker: not empty and without
 * characters that can hide text or end a marker or comment (as for
 * `isMentionMarkerType`, and `}`). Spaces, single `<` `>` `{`, `/`, `@`,
 * `+` and `:` are fine; an id with `:` is written as before, and every
 * reader splits it at the colon (known limit); an id over 200 UTF-16 units
 * is written as before and not read back as a marker.
 */
export function isMentionMarkerId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && !HOSTILE.test(id);
}

export interface MentionMarker {
  type: string;
  id: string;
  label: string;
}

export interface ParsedMentionMarker extends Readonly<MentionMarker> {
  /**
   * Type and id writable and the label already canonical: what a current
   * writer sends. Computed when first read.
   */
  readonly canonical: boolean;
  /** UTF-16 offsets of the whole marker in the text, `end` exclusive. */
  readonly span: { start: number; end: number };
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

/** A parsed marker; `canonical` is computed on first read, so readers that do not need it pay nothing. */
class ParsedMarker implements ParsedMentionMarker {
  #canonical: boolean | undefined;

  constructor(
    readonly type: string,
    readonly id: string,
    readonly label: string,
    readonly span: { start: number; end: number },
  ) {}

  get canonical(): boolean {
    this.#canonical ??= isMentionMarkerType(this.type) && isMentionMarkerId(this.id)
      && canonicalMentionLabel(this.label, { id: this.id }) === this.label;
    return this.#canonical;
  }

  toJSON(): { type: string; id: string; label: string; canonical: boolean; span: { start: number; end: number } } {
    return { type: this.type, id: this.id, label: this.label, canonical: this.canonical, span: this.span };
  }
}

/**
 * The markers of `text` in order, read exactly as every SDK version reads
 * them (type and id 1-200 UTF-16 units without `:` and `}`, label 1-1000
 * units without `}`), so old stored text gives the same matches. `canonical`
 * (computed when first read) says whether a marker is in the canonical
 * profile; a legacy or model-written marker that is not keeps its label as
 * written here. Linear in the length of `text`, also on many unterminated
 * markers.
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
    const end = labelEnd + 2;
    markers.push(new ParsedMarker(text.slice(typeStart, typeEnd), text.slice(idStart, idEnd), text.slice(labelStart, labelEnd), { start, end }));
    from = end;
  }
  return markers;
}

export interface SerializeMentionMarkerOptions {
  /**
   * `canonical` (default): the label in its canonical form; a mention whose
   * type or id carries characters that can hide text gets no marker. `raw`:
   * label, type and id as given, the format of releases before (a label can
   * then end the marker or carry text the chat hides).
   */
  labels?: 'canonical' | 'raw';
  /** Code points of a canonical label, 1-120 (default 120). */
  maxLabelLength?: number;
}

/**
 * The marker text of one mention, or `undefined` when it cannot be written
 * canonically (a type or id that carries characters that can hide text).
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
