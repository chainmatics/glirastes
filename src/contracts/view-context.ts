/**
 * View context: what the user currently looks at in the app, declared by the
 * app (never guessed from the URL) and sent with a chat message. The server
 * validates and bounds it with {@link sanitizeViewContext} before it reaches
 * the model as data, never as an instruction. It grants no permission: every
 * tool call is authorized as before.
 *
 * An entry names one record of a declared entity type (`defineEntity`, tool
 * `outputEntities` / `inputEntities`), a selection of records, or both, plus
 * optionally a short label, facts the app declared a schema for, an unsaved
 * flag and the route path. Untrusted input is never rejected as a whole: what
 * is invalid is dropped, and the result says how often each reason applied
 * (counts only, never a value), so diagnostics stay content-free.
 *
 * Characters. One policy ({@link VIEW_CONTEXT_CHARACTER_POLICY}) decides which
 * characters never reach the model: labels and fact strings lose them, ids
 * and routes that contain one are invalid (an id reaches the server exactly
 * as the app wrote it, or not at all).
 *
 * Delimiters. Labels have comment and marker delimiters replaced by visible
 * look-alikes (the mention marker's canonical label rules, so a name reads
 * the same in a chip, a marker and this block; `escapeCommentDelimiters`
 * instead writes JSON escapes, which suit JSON text, not a visible name). Ids,
 * routes and fact strings are data and keep `<`, `>`, `-->`, `}}` and the like
 * as they are. Every renderer of entries MUST therefore write them as JSON
 * and escape that JSON for its block: `escapeJsonAngles` (`<` and `>`) for a
 * block inside an HTML comment (`<!--context:...-->`), `escapeJsonForBlock`
 * (`<`) for a tag-delimited block (`<view-context>`). `escapeJsonForBlock`
 * alone does not cover `-->`. Line and paragraph separators cannot occur:
 * the character policy removes them.
 *
 * Cost. Entries, entities and selections are read by their known keys only
 * (unknown keys are ignored, never enumerated); at most 32 entries and 100
 * selection ids are looked at; labels are cut before they are cleaned; facts
 * are enumerated (at most three passes) and stop at their bounds. What stays
 * linear in the input is the enumeration of a facts object's keys, so the
 * HTTP body size limit of the chat route is the outer bound.
 *
 * Local to the app: the browser, the app's server and the model call. Nothing
 * here goes to the Platform. Pure and framework-neutral (no engine, provider
 * or React import).
 *
 * @module
 */
import { z } from 'zod';
import { ENTITY_TYPE_PATTERN, isEntityIdValue, MAX_ENTITY_ID_PARTS } from './entity-declaration.js';

// ============================================================================
// Limits
// ============================================================================

/** Bounds of a view context. */
export const VIEW_CONTEXT_LIMITS = Object.freeze({
  /** Entries per message, at most (a policy can lower it). */
  maxEntries: 8,
  /** Entries of the input looked at, at most; the rest is dropped as `over-limit` unread. */
  maxScannedEntries: 32,
  /** Ids of a selection, at most. */
  maxSelectionIds: 50,
  /** Ids of a selection looked at, at most; the rest is dropped as `selection-id-over-limit` unread. */
  maxScannedSelectionIds: 100,
  /** Label length in code points, after cleaning (a longer one ends in `…`). */
  maxLabelLength: 60,
  /** Route length in characters. */
  maxRouteLength: 256,
  /** Facts of one entry as JSON, in UTF-8 bytes. */
  maxFactsBytes: 2048,
  /** Nesting depth of facts below the facts object. */
  maxFactsDepth: 6,
  /** Values (objects, arrays, scalars) in the facts of one entry. */
  maxFactsNodes: 256,
  /** Length of a facts key in code units. */
  maxFactKeyLength: 64,
  /** All kept entries as a JSON list, in UTF-8 bytes; a long selection is cut to fit before an entry is dropped. */
  maxTotalBytes: 2560,
});

/** Which earlier messages keep their view context for the model. `none`: only the newest message's; `changes`: also earlier ones where it changed; `all`: every message's. */
export const VIEW_CONTEXT_HISTORY_MODES = ['none', 'changes', 'all'] as const;

/** See {@link VIEW_CONTEXT_HISTORY_MODES}. */
export type ViewContextHistory = (typeof VIEW_CONTEXT_HISTORY_MODES)[number];

/**
 * Why something was dropped. Entry reasons (the whole entry is gone):
 * `disabled`, `not-a-list`, `invalid-entry`, `invalid-entity`,
 * `no-entity-or-selection`, `undeclared-type`, `type-not-allowed`,
 * `duplicate`, `over-limit`, `over-size`. Field reasons (the entry stays
 * without that field or id; counted only for entries that are kept): the
 * others.
 */
