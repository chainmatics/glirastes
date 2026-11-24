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
 * Characters. The character policy of the mention marker
 * (`mention-marker.ts`) decides which characters never reach the model, so
 * the SDK has one policy. Labels are canonical mention labels (60 code
 * points); fact strings go through `cleanDisplayText` (hidden characters
 * removed with the emoji, flag and joining-script exceptions, NFC, each run
 * of control or line/paragraph separator characters one space, trimmed).
 * Both read at most 4096 code points, more than a label keeps and more than
 * a fact string may have (2048 UTF-16 units), so nothing a fact holds is left
 * unread. Ids and routes are never cleaned: one hidden, control, unassigned
 * or separator character (`hasHiddenChar`, without the display exceptions)
 * makes them invalid, so an id reaches the server exactly as the app wrote
 * it, or not at all.
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
 * cleaning turns them into spaces, and ids and routes holding one are invalid.
 *
 * Cost. Entries, entities and selections are read by their known keys only
 * (unknown keys are ignored, never enumerated); at most 32 entries and 100
 * selection ids are looked at; labels are read up to 4096 code points; facts
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
import { canonicalMentionLabel, cleanDisplayText, hasHiddenChar } from './mention-marker.js';

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
  /**
   * Every count in `dropped` and `droppedEntries` stops here, so it stays a
   * small safe integer whatever length a list has or claims (a proxy may
   * claim any). Up to 1,000,000 dropped a count is exact; only when more are
   * dropped for it (possible with plain JSON too, given a large body limit)
   * is it a lower bound, and `droppedEntries + entries.length` is then less
   * than the input length.
   */
  maxDropCount: 1_000_000,
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
 * most 200 characters without surrounding whitespace and without a hidden,
 * control, unassigned or separator character, or a safe integer; for a
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
  /** A short name for the view, canonical: at most 60 code points, the canonical mention label form (NFC, one line, no hidden characters, comment and marker delimiters replaced). */
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

/**
 * The canonical form of a view context label: the canonical mention label
 * (`canonicalMentionLabel` with `maxLength` 60: `cleanDisplayText`, then
 * `{` `}` `<!` `-->` `--!>` replaced by visible look-alikes, cut at a
 * grapheme boundary with `…`), so a name reads the same in a chip, a marker
 * and this block. Empty when nothing visible is left (the label is then
 * dropped; a mention label would fall back to its id). Idempotent.
 */
export function canonicalViewContextLabel(text: string, max: number = VIEW_CONTEXT_LIMITS.maxLabelLength): string {
  return cleanDisplayText(text) === '' ? '' : canonicalMentionLabel(text, { maxLength: max });
}

