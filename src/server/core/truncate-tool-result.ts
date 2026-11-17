/**
 * Bounding tool results before they reach the model.
 *
 * `truncateToolResult` is a true upper bound: after it ran, the serialized
 * result of every successful record result is at most the limit (see the
 * documented exceptions on the function). It is pure, deterministic (the
 * loop-detection fingerprint hashes the result) and linear in the size of the
 * result per compaction round, with a small fixed number of rounds.
 */
import { DEFAULT_MAX_RESULT_CHARS } from '../../runtime/result-limit.js';

/** Input parameter names that page through a result; named in the hint of a read tool that has them. */
export const PAGINATION_PARAMETER_NAMES: ReadonlyArray<string> = [
  'page', 'limit', 'offset', 'cursor', 'pageSize', 'per_page', 'skip', 'take',
];

export interface TruncateToolResultOptions {
  /**
   * Whether the tool only reads. Only then does the hint offer to fetch the
   * next page or filter the request; otherwise (the default, since a write
   * tool called again would write again) it tells the model not to call the
   * tool again just to see more. `toolToAiTool` sets it: GET and HEAD
   * endpoint tools, and tools without a method that need no approval, read.
   */
  readOnly?: boolean;
  /**
   * The tool's input schema (a Zod object or a `createJsonSchemaLike`
   * schema). For a read tool its pagination-like parameters (`page`,
   * `limit`, `offset`, `cursor`, `pageSize`, `per_page`, `skip`, `take`) are
   * named in the hint so the model can fetch the next page.
   */
  inputSchema?: unknown;
  /** Pagination parameter names for the hint of a read tool; wins over `inputSchema`. */
  paginationParams?: ReadonlyArray<string>;
}

/** The `_truncated` marker added to a cut result. */
export interface TruncatedMarker {
  /** Dot path of the array that was cut (`data.items`); absent when no array was cut. */
  field?: string;
  /** Entries of `field` kept. */
  showing?: number;
  /** Entries `field` had. */
  total?: number;
  /** Up to five dot paths of fields that were clipped, replaced by a placeholder or left out. */
  compacted?: string[];
  /** Fields left out because their key alone is too long (never named). */
  omittedKeys?: number;
  /** What the model tells the user, and whether it may fetch more. */
  hint: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Holder = JsonObject | Json[];

interface PathNode {
  parent: PathNode | undefined;
  key: string | number;
}

/** Top-level keys that are never altered or removed. */
const PROTECTED_KEYS: ReadonlySet<string> = new Set(['success', 'uiAction']);
/** A string or container larger than this (serialized) may be clipped or replaced. */
const COMPACT_THRESHOLD = 120;
/** A key longer than this (serialized) is left out with its value. */
const MAX_KEY_CHARS = 120;
/** What a fully clipped string keeps, serialized. */
const CLIP_TARGET = 80;
/** Upper bound of a serialized container placeholder. */
const PLACEHOLDER_CHARS = 45;
const CLIP_SUFFIX = '…[clipped]';
const MAX_MARKER_PATHS = 5;
const MAX_MARKER_PATH_CHARS = 100;
const MAX_COMPACT_ROUNDS = 8;

function isContainer(value: unknown): value is Holder {
  return typeof value === 'object' && value !== null;
}

function isPlainObject(value: unknown): value is JsonObject {
  return isContainer(value) && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Sets an own data property, also for `__proto__`, which plain assignment would turn into the prototype. */
function setField(holder: Holder | Record<string, unknown>, key: string | number, value: unknown): void {
  if (Array.isArray(holder)) holder[key as number] = value as Json;
  else Object.defineProperty(holder, key, { value, writable: true, enumerable: true, configurable: true });
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function pathString(path: PathNode | undefined): string {
  const keys: Array<string | number> = [];
  for (let node = path; node; node = node.parent) keys.push(node.key);
  const text = keys.reverse().map(String).join('.');
  return text.length > MAX_MARKER_PATH_CHARS ? `${text.slice(0, MAX_MARKER_PATH_CHARS - 1)}…` : text;
}

/** Removes every property whose key alone is too long, at any depth; returns how many. */
function removeLongKeys(root: Json): number {
  let removed = 0;
  const stack: Json[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (Array.isArray(node)) {
      for (const value of node) if (isContainer(value)) stack.push(value);
    } else if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        if (key.length + 2 > MAX_KEY_CHARS || serializedLength(key) > MAX_KEY_CHARS) {
          delete node[key];
          removed += 1;
        } else {
          const value = node[key]!;
          if (isContainer(value)) stack.push(value);
        }
      }
    }
  }
  return removed;
}

/** Names of the top-level input properties of a Zod object or a JSON-schema-backed schema. */
function inputPropertyNames(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const carrier = schema as { jsonSchema?: unknown; shape?: unknown; _def?: { shape?: unknown } };
  if (isPlainObject(carrier.jsonSchema) && isPlainObject(carrier.jsonSchema.properties)) {
    return Object.keys(carrier.jsonSchema.properties);
  }
  try {
    if (carrier.shape && typeof carrier.shape === 'object') return Object.keys(carrier.shape);
    const shape = carrier._def?.shape;
    if (typeof shape === 'function') {
      const value: unknown = (shape as () => unknown)();
      if (value && typeof value === 'object') return Object.keys(value);
    }
  } catch {
    // An exotic schema: no parameter names, the hint stays generic.
  }
  return [];
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '');
}

