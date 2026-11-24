/**
 * The mention marker `{{mention:type:id:label}}` that a picked mention
 * becomes in a sent message, and its canonical profile: a canonical label
 * (the part the chip shows; type and id come from the app and are not
 * shown, as before) has nothing the chat bubble hides and the model still reads (no comment
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
 * label  = 1-120 code points, never empty, the character policy below
 *          applied (the exceptions for emoji, flags and joining scripts
 *          are for labels only; an id with such characters is refused)
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
 * | ZWJ / ZWNJ run between two letters or marks of a joining script (Script_Extensions Arabic, Syriac, Thaana, N'Ko, Mandaic, Mongolian, Brahmic scripts such as Devanagari, Bengali, Tamil, Malayalam, Sinhala, Khmer, Myanmar, Tibetan, Meetei Mayek, Chakma, Tai Tham, Sundanese, Newa, Limbu, Kayah Li …; not Latin, Greek, Cyrillic, Han, Kana, Hangul) | its first joiner |
 * | ZWJ / ZWNJ run after a Malayalam consonant and virama, not followed by a joining letter (legacy chillu at word end) | one ZWJ |
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
 * | over 120 (or `maxLength`) code points | cut at a grapheme boundary (`Intl.Segmenter`; without it, never before a mark, joiner or selector, after a joiner or virama, or inside a flag or keycap; other clusters such as Thai Sara Am can then be split) to at most 119 and `…`; a bare `…` becomes the id; never empty |
 * | a value the cut would split, only with `cut: 'value-safe'` (the React chat's send path; the default `grapheme` cuts as in 0.24.2) | the value run at the cut is left out whole: tokens (split at whitespace) with a digit, `@ / : + _ % = # & ~ \ |` or a dot inside, punctuation-only tokens, and groups of 1-4 upper-case letters next to them (`+49 170 1234567`, `GB29 NWBK 6016 …`), so a PII detector on the server never gets a fragment it cannot recognise; the id fallback is cut as before |
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

/**
 * Engine features this module relies on beyond ES2018 are probed, never
 * assumed: a regular expression with a Unicode property or script the
 * engine does not know is built through `compiled`, which returns
 * `undefined` instead of throwing, so the module always loads. ES2018
 * property escapes (General_Category, the ES2018 binary properties such as
 * Emoji, Default_Ignorable_Code_Point, Ideographic, Regional_Indicator) are
 * the baseline of the ES2022 target and stay literals. Guarded:
 * - Script_Extensions values (each script probed alone): an unknown script
 *   loses its joiner exception, its ZWJ/ZWNJ are removed; none known, no
 *   script joiner exception at all.
 * - Extended_Pictographic (ES2020): falls back to Emoji_Presentation
 *   without regional indicators and skin-tone modifiers; emoji that have
 *   text presentation by default (❤, ☠, ©) then lose their joiners, so a
 *   degraded engine keeps a subset of the joiners a full one keeps.
 * - Intl.Segmenter: the code point cut rule of `splitsSequence`.
 * No lookbehind and no `v` flag are used.
 */
function compiled(source: string, flags: string): RegExp | undefined {
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}

/** Matches nothing. */
const NEVER = /(?!)/;

/** A letter or mark of one of `scripts`; scripts the engine does not know are left out. */
function scriptLetter(scripts: readonly string[], marks: boolean): RegExp {
  const known = scripts.filter((script) => compiled(`\\p{scx=${script}}`, 'u') !== undefined);
  if (known.length === 0) return NEVER;
  const kind = marks ? '[\\p{L}\\p{M}]' : '\\p{L}';
  return compiled(`^(?=${kind})[${known.map((script) => `\\p{scx=${script}}`).join('')}]$`, 'u') ?? NEVER;
}

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
const HIDDEN_OR_BREAK = new RegExp(String.raw`[\p{Cc}\p{Zl}\p{Zp}\p{Cs}\p{Cn}${HIDDEN_CLASS}]`, 'u');

