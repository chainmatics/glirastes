/**
 * The overview the model gets instead of a large tool result that has a
 * result handle. Breadth first: every entry of the dominant array stays
 * visible with its small fields, and only when the small fields alone do not
 * fit is the number of entries reduced. Fields are left out by the value
 * they carry for the model, measured in the data across all entries: first
 * nested arrays and objects, foreign keys, opaque ids, URLs and long texts,
 * then other strings, last booleans, numbers, null and short enum-like
 * labels; within each class the largest first. Pure and deterministic.
 */
import { READ_RESULT_TOOL_NAME } from '../../contracts/result-handle.js';
import { formatResultPath, isSelectablePath, setOwn, type PathStep } from './result-paths.js';

/** The `_result` marker of an overview. */
export interface ResultOverviewMarker {
  /** The handle `read_result` reads from (`ro_…` or `rw_…`). */
  id: string;
  /** Arrays reached through object properties and their lengths (up to five, dominant first). */
  arrays?: Record<string, number>;
  /** Entries of the dominant array in this overview. */
  showing?: number;
  /** Entries the dominant array has. */
  total?: number;
  /**
   * Fields left out, largest first, with their approximate serialized size
   * across all entries. A nested object whose fields were all left out is
   * listed once by its own path (and removed from the entries instead of
   * staying as `{}`). Every path is a valid `fields` path of `read_result`
   * that reads exactly that field: a field whose path cannot be written so
   * (a key that is empty or holds `.`, `[` or `]`, a path over 120
   * characters) is not listed, only counted in `omittedMore`.
   */
  omitted?: Array<{ path: string; approxChars: number }>;
  /** Further left-out fields (or parents) that `omitted` does not list: beyond twenty, or not selectable by path. */
  omittedMore?: number;
  hint: string;
}

export interface BuildResultOverviewOptions {
  id: string;
  /** Upper bound of the serialized overview. */
  maxChars: number;
  /** Whether the origin tool only reads (decides the `result_expired` instruction). */
  readOnly: boolean;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const PROTECTED_KEYS: ReadonlySet<string> = new Set(['success', 'uiAction']);
const MARKER_KEY = '_result';
/** Nested objects are measured down to this depth (an entry's own fields are depth 1). */
const MAX_FIELD_DEPTH = 3;
/** At most this many distinct field paths are considered for leaving out (the largest). */
const MAX_CANDIDATES = 500;
const MAX_LISTED_OMITTED = 20;
const MAX_LISTED_ARRAYS = 5;
const MAX_LISTED_PATH_CHARS = 120;
/** An entry's own fields that name it stay as long as they are small. Foreign keys (`folderId`) do not. */
const IDENTITY_KEY = /^(id|uuid|key|slug|code|name|title|label|displayName)$/;
const MAX_IDENTITY_FIELD_CHARS = 200;
/**
 * A field that refers to another record (`folderId`, `tenant_id`,
 * `brandKitIDs`), not a word ending in "ID" (`VALID`, `COVID`).
 */
const FOREIGN_KEY = /^(?:.*[a-z0-9_](?:Id|ID)|.+_id)s?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|data:|\/\/)/i;
/** Long tokens with letters and digits (cuid, nanoid, base64 ids). */
const TOKEN = /^(?=[^\s]*\d)(?=[^\s]*[a-z])[A-Za-z0-9_-]{20,}$/i;
/** Strings longer than this (on average) are texts, not labels. */
const MAX_LABEL_CHARS = 32;
/** Strings longer than this (on average) rank with the opaque values. */
const LONG_TEXT_CHARS = 64;
/** Distinct short strings tracked per field to tell enum-like labels. */
const MAX_TRACKED_DISTINCT = 64;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** Approximate size: tens below 1,000, else two significant digits. */
function approx(size: number): number {
  if (size < 1_000) return Math.max(10, Math.round(size / 10) * 10);
  const magnitude = 10 ** (Math.floor(Math.log10(size)) - 1);
  return Math.round(size / magnitude) * magnitude;
}

function listedPath(text: string): string {
  return text.length > MAX_LISTED_PATH_CHARS ? `${text.slice(0, MAX_LISTED_PATH_CHARS - 1)}…` : text;
}

interface DominantArray {
  /** Object keys from the root to the array. */
  route: string[];
  entries: Json[];
}