const PAGINATION_NORMALIZED = new Set(PAGINATION_PARAMETER_NAMES.map(normalizedName));

function paginationParamsOf(options: TruncateToolResultOptions | undefined): string[] {
  if (options?.paginationParams) return [...new Set(options.paginationParams)].sort();
  return inputPropertyNames(options?.inputSchema)
    .filter((name) => PAGINATION_NORMALIZED.has(normalizedName(name)))
    .sort();
}

/** A prefix of `text` that serializes, with the clip suffix, to at most `target` characters. */
function clipString(text: string, serialized: number, target: number): string {
  let keep: number;
  if (serialized === text.length + 2) {
    // Nothing escaped: one character is one serialized character.
    keep = Math.min(text.length, Math.max(0, target - 2 - CLIP_SUFFIX.length));
  } else {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (serializedLength(text.slice(0, mid) + CLIP_SUFFIX) <= target) low = mid;
      else high = mid - 1;
    }
    keep = low;
  }
  // Never split a surrogate pair.
  const last = text.charCodeAt(keep - 1);
  if (keep > 0 && last >= 0xd800 && last <= 0xdbff) keep -= 1;
  return text.slice(0, keep) + CLIP_SUFFIX;
}

function placeholderOf(value: Holder): string {
  return Array.isArray(value)
    ? `[omitted: array with ${value.length} items]`
    : `[omitted: object with ${Object.keys(value).length} keys]`;
}

interface Candidate {
  holder: Holder;
  key: string | number;
  size: number;
  order: number;
  isString: boolean;
  path: PathNode;
}

/**
 * One walk: the serialized size of `node`, and the strings and containers
 * below it that may be clipped or replaced (larger than the threshold, not
 * excluded). A container is a candidate only when all its children are small,
 * so candidates never nest. `node` itself is never a candidate.
 */
function collectCandidates(
  node: Holder,
  path: PathNode | undefined,
  excluded: ReadonlySet<object>,
  out: Candidate[],
): { size: number; allSmall: boolean } {
  let allSmall = true;
  const visit = (value: Json, key: string | number): number => {
    const childPath: PathNode = { parent: path, key };
    let size: number;
    if (isContainer(value)) {
      const child = collectCandidates(value, childPath, excluded, out);
      size = child.size;
      if (child.allSmall && size > COMPACT_THRESHOLD && !excluded.has(value)) {
        out.push({ holder: node, key, size, order: out.length, isString: false, path: childPath });
      }
    } else {
      size = serializedLength(value);
      if (typeof value === 'string' && size > COMPACT_THRESHOLD) {
        out.push({ holder: node, key, size, order: out.length, isString: true, path: childPath });
      }
    }
    if (size > COMPACT_THRESHOLD) allSmall = false;
    return size;
  };
  if (Array.isArray(node)) {
    let size = 2 + Math.max(0, node.length - 1);
    for (let index = 0; index < node.length; index += 1) size += visit(node[index]!, index);
    return { size, allSmall };
  }
  const keys = Object.keys(node);
  let size = 2 + Math.max(0, keys.length - 1);
  for (const key of keys) size += serializedLength(key) + 1 + visit(node[key]!, key);
  return { size, allSmall };
}