export const VIEW_CONTEXT_DROP_REASONS = [
  'disabled',
  'not-a-list',
  'invalid-entry',
  'invalid-entity',
  'no-entity-or-selection',
  'undeclared-type',
  'type-not-allowed',
  'duplicate',
  'over-limit',
  'over-size',
  'invalid-label',
  'invalid-unsaved',
  'invalid-route',
  'invalid-selection',
  'selection-id-invalid',
  'selection-id-duplicate',
  'selection-id-over-limit',
  'selection-id-over-size',
  'facts-disabled',
  'facts-no-schema',
  'facts-invalid',
  'facts-too-large',
] as const;

/** See {@link VIEW_CONTEXT_DROP_REASONS}. */
export type ViewContextDropReason = (typeof VIEW_CONTEXT_DROP_REASONS)[number];

const ENTRY_REASONS: ReadonlySet<ViewContextDropReason> = new Set([
  'disabled', 'not-a-list', 'invalid-entry', 'invalid-entity', 'no-entity-or-selection', 'undeclared-type',
  'type-not-allowed', 'duplicate', 'over-limit', 'over-size',
]);

// ============================================================================
// Types
// ============================================================================

/**
 * The id of a record, exactly as the app has it: a non-empty string of at
 * most 200 characters without surrounding whitespace and without a character
 * the {@link VIEW_CONTEXT_CHARACTER_POLICY} removes, or a safe integer; for a
 * composite key the list of its 2 to 4 parts in the declared order. Never
 * normalised; two ids with the same NFC form count as the same record.
 */
export type ViewContextEntityId = string | number | ReadonlyArray<string | number>;

/** One record of a declared entity type. */
export interface ViewContextEntity {
  /** A declared entity type (`order`, `channel-revision`). */
  readonly type: string;
  readonly id: ViewContextEntityId;
}

/** Records the user selected, all of one declared type (for example rows of a list). */
export interface ViewContextSelection {
  readonly type: string;
  /** 1 to 50 distinct ids, in the order sent. */
  readonly ids: ReadonlyArray<ViewContextEntityId>;
}

/** Plain JSON values: no class instances, functions, `undefined` in lists or non-finite numbers. */
export type ViewContextFactValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<ViewContextFactValue>
  | { readonly [key: string]: ViewContextFactValue };

/** Facts the app states about the view (`{ status: 'open', tab: 'lines' }`), accepted only against a known schema. */
export type ViewContextFacts = { readonly [key: string]: ViewContextFactValue };

/** The fields every view context entry may carry. */
interface ViewContextEntryFields {
  /** A short name for the view, canonical: at most 60 code points, NFC, one line, no character the policy removes, comment and marker delimiters replaced. */
  readonly label?: string;
  /** At most 2 KB as JSON, what the schema of the entity type (of the selection type in a list view) kept, strings cleaned. */
  readonly facts?: ViewContextFacts;
  /** The user has unsaved changes in this view. */
  readonly unsaved?: boolean;
  /** The path of the page (`/orders/42`, `/städte/köln`), see {@link isViewContextRoute}. */
  readonly route?: string;
}

/**
 * One thing the user looks at: a record (`entity`, optionally with a
 * selection, say of its lines), or a list view with selected records and no
 * single record (`selection` without `entity`). An entry with neither does
 * not exist. Every other field is optional and is dropped alone when invalid.
 */
export type ViewContextEntry =
  | (ViewContextEntryFields & { readonly entity: ViewContextEntity; readonly selection?: ViewContextSelection })
  | (ViewContextEntryFields & { readonly entity?: undefined; readonly selection: ViewContextSelection });

/**
 * A schema for the facts of one entity type: any object with `safeParse`,
 * such as a Zod schema or the JSON schema validator the runtime builds from
 * the generated artifact. It must return plain JSON (ISO strings, not `Date`);
 * any other result drops the facts.
 */
export interface ViewContextFactsSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error?: unknown };
}

/** Facts schemas by entity type. */
export type ViewContextFactsSchemas = Readonly<Record<string, ViewContextFactsSchema>>;

/** The `viewContext` option of the chat server. */
export interface ViewContextPolicy {
  /** Default `true`. */
  readonly enabled?: boolean;
  /**
   * Entity types accepted (entities and selections). Default: every declared
   * type. `[]` accepts none; a type that is not declared is ignored.
   */
  readonly types?: ReadonlyArray<string>;
  /** Default `'none'`. */
  readonly history?: ViewContextHistory;
  /** Entries per message, 1 to 8. Default 8. */
  readonly maxEntries?: number;
  /**
   * Facts schemas by entity type. A listed type uses the schema given here
   * instead of the generated one, or `false` to drop facts of that type; an
   * unlisted type keeps the generated schema. `false` for the whole option
   * drops all facts.
   */
  readonly facts?: false | Readonly<Record<string, ViewContextFactsSchema | false>>;
}

/** `false` turns the view context off, `true` or omitted keeps the defaults. */
export type ViewContextOption = boolean | ViewContextPolicy;