const ROUTE_ASCII = /^[A-Za-z0-9\-._~!$&'()*+,=:@/]$/;
const ROUTE_UNICODE = /^[\p{L}\p{M}\p{N}]$/u;

/**
 * Whether `value` is a route as a view context carries it: a decoded path of
 * at most 256 characters starting with one `/`. Allowed: ASCII letters,
 * digits and `- . _ ~ ! $ & ' ( ) * + , = : @ /`, and non-ASCII letters,
 * marks and digits without a hidden character (`hasHiddenChar`) (send `/städte/köln`, not
 * `/st%C3%A4dte/k%C3%B6ln`). Never: `%` (no encoded `/`, `\`, `.` or control
 * can hide), `;`, `?`, `#`, `\`, whitespace, a scheme or host (`//`), or a
 * `.` / `..` segment.
 */
export function isViewContextRoute(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > VIEW_CONTEXT_LIMITS.maxRouteLength) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  for (const char of value) {
    if (char.charCodeAt(0) < 0x80 ? !ROUTE_ASCII.test(char) : !ROUTE_UNICODE.test(char) || hasHiddenChar(char)) return false;
  }
  return value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

/**
 * The length of an input list as a checked primitive: a safe, non-negative
 * integer read once, else undefined (the list is then invalid). A proxy that
 * passes `Array.isArray` may claim any `length`; only this number is used.
 */
function listLength(list: ReadonlyArray<unknown>): number | undefined {
  const length: unknown = list.length;
  return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

function idPart(value: unknown): string | number | undefined {
  if (!isEntityIdValue(value)) return undefined;
  if (typeof value === 'number') return value;
  return value.trim() === value && !hasHiddenChar(value) ? value : undefined;
}

/** A valid id exactly as given; undefined when invalid. */
function entityId(value: unknown): ViewContextEntityId | undefined {
  if (!Array.isArray(value)) return idPart(value);
  const length = listLength(value);
  if (length === undefined || length < 2 || length > MAX_ENTITY_ID_PARTS) return undefined;
  const parts: Array<string | number> = [];
  for (let index = 0; index < length; index += 1) {
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
      const cleaned = cleanDisplayText(input);
      if (cleaned !== input) changed = true;
      return cleaned;
    }
    if (depth >= maxFactsDepth) throw new Stop('facts-invalid');
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) throw new Stop('facts-invalid');
      grow(2);
      const list: ViewContextFactValue[] = [];
      const length = listLength(input);
      if (length === undefined) throw new Stop('facts-invalid');
      for (let index = 0; index < length; index += 1) {
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
      if (FORBIDDEN_KEYS.has(key) || key.length > maxFactKeyLength || !FACT_KEY.test(key) || hasHiddenChar(key)) {
        throw new Stop('facts-invalid');
      }
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
    const { maxDropCount } = VIEW_CONTEXT_LIMITS;
    dropped[reason] = Math.min(maxDropCount, (dropped[reason] ?? 0) + count);
    if (ENTRY_REASONS.has(reason)) droppedEntries = Math.min(maxDropCount, droppedEntries + count);
  };
  const done = (entries: ViewContextEntry[]): ViewContextSanitizeResult => ({ entries, dropped, droppedEntries });

  if (input === undefined || input === null) return done([]);
  let length: number;
  try {
    if (!Array.isArray(input)) throw new TypeError('not a list');
    const checked = listLength(input);
    if (checked === undefined) throw new TypeError('not a list');
    length = checked;
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
    if (!isPlainObject(value)) { note('invalid-selection'); return undefined; }
    // Each field is read once: a getter cannot pass the check and return something else.
    const type = value.type;
    const raw = value.ids;
    if (typeIssue(type) !== undefined || !Array.isArray(raw)) {
      note('invalid-selection');
      return undefined;
    }
    const ids: ViewContextEntityId[] = [];
    const seen = new Set<string>();
    const { maxSelectionIds, maxScannedSelectionIds } = VIEW_CONTEXT_LIMITS;
    const total = listLength(raw);
    if (total === undefined) { note('invalid-selection'); return undefined; }
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
    return { type: type as string, ids };
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
    // Each field is read exactly once into a local and only that local is checked
    // and returned: a getter (a caller that is not JSON) cannot swap a value in.
    const rawEntity = value.entity;
    const rawSelection = value.selection;
    const rawLabel = value.label;
    const rawFacts = value.facts;
    const rawUnsaved = value.unsaved;
    const rawRoute = value.route;
    let entity: ViewContextEntity | undefined;
    if (rawEntity !== undefined) {
      if (!isPlainObject(rawEntity)) return 'invalid-entity';
      const entityType = rawEntity.type;
      const rawId = rawEntity.id;
      const issue = typeIssue(entityType);
      if (issue) return issue;
      const id = entityId(rawId);
      if (id === undefined) return 'invalid-entity';
      entity = { type: entityType as string, id };
    }
    const selection = rawSelection !== undefined ? readSelection(rawSelection, note) : undefined;
    if (!entity && !selection) return 'no-entity-or-selection';
    const type = entity ? entity.type : selection!.type;

    let label: string | undefined;
    if (rawLabel !== undefined) {
      label = typeof rawLabel === 'string' ? canonicalViewContextLabel(rawLabel) : '';
      if (label === '') { label = undefined; note('invalid-label'); }
    }
    const facts = rawFacts !== undefined ? readFacts(type, rawFacts, note) : undefined;
    let unsaved: boolean | undefined;
    if (rawUnsaved !== undefined) {
      if (typeof rawUnsaved === 'boolean') unsaved = rawUnsaved;
      else note('invalid-unsaved');
    }
    let route: string | undefined;
    if (rawRoute !== undefined) {
      if (isViewContextRoute(rawRoute)) route = rawRoute;
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
      if (count > 0) pending[reason] = Math.min(VIEW_CONTEXT_LIMITS.maxDropCount, (pending[reason] ?? 0) + count);
    };
    // Everything about one entry runs inside the try: a throwing getter or proxy drops the entry, never the call.
    try {
      const entry = readEntry(input[index], note);
      if (typeof entry === 'string') { drop(entry); continue; }
      // A list view is one per selection type; it never collides with an entity.
      const key = entry.entity
        ? `entity\u0000${entry.entity.type}\u0000${idKey(entry.entity.id)}`
        : `list\u0000${entry.selection.type}`;
      if (seen.has(key)) { drop('duplicate'); continue; }
      const comma = entries.length > 0 ? 1 : 0;
      const kept = fitted(entry, VIEW_CONTEXT_LIMITS.maxTotalBytes - total - comma, note);
      if (!kept) { drop('over-size'); continue; }
      const size = utf8Length(JSON.stringify(kept)) + comma;
      seen.add(key);
      total += size;
      entries.push(kept);
    } catch {
      drop('invalid-entry');
      continue;
    }
    for (const [reason, count] of Object.entries(pending) as Array<[ViewContextDropReason, number]>) drop(reason, count);
  }
  drop('over-limit', length - index);
  return done(entries);
}

// ============================================================================
// Schemas of sanitized entries
// ============================================================================

/** A list in a stored view context longer than this is refused before it is copied (a kept one has at most 50 items). */
const MAX_SCHEMA_LIST_LENGTH = 10_000;

/**
 * The first stage of a list schema: a new array holding the same elements
 * (not copied themselves) of an array with an honest `length` (read once,
 * `listLength`, at most 10,000), so the `z.array` after it reads a real
 * array and never a length a proxy claims. Anything that is not an array is
 * passed on unchanged, so `z.array` reports it as always.
 */
function honestList(maximum: number) {
  return z.unknown().transform((value, ctx) => {
    if (!Array.isArray(value)) return value;
    const length = listLength(value);
    if (length === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Expected a list with a valid length', input: value });
      return z.NEVER;
    }
    if (length > MAX_SCHEMA_LIST_LENGTH) {
      ctx.addIssue({ code: 'too_big', origin: 'array', maximum, inclusive: true, input: value });
      return z.NEVER;
    }
    return Array.from({ length }, (_, index) => value[index]);
  });
}

const typeSchema = z.string().regex(ENTITY_TYPE_PATTERN);
const idSchema = z.custom<ViewContextEntityId>((value) => entityId(value) !== undefined, { message: 'Expected an entity id' });
const entitySchema = z.object({ type: typeSchema, id: idSchema }).strict();
const selectionSchema = z.object({
  type: typeSchema,
  ids: honestList(VIEW_CONTEXT_LIMITS.maxSelectionIds)
    .pipe(z.array(idSchema).min(1).max(VIEW_CONTEXT_LIMITS.maxSelectionIds)),
}).strict();
const entryFields = {
  label: z.string().min(1).refine((label) => canonicalViewContextLabel(label) === label, 'Expected a canonical label').optional(),
  facts: z.custom<ViewContextFacts>((value) => {
    // Read once: the copy is checked, never `value` again (no second walk, no `toJSON`).
    const raw = plainFacts(value, false);
    if (!raw.ok) return false;
    const cleaned = plainFacts(raw.value, true);
    return cleaned.ok && !cleaned.changed;
  }, { message: 'Expected bounded, cleaned plain JSON facts' }).optional(),
  unsaved: z.boolean().optional(),
  route: z.custom<string>(isViewContextRoute, { message: 'Expected a route path' }).optional(),
};

/**
 * The shape of a sanitized entry (what {@link sanitizeViewContext} keeps),
 * for trusted, stored view contexts: an entity (with an optional selection)
 * or a selection alone (`entity` absent or `undefined`). It rejects unknown
 * keys, an entry with neither, a label that is not canonical, an id or route
 * the policy does not allow, facts that are not bounded, cleaned plain JSON,
 * and `selection.ids` over 10,000 items before any item is checked. It
 * promises no copy of the input: facts and composite ids in the result can
 * be the input's own objects. It does not know the declared types or facts
 * schemas; input from the browser goes through `sanitizeViewContext`.
 */
export const ViewContextEntrySchema: z.ZodType<ViewContextEntry> = z.union([
  z.object({ entity: entitySchema, selection: selectionSchema.optional(), ...entryFields }).strict(),
  z.object({ entity: z.undefined().optional(), selection: selectionSchema, ...entryFields }).strict(),
]) as z.ZodType<ViewContextEntry>;

/**
 * The shape of a sanitized view context, for trusted, stored data: at most 8
 * entries of {@link ViewContextEntrySchema}. A list whose `length` is not a
 * safe non-negative integer, or over 10,000, is refused before any entry is
 * checked. It promises no copy of the input (see the entry schema); input
 * from the browser goes through `sanitizeViewContext`.
 */
export const ViewContextSchema: z.ZodType<ViewContextEntry[]> = honestList(VIEW_CONTEXT_LIMITS.maxEntries)
  .pipe(z.array(ViewContextEntrySchema).max(VIEW_CONTEXT_LIMITS.maxEntries));
