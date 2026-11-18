/**
 * Compaction of a tool result that is re-sent to the model in a later turn.
 *
 * The model keeps the names of an earlier list from its own answer, but only
 * the ids the history still shows. So the entries of the dominant array that
 * do not stay complete keep their identity fields (the keys the result
 * overview keeps) instead of being dropped, under a `_history` marker that
 * says what this copy is. Pure, deterministic, linear in the size of the
 * result; it only copies values of the history copy it is given.
 *
 * @module
 */

import { READ_RESULT_ID_PREFIX, WRITE_RESULT_ID_PREFIX, READ_RESULT_TOOL_NAME } from '../../../contracts/result-handle.js';
import { idLikeFieldsOf } from '../../../contracts/record-identity.js';
import {
  dominantArrayRoute,
  expiredInstruction,
  IDENTITY_ID_KEYS,
  IDENTITY_NAME_KEYS,
  identityFieldsOf,
} from '../../core/result-overview.js';

export const HISTORY_DEFAULTS = {
  maxTurns: 6,
  toolTurns: 1,
  maxTokens: 4_000,
  maxItems: 10,
  maxStringLength: 300,
  keepIdentity: true,
} as const;

/** Key of the marker on a result that history compaction reduced. */
export const HISTORY_MARKER_KEY = '_history';

/** The `_history` marker. */
export interface HistoryMarker {
  /** Dot path of the reduced array (`data` for a list result). */
  field: string;
  /** Entries listed here. */
  showing: number;
  /** Leading entries listed with all their (compacted) fields. */
  full: number;
  /** Entries the result had (the total of its own `_truncated` / `_result` marker when it gave one). */
  total: number;
  /** Identity fields the other listed entries keep. */
  keys: string[];
  hint: string;
}

/** Said in an earlier turn sent as text only, once, where its tool results were left out. */
export const HISTORY_TEXT_ONLY_NOTE = '[Tool results of this and earlier turns are left out: no ids from them are available. '
  + 'Before calling a tool that needs an id, look the entry up by name with a read tool.]';

const MAX_COMPACT_DEPTH = 6;
const MARKER_LENGTH = JSON.stringify(HISTORY_MARKER_KEY).length;
const OWN_MARKERS: ReadonlySet<string> = new Set(['_truncated', HISTORY_MARKER_KEY]);
const ID_KEYS: ReadonlySet<string> = new Set(IDENTITY_ID_KEYS);
const NAME_KEYS: ReadonlySet<string> = new Set(IDENTITY_NAME_KEYS);

/**
 * The marker's `keys` in a fixed order: the recognised id keys, then the
 * id-like keys of entries without one (`playlist_id`, in the order they first
 * occur), then the name keys.
 */
function orderedKeys(kept: ReadonlySet<string>, idLikeOrder: ReadonlyArray<string>): string[] {
  return [
    ...IDENTITY_ID_KEYS.filter((key) => kept.has(key)),
    ...idLikeOrder.filter((key) => kept.has(key) && !ID_KEYS.has(key) && !NAME_KEYS.has(key)),
    ...IDENTITY_NAME_KEYS.filter((key) => kept.has(key)),
  ];
}