interface CompactInfo {
  /** Distinct paths clipped, replaced or left out, in the order they were changed. */
  seen: Set<string>;
  omittedKeys: number;
}

function copyInfo(info: CompactInfo): CompactInfo {
  return { seen: new Set(info.seen), omittedKeys: info.omittedKeys };
}

/**
 * Clips strings and replaces containers below `scope` in place until
 * `total(scopeSize) <= limit` or nothing is left to compact. Each round walks
 * the tree once and applies its whole batch: the smallest candidate that
 * alone removes the excess, else the largest candidates until their savings
 * cover it.
 */
function compactInPlace(
  scope: Holder,
  scopePath: PathNode | undefined,
  excluded: ReadonlySet<object>,
  total: (scopeSize: number) => number,
  limit: number,
  info: CompactInfo,
): boolean {
  for (let round = 0; round < MAX_COMPACT_ROUNDS; round += 1) {
    const candidates: Candidate[] = [];
    let scopeSize = collectCandidates(scope, scopePath, excluded, candidates).size;
    const now = total(scopeSize);
    if (now <= limit) return true;
    if (candidates.length === 0) return false;
    // Room for the marker, which grows by the paths and the count this round adds.
    const pending = Math.max(0, MAX_MARKER_PATHS - info.seen.size);
    const needed = now - limit + pending * (MAX_MARKER_PATH_CHARS + 3) + 16;
    const saving = (candidate: Candidate): number => candidate.size - (candidate.isString ? CLIP_TARGET : PLACEHOLDER_CHARS);
    let covering: Candidate | undefined;
    for (const candidate of candidates) {
      if (saving(candidate) >= needed && (!covering || candidate.size < covering.size)) covering = candidate;
    }
    const chosen: Array<{ candidate: Candidate; target: number }> = [];
    if (covering) {
      chosen.push({ candidate: covering, target: covering.size - needed });
    } else {
      let covered = 0;
      const bySize = [...candidates].sort((left, right) => right.size - left.size || left.order - right.order);
      for (const candidate of bySize) {
        chosen.push({ candidate, target: CLIP_TARGET });
        covered += saving(candidate);
        if (covered >= needed) break;
      }
      chosen.sort((left, right) => left.candidate.order - right.candidate.order);
    }
    for (const { candidate, target } of chosen) {
      const value = (candidate.holder as Record<string | number, Json>)[candidate.key]!;
      const replacement = typeof value === 'string'
        ? clipString(value, candidate.size, Math.max(CLIP_TARGET, target))
        : placeholderOf(value as Holder);
      setField(candidate.holder, candidate.key, replacement);
      scopeSize -= candidate.size - serializedLength(replacement);
      info.seen.add(pathString(candidate.path));
    }
    if (total(scopeSize) <= limit) return true;
  }
  return false;
}

/** The largest non-empty array reached through object properties only (not inside arrays). */
function largestArray(root: JsonObject): { holder: JsonObject; key: string; route: JsonObject[]; path: string[]; size: number } | undefined {
  let best: { holder: JsonObject; key: string; route: JsonObject[]; path: string[]; size: number } | undefined;
  const visit = (object: JsonObject, route: JsonObject[], path: string[]): void => {
    for (const key of Object.keys(object)) {
      const value = object[key]!;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        const size = serializedLength(value);
        if (!best || size > best.size) best = { holder: object, key, route, path: [...path, key], size };
      } else if (isPlainObject(value)) {
        visit(value, [...route, value], [...path, key]);
      }
    }
  };
  visit(root, [], []);
  return best;
}