/** Arrays reached through object properties only (not inside arrays), largest first. */
function findArrays(root: JsonObject): Array<{ route: string[]; entries: Json[]; size: number }> {
  const found: Array<{ route: string[]; entries: Json[]; size: number }> = [];
  const visit = (object: JsonObject, route: string[]): void => {
    for (const key of Object.keys(object)) {
      if (route.length === 0 && (PROTECTED_KEYS.has(key) || key === MARKER_KEY)) continue;
      const value = object[key]!;
      if (Array.isArray(value)) {
        if (value.length > 0) found.push({ route: [...route, key], entries: value, size: serializedLength(value) });
      } else if (isPlainObject(value)) {
        visit(value, [...route, key]);
      }
    }
  };
  visit(root, []);
  // Code-unit order breaks ties: the same on every locale.
  return found.sort((left, right) => {
    const a = left.route.join('.');
    const b = right.route.join('.');
    return right.size - left.size || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/** Object keys from the root to the dominant array (the largest one reached through object properties). */
export function dominantArrayRoute(root: Record<string, unknown>): string[] | undefined {
  return findArrays(root as JsonObject)[0]?.route;
}

/** What the values of one field path look like across all entries. */
interface ValueStats {
  count: number;
  /** Non-empty arrays and objects (beyond the measured depth). */
  nested: number;
  strings: number;
  stringChars: number;
  /** UUIDs, long hex or tokens, URLs. */
  opaque: number;
  /** Distinct strings, while they are few and short; undefined once there are too many. */
  distinct: Set<string> | undefined;
}

interface Candidate {
  /** Steps from the root; entry fields start with the dominant route and `[]`. */
  steps: PathStep[];
  path: string;
  size: number;
  /** Set for entry fields: the entry's own field it belongs to. */
  entryKey?: string;
  stats: ValueStats;
  /** Steps before the field itself that belong to the dominant array or its route (never collapsed). */
  base: number;
}

function isOpaque(text: string): boolean {
  return UUID.test(text) || HEX.test(text) || URL_LIKE.test(text) || TOKEN.test(text);
}

function measure(stats: ValueStats, value: Json): void {
  stats.count += 1;
  if (Array.isArray(value) ? value.length > 0 : isPlainObject(value) && Object.keys(value).length > 0) {
    stats.nested += 1;
  } else if (typeof value === 'string') {
    stats.strings += 1;
    stats.stringChars += value.length;
    if (value.length <= 2_048 && isOpaque(value)) stats.opaque += 1;
    if (stats.distinct) {
      if (value.length > LONG_TEXT_CHARS) stats.distinct = undefined;
      else {
        stats.distinct.add(value);
        if (stats.distinct.size > MAX_TRACKED_DISTINCT) stats.distinct = undefined;
      }
    }
  }
}

/**
 * How much a field is worth to the model, by its values: 0 is left out
 * first (nested arrays and objects, foreign keys, opaque ids and URLs, long
 * texts), then 1 (other strings), last 2 (booleans, numbers, null and short
 * labels with few distinct values, e.g. a status).
 */
function valueRank(candidate: Candidate): 0 | 1 | 2 {
  const last = candidate.steps[candidate.steps.length - 1];
  if (last?.kind === 'key' && FOREIGN_KEY.test(last.key)) return 0;
  const stats = candidate.stats;
  if (stats.nested > 0) return 0;
  if (stats.strings === 0) return 2;
  if (stats.opaque * 2 >= stats.strings) return 0;
  const average = stats.stringChars / stats.strings;
  if (average > LONG_TEXT_CHARS) return 0;
  const enumLike = stats.distinct !== undefined && stats.distinct.size <= Math.max(2, Math.floor(Math.sqrt(stats.count)));
  return average <= MAX_LABEL_CHARS && enumLike ? 2 : 1;
}

/** Field paths of the root and of every entry, with their aggregate serialized size. */
function collectCandidates(root: JsonObject, dominant: DominantArray | undefined): Candidate[] {
  const byPath = new Map<string, Candidate>();
  const entryBase = dominant ? dominant.route.length + 1 : 0;
  const add = (steps: PathStep[], size: number, value: Json, entry: boolean, entryKey?: string) => {
    const path = formatResultPath(steps);
    let known = byPath.get(path);
    if (known) known.size += size;
    else {
      known = {
        steps, path, size, ...(entryKey !== undefined ? { entryKey } : {}),
        stats: { count: 0, nested: 0, strings: 0, stringChars: 0, opaque: 0, distinct: new Set() },
        base: entry ? entryBase : routeDepth(dominant, steps),
      };
      byPath.set(path, known);
    }
    measure(known.stats, value);
  };
  const fieldSize = (key: string, value: Json) => serializedLength(key) + 1 + serializedLength(value) + 1;
  /** `entry`: walking an entry of the dominant array; `entryKey`: the entry's own field above. */
  const walk = (
    object: JsonObject,
    steps: PathStep[],
    depth: number,
    onRoute: (key: string) => 'skip' | 'descend' | undefined,
    entry: boolean,
    entryKey?: string,
  ): void => {
    for (const key of Object.keys(object)) {
      const decision = onRoute(key);
      if (decision === 'skip') continue;
      const value = object[key]!;
      const childSteps: PathStep[] = [...steps, { kind: 'key', key }];
      const owner = entry ? entryKey ?? key : undefined;
      if (decision === 'descend' && isPlainObject(value)) {
        walk(value, childSteps, depth + 1, routeStep(dominant, childSteps), entry, owner);
      } else if (isPlainObject(value) && depth < MAX_FIELD_DEPTH && Object.keys(value).length > 0) {
        walk(value, childSteps, depth + 1, () => undefined, entry, owner);
      } else {
        add(childSteps, fieldSize(key, value), value, entry, owner);
      }
    }
  };
  walk(root, [], 1, (key) => (PROTECTED_KEYS.has(key) || key === MARKER_KEY ? 'skip' : routeStep(dominant, [])(key)), false);
  if (dominant) {
    const entrySteps: PathStep[] = [...dominant.route.map((key): PathStep => ({ kind: 'key', key })), { kind: 'each' }];
    for (const entry of dominant.entries) {
      if (isPlainObject(entry)) walk(entry, entrySteps, 1, () => undefined, true);
    }
  }
  return [...byPath.values()];
}

/** How many leading steps of a root field are objects on the route to the dominant array. */
function routeDepth(dominant: DominantArray | undefined, steps: PathStep[]): number {
  if (!dominant) return 0;
  let depth = 0;
  while (depth < steps.length - 1 && depth < dominant.route.length) {
    const step = steps[depth]!;
    if (step.kind !== 'key' || step.key !== dominant.route[depth]) break;
    depth += 1;
  }
  return depth;
}

/** How the root walk treats `key` below `steps`: the dominant array is skipped, its route descended. */
function routeStep(dominant: DominantArray | undefined, steps: PathStep[]): (key: string) => 'skip' | 'descend' | undefined {
  return (key) => {
    if (!dominant || steps.length >= dominant.route.length) return undefined;
    const onRoute = steps.every((step, index) => step.kind === 'key' && step.key === dominant.route[index]);
    if (!onRoute || dominant.route[steps.length] !== key) return undefined;
    return steps.length + 1 === dominant.route.length ? 'skip' : 'descend';
  };
}

interface RemovalNode {
  remove: boolean;
  keys: Map<string, RemovalNode>;
  each?: RemovalNode;
}

function removalTrie(paths: ReadonlyArray<ReadonlyArray<PathStep>>): RemovalNode {
  const root: RemovalNode = { remove: false, keys: new Map() };
  for (const steps of paths) {
    let node = root;
    for (const step of steps) {
      if (step.kind === 'each') node = node.each ??= { remove: false, keys: new Map() };
      else if (step.kind === 'key') {
        let next = node.keys.get(step.key);
        if (!next) {
          next = { remove: false, keys: new Map() };
          node.keys.set(step.key, next);
        }
        node = next;
      }
    }
    node.remove = true;
  }
  return root;
}

/** Returned for an object property whose fields were all removed. */
const SHELL = Symbol('shell');

/**
 * A copy of `value` without the removed paths; untouched subtrees are
 * shared. An object property whose fields were all removed is removed too
 * (no `{}` shell); an object that was empty already, an array entry and the
 * root stay.
 */
function without(value: Json, node: RemovalNode | undefined, property = false): Json | typeof SHELL {
  if (!node) return value;
  if (Array.isArray(value)) return node.each ? value.map((entry) => without(entry, node.each) as Json) : value;
  if (!isPlainObject(value) || node.keys.size === 0) return value;
  const output: JsonObject = {};
  let kept = 0;
  const keys = Object.keys(value);
  for (const key of keys) {
    const child = node.keys.get(key);
    if (child?.remove) continue;
    const copy = without(value[key]!, child, true);
    if (copy === SHELL) continue;
    setOwn(output, key, copy);
    kept += 1;
  }
  return property && kept === 0 && keys.length > 0 ? SHELL : output;
}

function hintOf(options: BuildResultOverviewOptions, shown: string, omittedFields: boolean, unnamed: boolean): string {
  const first = `Overview${shown}${omittedFields ? ', without the fields in omitted' : ''}.`;
  const infer = omittedFields ? ' Do not infer missing fields from other fields; read them or say they are not known.' : '';
  const read = ` Read more with ${READ_RESULT_TOOL_NAME} in this turn (resultId = _result.id; fields as in omitted, `
    + '"[]" every entry, "[2]" one; offset, limit).';
  const odd = unnamed ? ' Fields with unusual key names are only counted (omittedMore); read them with their parent.' : '';
  const expired = options.readOnly
    ? ' On result_expired call the original tool again.'
    : ' On result_expired do not call the tool again (it has run); say the details are no longer available or use a read tool.';
  return first + infer + read + odd + expired;
}

/**
 * Builds the overview of `value` (a successful record result) within
 * `options.maxChars`, with a `_result` marker. `success` and `uiAction` are
 * never altered. Returns undefined when not even the overview without any
 * entry and without every field that may be left out fits (the caller then
 * cuts the result instead). The output shares no objects with `value`.
 */
export function buildResultOverview(
  value: Record<string, unknown>,
  options: BuildResultOverviewOptions,
): Record<string, unknown> | undefined {
  const root = value as JsonObject;
  const arrays = findArrays(root);
  const largest = arrays[0];
  const dominant: DominantArray | undefined = largest ? { route: largest.route, entries: largest.entries } : undefined;
  const dominantPath = dominant ? dominant.route.join('.') : undefined;

  const byPath = (left: Candidate, right: Candidate) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const all = collectCandidates(root, dominant);
  const candidates = [...all].sort((left, right) => right.size - left.size || byPath(left, right)).slice(0, MAX_CANDIDATES);

  // Fields that name an entry stay; without any, the smallest own field does.
  const objectEntries = dominant ? dominant.entries.filter(isPlainObject).length : 0;
  const ownFieldSize = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.entryKey === undefined) continue;
    ownFieldSize.set(candidate.entryKey, (ownFieldSize.get(candidate.entryKey) ?? 0) + candidate.size);
  }
  const keep = new Set([...ownFieldSize].filter(([key, size]) => (
    IDENTITY_KEY.test(key) && size / Math.max(1, objectEntries) <= MAX_IDENTITY_FIELD_CHARS
  )).map(([key]) => key));
  if (keep.size === 0 && ownFieldSize.size > 0) {
    const smallest = [...ownFieldSize].sort((left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : 1))[0]!;
    keep.add(smallest[0]);
  }
  const rank = new Map(candidates.map((candidate) => [candidate, valueRank(candidate)]));
  // Low value first, within a class the largest first.
  const droppable = candidates
    .filter((candidate) => candidate.entryKey === undefined || !keep.has(candidate.entryKey))
    .sort((left, right) => rank.get(left)! - rank.get(right)! || right.size - left.size || byPath(left, right));

  // Parents (below the dominant array or its route) a field can be listed under, shallowest first.
  const parentsOf = new Map<Candidate, string[]>();
  const fieldsUnder = new Map<string, number>();
  /** Whether a path (a field or a parent) can be written so that `read_result` reads exactly it. */
  const selectable = new Map<string, boolean>();
  for (const candidate of all) {
    const parents: string[] = [];
    for (let length = candidate.base + 1; length <= candidate.steps.length; length += 1) {
      const steps = candidate.steps.slice(0, length);
      const path = length === candidate.steps.length ? candidate.path : formatResultPath(steps);
      if (!selectable.has(path)) selectable.set(path, isSelectablePath(steps, MAX_LISTED_PATH_CHARS));
      if (length < candidate.steps.length) parents.push(path);
    }
    parentsOf.set(candidate, parents);
    for (const path of [...parents, candidate.path]) fieldsUnder.set(path, (fieldsUnder.get(path) ?? 0) + 1);
  }
  /** Left-out fields, a parent whose fields were all left out listed once instead, largest first. */
  const omittedGroups = (dropped: Candidate[]): Array<{ path: string; size: number; selectable: boolean }> => {
    const droppedUnder = new Map<string, number>();
    for (const candidate of dropped) {
      for (const path of [...parentsOf.get(candidate)!, candidate.path]) droppedUnder.set(path, (droppedUnder.get(path) ?? 0) + 1);
    }
    const groups = new Map<string, number>();
    for (const candidate of dropped) {
      const parent = parentsOf.get(candidate)!.find((path) => droppedUnder.get(path) === fieldsUnder.get(path));
      const path = parent ?? candidate.path;
      groups.set(path, (groups.get(path) ?? 0) + candidate.size);
    }
    return [...groups].map(([path, size]) => ({ path, size, selectable: selectable.get(path) === true }))
      .sort((left, right) => right.size - left.size || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  };

  const arraysMarker: Record<string, number> = {};
  for (const array of arrays.slice(0, MAX_LISTED_ARRAYS)) setOwn(arraysMarker, listedPath(array.route.join('.')), array.entries.length);

  const build = (dropCount: number, entryCount: number): { output: Record<string, unknown>; size: number } => {
    const dropped = droppable.slice(0, dropCount);
    const trie = removalTrie(dropped.map((candidate) => candidate.steps));
    let data = without(root, trie) as JsonObject;
    const groups = omittedGroups(dropped);
    if (dominant && entryCount < dominant.entries.length) {
      // Cut the dominant array of the copy (its route was copied by `without` or is cut here).
      const cut = (object: JsonObject, depth: number): JsonObject => {
        const key = dominant.route[depth]!;
        const copy: JsonObject = {};
        for (const field of Object.keys(object)) setOwn(copy, field, object[field]);
        const current = object[key]!;
        setOwn(copy, key, depth + 1 === dominant.route.length
          ? (current as Json[]).slice(0, entryCount)
          : cut(current as JsonObject, depth + 1));
        return copy;
      };
      data = cut(data, 0);
    }
    // Only paths that read exactly the left-out field are listed; the others are counted.
    const omitted = groups.filter((group) => group.selectable).slice(0, MAX_LISTED_OMITTED).map((group) => ({
      path: group.path,
      approxChars: approx(group.size),
    }));
    const shown = dominant
      ? entryCount === dominant.entries.length
        ? `: all ${entryCount} entries of ${listedPath(dominantPath!)}`
        : `: ${entryCount} of ${dominant.entries.length} entries of ${listedPath(dominantPath!)}`
      : '';
    const marker: ResultOverviewMarker = {
      id: options.id,
      ...(Object.keys(arraysMarker).length > 0 ? { arrays: arraysMarker } : {}),
      ...(dominant ? { showing: entryCount, total: dominant.entries.length } : {}),
      ...(omitted.length > 0 ? { omitted } : {}),
      ...(groups.length > omitted.length ? { omittedMore: groups.length - omitted.length } : {}),
      hint: hintOf(options, shown, dropped.length > 0, groups.some((group) => !group.selectable)),
    };
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(root)) {
      if (key === MARKER_KEY) continue;
      if (PROTECTED_KEYS.has(key)) setOwn(output, key, root[key]);
      else if (hasOwn(data, key)) setOwn(output, key, data[key]);
    }
    setOwn(output, MARKER_KEY, marker);
    return { output, size: serializedLength(output) };
  };

  const total = dominant ? dominant.entries.length : 0;
  const fits = (dropCount: number, entryCount: number) => build(dropCount, entryCount).size <= options.maxChars;
  let chosen: { output: Record<string, unknown>; size: number } | undefined;
  if (fits(droppable.length, total)) {
    // The fewest fields left out (largest first) with every entry.
    let low = 0;
    let high = droppable.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(mid, total)) high = mid;
      else low = mid + 1;
    }
    chosen = build(low, total);
  } else if (dominant) {
    // Small fields alone do not fit: the most leading entries that do.
    let low = 0;
    let high = total;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(droppable.length, mid)) low = mid;
      else high = mid - 1;
    }
    const candidate = build(droppable.length, low);
    if (candidate.size <= options.maxChars) chosen = candidate;
  }
  if (!chosen || chosen.size > options.maxChars) return undefined;
  // Nothing of the stored result leaks out by reference.
  return JSON.parse(JSON.stringify(chosen.output)) as Record<string, unknown>;
}