/**
 * Whether `text` holds a character that can hide text or break a line:
 * control, line/paragraph separator, lone surrogate, unassigned, and the
 * hidden characters of `cleanDisplayText` (without its exceptions). For
 * values that are never cleaned, such as ids: one of these makes them
 * invalid. Not part of the public API.
 */
export function hasHiddenChar(text: string): boolean {
  return HIDDEN_OR_BREAK.test(text);
}
/** The type part of the reader every SDK version used. */
const READ_TYPE = /^[^:}]{1,200}$/;
const EMOJI = /^\p{Emoji}$/u;
const KEYCAP_BASE = /^[0-9#*]$/;
const KEYCAP = '\u20E3';
// Fallback: emoji-presentation characters without regional indicators and skin-tone modifiers,
// which Extended_Pictographic does not contain either, so a degraded engine keeps no more joiners.
const PICTOGRAPHIC = compiled('^\\p{Extended_Pictographic}$', 'u')
  ?? /^(?![\p{Regional_Indicator}\p{Emoji_Modifier}])\p{Emoji_Presentation}$/u;
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const IDEOGRAPH = /^\p{Ideographic}$/u;
const IVS = /^[\u{E0100}-\u{E01EF}]$/u;
const MONGOLIAN_LETTER = scriptLetter(['Mong'], false);
const MONGOLIAN_FVS = /^[\u180B-\u180D\u180F]$/u;
const MONGOLIAN_VOWEL_SEPARATOR = '\u180E';
/**
 * Letters and marks of scripts whose words need ZWJ/ZWNJ (cursive joining
 * and Brahmic conjuncts). Not Latin, Greek, Cyrillic, Han, Kana or Hangul.
 */
const JOINING_LETTER = scriptLetter([
  'Arab', 'Syrc', 'Nkoo', 'Mand', 'Mani', 'Phlp', 'Rohg', 'Sogd', 'Ougr', 'Chrs', 'Adlm', 'Mong', 'Phag',
  'Deva', 'Beng', 'Guru', 'Gujr', 'Orya', 'Taml', 'Telu', 'Knda', 'Mlym', 'Sinh', 'Khmr', 'Mymr', 'Tibt',
  'Gran', 'Shrd', 'Tirh', 'Kthi', 'Modi', 'Takr', 'Khoj', 'Sind', 'Mahj', 'Bali', 'Java',
  'Mtei', 'Cakm', 'Lana', 'Sund', 'Newa', 'Limb', 'Kali', 'Thaa',
], true);
const REGIONAL_INDICATOR = /^\p{Regional_Indicator}$/u;
/** Viramas (and the Khmer coeng, Myanmar asat, Tibetan halanta) of the joining scripts. */
const VIRAMA = /^[\u094D\u09CD\u0A4D\u0ACD\u0B4D\u0BCD\u0C4D\u0CCD\u0D4D\u0DCA\u0F84\u1039\u103A\u17D2\u1A60\u1B44\u1BAA\u1BAB\uA9C0\uAAF6\uABED\u{11046}\u{110B9}\u{11133}\u{111C0}\u{11235}\u{112EA}\u{1134D}\u{11442}\u{114C2}\u{115BF}\u{1163F}\u{116B6}\u{11839}]$/u;
const MALAYALAM_VIRAMA = '\u0D4D';
const MALAYALAM_LETTER = scriptLetter(['Mlym'], false);
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
   * Code points kept, 8-120 (default 120); a longer label ends in `…`. A
   * value that is not a positive integer means the default; 1-7 means 8;
   * above 120, 120.
   */
  maxLength?: number;
  /**
   * How a label over `maxLength` is cut. `grapheme` (default, unchanged
   * since 0.24.2): at a grapheme boundary only. `value-safe`: at a grapheme
   * boundary, and a value run the cut would split is left out whole: tokens
   * with a digit, `@`, `/`, `:`, `+` … or a dot inside (email, IBAN, phone
   * number, URL), punctuation-only tokens and groups of 1-4 upper-case
   * letters next to them (`GB29 NWBK 6016 …`), so a PII detector on the
   * server never gets a fragment it cannot recognise; the React chat sends
   * mention labels with it. Labels within `maxLength`, and the id fallback,
   * are the same either way.
   */
  cut?: MentionLabelCut;
}

