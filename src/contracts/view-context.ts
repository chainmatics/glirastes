/**
 * View context: what the user currently looks at in the app, declared by the
 * app (never guessed from the URL) and sent with a chat message. The server
 * validates and bounds it with {@link sanitizeViewContext} before it reaches
 * the model as data, never as an instruction. It grants no permission: every
 * tool call is authorized as before.
 *
 * An entry names one record of a declared entity type (`defineEntity`, tool
 * `outputEntities` / `inputEntities`), optionally a selection, a short label,
 * facts the app declared a schema for, an unsaved flag and the route path.
 * Untrusted input is never rejected as a whole: what is invalid is dropped,
 * and the result says how often each reason applied (counts only, never a
 * value), so diagnostics stay content-free.
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
 * `duplicate`, `over-limit`, `over-size`. Field reasons (the entry stays without that field or id):
 * the others.
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
  'unknown-field',
  'invalid-label',
  'invalid-unsaved',
  'invalid-route',
  'invalid-selection',
  'selection-id-invalid',
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
  'disabled', 'not-a-list', 'invalid-entry', 'invalid-entity', 'no-entity-or-selection', 'undeclared-type', 'type-not-allowed',
  'duplicate', 'over-limit', 'over-size',
]);

// ============================================================================
// Types
// ============================================================================

/**
 * The id of a record: a non-empty string of at most 200 characters (no
 * control, format or line separator characters) or a safe integer, as
 * `isEntityIdValue`; for a composite key the list of its 2 to 4 parts in the
 * declared order.
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
  /** A short name for the view, cleaned: at most 60 code points, one line, no control, format or bidi characters, no comment or marker delimiters. */
  readonly label?: string;
  /** At most 2 KB as JSON, and only what the schema of the entity type (of the selection type in a list view) kept. */
  readonly facts?: ViewContextFacts;
  /** The user has unsaved changes in this view. */
  readonly unsaved?: boolean;
  /** The path of the page (`/orders/42`): no query, no hash, no scheme or host, no dot segments. */
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
 * the generated artifact. It must return plain JSON (ISO strings, not `Date`).
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
  /** Entity types accepted, a subset of the declared ones. Default: every declared type. */
  readonly types?: ReadonlyArray<string>;
  /** Default `'none'`. */
  readonly history?: ViewContextHistory;
  /** Entries per message, 1 to 8. Default 8. */
  readonly maxEntries?: number;
  /** Facts schemas by entity type that replace the generated ones; `false` drops all facts. */
  readonly facts?: false | ViewContextFactsSchemas;
}

/** `false` turns the view context off, `true` or omitted keeps the defaults. */
export type ViewContextOption = boolean | ViewContextPolicy;

/** A {@link ViewContextPolicy} with its defaults applied. */
export interface ResolvedViewContextPolicy {
  readonly enabled: boolean;
  readonly types?: ReadonlyArray<string>;
  readonly history: ViewContextHistory;
  readonly maxEntries: number;
  readonly facts?: false | ViewContextFactsSchemas;
}