/**
 * Bounds a tool result for the model.
 *
 * Results whose serialization is within `maxChars` (default 16,000) are
 * returned unchanged, as are non-objects, unserializable values (a cycle, a
 * BigInt) and failure results (`success: false`, bounded elsewhere). The input
 * is never mutated. Otherwise, on a copy:
 *
 * 1. Fields whose key alone is longer than 120 characters are left out at any
 *    depth (counted in `omittedKeys`, never named).
 * 2. The array with the largest serialized size, at any depth reached
 *    through object properties (`data.items`), is cut to the most leading
 *    entries that fit (binary search). If not even one entry fits, the first
 *    entry is compacted (long strings clipped, nested objects and arrays
 *    replaced by short placeholders); if it still does not fit, no entry is
 *    kept. Other fields (`meta`) are kept; if they alone are too large they
 *    are compacted first.
 * 3. Without an array large enough to remove the excess, long strings are
 *    clipped and the largest fields replaced by placeholders. If even that
 *    is too large (thousands of fields), the leading top-level fields that
 *    fit are kept and the rest left out.
 * 4. A `_truncated` marker is added: `field`, `showing`, `total` when an
 *    array was cut, `compacted` with up to five changed paths, `omittedKeys`,
 *    and a `hint` for the model. For a read tool (`options.readOnly`) the
 *    hint says "showing N of M" and offers filtering or the next page, naming
 *    the tool's paging parameters; otherwise it says the tool must not be
 *    called again just to see more and that the user is told the result was
 *    shortened.
 *
 * `success` and `uiAction` are never altered or removed. The bound therefore
 * holds except when `success`, `uiAction` and the marker alone exceed
 * `maxChars` (with an accepted `maxResultChars`, from 1,000, only an
 * oversized `uiAction` can do that); the result then keeps them and exceeds
 * it. A root array that has to be cut is returned as `{ data: [...],
 * _truncated }`. The output is deterministic for a given input.
 */
