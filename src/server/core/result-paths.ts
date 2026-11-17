/**
 * Field paths of `read_result` and the projection of a stored result.
 *
 * Syntax: segments joined by `.`; a segment is a field name, optionally
 * followed by `[]`, which descends into every element of the array there
 * (`data[].owner.name`). A root array is `[]`. A path selects the whole
 * subtree it reaches. No wildcards, negation or filters.
 */

export const MAX_RESULT_PATHS = 50;
export const MAX_RESULT_PATH_CHARS = 200;
const MAX_PATH_STEPS = 32;

export type PathStep = { kind: 'key'; key: string } | { kind: 'each' };

export interface ParsedPath {
  /** The path as written. */
  text: string;
  steps: PathStep[];
}

/** A field name may not contain `.`, `[` or `]` and may not be empty. */
const FIELD = /^[^.[\]]+$/;

/** Parses one path; undefined when it is not valid. */
export function parseResultPath(text: string): ParsedPath | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_RESULT_PATH_CHARS) return undefined;
  const steps: PathStep[] = [];
  const segments = text.split('.');
  for (let index = 0; index < segments.length; index += 1) {
    let segment = segments[index]!;
    let arrays = 0;
    while (segment.endsWith('[]')) {
      segment = segment.slice(0, -2);
      arrays += 1;
    }
    if (segment.length > 0) {
      if (!FIELD.test(segment)) return undefined;
      steps.push({ kind: 'key', key: segment });
    } else if (index > 0 || arrays === 0) {
      // Only the first segment may be a bare `[]` (a root array).
      return undefined;
    }
    for (let count = 0; count < arrays; count += 1) steps.push({ kind: 'each' });
  }
  if (steps.length === 0 || steps.length > MAX_PATH_STEPS) return undefined;
  return { text, steps };
}

/** Formats steps back into the path syntax (`data[].name`). */
export function formatResultPath(steps: ReadonlyArray<PathStep>): string {
  let text = '';
  for (const step of steps) {
    if (step.kind === 'each') text += '[]';
    else text += text.length > 0 ? `.${step.key}` : step.key;
  }
  return text;
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
    return isPlainObject(value) && hasOwn(value, step.key) && reach(value[step.key], index + 1);
  };
  return reach(root, 0);
}

interface TrieNode {
  /** Indices of the paths that end here (select the whole subtree). */
  ends: number[];
  keys: Map<string, TrieNode>;
  each?: TrieNode;
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
      else {
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
      if (!node.each) return undefined;
      const child = node.each;
      const childRoute: PathStep[] = [...route, { kind: 'each' }];
      const entries = sliced ? value : windowed(value, route);
      const nextSliced = true;
      const projected = entries.map((entry) => visit(entry, child, childRoute, nextSliced));
      if (projected.every((entry) => entry === undefined) && entries.length > 0) return undefined;
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

  const value = visit(root, trie, [], false);
  return {
    value: isPlainObject(value) ? value : {},
    matched,
    slices: [...slices.values()],
  };
}