/** How an over-long label is cut; see `CanonicalMentionLabelOptions.cut`. */
export type MentionLabelCut = 'value-safe' | 'grapheme';

/** The smallest `maxLength`: room for a short word and `…`, and never an empty label. */
const MIN_LABEL_LENGTH = 8;

function labelLength(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return MENTION_MARKER_MAX_LABEL_LENGTH;
  return Math.min(MENTION_MARKER_MAX_LABEL_LENGTH, Math.max(MIN_LABEL_LENGTH, value));
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
      } else if (hasZwj && before === MALAYALAM_VIRAMA && i >= 2 && kept === i - 1 && MALAYALAM_LETTER.test(points[i - 2]!)) {
        // Legacy Malayalam chillu: consonant, virama, ZWJ at the end of a word.
        out += ZWJ;
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
  return cleanDisplayTextWithPassLimit(text, MAX_CLEAN_PASSES);
}

/**
 * Code points of a label (or slug source) read before any normalisation:
 * `normalize` is quadratic on long runs of combining marks. 4096 is 34
 * times the 120 code points a label keeps, so a label is only read
 * differently when more than 3976 of its first 4096 code points are removed
 * as hidden characters (then what follows them is not read); every label
 * that long was already cut to 120 code points.
 */
export const MAX_INPUT_CODE_POINTS = 4_096;

/** The first `max` code points of `text`, never splitting a surrogate pair. Linear in `max`. */
export function firstCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  let units = 0;
  for (let points = 0; points < max && units < text.length; points += 1) {
    const unit = text.charCodeAt(units);
    const pair = unit >= 0xd800 && unit <= 0xdbff && units + 1 < text.length
      && text.charCodeAt(units + 1) >= 0xdc00 && text.charCodeAt(units + 1) <= 0xdfff;
    units += pair ? 2 : 1;
  }
  return text.slice(0, units);
}

/** Passes of removal and NFC before the strict fallback; real text needs one or two. */
const MAX_CLEAN_PASSES = 8;
const ANY_HIDDEN_CHAR = new RegExp(`[${HIDDEN_CLASS}]`, 'gu');

/**
 * `cleanDisplayText` with a bound on the passes, for tests of the bound.
 * Internal. Removal and NFC repeat until a pass changes nothing: removing
 * a character can let NFC reorder or compose the marks around it, which
 * changes the neighbours a kept joiner or selector depends on. Each pass
 * only removes characters or composes, so it ends; if `maxPasses` passes
 * still change the text, every remaining hidden character is removed (also
 * the joiners and selectors the rules keep), which no later pass changes.
 */
export function cleanDisplayTextWithPassLimit(text: string, maxPasses: number): string {
  let current = firstCodePoints(text, MAX_INPUT_CODE_POINTS).replace(LONE_SURROGATE, '');
  let stable = false;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    // Hidden characters go before NFC: removed later, they could leave a
    // base and a combining mark that NFC composes.
    const next = withoutHiddenChars(current).normalize('NFC');
    if (next === current) {
      stable = true;
      break;
    }
    current = next;
  }
  if (!stable) current = current.replace(ANY_HIDDEN_CHAR, '').normalize('NFC');
  return current.replace(LINE_BREAKING_RUNS, ' ').trim();
}

function visibleLabel(label: string): string {
  return cleanDisplayText(label).replace(DELIMITERS, (found) => DELIMITER_REPLACEMENTS[found]!);
}

/**
 * Whether a cut in front of `points[k]` would split a sequence that belongs
 * together (the fallback without `Intl.Segmenter`): before a mark, emoji
 * modifier, joiner, tag or selector; after a joiner or a virama (Indic
 * conjuncts); inside a regional-indicator pair. It does not know other
 * clusters (Thai Sara Am, Hangul jamo sequences).
 */
