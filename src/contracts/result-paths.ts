/**
 * Field paths of `read_result` and the projection of a stored result.
 *
 * Syntax: segments joined by `.`; a segment is a field name, optionally
 * followed by `[]`, which descends into every element of the array there
 * (`data[].owner.name`), or by `[n]` (a non-negative integer), which selects
 * the element at that index (`data[2].items`). A root array is `[]` or `[n]`.
 * A path selects the whole subtree it reaches. No wildcards, negation or
 * filters.
 *
 * Dependency-free and not exported from `glirastes/contracts`: shared by the
 * server core and the neutral chat-view resolver so both use one grammar.
 */

export const MAX_RESULT_PATHS = 50;
export const MAX_RESULT_PATH_CHARS = 200;
export const MAX_PATH_STEPS = 32;

export type PathStep = { kind: 'key'; key: string } | { kind: 'each' } | { kind: 'index'; index: number };

export interface ParsedPath {
  /** The path as written. */
  text: string;
  steps: PathStep[];
}

/** A field name (may not contain `.`, `[` or `]`), then any number of `[]` or `[n]` (no leading zeros, at most nine digits). */
const SEGMENT = /^([^.[\]]*)((?:\[(?:0|[1-9]\d{0,8})?\])*)$/;
const BRACKET = /\[(\d*)\]/g;

/** Parses one path; undefined when it is not valid. */
export function parseResultPath(text: string): ParsedPath | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_RESULT_PATH_CHARS) return undefined;
  const steps: PathStep[] = [];
  const segments = text.split('.');
  for (let index = 0; index < segments.length; index += 1) {
    const match = SEGMENT.exec(segments[index]!);
    if (!match) return undefined;
    const name = match[1]!;
    const brackets = match[2]!;
    if (name.length > 0) {
      steps.push({ kind: 'key', key: name });
    } else if (index > 0 || brackets.length === 0) {
      // Only the first segment may be bare brackets (a root array).
      return undefined;
    }
    for (const bracket of brackets.matchAll(BRACKET)) {
      steps.push(bracket[1]!.length > 0 ? { kind: 'index', index: Number(bracket[1]) } : { kind: 'each' });
    }
  }
  if (steps.length === 0 || steps.length > MAX_PATH_STEPS) return undefined;
  return { text, steps };
}

/** A field name a path can name exactly: not empty, without `.`, `[` and `]`. */
const PLAIN_KEY = /^[^.[\]]+$/;

/**
 * Whether `steps` can be written as a path that parses back to exactly these
 * steps, in at most `maxChars` characters.
 */
export function isSelectablePath(steps: ReadonlyArray<PathStep>, maxChars: number): boolean {
  return steps.length > 0 && steps.length <= MAX_PATH_STEPS
    && !isAnyDepthForm(steps)
    && steps.every((step) => step.kind !== 'key' || PLAIN_KEY.test(step.key))
    && formatResultPath(steps).length <= Math.min(maxChars, MAX_RESULT_PATH_CHARS);
}

/**
 * Whether a path starts with a field named `**`: the any-depth form of
 * `outputDeniedFields` (`**.fileUrl`), which `read_result` refuses as an
 * invalid field instead of reading a field of that name.
 */
export function isAnyDepthForm(steps: ReadonlyArray<PathStep>): boolean {
  const first = steps[0];
  return first?.kind === 'key' && first.key === '**';
}

/** Formats steps back into the path syntax (`data[].name`, `data[2].items`). */
export function formatResultPath(steps: ReadonlyArray<PathStep>): string {
  let text = '';
  for (const step of steps) {
    if (step.kind === 'each') text += '[]';
    else if (step.kind === 'index') text += `[${step.index}]`;
    else text += text.length > 0 ? `.${step.key}` : step.key;
  }
  return text;
}

