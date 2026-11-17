/**
 * The overview the model gets instead of a large tool result that has a
 * result handle. Breadth first: every entry of the dominant array stays
 * visible with its small fields, the largest fields (measured across all
 * entries) are left out first, and only when the small fields alone do not
 * fit is the number of entries reduced. Pure and deterministic.
 */
import { READ_RESULT_TOOL_NAME } from '../../contracts/result-handle.js';
import { formatResultPath, setOwn, type PathStep } from './result-paths.js';

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
  /** Fields left out, largest first, with their approximate serialized size across all entries. */
  omitted?: Array<{ path: string; approxChars: number }>;
  /** Further fields left out that `omitted` does not list. */
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
/** Entry fields that name an entry stay as long as they are small. */
const IDENTITY_KEY = /^(id|uuid|key|slug|code|name|title|label|displayName|.+Id|.+_id|.+ID)$/;
const MAX_IDENTITY_FIELD_CHARS = 200;

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
  return found.sort((left, right) => right.size - left.size || left.route.join('.').localeCompare(right.route.join('.')));
}

/** Object keys from the root to the dominant array (the largest one reached through object properties). */
export function dominantArrayRoute(root: Record<string, unknown>): string[] | undefined {
  return findArrays(root as JsonObject)[0]?.route;
}

interface Candidate {
  /** Steps from the root; entry fields start with the dominant route and `[]`. */
  steps: PathStep[];
  path: string;
  size: number;
  /** Set for entry fields: the entry's own field it belongs to. */
  entryKey?: string;
}

/** Field paths of the root and of every entry, with their aggregate serialized size. */
function collectCandidates(root: JsonObject, dominant: DominantArray | undefined): Candidate[] {
  const byPath = new Map<string, Candidate>();
  const add = (steps: PathStep[], size: number, entryKey?: string) => {
    const path = formatResultPath(steps);
    const known = byPath.get(path);
    if (known) known.size += size;
    else byPath.set(path, { steps, path, size, ...(entryKey !== undefined ? { entryKey } : {}) });
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
        add(childSteps, fieldSize(key, value), owner);
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
      else {
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

/** A copy of `value` without the removed paths; untouched subtrees are shared. */
function without(value: Json, node: RemovalNode | undefined): Json {
  if (!node) return value;
  if (Array.isArray(value)) return node.each ? value.map((entry) => without(entry, node.each)) : value;
  if (!isPlainObject(value) || node.keys.size === 0) return value;
  const output: JsonObject = {};
  for (const key of Object.keys(value)) {
    const child = node.keys.get(key);
    if (child?.remove) continue;
    setOwn(output, key, without(value[key]!, child));
  }
  return output;
}

function hintOf(options: BuildResultOverviewOptions, shown: string, omittedFields: boolean): string {
  const first = `Overview of a large result${shown}${omittedFields ? ', without the fields listed in omitted' : ''}.`;
  const read = ` Read omitted fields or further entries with ${READ_RESULT_TOOL_NAME} (resultId = _result.id; fields, offset, limit) during this turn.`;
  const expired = options.readOnly
    ? ` If ${READ_RESULT_TOOL_NAME} answers result_expired, call the original tool again.`
    : ` The tool has already run: if ${READ_RESULT_TOOL_NAME} answers result_expired, do not call it again;`
      + ' tell the user the remaining details are no longer available, or look them up with a read tool.';
  return first + read + expired;
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

  const candidates = collectCandidates(root, dominant)
    .sort((left, right) => right.size - left.size || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .slice(0, MAX_CANDIDATES);

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
  const droppable = candidates.filter((candidate) => candidate.entryKey === undefined || !keep.has(candidate.entryKey));

  const arraysMarker: Record<string, number> = {};
  for (const array of arrays.slice(0, MAX_LISTED_ARRAYS)) setOwn(arraysMarker, listedPath(array.route.join('.')), array.entries.length);

  const build = (dropCount: number, entryCount: number): { output: Record<string, unknown>; size: number } => {
    const dropped = droppable.slice(0, dropCount);
    const trie = removalTrie(dropped.map((candidate) => candidate.steps));
    let data = without(root, trie) as JsonObject;
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
    const omitted = dropped.slice(0, MAX_LISTED_OMITTED).map((candidate) => ({
      path: listedPath(candidate.path),
      approxChars: approx(candidate.size),
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
      ...(dropped.length > MAX_LISTED_OMITTED ? { omittedMore: dropped.length - MAX_LISTED_OMITTED } : {}),
      hint: hintOf(options, shown, dropped.length > 0),
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