/** A {@link ViewContextPolicy} with its defaults applied (itself a valid policy). */
export interface ResolvedViewContextPolicy {
  readonly enabled: boolean;
  readonly types?: ReadonlyArray<string>;
  readonly history: ViewContextHistory;
  readonly maxEntries: number;
  readonly facts?: false | Readonly<Record<string, ViewContextFactsSchema | false>>;
}

/** What {@link sanitizeViewContext} checks an input against. */
export interface ViewContextSanitizeOptions {
  /** Entity types the app declared; an entry or selection of another type is dropped. */
  readonly declaredTypes: ReadonlySet<string> | ReadonlyArray<string>;
  /** Facts schemas by entity type (from the generated artifact); without one, facts are dropped. */
  readonly factsSchemas?: ViewContextFactsSchemas;
  /** The server option or its resolved form; default on. Checked before the input, an invalid one throws. */
  readonly policy?: ViewContextOption | ResolvedViewContextPolicy;
}

/** The kept entries and, content-free, what was dropped. */
export interface ViewContextSanitizeResult {
  readonly entries: ViewContextEntry[];
  /** How often each reason applied; reasons that did not apply are absent. */
  readonly dropped: Readonly<Partial<Record<ViewContextDropReason, number>>>;
  /** Entries dropped as a whole. */
  readonly droppedEntries: number;
}

// ============================================================================
// Character policy (one primitive for labels, fact strings, ids and routes)
// ============================================================================

/**
 * Which characters never reach the model. `removed`: dropped from labels and
 * fact strings, an id or route containing one is invalid. `breaks`: become a
 * space in labels (runs collapse to one) and fact strings, invalid in ids and
 * routes. `kept`: the exceptions to `removed`, only in the position named.
 */
export const VIEW_CONTEXT_CHARACTER_POLICY = Object.freeze({
  breaks: 'Cc (controls, tab, CR, LF, NUL), Zl (U+2028), Zp (U+2029)',
  removed: [
    'Cf (format: bidi controls, zero-width characters, soft hyphen, BOM, tag characters)',
    'Cs (lone surrogates)',
    'Co (private use)',
    'Cn (unassigned, noncharacters such as U+FFFF and U+FDD0..U+FDEF)',
    'Default_Ignorable_Code_Point (variation selectors U+FE00..U+FE0F and U+E0100..U+E01EF, U+034F, Hangul fillers U+115F, U+1160, U+3164, U+FFA0, U+17B4, U+17B5, U+180B..U+180F)',
    'U+2800 (braille blank)',
  ].join('; '),
  kept: [
    'one U+FE0E or U+FE0F directly after a character with the Emoji property (❤\ufe0f, 1\ufe0f⃣)',
    'U+200D between two emoji (after an Extended_Pictographic, its modifier or U+FE0F, before an Extended_Pictographic)',
    'U+200D and U+200C between two letters or marks, one joiner at a time',
    'the tag sequences of the three RGI subdivision flags after U+1F3F4 (England, Scotland, Wales)',
  ].join('; '),
});

const BREAK = /^[\p{Cc}\p{Zl}\p{Zp}]$/u;
const SPACE = /^\s$/u;
const REMOVED = /^[\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u2800\u034f\u115f\u1160\u3164\uffa0]$/u;
const PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const EMOJI = /^\p{Emoji}$/u;
const EMOJI_MODIFIER = /^\p{Emoji_Modifier}$/u;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const ZWJ = '\u200d';
const ZWNJ = '\u200c';
const BLACK_FLAG = '\u{1f3f4}';
const CANCEL_TAG = '\u{e007f}';
const SUBDIVISION_TAGS: ReadonlyArray<string> = ['gbeng', 'gbsct', 'gbwls']
  .map((code) => [...code].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join('') + CANCEL_TAG);
const TAG_SEQUENCE_LENGTH = 6;

const isVariationSelector = (char: string) => char === '\ufe0e' || char === '\ufe0f';
const isTag = (char: string) => { const cp = char.codePointAt(0)!; return cp >= 0xe0000 && cp <= 0xe007f; };
const isJoinable = (char: string | undefined) =>
  char !== undefined && LETTER_OR_MARK.test(char) && !REMOVED.test(char) && !BREAK.test(char);

type CleanMode = 'label' | 'fact' | 'exact';

/**
 * `text` under the character policy, in one pass over its code points.
 * `label`: breaks and whitespace runs become one space (none at the ends),
 * `{` and `}` become `｛` and `｝`. `fact`: each break becomes a space.
 * `exact`: breaks are removed (the caller compares with the input).
 */