/**
 * Positions (1-based) of the paths that select both every element (`[]`)
 * and single elements (`[n]`) of the same array, e.g. `data[].name` with
 * `data[0].items`: one answer cannot hold both shapes of that array.
 * Empty when there is no such mix.
 */
export function mixedArraySelections(paths: ReadonlyArray<ParsedPath>): number[] {
  const kinds = new Map<string, { each: number[]; index: number[] }>();
  paths.forEach((path, position) => {
    let prefix = '';
    for (const step of path.steps) {
      if (step.kind !== 'key') {
        let entry = kinds.get(prefix);
        if (!entry) {
          entry = { each: [], index: [] };
          kinds.set(prefix, entry);
        }
        const list = step.kind === 'each' ? entry.each : entry.index;
        if (list[list.length - 1] !== position + 1) list.push(position + 1);
      }
      prefix += step.kind === 'key' ? `.${JSON.stringify(step.key)}` : step.kind === 'each' ? '[]' : `[${step.index}]`;
    }
  });
  const mixed = new Set<number>();
  for (const { each, index } of kinds.values()) {
    if (each.length > 0 && index.length > 0) for (const position of [...each, ...index]) mixed.add(position);
  }
  return [...mixed].sort((left, right) => left - right);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isPlainObject(value: unknown): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Sets an own data property, also for `__proto__`. */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Whether `steps` reach a value anywhere in `root` (any array element counts). */
export function resultPathExists(root: unknown, steps: ReadonlyArray<PathStep>): boolean {
  const reach = (value: unknown, index: number): boolean => {
    if (index === steps.length) return true;
    const step = steps[index]!;
    if (step.kind === 'each') {
      return Array.isArray(value) && value.some((entry) => reach(entry, index + 1));
    }
    if (step.kind === 'index') {
      return Array.isArray(value) && step.index < value.length && reach(value[step.index], index + 1);
    }
    return isPlainObject(value) && hasOwn(value, step.key) && reach(value[step.key], index + 1);
  };
  return reach(root, 0);
}

/**
 * The value `steps` reach in `root`. Without `[]` it is the one value there;
 * with `[]` it is the flat list of every value reached through the arrays
 * (`data[]`: the entries, `data[].total`: the totals of the entries that
 * have one). `found: false` when the path reaches nothing
 * (`resultPathExists`).
 */
export function readResultPath(
  root: unknown,
  steps: ReadonlyArray<PathStep>,
): { found: true; value: unknown } | { found: false } {
  if (!resultPathExists(root, steps)) return { found: false };
  const values: unknown[] = [];
  const collect = (value: unknown, index: number): void => {
    if (index === steps.length) {
      values.push(value);
      return;
    }
    const step = steps[index]!;
    if (step.kind === 'each') {
      if (Array.isArray(value)) for (const entry of value) collect(entry, index + 1);
    } else if (step.kind === 'index') {
      if (Array.isArray(value) && step.index < value.length) collect(value[step.index], index + 1);
    } else if (isPlainObject(value) && hasOwn(value, step.key)) {
      collect(value[step.key], index + 1);
    }
  };
  collect(root, 0);
  return { found: true, value: steps.some((step) => step.kind === 'each') ? values : values[0] };
}

/** At most this many values are visited to describe a path that selects nothing. */
const MAX_DESCRIBED_VALUES = 10_000;
const MAX_DESCRIBED_KEYS = 200;

/** Why a path selects nothing: how far it reaches and what is there. */
export interface MissingPathInfo {
  /** Number of leading steps that still reach a value (the nearest existing parent). */
  reached: number;
  /**
   * Keys found at the parent, in first-seen order (at most 200): of the
   * objects there, or, when there are none, of the objects inside the
   * arrays there (`entryKeys`).
   */
  keys: string[];
  /** Whether `keys` are the keys of array entries (the parent needs `[]`). */
  entryKeys: boolean;
  /** When the next step is an index: the most entries an array at the parent has (the index is out of range). */
  arrayLength?: number;
}

/**
 * Describes a path that selects nothing in `root`: the longest prefix that
 * still reaches a value, the keys there (only with `withKeys`, else empty),
 * and for an index step an array that is too short. Visits at most 10,000
 * values; deterministic.
 */
export function describeMissingPath(root: unknown, steps: ReadonlyArray<PathStep>, withKeys = true): MissingPathInfo {
  // Reaching is monotone in the prefix length: a binary search finds the longest prefix.
  let low = 0;
  let high = steps.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (resultPathExists(root, steps.slice(0, mid))) low = mid;
    else high = mid - 1;
  }
  const reached = Math.max(0, low);
  const values: unknown[] = [];
  const collect = (value: unknown, index: number): void => {
    if (values.length >= MAX_DESCRIBED_VALUES) return;
    if (index === reached) {
      values.push(value);
      return;
    }
    const step = steps[index]!;
    if (step.kind === 'each') {
      if (Array.isArray(value)) for (const entry of value) collect(entry, index + 1);
    } else if (step.kind === 'index') {
      if (Array.isArray(value) && step.index < value.length) collect(value[step.index], index + 1);
    } else if (isPlainObject(value) && hasOwn(value, step.key)) {
      collect(value[step.key], index + 1);
    }
  };
  collect(root, 0);
  const objectKeys = new Set<string>();
  const entryKeys = new Set<string>();
  let arrayLength: number | undefined;
  const addKeys = (target: Set<string>, object: Record<string, Json>) => {
    for (const key of Object.keys(object)) {
      if (target.size >= MAX_DESCRIBED_KEYS) return;
      target.add(key);
    }
  };
  let visited = 0;
  for (const value of values) {
    if (isPlainObject(value)) {
      if (withKeys) addKeys(objectKeys, value);
    } else if (Array.isArray(value)) {
      arrayLength = Math.max(arrayLength ?? 0, value.length);
      if (!withKeys) continue;
      for (const entry of value) {
        if (visited >= MAX_DESCRIBED_VALUES) break;
        visited += 1;
        if (isPlainObject(entry)) addKeys(entryKeys, entry);
      }
    }
  }
  const next = steps[reached];
  const useEntries = objectKeys.size === 0 && entryKeys.size > 0;
  return {
    reached,
    keys: [...(useEntries ? entryKeys : objectKeys)],
    entryKeys: useEntries,
    ...(next?.kind === 'index' && arrayLength !== undefined ? { arrayLength } : {}),
  };
}