function splitsSequence(points: string[], k: number): boolean {
  if (ATTACHED.test(points[k]!)) return true;
  if (points[k - 1] === ZWJ || points[k - 1] === ZWNJ || VIRAMA.test(points[k - 1]!)) return true;
  if (!REGIONAL_INDICATOR.test(points[k]!) || !REGIONAL_INDICATOR.test(points[k - 1]!)) return false;
  // Regional indicators pair up from the start of their run: an odd run before k ends mid-flag.
  let run = 0;
  for (let j = k - 1; j >= 0 && REGIONAL_INDICATOR.test(points[j]!); j -= 1) run += 1;
  return run % 2 === 1;
}

type GraphemeSegmenter = { segment(text: string): Iterable<{ segment: string }> };
type SegmenterConstructor = new (locale?: string, options?: { granularity: 'grapheme' }) => GraphemeSegmenter;
let segmenterOf: SegmenterConstructor | undefined;
let graphemes: GraphemeSegmenter | undefined;

/** The grapheme segmenter of the current `Intl.Segmenter`, or `null` without one. */
function graphemeSegmenter(): GraphemeSegmenter | null {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  if (typeof Segmenter !== 'function') return null;
  if (Segmenter !== segmenterOf) {
    segmenterOf = Segmenter;
    graphemes = new Segmenter(undefined, { granularity: 'grapheme' });
  }
  return graphemes!;
}