function cleanText(text: string, mode: CleanMode): string {
  const chars = Array.from(text);
  let out = '';
  let prev = '';
  let emojiTail = false;
  let pendingSpace = false;
  const emit = (char: string, tail: boolean) => {
    if (pendingSpace) { out += ' '; pendingSpace = false; }
    out += char;
    prev = char;
    emojiTail = tail;
  };
  const blank = () => {
    if (mode === 'label') { if (out !== '') pendingSpace = true; }
    else if (mode === 'fact') emit(' ', false);
  };
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    const next = chars[index + 1];
    if (BREAK.test(char)) { blank(); continue; }
    const adjacent = !pendingSpace && prev !== '';
    if (char === ZWJ || char === ZWNJ) {
      const betweenEmoji = char === ZWJ && emojiTail && next !== undefined && PICTOGRAPHIC.test(next) && !REMOVED.test(next);
      const betweenLetters = LETTER_OR_MARK.test(prev) && !isVariationSelector(prev) && isJoinable(next);
      if (adjacent && (betweenEmoji || betweenLetters)) emit(char, false);
      continue;
    }
    if (isVariationSelector(char)) {
      if (adjacent && EMOJI.test(prev)) emit(char, emojiTail);
      continue;
    }
    if (REMOVED.test(char)) continue;
    if (mode === 'label' && SPACE.test(char)) { blank(); continue; }
    const tail = PICTOGRAPHIC.test(char) || (emojiTail && EMOJI_MODIFIER.test(char));
    emit(mode === 'label' && char === '{' ? '｛' : mode === 'label' && char === '}' ? '｝' : char, tail);
    if (char === BLACK_FLAG) {
      const tags = chars.slice(index + 1, index + 1 + TAG_SEQUENCE_LENGTH).join('');
      if (SUBDIVISION_TAGS.includes(tags)) { out += tags; index += TAG_SEQUENCE_LENGTH; }
    }
  }
  return out;
}

/** Whether `text` is unchanged under the character policy (nothing to remove, no break). */
const isExactText = (text: string): boolean => cleanText(text, 'exact') === text;