interface TrieNode {
  /** Indices of the paths that end here (select the whole subtree). */
  ends: number[];
  keys: Map<string, TrieNode>;
  each?: TrieNode;
  /** Single elements selected with `[n]`. */
  indices?: Map<number, TrieNode>;
}

function newNode(): TrieNode {
  return { ends: [], keys: new Map() };
}

export interface ProjectionWindow {
  offset: number;
  /** Undefined: every entry from `offset` on. */
  limit?: number;
}

export interface ArraySlice {
  /** Path of the array the window applied to (`data`, `data.items`). */
  path: string;
  total: number;
  returned: number;
}

export interface Projection {
  value: Record<string, unknown>;
  /** Paths (by index) that matched something. */
  matched: Set<number>;
  /** The outermost arrays the window applied to, in the order they were first reached. */
  slices: ArraySlice[];
}

/**
 * Projects `root` onto `paths`. The window (`offset`, `limit`) applies to the
 * outermost arrays of each selected path (also those inside a selected
 * object); arrays inside a paged array's entries are kept whole.
 * Elements an inner path does not reach stay as `{}` so positions line up.
 * An element selected by index (`data[2]`) comes back as an object keyed by
 * its index (`data: { "2": … }`) and is not paged itself: the outermost
 * arrays inside it are. A node with both `[]` and `[n]` uses `[]` (the
 * caller refuses such a mix, see `mixedArraySelections`).
 */