/**
 * The first at most `budget` code points of `visible`, ending at a grapheme
 * boundary (`Intl.Segmenter`; without it, before any joined sequence by the
 * code point rule of `splitsSequence`), never after a joiner or a Mongolian
 * vowel separator.
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
  // A joiner or Mongolian vowel separator is kept only before a letter: never leave one before `…`.
  const needsNext = (cp: string | undefined) => cp === ZWJ || cp === ZWNJ || cp === MONGOLIAN_VOWEL_SEPARATOR;
  while (prefix.length > 0 && needsNext(prefix[prefix.length - 1])) prefix.pop();
  return prefix.join('');
}

/** Whitespace that separates words; all BMP, so a check per UTF-16 unit is exact. */
const isSpace = (unit: string | undefined) => unit !== undefined && /\s/.test(unit);
const EDGE_PUNCTUATION = /^\p{P}+|\p{P}+$/gu;
/** A keycap emoji (1️⃣, #️⃣): a digit or `#` `*` that is not a value. */
const KEYCAP_EMOJI = /[0-9#*]\uFE0F?\u20E3/gu;
/**
 * A token that carries a value a PII detector may look for: a digit, one
 * of `@ / : + _ % = # & ~ \ |`, or a dot between letters or digits (email,
 * IBAN, phone number, URL, domain, date, id). Plain words, also with a
 * hyphen, an apostrophe or punctuation at their edges, and emoji (also
 * keycaps such as 1️⃣) are not.
 */
const VALUE_CHAR = /[\p{N}@/:+_%=#&~\\|]|[\p{L}\p{N}]\.[\p{L}\p{N}]/u;

/**
 * A group of 1-4 upper-case letters (`NWBK`, `ABNA`, `MALT`, `AB` of a
 * licence plate, `O` of a case number): part of a value only when it is
 * next to one, so an acronym among words (`KG`, `EU`, `USA`) stays a word.
 */
const UPPER_GROUP = /^\p{Lu}{1,4}$/u;

type TokenKind = 'value' | 'separator' | 'group' | 'word';

function tokenKind(token: string): TokenKind {
  const core = token.replace(KEYCAP_EMOJI, '').replace(EDGE_PUNCTUATION, '');
  if (!core) return 'separator';
  if (VALUE_CHAR.test(core)) return 'value';
  return UPPER_GROUP.test(core) ? 'group' : 'word';
}

/** Start of the token that ends at `end` (exclusive), after the whitespace before it. */
function tokenStartBefore(text: string, end: number): number {
  let start = end;
  while (start > 0 && !isSpace(text[start - 1])) start -= 1;
  return start;
}

/**
 * `prefix` (a prefix of `full`, cut inside it) without a value the cut
 * splits. A value run is a sequence of tokens (split at whitespace) that
 * are values (`VALUE_CHAR`), separators (only punctuation) or upper-case
 * groups of 1-4 letters (`UPPER_GROUP`), with at least one value. When the
 * cut falls in such a run (in one of its tokens, or right before it), the
 * part of the run before the cut is dropped, with the whitespace before
 * it, so a value written with spaces (`+49 170 1234567`, `GB29 NWBK 6016
 * …`) goes whole. A server-side PII detector never sees a value it can no
 * longer recognise. Otherwise `prefix` is returned as it is. Linear.
 */
function withoutSplitValue(full: string, prefix: string): string {
  const cut = prefix.length;
  const inToken = cut > 0 && !isSpace(full[cut - 1]) && !isSpace(full[cut]);
  let from = inToken ? tokenStartBefore(full, cut) : cut;
  const dropFrom = from;
  // The token the cut falls in, or the first after it; separators ("/", "–") and
  // upper-case groups are skipped, so a run counts only when it holds a value.
  for (;;) {
    while (from < full.length && isSpace(full[from])) from += 1;
    if (from >= full.length) return prefix;
    let end = from;
    while (end < full.length && !isSpace(full[end])) end += 1;
    const kind = tokenKind(full.slice(from, end));
    if (kind === 'word') return prefix;
    if (kind === 'value') break;
    from = end;
  }
  // Back over the run: values, separators and upper-case groups before the cut.
  let keep = dropFrom;
  for (;;) {
    let end = keep;
    while (end > 0 && isSpace(full[end - 1])) end -= 1;
    if (end === 0) break;
    const start = tokenStartBefore(full, end);
    if (tokenKind(full.slice(start, end)) === 'word') break;
    keep = start;
  }
  if (keep >= cut) return prefix;
  return full.slice(0, keep).trimEnd();
}

function truncated(visible: string, max: number, cut: MentionLabelCut): string {
  // Compare UTF-16 units first: only a label that long can have too many code points.
  if (visible.length <= max) return visible;
  if (Array.from(visible).length <= max) return visible;
  const atBoundary = cutAtBoundary(visible, max - 1);
  const prefix = cut === 'grapheme' ? atBoundary : withoutSplitValue(visible, atBoundary);
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
  const cut: MentionLabelCut = options?.cut === 'value-safe' ? 'value-safe' : 'grapheme';
  // The id fallback is cut as in 0.24.2 in both modes: the id is app data, sent whole in the marker anyway.
  const fromId = () => (typeof options?.id === 'string' ? truncated(visibleLabel(options.id), max, 'grapheme') : '');
  const visible = visibleLabel(typeof label === 'string' ? label : '');
  // Never empty: a marker with an empty label is read by no reader.
  if (!visible) return fromId() || '…';
  return truncated(visible, max, cut) || fromId() || '…';
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
   * writer sends. A getter, computed on first read (parsing costs nothing
   * for readers that do not need it); `{ ...marker }` and `structuredClone`
   * drop it, so read it before copying.
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
   * label, type and id as given, without validation, the format of
   * releases before (a label can then end the marker or carry text the
   * chat hides).
   */
  labels?: 'canonical' | 'raw';
  /** Code points of a canonical label, 8-120 (default 120; 1-7 means 8, other values the default). */
  maxLabelLength?: number;
  /** How an over-long canonical label is cut (`CanonicalMentionLabelOptions.cut`); default `grapheme`, the React chat sends `value-safe`. */
  labelCut?: MentionLabelCut;
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
    ...(options?.labelCut === undefined ? {} : { cut: options.labelCut }),
  });
  return `${MARKER_OPEN}${mention.type}:${mention.id}:${label}}}`;
}