// ============================================================================
// Labels, routes, ids
// ============================================================================

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** `text` cut to at most `limit` code units without splitting a surrogate pair. */
function cutUnits(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const code = text.charCodeAt(limit - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

/**
 * The canonical form of a label, idempotent: cleaned under the character
 * policy (breaks and whitespace runs become one space, `{` / `}` become
 * `｛` / `｝`), then NFC (after cleaning, so a removed character never blocks
 * a composition), then `<!`, `-->` and `--!>` become `‹!`, `--›` and `--!›`;
 * longer than `max` code points: the first `max - 1` (without a dangling
 * joiner, partial flag tag sequence or space) and `…`. The rules of the
 * mention marker's canonical label with a shorter bound; to be unified with
 * that module once it is merged. Single `<` and `>` stay (the renderer
 * escapes them).
 */
export function canonicalViewContextLabel(text: string, max: number = VIEW_CONTEXT_LIMITS.maxLabelLength): string {
  // A longer input is cut first, so a 10 MB label costs as much as a short one.
  const bound = max * 8;
  const cut = text.length > bound;
  let cleaned = cleanText(cut ? cutUnits(text, bound) : text, 'label').normalize('NFC');
  // A composition can change the neighbour a joiner or variation selector was
  // kept for (`>` + U+0338 becomes `≯`): clean again until nothing changes.
  // Every round only removes characters, so this ends within the bounded length.
  for (let next = cleanText(cleaned, 'label').normalize('NFC'); next !== cleaned; next = cleanText(next, 'label').normalize('NFC')) {
    cleaned = next;
  }
  const out = cleaned.replaceAll('<!', '‹!').replaceAll('--!>', '--!›').replaceAll('-->', '--›');
  const points = [...out];
  if (out === '' || (!cut && points.length <= max)) return out;
  const kept = points.slice(0, max - 1);
  if (points.length > max - 1) {
    // Cutting may leave a joiner without its next character or half a flag tag sequence.
    if (kept.length > 0 && isTag(kept[kept.length - 1]!) && kept[kept.length - 1] !== CANCEL_TAG) {
      while (kept.length > 0 && isTag(kept[kept.length - 1]!)) kept.pop();
    }
    while (kept.length > 0 && [ZWJ, ZWNJ, ' '].includes(kept[kept.length - 1]!)) kept.pop();
  }
  return kept.length > 0 ? `${kept.join('')}…` : '';
}

const ROUTE_ASCII = /^[A-Za-z0-9\-._~!$&'()*+,=:@/]$/;
const ROUTE_UNICODE = /^[\p{L}\p{M}\p{N}]$/u;

/**
 * Whether `value` is a route as a view context carries it: a decoded path of
 * at most 256 characters starting with one `/`. Allowed: ASCII letters,
 * digits and `- . _ ~ ! $ & ' ( ) * + , = : @ /`, and non-ASCII letters,
 * marks and digits the character policy keeps (send `/städte/köln`, not
 * `/st%C3%A4dte/k%C3%B6ln`). Never: `%` (no encoded `/`, `\`, `.` or control
 * can hide), `;`, `?`, `#`, `\`, whitespace, a scheme or host (`//`), or a
 * `.` / `..` segment.
 */
export function isViewContextRoute(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > VIEW_CONTEXT_LIMITS.maxRouteLength) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  for (const char of value) {
    if (char.charCodeAt(0) < 0x80 ? !ROUTE_ASCII.test(char) : !ROUTE_UNICODE.test(char) || REMOVED.test(char)) return false;
  }
  return value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function idPart(value: unknown): string | number | undefined {
  if (!isEntityIdValue(value)) return undefined;
  if (typeof value === 'number') return value;
  return value.trim() === value && isExactText(value) ? value : undefined;
}

/** A valid id exactly as given; undefined when invalid. */
function entityId(value: unknown): ViewContextEntityId | undefined {
  if (!Array.isArray(value)) return idPart(value);
  if (value.length < 2 || value.length > MAX_ENTITY_ID_PARTS) return undefined;
  const parts: Array<string | number> = [];
  for (let index = 0; index < value.length; index += 1) {
    const valid = idPart(value[index]);
    if (valid === undefined) return undefined;
    parts.push(valid);
  }
  return parts;
}

/**
 * The comparison key of an id: its NFC form, so `café` written composed and
 * decomposed is one record. The id itself is never normalised: a backend
 * that compares bytes still gets exactly the id the app sent, and two ids
 * that look the same never both reach the model.
 */
const idKey = (id: ViewContextEntityId): string => {
  const nfc = (part: string | number) => (typeof part === 'string' ? part.normalize('NFC') : part);
  return JSON.stringify(Array.isArray(id) ? id.map(nfc) : nfc(id as string | number));
};

// ============================================================================
// Facts
// ============================================================================

const FACT_KEY = /^[\p{L}\p{N}_$][\p{L}\p{N}_$.-]*$/u;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

type FactsCheck =
  | { ok: true; value: ViewContextFacts; changed: boolean }
  | { ok: false; reason: 'facts-invalid' | 'facts-too-large' };

/**
 * A plain JSON copy of `value` (a plain object), its strings cleaned when
 * `clean` is set (`changed` says whether cleaning changed one), or why not:
 * `facts-invalid` for anything that is not plain JSON, a forbidden or
 * malformed key, or nesting deeper than the bound (a cycle included);
 * `facts-too-large` when the copy exceeds the size or value bound. Stops at
 * the first problem.
 */
function plainFacts(value: unknown, clean: boolean): FactsCheck {
  if (!isPlainObject(value)) return { ok: false, reason: 'facts-invalid' };
  const { maxFactsBytes, maxFactsDepth, maxFactsNodes, maxFactKeyLength } = VIEW_CONTEXT_LIMITS;
  let nodes = 0;
  let size = 0;
  let changed = false;
  class Stop { constructor(readonly reason: 'facts-invalid' | 'facts-too-large') {} }
  const grow = (units: number) => {
    nodes += 1;
    size += units;
    if (nodes > maxFactsNodes || size > maxFactsBytes) throw new Stop('facts-too-large');
  };
  const copy = (input: unknown, depth: number): ViewContextFactValue => {
    if (input === null || typeof input === 'boolean') { grow(5); return input; }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Stop('facts-invalid');
      grow(String(input).length);
      return input;
    }
    if (typeof input === 'string') {
      if (input.length > maxFactsBytes) throw new Stop('facts-too-large');
      grow(input.length + 2);
      if (!clean) return input;
      const cleaned = cleanText(input, 'fact');
      if (cleaned !== input) changed = true;
      return cleaned;
    }
    if (depth >= maxFactsDepth) throw new Stop('facts-invalid');
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) throw new Stop('facts-invalid');
      grow(2);
      const list: ViewContextFactValue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        if (!(index in input)) throw new Stop('facts-invalid');
        list.push(copy(input[index], depth + 1));
      }
      return list;
    }
    if (!isPlainObject(input)) throw new Stop('facts-invalid');
    grow(2);
    const object: Record<string, ViewContextFactValue> = {};
    for (const key in input) {
      if (!own(input, key)) continue;
      if (FORBIDDEN_KEYS.has(key) || key.length > maxFactKeyLength || !FACT_KEY.test(key)) throw new Stop('facts-invalid');
      const child = input[key];
      if (child === undefined) continue;
      size += key.length + 3;
      object[key] = copy(child, depth + 1);
    }
    return object;
  };
  try {
    const result = copy(value, 0) as ViewContextFacts;
    if (utf8Length(JSON.stringify(result)) > maxFactsBytes) return { ok: false, reason: 'facts-too-large' };
    return { ok: true, value: result, changed };
  } catch (error) {
    return { ok: false, reason: error instanceof Stop ? error.reason : 'facts-invalid' };
  }
}

/** The data of a successful `safeParse`; undefined for a failure, a throw or a result of another shape. */
function parsedData(schema: ViewContextFactsSchema, value: unknown): { data: unknown } | undefined {
  try {
    const result: unknown = schema.safeParse(value);
    if (typeof result !== 'object' || result === null) return undefined;
    const { success } = result as { success?: unknown };
    if (success !== true || !('data' in result)) return undefined;
    return { data: (result as { data: unknown }).data };
  } catch {
    return undefined;
  }
}