export function projectResult(
  root: Record<string, unknown>,
  paths: ReadonlyArray<ParsedPath>,
  window: ProjectionWindow,
): Projection {
  const trie = newNode();
  paths.forEach((path, index) => {
    let node = trie;
    for (const step of path.steps) {
      if (step.kind === 'each') node = node.each ??= newNode();
      else if (step.kind === 'index') {
        node.indices ??= new Map();
        let next = node.indices.get(step.index);
        if (!next) {
          next = newNode();
          node.indices.set(step.index, next);
        }
        node = next;
      } else {
        let next = node.keys.get(step.key);
        if (!next) {
          next = newNode();
          node.keys.set(step.key, next);
        }
        node = next;
      }
    }
    node.ends.push(index);
  });
  const matched = new Set<number>();
  const slices = new Map<string, ArraySlice>();

  const windowed = (value: unknown[], route: PathStep[]): unknown[] => {
    const start = Math.min(window.offset, value.length);
    const end = window.limit === undefined ? value.length : Math.min(value.length, start + window.limit);
    const entries = value.slice(start, end);
    const path = formatResultPath(route);
    if (!slices.has(path)) slices.set(path, { path, total: value.length, returned: entries.length });
    return entries;
  };

  /** A selected subtree not yet inside a paged array: its outermost arrays are paged. */
  const paged = (value: unknown, route: PathStep[]): unknown => {
    if (Array.isArray(value)) return windowed(value, route);
    if (!isPlainObject(value)) return value;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) setOwn(output, key, paged(value[key], [...route, { kind: 'key', key }]));
    return output;
  };

  const visit = (value: unknown, node: TrieNode, route: PathStep[], sliced: boolean): unknown => {
    if (node.ends.length > 0) {
      for (const index of node.ends) matched.add(index);
      // A path that selects an array, or an object holding arrays, pages through them.
      return sliced ? value : paged(value, route);
    }
    if (Array.isArray(value)) {
      if (!node.each) return node.indices ? selectIndices(value, node.indices, route, sliced) : undefined;
      const child = node.each;
      const childRoute: PathStep[] = [...route, { kind: 'each' }];
      const entries = sliced ? value : windowed(value, route);
      const nextSliced = true;
      const projected = entries.map((entry) => visit(entry, child, childRoute, nextSliced));
      // Entries of the paged array that lack the field stay visible as "{}": a page
      // without any is not an empty answer. Inside an entry such an array is left out.
      if (sliced && projected.every((entry) => entry === undefined) && entries.length > 0) return undefined;
      return projected.map((entry) => (entry === undefined ? {} : entry));
    }
    if (isPlainObject(value)) {
      const output: Record<string, unknown> = {};
      let any = false;
      for (const [key, child] of node.keys) {
        if (!hasOwn(value, key)) continue;
        const projected = visit(value[key], child, [...route, { kind: 'key', key }], sliced);
        if (projected === undefined) continue;
        setOwn(output, key, projected);
        any = true;
      }
      return any ? output : undefined;
    }
    return undefined;
  };

  /**
   * Single elements of an array, as an object keyed by their index
   * (`{ "2": … }`). Selecting an element neither pages nor counts as paging:
   * the outermost arrays inside it are paged by the window.
   */
  const selectIndices = (value: unknown[], indices: Map<number, TrieNode>, route: PathStep[], sliced: boolean): unknown => {
    const output: Record<string, unknown> = {};
    let any = false;
    for (const index of [...indices.keys()].sort((left, right) => left - right)) {
      if (index >= value.length) continue;
      const projected = visit(value[index], indices.get(index)!, [...route, { kind: 'index', index }], sliced);
      if (projected === undefined) continue;
      setOwn(output, String(index), projected);
      any = true;
    }
    return any ? output : undefined;
  };

  const value = visit(root, trie, [], false);
  return {
    value: isPlainObject(value) ? value : {},
    matched,
    slices: [...slices.values()],
  };
}