export function truncateToolResult(
  result: unknown,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS,
  options?: TruncateToolResultOptions,
): unknown {
  if (typeof result !== 'object' || result === null) return result;
  const rootArray = Array.isArray(result);
  if (!rootArray && (result as Record<string, unknown>).success === false) return result;

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    // Not serializable (a cycle, a BigInt); the transport fails on it either way.
    return result;
  }
  if (serialized === undefined || serialized.length <= maxChars) return result;

  const original: Record<string, unknown> = rootArray ? { data: result } : result as Record<string, unknown>;
  // A fresh copy this function owns and changes in place.
  const root = JSON.parse(rootArray ? `{"data":${serialized}}` : serialized) as JsonObject;
  const keyOrder = Object.keys(root).filter((key) => key !== '_truncated');
  for (const key of [...PROTECTED_KEYS, '_truncated']) delete root[key];

  const readOnly = options?.readOnly === true;
  const params = readOnly ? paginationParamsOf(options) : [];
  const info: CompactInfo = { seen: new Set(), omittedKeys: removeLongKeys(root) };
  const rootFields = Object.keys(root).length;

  interface ArrayState { field: string; showing: number; total: number }
  const markerOf = (array: ArrayState | undefined, state: CompactInfo = info, dropped: ReadonlyArray<string> = []): TruncatedMarker => {
    const paths: string[] = [];
    for (const path of state.seen) {
      if (paths.length >= MAX_MARKER_PATHS) break;
      paths.push(path);
    }
    for (const key of dropped) {
      if (paths.length >= MAX_MARKER_PATHS) break;
      paths.push(key);
    }
    const changed = state.seen.size + dropped.length + state.omittedKeys;
    const fieldsNote = changed > 0
      ? ` ${changed} field(s) were clipped, replaced by placeholders or left out${paths.length > 0 ? ' (see compacted)' : ''}.`
      : '';
    const first = array
      ? `Result cut to fit the size limit: showing ${array.showing} of ${array.total} entries of ${array.field}.${fieldsNote}`
      : `Result shortened to fit the size limit.${fieldsNote}`;
    const paging = params.length > 0
      ? `to fetch the next page with the parameters ${params.join(', ')}`
      : 'to fetch the rest in pages';
    const next = readOnly
      ? array
        ? ` Tell the user you are showing ${array.showing} of ${array.total}, and offer to filter the request or ${paging}.`
        : ` Tell the user the result is incomplete, and offer to filter the request or ${paging}.`
      : ' The tool has already run: do not call it again just to see more.'
        + ` Tell the user the result was shortened${array ? ` (showing ${array.showing} of ${array.total})` : ''}.`;
    return {
      ...(array ? { field: array.field, showing: array.showing, total: array.total } : {}),
      ...(paths.length > 0 ? { compacted: paths } : {}),
      ...(state.omittedKeys > 0 ? { omittedKeys: state.omittedKeys } : {}),
      hint: first + next,
    };
  };
  const build = (data: JsonObject, marker: TruncatedMarker): Record<string, unknown> => {
    const output: Record<string, unknown> = {};
    for (const key of keyOrder) {
      if (PROTECTED_KEYS.has(key)) setField(output, key, original[key]);
      else if (hasOwn(data, key)) setField(output, key, data[key]);
    }
    setField(output, '_truncated', marker);
    return output;
  };
  /** Serialized size of `build(data, marker)` from the size of `data` alone, without serializing it. */
  const totalOf = (dataSize: number, dataFields: number, marker: TruncatedMarker): number => (
    serializedLength(build({}, marker)) + dataSize - 2 + (dataFields > 0 ? 1 : 0)
  );

  /** Last resort: the leading top-level fields that fit, the rest left out. */
  const leadingFields = (array: ArrayState | undefined): Record<string, unknown> => {
    const keys = Object.keys(root);
    const prefix: number[] = [0];
    for (const key of keys) prefix.push(prefix[prefix.length - 1]! + serializedLength(key) + 1 + serializedLength(root[key]));
    const sizeWith = (count: number): number => totalOf(
      2 + prefix[count]! + Math.max(0, count - 1), count, markerOf(array, info, keys.slice(count)),
    );
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (sizeWith(mid) <= maxChars) low = mid;
      else high = mid - 1;
    }
    const kept: JsonObject = {};
    for (const key of keys.slice(0, low)) setField(kept, key, root[key]);
    return build(kept, markerOf(array, info, keys.slice(low)));
  };

  let rootSize = serializedLength(root);
  if (totalOf(rootSize, rootFields, markerOf(undefined)) <= maxChars) return build(root, markerOf(undefined));
  const excess = totalOf(rootSize, rootFields, markerOf(undefined)) - maxChars;
  const array = largestArray(root);
  // The array is cut when removing it alone could fit the result, or when it is
  // at least half of it (the other fields are then compacted first).
  if (array && (array.size >= excess || array.size * 2 >= rootSize)) {
    const entries = array.holder[array.key] as Json[];
    const state = (showing: number): ArrayState => ({
      field: rootArray ? 'data' : array.path.join('.'), showing, total: entries.length,
    });
    const empty: Json[] = [];
    setField(array.holder, array.key, empty);
    rootSize -= array.size - 2;
    if (totalOf(rootSize, rootFields, markerOf(state(0))) > maxChars) {
      // The other fields alone are too large: compact them, never the array or its parents.
      const excluded = new Set<object>([...array.route, array.holder, empty]);
      compactInPlace(root, undefined, excluded, (size) => totalOf(size, rootFields, markerOf(state(0))), maxChars, info);
      rootSize = serializedLength(root);
    }
    if (totalOf(rootSize, rootFields, markerOf(state(0))) <= maxChars) {
      const prefix: number[] = [0];
      for (const entry of entries) prefix.push(prefix[prefix.length - 1]! + serializedLength(entry));
      const sizeWith = (count: number): number => totalOf(
        rootSize + prefix[count]! + Math.max(0, count - 1), rootFields, markerOf(state(count)),
      );
      let low = 0;
      let high = entries.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (sizeWith(mid) <= maxChars) low = mid;
        else high = mid - 1;
      }
      if (low > 0) {
        setField(array.holder, array.key, entries.slice(0, low));
        return build(root, markerOf(state(low)));
      }
      // Not even one entry fits: compact the first one inside a one-entry array.
      const first = entries[0]!;
      const wrapper: Json[] = [first];
      setField(array.holder, array.key, wrapper);
      const trial = copyInfo(info);
      let wrapperPath: PathNode | undefined;
      for (const key of array.path) wrapperPath = { parent: wrapperPath, key };
      const fits = compactInPlace(wrapper, wrapperPath, new Set(),
        (size) => totalOf(rootSize - 2 + size, rootFields, markerOf(state(1), trial)), maxChars, trial);
      // An entry replaced by a single placeholder tells the model nothing.
      if (fits && (typeof wrapper[0] !== 'string' || typeof first === 'string')) {
        return build(root, markerOf(state(1), trial));
      }
      setField(array.holder, array.key, empty);
      return build(root, markerOf(state(0)));
    }
    // Even an empty array leaves the result too large.
    return leadingFields(state(0));
  }

  if (compactInPlace(root, undefined, new Set(), (size) => totalOf(size, rootFields, markerOf(undefined)), maxChars, info)) {
    return build(root, markerOf(undefined));
  }
  return leadingFields(undefined);
}