type Limits = { maxItems: number; maxStringLength: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** The size bound of earlier versions: first `maxItems` entries plus a count, strings cut, nesting cut. */
function compactValue(current: unknown, depth: number, limits: Limits): unknown {
  if (typeof current === 'string') {
    return current.length > limits.maxStringLength
      ? `${current.slice(0, limits.maxStringLength)}… [${current.length - limits.maxStringLength} more characters]`
      : current;
  }
  if (current === null || typeof current !== 'object') return current;
  if (depth >= MAX_COMPACT_DEPTH) return Array.isArray(current) ? '[…]' : '{…}';
  if (Array.isArray(current)) {
    const kept = current.slice(0, limits.maxItems).map((item) => compactValue(item, depth + 1, limits));
    return current.length > limits.maxItems
      ? [...kept, `[${current.length - limits.maxItems} more items, ${current.length} total]`]
      : kept;
  }
  return Object.fromEntries(Object.entries(current)
    .map(([key, item]) => [key, compactValue(item, depth + 1, limits)]));
}

/**
 * Deterministic size bound for a tool result re-sent in a later turn: arrays
 * keep their first `maxItems` entries plus a count, strings are cut at
 * `maxStringLength`, nesting is cut below a fixed depth. Kept items keep all
 * their (short) fields, ids included.
 */
export function compactToolOutput(
  value: unknown,
  limits: { maxItems?: number; maxStringLength?: number } = {},
): unknown {
  return compactValue(value, 0, {
    maxItems: limits.maxItems ?? HISTORY_DEFAULTS.maxItems,
    maxStringLength: limits.maxStringLength ?? HISTORY_DEFAULTS.maxStringLength,
  });
}

/** A name kept in a reduced entry is clipped to this many characters only as a last step (still recognisable). */
export const HISTORY_NAME_CLIP_CHARS = 60;
const CLIP_SUFFIX = '…[clipped]';

function clipName(name: string): string {
  if (name.length <= HISTORY_NAME_CLIP_CHARS) return name;
  let keep = HISTORY_NAME_CLIP_CHARS;
  const last = name.charCodeAt(keep - 1);
  // Never split a surrogate pair.
  if (last >= 0xd800 && last <= 0xdbff) keep -= 1;
  return name.slice(0, keep) + CLIP_SUFFIX;
}

/** How much of an entry's identity a reduced entry keeps. */
type IdentityLevel = 'all' | 'pair' | 'clipped';

/**
 * Identity of an entry, in the entry's key order: `all` its identity
 * fields; `pair` its first id field and its first name field; `clipped`
 * that pair with the name clipped. A name too long to be an identity field
 * is kept clipped on every level, so an entry with a name never loses it.
 * An entry without a recognised identifier keeps every id-like field
 * (`idLikeFieldsOf`) on every level.
 */
function identityOf(entry: unknown, level: IdentityLevel): Array<[string, unknown]> {
  if (!isPlainObject(entry)) return [];
  const kept = new Map(identityFieldsOf(entry));
  const idLike = new Set(idLikeFieldsOf(entry, IDENTITY_ID_KEYS));
  let fields: Array<[string, unknown]> = [];
  for (const key of Object.keys(entry)) {
    const value = entry[key];
    if (kept.has(key)) fields.push([key, kept.get(key)]);
    else if (NAME_KEYS.has(key) && typeof value === 'string') fields.push([key, clipName(value)]);
  }
  if (level === 'all') return fields;
  const id = fields.find(([key]) => ID_KEYS.has(key));
  const name = fields.find(([key]) => NAME_KEYS.has(key));
  fields = fields.filter((field) => field === id || field === name || idLike.has(field[0]));
  return level === 'clipped'
    ? fields.map(([key, value]) => [key, NAME_KEYS.has(key) && typeof value === 'string' ? clipName(value) : value])
    : fields;
}

function isClipped(fields: Array<[string, unknown]>): boolean {
  return fields.some(([key, value]) => NAME_KEYS.has(key) && typeof value === 'string' && value.endsWith(CLIP_SUFFIX));
}

function objectOf(fields: Array<[string, unknown]>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of fields) setOwn(output, key, value);
  return output;
}

/** The handle hint of an overview from an earlier turn: the handle has expired. */
function expiredHandleHint(id: string): string {
  return `From an earlier turn: this result id has expired, do not pass it to ${READ_RESULT_TOOL_NAME}. `
    + `For anything not shown, ${expiredInstruction(id.startsWith(READ_RESULT_ID_PREFIX))}`;
}

function markerHint(field: string, showing: number, full: number, total: number, keys: ReadonlyArray<string>, clipped: boolean): string {
  const reduced = showing - full;
  const listed = `${showing} of ${total} entries of ${field}`;
  const shape = reduced === 0
    ? ''
    : full === 0
      ? `, reduced to ${keys.join(', ')}`
      : `, the first ${full} complete, the other ${reduced} reduced to ${keys.join(', ')}`;
  const names = clipped ? ` Names ending in ${CLIP_SUFFIX} are shortened.` : '';
  const missing = showing < total
    ? ' Entries not listed are not known here: get them with a read tool (call the list tool again) before using their id.'
    : '';
  return `Shortened copy of a result from an earlier turn: ${listed}${shape}.${names}${missing}`
    + ' Never pair an id with a name from another entry; for fields not shown call a read tool again.';
}

export interface CompactHistoryResultOptions {
  maxItems?: number;
  maxStringLength?: number;
  /** Keep the identity fields of entries beyond `maxItems` (default true). */
  keepIdentity?: boolean;
  /** Upper bound of the serialized result when it carries a `_history` marker (default: none). */
  maxChars?: number;
}