/** What {@link sanitizeViewContext} checks an input against. */
export interface ViewContextSanitizeOptions {
  /** Entity types the app declared; an entry or selection of another type is dropped. */
  readonly declaredTypes: ReadonlySet<string> | ReadonlyArray<string>;
  /** Facts schemas by entity type (from the generated artifact); without one, facts are dropped. */
  readonly factsSchemas?: ViewContextFactsSchemas;
  /** The server option; default on. */
  readonly policy?: ViewContextOption;
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
// Text and value checks (linear: single-character classes, no nested quantifiers)
// ============================================================================

const FORMAT_CHAR = /^\p{Cf}$/u;
const BREAK_CHAR = /^[\p{Cc}\p{Zl}\p{Zp}\s]$/u;
const HIDDEN_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ROUTE_CHARS = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;
const BAD_PERCENT = /%(?![0-9A-Fa-f]{2})/;
const FACT_KEY = /^[\p{L}\p{N}_$][\p{L}\p{N}_$.-]*$/u;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

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
 * The canonical form of a label, idempotent: NFC; runs of whitespace,
 * control and line/paragraph separator characters become one space; format
 * characters (bidi controls, zero-width characters, soft hyphen, tag
 * characters, BOM) are removed; `{` and `}` become `｛` and `｝`, `<!`, `-->`
 * and `--!>` become `‹!`, `--›` and `--!›`; trimmed; longer than `max` code
 * points: the first `max - 1` and `…`. The same rules as the canonical mention
 * label of the mention marker design, with a shorter bound; to be unified
 * with that module once it is merged. Single `<` and `>` stay (the renderer
 * escapes them).
 */
export function canonicalViewContextLabel(text: string, max: number = VIEW_CONTEXT_LIMITS.maxLabelLength): string {
  // Enough input for `max` code points after cleaning in all but pathological
  // cases; a longer input is cut first, so a 10 MB label costs as much as a short one.
  const bound = max * 8;
  const cut = text.length > bound;
  const source = (cut ? cutUnits(text, bound) : text).normalize('NFC');
  let out = '';
  let space = false;
  for (const char of source) {
    if (FORMAT_CHAR.test(char)) continue;
    if (BREAK_CHAR.test(char)) { space = out !== ''; continue; }
    if (space) { out += ' '; space = false; }
    out += char === '{' ? '｛' : char === '}' ? '｝' : char;
  }
  out = out.replaceAll('<!', '‹!').replaceAll('--!>', '--!›').replaceAll('-->', '--›');
  const points = [...out];
  if (out === '' || (points.length <= max && !cut)) return out;
  if (points.length <= max - 1 && cut) return `${out}…`;
  return `${points.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Whether `value` is a route as a view context carries it: a path of at most 256 ASCII URL path characters starting with one `/`, valid percent escapes, no query, hash, scheme, host or `.`/`..` segment. */
export function isViewContextRoute(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > VIEW_CONTEXT_LIMITS.maxRouteLength) return false;
  if (!ROUTE_CHARS.test(value) || value.startsWith('//') || BAD_PERCENT.test(value)) return false;
  for (const segment of value.split('/')) {
    const plain = segment.replaceAll('%2e', '.').replaceAll('%2E', '.');
    if (plain === '.' || plain === '..') return false;
  }
  return true;
}

function idPart(value: unknown): string | number | undefined {
  if (!isEntityIdValue(value)) return undefined;
  if (typeof value === 'number') return value;
  if (HIDDEN_CHAR.test(value)) return undefined;
  return value.trim();
}

/** A valid id, trimmed; undefined when invalid. */
function entityId(value: unknown): ViewContextEntityId | undefined {
  if (!Array.isArray(value)) return idPart(value);
  if (value.length < 2 || value.length > MAX_ENTITY_ID_PARTS) return undefined;
  const parts: Array<string | number> = [];
  for (const part of value) {
    const valid = idPart(part);
    if (valid === undefined) return undefined;
    parts.push(valid);
  }
  return parts;
}

const idKey = (id: ViewContextEntityId): string => JSON.stringify(id);

/** Removes format characters and turns control and line separator characters into spaces, for fact strings. */
function cleanFactText(text: string): string {
  if (!HIDDEN_CHAR.test(text)) return text;
  let out = '';
  for (const char of text) {
    if (FORMAT_CHAR.test(char)) continue;
    out += HIDDEN_CHAR.test(char) ? ' ' : char;
  }
  return out;
}

type FactsCheck = { ok: true; value: ViewContextFacts } | { ok: false; reason: 'facts-invalid' | 'facts-too-large' };

/**
 * A plain JSON copy of `value` (a plain object), with cleaned strings when
 * `clean` is set, or why
 * not: `facts-invalid` for anything that is not plain JSON, a forbidden or
 * malformed key, or nesting deeper than the bound (a cycle included);
 * `facts-too-large` when the copy exceeds the size or value bound. Stops at
 * the first problem, so its cost is bounded by the limits, not by the input.
 */
function plainFacts(value: unknown, clean: boolean): FactsCheck {
  if (!isPlainObject(value)) return { ok: false, reason: 'facts-invalid' };
  const { maxFactsBytes, maxFactsDepth, maxFactsNodes, maxFactKeyLength } = VIEW_CONTEXT_LIMITS;
  let nodes = 0;
  let size = 0;
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
      return clean ? cleanFactText(input) : input;
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
    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, reason: error instanceof Stop ? error.reason : 'facts-invalid' };
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

function isSchemaMap(value: unknown): value is ViewContextFactsSchemas {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).every((type) => {
    const schema = value[type];
    return ENTITY_TYPE_PATTERN.test(type) && typeof schema === 'object' && schema !== null
      && typeof (schema as { safeParse?: unknown }).safeParse === 'function';
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
export function resolveViewContextPolicy(option?: ViewContextOption): ResolvedViewContextPolicy {
  const { maxEntries: limit } = VIEW_CONTEXT_LIMITS;
  if (option === undefined || option === true) return { enabled: true, history: 'none', maxEntries: limit };
  if (option === false) return { enabled: false, history: 'none', maxEntries: limit };
  if (!isPlainObject(option)) throw policyError('must be true, false or an object');
  const raw: Record<string, unknown> = option;
  const extra = Object.keys(raw).filter((key) => !POLICY_KEYS.has(key));
  if (extra.length > 0) throw policyError(`has unknown keys (${extra.slice(0, 5).join(', ')})`);
  const { enabled = true, history = 'none', maxEntries = limit, types, facts } = raw;
  if (typeof enabled !== 'boolean') throw policyError('enabled must be a boolean');
  if (!isHistory(history)) throw policyError(`history must be one of ${VIEW_CONTEXT_HISTORY_MODES.join(', ')}`);
  if (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > limit) {
    throw policyError(`maxEntries must be an integer from 1 to ${limit}`);
  }
  if (types !== undefined && !isTypeList(types)) throw policyError('types must be a list of entity type names');
  if (facts !== undefined && facts !== false && !isSchemaMap(facts)) {
    throw policyError('facts must be false or map entity type names to schemas with safeParse');
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

const ENTRY_KEYS: ReadonlySet<string> = new Set(['entity', 'label', 'selection', 'facts', 'unsaved', 'route']);

/**
 * The valid part of a view context from an untrusted source (the browser):
 * at most `maxEntries` entries of declared (and allowed) types, each field
 * checked and bounded on its own; an invalid entry or field is dropped, never
 * an error. An entry needs an entity or a selection (a list view). Facts are
 * kept only when a schema for the entity type (the selection type in a list
 * view) is known (`policy.facts` first, then `factsSchemas`) and the value
 * as sent passes it; the schema output is then cleaned for the model.
 * Duplicates keep the first: entities by type and id, list views by
 * selection type. Over the overall size bound, a selection keeps the ids that
 * fit (or goes, when the entry has an entity) before an entry is dropped. Deterministic; its cost is bounded by the limits,
 * not by the size of the input. `dropped` holds reason codes and counts only.
 */
export function sanitizeViewContext(input: unknown, options: ViewContextSanitizeOptions): ViewContextSanitizeResult {
  const dropped: Partial<Record<ViewContextDropReason, number>> = {};
  let droppedEntries = 0;
  const drop = (reason: ViewContextDropReason, count = 1) => {
    if (count <= 0) return;
    dropped[reason] = (dropped[reason] ?? 0) + count;
    if (ENTRY_REASONS.has(reason)) droppedEntries += count;
  };
  const done = (entries: ViewContextEntry[]): ViewContextSanitizeResult => ({ entries, dropped, droppedEntries });

  if (input === undefined || input === null) return done([]);
  if (!Array.isArray(input)) { drop('not-a-list'); return done([]); }
  const policy = resolveViewContextPolicy(options.policy);
  if (!policy.enabled) { drop('disabled', input.length); return done([]); }

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
  const schemaFor = (type: string): ViewContextFactsSchema | undefined => {
    const override = policy.facts || undefined;
    if (override && own(override, type)) return override[type];
    const generated = options.factsSchemas;
    return generated && own(generated, type) ? generated[type] : undefined;
  };

  const readSelection = (value: unknown): ViewContextSelection | undefined => {
    if (!isPlainObject(value) || typeIssue(value.type) !== undefined || !Array.isArray(value.ids)) {
      drop('invalid-selection');
      return undefined;
    }
    const raw = value.ids;
    const ids: ViewContextEntityId[] = [];
    const seen = new Set<string>();
    const { maxSelectionIds, maxScannedSelectionIds } = VIEW_CONTEXT_LIMITS;
    let index = 0;
    for (; index < raw.length && index < maxScannedSelectionIds && ids.length < maxSelectionIds; index += 1) {
      const id = entityId(raw[index]);
      if (id === undefined) { drop('selection-id-invalid'); continue; }
      const key = idKey(id);
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push(id);
    }
    drop('selection-id-over-limit', raw.length - index);
    if (ids.length === 0) { drop('invalid-selection'); return undefined; }
    return { type: value.type as string, ids };
  };

  const readFacts = (type: string, value: unknown): ViewContextFacts | undefined => {
    if (policy.facts === false) { drop('facts-disabled'); return undefined; }
    const schema = schemaFor(type);
    if (!schema) { drop('facts-no-schema'); return undefined; }
    // The schema sees the app's real strings (an enum or pattern may hold a tab
    // or a joiner); only its output, what reaches the model, is cleaned. Cleaning
    // only removes or blanks characters, so it can never add a delimiter.
    const before = plainFacts(value, false);
    if (!before.ok) { drop(before.reason); return undefined; }
    let parsed: ReturnType<ViewContextFactsSchema['safeParse']>;
    try {
      parsed = schema.safeParse(before.value);
    } catch {
      drop('facts-invalid');
      return undefined;
    }
    if (!parsed.success) { drop('facts-invalid'); return undefined; }
    const after = plainFacts(parsed.data, true);
    if (!after.ok) { drop(after.reason); return undefined; }
    return Object.keys(after.value).length > 0 ? after.value : undefined;
  };

  const readEntry = (value: unknown): ViewContextEntry | ViewContextDropReason => {
    if (!isPlainObject(value)) return 'invalid-entry';
    let entity: ViewContextEntity | undefined;
    if (value.entity !== undefined) {
      const raw = value.entity;
      if (!isPlainObject(raw)) return 'invalid-entity';
      const issue = typeIssue(raw.type);
      if (issue) return issue;
      const id = entityId(raw.id);
      if (id === undefined) return 'invalid-entity';
      for (const key of Object.keys(raw)) if (key !== 'type' && key !== 'id') drop('unknown-field');
      entity = { type: raw.type as string, id };
    }
    const selection = value.selection !== undefined ? readSelection(value.selection) : undefined;
    if (!entity && !selection) return 'no-entity-or-selection';
    for (const key of Object.keys(value)) if (!ENTRY_KEYS.has(key)) drop('unknown-field');
    const type = entity ? entity.type : selection!.type;

    let label: string | undefined;
    if (value.label !== undefined) {
      label = typeof value.label === 'string' ? canonicalViewContextLabel(value.label) : '';
      if (label === '') { label = undefined; drop('invalid-label'); }
    }
    const facts = value.facts !== undefined ? readFacts(type, value.facts) : undefined;
    let unsaved: boolean | undefined;
    if (value.unsaved !== undefined) {
      if (typeof value.unsaved === 'boolean') unsaved = value.unsaved;
      else drop('invalid-unsaved');
    }
    let route: string | undefined;
    if (value.route !== undefined) {
      if (isViewContextRoute(value.route)) route = value.route;
      else drop('invalid-route');
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
  const fitted = (entry: ViewContextEntry, budget: number): ViewContextEntry | undefined => {
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
      drop('selection-id-over-size', selection.ids.length - count);
      return { ...entry, selection: { ...selection, ids: selection.ids.slice(0, count) } };
    }
    if (!entry.entity) return undefined;
    const { selection: _removed, ...rest } = entry;
    if (utf8Length(JSON.stringify(rest)) > budget) return undefined;
    drop('selection-id-over-size', selection.ids.length);
    return rest as ViewContextEntry;
  };

  const entries: ViewContextEntry[] = [];
  const seen = new Set<string>();
  let total = 2; // the brackets of the JSON list
  let index = 0;
  for (; index < input.length && index < VIEW_CONTEXT_LIMITS.maxScannedEntries && entries.length < policy.maxEntries; index += 1) {
    let entry: ViewContextEntry | ViewContextDropReason;
    try {
      entry = readEntry(input[index]);
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
    const kept = fitted(entry, VIEW_CONTEXT_LIMITS.maxTotalBytes - total - comma);
    if (!kept) { drop('over-size'); continue; }
    seen.add(key);
    total += utf8Length(JSON.stringify(kept)) + comma;
    entries.push(kept);
  }
  drop('over-limit', input.length - index);
  return done(entries);
}

// ============================================================================
// Schemas of sanitized entries
// ============================================================================

const typeSchema = z.string().regex(ENTITY_TYPE_PATTERN);
const idSchema = z.custom<ViewContextEntityId>((value) => {
  const id = entityId(value);
  return id !== undefined && idKey(id) === idKey(value as ViewContextEntityId);
}, { message: 'Expected an entity id' });

const entitySchema = z.object({ type: typeSchema, id: idSchema }).strict();
const selectionSchema = z.object({
  type: typeSchema,
  ids: z.array(idSchema).min(1).max(VIEW_CONTEXT_LIMITS.maxSelectionIds),
}).strict();
const entryFields = {
  label: z.string().min(1).refine((label) => canonicalViewContextLabel(label) === label, 'Expected a canonical label').optional(),
  facts: z.custom<ViewContextFacts>((value) => {
    const check = plainFacts(value, true);
    return check.ok && JSON.stringify(check.value) === JSON.stringify(value);
  }, { message: 'Expected bounded plain JSON facts' }).optional(),
  unsaved: z.boolean().optional(),
  route: z.custom<string>(isViewContextRoute, { message: 'Expected a route path' }).optional(),
};

/**
 * A sanitized entry (what {@link sanitizeViewContext} keeps), for stored view
 * contexts: an entity (with an optional selection) or a selection alone.
 * Strict: it rejects an entry with neither, a label that is not canonical, a
 * route that is not a plain path and facts that are not bounded, cleaned plain
 * JSON. It does not know the declared types or facts schemas; run untrusted
 * input through `sanitizeViewContext` instead.
 */
export const ViewContextEntrySchema: z.ZodType<ViewContextEntry> = z.union([
  z.object({ entity: entitySchema, selection: selectionSchema.optional(), ...entryFields }).strict(),
  z.object({ selection: selectionSchema, ...entryFields }).strict(),
]);

/** A sanitized view context: at most 8 entries. */
export const ViewContextSchema = z.array(ViewContextEntrySchema).max(VIEW_CONTEXT_LIMITS.maxEntries);