// ============================================================================
// Policy
// ============================================================================

const POLICY_KEYS: ReadonlySet<string> = new Set(['enabled', 'types', 'history', 'maxEntries', 'facts']);

const isHistory = (value: unknown): value is ViewContextHistory =>
  (VIEW_CONTEXT_HISTORY_MODES as ReadonlyArray<unknown>).includes(value);

const isTypeList = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((type) => typeof type === 'string' && ENTITY_TYPE_PATTERN.test(type));

function isSchemaMap(value: unknown): value is Readonly<Record<string, ViewContextFactsSchema | false>> {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).every((type) => {
    const schema = value[type];
    return ENTITY_TYPE_PATTERN.test(type) && (schema === false || (typeof schema === 'object' && schema !== null
      && typeof (schema as { safeParse?: unknown }).safeParse === 'function'));
  });
}

function policyError(issue: string): Error {
  return new Error(`viewContext: ${issue}.`);
}

/**
 * The server's `viewContext` option with its defaults: on, every declared
 * type, history `'none'`, 8 entries, generated facts schemas. Throws on an
 * invalid option (a configuration error, like an invalid `defineEntity`).
 */
export function resolveViewContextPolicy(option?: ViewContextOption | ResolvedViewContextPolicy): ResolvedViewContextPolicy {
  const { maxEntries: limit } = VIEW_CONTEXT_LIMITS;
  if (option === undefined || option === true) return { enabled: true, history: 'none', maxEntries: limit };
  if (option === false) return { enabled: false, history: 'none', maxEntries: limit };
  if (!isPlainObject(option)) throw policyError('must be true, false or an object');
  const raw: Record<string, unknown> = option;
  const extra = Object.keys(raw).filter((key) => !POLICY_KEYS.has(key));
  if (extra.length > 0) throw policyError(`has unknown keys (${extra.slice(0, 5).map((key) => key.slice(0, 64)).join(', ')})`);
  const { enabled = true, history = 'none', maxEntries = limit, types, facts } = raw;
  if (typeof enabled !== 'boolean') throw policyError('enabled must be a boolean');
  if (!isHistory(history)) throw policyError(`history must be one of ${VIEW_CONTEXT_HISTORY_MODES.join(', ')}`);
  if (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > limit) {
    throw policyError(`maxEntries must be an integer from 1 to ${limit}`);
  }
  if (types !== undefined && !isTypeList(types)) throw policyError('types must be a list of entity type names');
  if (facts !== undefined && facts !== false && !isSchemaMap(facts)) {
    throw policyError('facts must be false or map entity type names to schemas with safeParse or false');
  }
  return {
    enabled,
    ...(types !== undefined ? { types: [...types] } : {}),
    history,
    maxEntries,
    ...(facts !== undefined ? { facts } : {}),
  };
}

// ============================================================================
// Sanitizing untrusted input
// ============================================================================

type DropCounts = Partial<Record<ViewContextDropReason, number>>;

/**
 * The valid part of a view context from an untrusted source (the browser).
 * The policy is resolved first (an invalid one throws, whatever the input).
 * At most `maxEntries` entries of declared (and allowed) types are kept, each
 * field checked and bounded on its own; an invalid entry or field is dropped,
 * never an error. An entry needs a valid entity or selection (a list view);
 * an invalid entity drops the entry. Unknown keys are ignored.
 *
 * Facts are kept only when a schema for the entity type (the selection type
 * in a list view) is known (`policy.facts` first, then `factsSchemas`): the
 * value as sent must pass it; its output is then cleaned for the model, and
 * when cleaning changed a string the cleaned facts must pass the schema too.
 *
 * Duplicates keep the first: entities by type and id (NFC), list views by
 * selection type, selection ids by id (NFC). Over the overall size bound a
 * selection keeps the ids that fit (or goes, when the entry has an entity)
 * before an entry is dropped. Deterministic. `dropped` holds reason codes and
 * counts only; field reasons count only for kept entries.
 */