/**
 * Compacts a tool result of an earlier turn. Without anything to reduce the
 * output is `compactToolOutput(value)`, byte for byte, apart from the hint
 * of an overview's `_result` marker, which then says the handle expired.
 *
 * The dominant array (the largest reached through object properties, or a
 * list result itself) keeps its first `maxItems` entries complete; the
 * other entries keep only their identity fields (`id`, `uuid`, `key`,
 * `slug`, `code`, `name`, `title`, `label`, `displayName`; scalars, at most
 * 200 characters per field, a longer name clipped to 60), so every id stays
 * with its own name. An entry without a recognised id (`id`, `uuid`, `key`,
 * `slug`, `code`) keeps every id-like field instead (`playlist_id`,
 * `ownerId`; `idLikeFieldsOf`), on every level below. A `_history` marker says what was reduced. Nested
 * arrays keep the earlier treatment (first entries plus a count).
 *
 * Within `maxChars` things give way in this order: complete entries are
 * reduced to their identity, last first; then every entry keeps only its
 * first id field and its first name field; then names are clipped to 60
 * characters (marked `…[clipped]`); then the trailing entries are left out
 * (the marker counts them). An entry with an id and a name keeps both.
 * When not even the marker fits, the earlier compaction is returned and
 * the caller sends the turn as text.
 */
export function compactHistoryResult(value: unknown, options: CompactHistoryResultOptions = {}): unknown {
  const limits: Limits = {
    maxItems: options.maxItems ?? HISTORY_DEFAULTS.maxItems,
    maxStringLength: options.maxStringLength ?? HISTORY_DEFAULTS.maxStringLength,
  };
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  const legacy = withExpiredHandle(compactValue(value, 0, limits));
  if (options.keepIdentity === false) return legacy;

  const rootArray = Array.isArray(value);
  if (!rootArray && !isPlainObject(value)) return legacy;
  if (!rootArray && Object.prototype.hasOwnProperty.call(value, HISTORY_MARKER_KEY)) return legacy;
  const route = rootArray ? [] : dominantArrayRoute(value as Record<string, unknown>, OWN_MARKERS);
  if (!route || route.length >= MAX_COMPACT_DEPTH) return legacy;
  let entries: unknown = value;
  for (const key of route) entries = (entries as Record<string, unknown>)[key];
  if (!Array.isArray(entries)) return legacy;
  const source: unknown[] = entries;
  const length = source.length;

  // Id-like keys of entries without a recognised identifier, in the order they first occur.
  const idLikeSeen = new Set<string>();
  for (const entry of source) for (const key of idLikeFieldsOf(entry, IDENTITY_ID_KEYS)) idLikeSeen.add(key);
  const idLikeOrder = [...idLikeSeen];
  // Identity per entry on each level, with prefix sums of their sizes and counts.
  const forms = (['all', 'pair', 'clipped'] as const).map((level) => {
    const sizes = [0];
    const counts = [0];
    const keys = new Set<string>();
    let clipped = false;
    for (const entry of source) {
      const fields = identityOf(entry, level);
      for (const [key] of fields) keys.add(key);
      clipped ||= isClipped(fields);
      sizes.push(sizes.at(-1)! + (fields.length > 0 ? serializedLength(objectOf(fields)) : 0));
      counts.push(counts.at(-1)! + (fields.length > 0 ? 1 : 0));
    }
    return { level, sizes, counts, clipped, keys: orderedKeys(keys, idLikeOrder) };
  });
  if (forms[0]!.counts[length] === 0) return legacy;
  const fullCount = Math.min(limits.maxItems, length);
  // Nothing beyond the complete entries to keep: the earlier compaction, while it fits.
  const identityBeyond = forms[0]!.counts[length]! > forms[0]!.counts[fullCount]!;
  if (!identityBeyond && serializedLength(legacy) <= maxChars) return legacy;

  const fullEntries = source.slice(0, fullCount).map((entry) => compactValue(entry, route.length + 1, limits));
  const fullSizes = [0];
  for (const entry of fullEntries) fullSizes.push(fullSizes.at(-1)! + serializedLength(entry));

  // Everything but the array, compacted as before; the array is set in afterwards.
  const base = withExpiredHandle(compactValue(rootArray ? [] : withArrayAt(value as Record<string, unknown>, route, []), 0, limits));
  const output = (rootArray ? { data: base } : base) as Record<string, unknown>;
  const field = rootArray ? 'data' : route.join('.');
  const baseSize = serializedLength(output);
  const total = reportedTotal(value, field, length);

  type Plan = { full: number; form: (typeof forms)[number]; end: number };
  const markerOf = (plan: Plan, keys: ReadonlyArray<string>, clipped: boolean): HistoryMarker => {
    const showing = plan.full + plan.form.counts[plan.end]! - plan.form.counts[plan.full]!;
    return { field, showing, full: plan.full, total, keys: [...keys], hint: markerHint(field, showing, plan.full, total, keys, clipped) };
  };
  // Exact but for `keys` and the clipped note, taken over all entries (at least what the plan keeps).
  const sizeOf = (plan: Plan): number => {
    const reduced = plan.form.counts[plan.end]! - plan.form.counts[plan.full]!;
    const present = plan.full + reduced;
    const array = 2 + fullSizes[plan.full]! + plan.form.sizes[plan.end]! - plan.form.sizes[plan.full]! + Math.max(0, present - 1);
    return baseSize - 2 + array + 1 + MARKER_LENGTH + 1 + serializedLength(markerOf(plan, plan.form.keys, plan.form.clipped));
  };
  const largest = (low: number, high: number, fits: (count: number) => boolean): number => {
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  const [all, pair, clipped] = forms as [Plan['form'], Plan['form'], Plan['form']];
  let plan: Plan | undefined;
  if (sizeOf({ full: 0, form: all, end: length }) <= maxChars) {
    // Complete entries give way first, the last of them first.
    const full = largest(0, fullCount, (count) => sizeOf({ full: count, form: all, end: length }) <= maxChars);
    plan = { full, form: all, end: length };
  } else if (sizeOf({ full: 0, form: pair, end: length }) <= maxChars) {
    plan = { full: 0, form: pair, end: length };
  } else if (sizeOf({ full: 0, form: clipped, end: length }) <= maxChars) {
    plan = { full: 0, form: clipped, end: length };
  } else if (sizeOf({ full: 0, form: clipped, end: 0 }) <= maxChars) {
    // Fewer entries, each still with its id and its name.
    const end = largest(0, length, (count) => sizeOf({ full: 0, form: clipped, end: count }) <= maxChars);
    plan = { full: 0, form: clipped, end };
  }
  if (!plan) return legacy;

  const array: unknown[] = fullEntries.slice(0, plan.full);
  const kept = new Set<string>();
  let anyClipped = false;
  for (let index = plan.full; index < plan.end; index += 1) {
    const fields = identityOf(source[index], plan.form.level);
    if (fields.length === 0) continue;
    for (const [key] of fields) kept.add(key);
    anyClipped ||= isClipped(fields);
    array.push(objectOf(fields));
  }
  let holder = output;
  for (const key of (rootArray ? ['data'] : route).slice(0, -1)) holder = holder[key] as Record<string, unknown>;
  setOwn(holder, rootArray ? 'data' : route.at(-1)!, array);
  setOwn(output, HISTORY_MARKER_KEY, markerOf(plan, orderedKeys(kept, idLikeOrder), anyClipped));
  return output;
}

/** A shallow copy of `root` whose objects along `route` are copied and whose array there is `replacement`. */
function withArrayAt(root: Record<string, unknown>, route: ReadonlyArray<string>, replacement: unknown[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(root)) setOwn(copy, key, root[key]);
  const [first, ...rest] = route;
  setOwn(copy, first!, rest.length === 0 ? replacement : withArrayAt(root[first!] as Record<string, unknown>, rest, replacement));
  return copy;
}

/** The total the result's own marker reports for the same array, else its length. */
function reportedTotal(value: unknown, field: string, length: number): number {
  if (!isPlainObject(value)) return length;
  const truncated = value._truncated;
  if (isPlainObject(truncated) && truncated.field === field && truncated.showing === length
    && typeof truncated.total === 'number' && truncated.total >= length) return truncated.total;
  const overview = value._result;
  if (isPlainObject(overview) && overview.showing === length
    && typeof overview.total === 'number' && overview.total >= length) return overview.total;
  return length;
}

/** Replaces the hint of an overview's `_result` marker (in a compacted copy): its handle has expired. */
function withExpiredHandle(compacted: unknown): unknown {
  if (!isPlainObject(compacted)) return compacted;
  const marker = compacted._result;
  if (!isPlainObject(marker) || typeof marker.id !== 'string' || typeof marker.hint !== 'string') return compacted;
  if (!marker.id.startsWith(READ_RESULT_ID_PREFIX) && !marker.id.startsWith(WRITE_RESULT_ID_PREFIX)) return compacted;
  setOwn(marker, 'hint', expiredHandleHint(marker.id));
  return compacted;
}