export function sanitizeViewContext(input: unknown, options: ViewContextSanitizeOptions): ViewContextSanitizeResult {
  const policy = resolveViewContextPolicy(options.policy);
  const dropped: DropCounts = {};
  let droppedEntries = 0;
  const drop = (reason: ViewContextDropReason, count = 1) => {
    if (count <= 0) return;
    dropped[reason] = (dropped[reason] ?? 0) + count;
    if (ENTRY_REASONS.has(reason)) droppedEntries += count;
  };
  const done = (entries: ViewContextEntry[]): ViewContextSanitizeResult => ({ entries, dropped, droppedEntries });

  if (input === undefined || input === null) return done([]);
  let length: number;
  try {
    if (!Array.isArray(input)) throw new TypeError('not a list');
    length = input.length;
    if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('not a list');
  } catch {
    drop('not-a-list');
    return done([]);
  }
  if (!policy.enabled) { drop('disabled', length); return done([]); }

  const declared: ReadonlySet<string> = options.declaredTypes instanceof Set
    ? options.declaredTypes
    : new Set(options.declaredTypes as ReadonlyArray<string>);
  const allowed = policy.types ? new Set(policy.types) : undefined;
  const typeIssue = (type: unknown): ViewContextDropReason | undefined => {
    if (typeof type !== 'string' || !ENTITY_TYPE_PATTERN.test(type)) return 'invalid-entity';
    if (!declared.has(type)) return 'undeclared-type';
    if (allowed && !allowed.has(type)) return 'type-not-allowed';
    return undefined;
  };
  const schemaFor = (type: string): ViewContextFactsSchema | false | undefined => {
    const override = policy.facts || undefined;
    if (override && own(override, type)) return override[type];
    const generated = options.factsSchemas;
    return generated && own(generated, type) ? generated[type] : undefined;
  };

  type Note = (reason: ViewContextDropReason, count?: number) => void;

  const readSelection = (value: unknown, note: Note): ViewContextSelection | undefined => {
    if (!isPlainObject(value) || typeIssue(value.type) !== undefined || !Array.isArray(value.ids)) {
      note('invalid-selection');
      return undefined;
    }
    const raw = value.ids;
    const ids: ViewContextEntityId[] = [];
    const seen = new Set<string>();
    const { maxSelectionIds, maxScannedSelectionIds } = VIEW_CONTEXT_LIMITS;
    const total = raw.length;
    let index = 0;
    for (; index < total && index < maxScannedSelectionIds && ids.length < maxSelectionIds; index += 1) {
      const id = entityId(raw[index]);
      if (id === undefined) { note('selection-id-invalid'); continue; }
      const key = idKey(id);
      if (seen.has(key)) { note('selection-id-duplicate'); continue; }
      seen.add(key);
      ids.push(id);
    }
    note('selection-id-over-limit', total - index);
    if (ids.length === 0) { note('invalid-selection'); return undefined; }
    return { type: value.type as string, ids };
  };

  const readFacts = (type: string, value: unknown, note: Note): ViewContextFacts | undefined => {
    if (policy.facts === false) { note('facts-disabled'); return undefined; }
    const schema = schemaFor(type);
    if (schema === false) { note('facts-disabled'); return undefined; }
    if (!schema) { note('facts-no-schema'); return undefined; }
    // The schema sees the app's real value (an enum or pattern may hold a tab or a joiner).
    const raw = plainFacts(value, false);
    if (!raw.ok) { note(raw.reason); return undefined; }
    const first = parsedData(schema, raw.value);
    if (!first) { note('facts-invalid'); return undefined; }
    let out = plainFacts(first.data, true);
    if (!out.ok) { note(out.reason); return undefined; }
    if (out.changed) {
      // Removing a character can join others into something the schema
      // refused (`<` + U+200B + `!--` becomes `<!--`): what reaches the model
      // must pass the schema as well.
      const second = parsedData(schema, out.value);
      if (!second) { note('facts-invalid'); return undefined; }
      out = plainFacts(second.data, true);
      if (!out.ok) { note(out.reason); return undefined; }
      if (out.changed) { note('facts-invalid'); return undefined; }
    }
    return Object.keys(out.value).length > 0 ? out.value : undefined;
  };

  const readEntry = (value: unknown, note: Note): ViewContextEntry | ViewContextDropReason => {
    if (!isPlainObject(value)) return 'invalid-entry';
    let entity: ViewContextEntity | undefined;
    const rawEntity = value.entity;
    if (rawEntity !== undefined) {
      if (!isPlainObject(rawEntity)) return 'invalid-entity';
      const issue = typeIssue(rawEntity.type);
      if (issue) return issue;
      const id = entityId(rawEntity.id);
      if (id === undefined) return 'invalid-entity';
      entity = { type: rawEntity.type as string, id };
    }
    const selection = value.selection !== undefined ? readSelection(value.selection, note) : undefined;
    if (!entity && !selection) return 'no-entity-or-selection';
    const type = entity ? entity.type : selection!.type;

    let label: string | undefined;
    if (value.label !== undefined) {
      label = typeof value.label === 'string' ? canonicalViewContextLabel(value.label) : '';
      if (label === '') { label = undefined; note('invalid-label'); }
    }
    const facts = value.facts !== undefined ? readFacts(type, value.facts, note) : undefined;
    let unsaved: boolean | undefined;
    if (value.unsaved !== undefined) {
      if (typeof value.unsaved === 'boolean') unsaved = value.unsaved;
      else note('invalid-unsaved');
    }
    let route: string | undefined;
    if (value.route !== undefined) {
      if (isViewContextRoute(value.route)) route = value.route;
      else note('invalid-route');
    }
    return {
      ...(entity ? { entity } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(selection !== undefined ? { selection } : {}),
      ...(facts !== undefined ? { facts } : {}),
      ...(unsaved !== undefined ? { unsaved } : {}),
      ...(route !== undefined ? { route } : {}),
    } as ViewContextEntry;
  };

  /**
   * `entry` within `budget` bytes as a list item: as it is, else with the
   * first selection ids that fit (at least one), else without its selection
   * when it has an entity; undefined when even that does not fit.
   */
  const fitted = (entry: ViewContextEntry, budget: number, note: Note): ViewContextEntry | undefined => {
    if (utf8Length(JSON.stringify(entry)) <= budget) return entry;
    const selection = entry.selection;
    if (!selection) return undefined;
    let size = utf8Length(JSON.stringify({ ...entry, selection: { ...selection, ids: [] } }));
    let count = 0;
    for (const id of selection.ids) {
      size += utf8Length(JSON.stringify(id)) + (count > 0 ? 1 : 0);
      if (size > budget) break;
      count += 1;
    }
    if (count > 0) {
      note('selection-id-over-size', selection.ids.length - count);
      return { ...entry, selection: { ...selection, ids: selection.ids.slice(0, count) } };
    }
    if (!entry.entity) return undefined;
    const { selection: _removed, ...rest } = entry;
    if (utf8Length(JSON.stringify(rest)) > budget) return undefined;
    note('selection-id-over-size', selection.ids.length);
    return rest as ViewContextEntry;
  };

  const entries: ViewContextEntry[] = [];
  const seen = new Set<string>();
  let total = 2; // the brackets of the JSON list
  let index = 0;
  for (; index < length && index < VIEW_CONTEXT_LIMITS.maxScannedEntries && entries.length < policy.maxEntries; index += 1) {
    // Field reasons count only once the entry is kept.
    const pending: DropCounts = {};
    const note: Note = (reason, count = 1) => {
      if (count > 0) pending[reason] = (pending[reason] ?? 0) + count;
    };
    let entry: ViewContextEntry | ViewContextDropReason;
    try {
      entry = readEntry(input[index], note);
    } catch {
      entry = 'invalid-entry';
    }
    if (typeof entry === 'string') { drop(entry); continue; }
    // A list view is one per selection type; it never collides with an entity.
    const key = entry.entity
      ? `entity\u0000${entry.entity.type}\u0000${idKey(entry.entity.id)}`
      : `list\u0000${entry.selection.type}`;
    if (seen.has(key)) { drop('duplicate'); continue; }
    const comma = entries.length > 0 ? 1 : 0;
    const kept = fitted(entry, VIEW_CONTEXT_LIMITS.maxTotalBytes - total - comma, note);
    if (!kept) { drop('over-size'); continue; }
    seen.add(key);
    total += utf8Length(JSON.stringify(kept)) + comma;
    entries.push(kept);
    for (const [reason, count] of Object.entries(pending) as Array<[ViewContextDropReason, number]>) drop(reason, count);
  }
  drop('over-limit', length - index);
  return done(entries);
}

// ============================================================================
// Schemas of sanitized entries
// ============================================================================

const typeSchema = z.string().regex(ENTITY_TYPE_PATTERN);
const idSchema = z.custom<ViewContextEntityId>((value) => entityId(value) !== undefined, { message: 'Expected an entity id' });
const entitySchema = z.object({ type: typeSchema, id: idSchema }).strict();
const selectionSchema = z.object({
  type: typeSchema,
  ids: z.array(idSchema).min(1).max(VIEW_CONTEXT_LIMITS.maxSelectionIds),
}).strict();
const entryFields = {
  label: z.string().min(1).refine((label) => canonicalViewContextLabel(label) === label, 'Expected a canonical label').optional(),
  facts: z.custom<ViewContextFacts>((value) => {
    const check = plainFacts(value, true);
    return check.ok && !check.changed && JSON.stringify(check.value) === JSON.stringify(value);
  }, { message: 'Expected bounded, cleaned plain JSON facts' }).optional(),
  unsaved: z.boolean().optional(),
  route: z.custom<string>(isViewContextRoute, { message: 'Expected a route path' }).optional(),
};

/**
 * A sanitized entry (what {@link sanitizeViewContext} keeps), for stored view
 * contexts: an entity (with an optional selection) or a selection alone
 * (`entity` absent or `undefined`). Strict: it rejects an entry with neither,
 * a label that is not canonical, an id or route the policy does not allow and
 * facts that are not bounded, cleaned plain JSON. It does not know the
 * declared types or facts schemas; run untrusted input through
 * `sanitizeViewContext` instead.
 */
export const ViewContextEntrySchema: z.ZodType<ViewContextEntry> = z.union([
  z.object({ entity: entitySchema, selection: selectionSchema.optional(), ...entryFields }).strict(),
  z.object({ entity: z.undefined().optional(), selection: selectionSchema, ...entryFields }).strict(),
]) as z.ZodType<ViewContextEntry>;

/** A sanitized view context: at most 8 entries. */
export const ViewContextSchema = z.array(ViewContextEntrySchema).max(VIEW_CONTEXT_LIMITS.maxEntries);
