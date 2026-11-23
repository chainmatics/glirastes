/**
 * Output field declarations of a tool: `outputAllowedFields` and
 * `outputDeniedFields` (together the upper bound of what a successful result
 * may show the model and the browser: the allowed fields, or every field,
 * minus the denied ones) and `outputDefaultFields` (what the first answer
 * shows). All three are lists of
 * `read_result` paths without an index (`data[].name`, `data[].owner`,
 * `meta`); a path selects the whole subtree it reaches. Paths address the
 * result as the model sees it: a list or scalar answer of an endpoint travels
 * under `data`. Pure and dependency-free apart from the path grammar.
 */
import { MAX_PATH_STEPS, MAX_RESULT_PATH_CHARS, parseResultPath, setOwn } from './result-paths.js';

/** Most paths one declaration may hold. */
export const MAX_OUTPUT_FIELDS = 200;
/** Longest path of a declaration, in characters. */
export const MAX_OUTPUT_FIELD_CHARS = MAX_RESULT_PATH_CHARS;

export type OutputFieldStep = { kind: 'key'; key: string } | { kind: 'each' };

/** The two declarations, by their name on `Tool`, `contract.ts` and in `tool-contracts.json`. */
export type OutputFieldsName = 'outputAllowedFields' | 'outputDeniedFields' | 'outputDefaultFields';

/** The field name `**` is reserved for the any-depth form of `outputDeniedFields`. */
export const ANY_DEPTH = '**';
const ANY_DEPTH_PREFIX = `${ANY_DEPTH}.`;

/**
 * Steps of one declared path; undefined when it is not a string, does not
 * parse in the `read_result` grammar, starts with brackets (a result is
 * always a record), holds an index (`[2]`), a field named `**` or any
 * whitespace (field names are matched exactly and case-sensitively).
 */
export function parseOutputFieldPath(text: unknown): OutputFieldStep[] | undefined {
  // Whitespace anywhere protects nothing (no key is written so): invalid.
  if (typeof text !== 'string' || text.length > MAX_OUTPUT_FIELD_CHARS || /\s/.test(text)) return undefined;
  const parsed = parseResultPath(text);
  if (!parsed || parsed.steps[0]?.kind !== 'key') return undefined;
  const steps: OutputFieldStep[] = [];
  for (const step of parsed.steps) {
    if (step.kind === 'index' || (step.kind === 'key' && step.key === ANY_DEPTH)) return undefined;
    steps.push(step.kind === 'key' ? { kind: 'key', key: step.key } : { kind: 'each' });
  }
  return steps;
}

/**
 * The key of an any-depth denied path `**.<key>` (`**.fileUrl`), or
 * undefined for any other text. `**.` must be followed by exactly one field
 * name (no `.`, `[` or `]`, not `**`); only `outputDeniedFields` accepts it.
 */
export function parseAnyDepthKey(text: unknown): string | undefined {
  if (typeof text !== 'string' || text.length > MAX_OUTPUT_FIELD_CHARS || !text.startsWith(ANY_DEPTH_PREFIX)) return undefined;
  const steps = parseOutputFieldPath(text.slice(ANY_DEPTH_PREFIX.length));
  return steps?.length === 1 && steps[0]!.kind === 'key' ? steps[0]!.key : undefined;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The declaration de-duplicated and sorted in code-unit order, or undefined
 * when it is invalid: not an array, more than 200 paths, or a path that is
 * not a valid field path (see `parseOutputFieldPath`). `[]` is valid. Only
 * `outputDeniedFields` also accepts the any-depth form `**.<key>`.
 */
export function normalizeOutputFields(value: unknown, name: OutputFieldsName = 'outputAllowedFields'): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OUTPUT_FIELDS) return undefined;
  const anyDepth = name === 'outputDeniedFields';
  for (const path of value) {
    if (!parseOutputFieldPath(path) && !(anyDepth && parseAnyDepthKey(path) !== undefined)) return undefined;
  }
  return [...new Set(value as string[])].sort(compareCodeUnits);
}

/** Whether `value` is a valid declaration named `name` (see `normalizeOutputFields`). */
export function isValidOutputFields(value: unknown, name: OutputFieldsName = 'outputAllowedFields'): value is string[] {
  return normalizeOutputFields(value, name) !== undefined;
}

/** Throws a clear error naming `label` when `value` is set but no valid declaration. Never repeats the value. */
export function assertOutputFields(value: unknown, label: string, name: OutputFieldsName): void {
  if (value === undefined || isValidOutputFields(value, name)) return;
  throw new Error(
    `${label}: ${name} must be a list of at most ${MAX_OUTPUT_FIELDS} field paths such as "data[].name" or "meta" `
      + `(each at most ${MAX_OUTPUT_FIELD_CHARS} characters, starting with a field name, without an index`
      + (name === 'outputDeniedFields' ? '; "**.key" removes a key at any depth' : '; no "**"')
      + ')',
  );
}

/** The keys of the any-depth paths (`**.<key>`) of a denied list. */
export function anyDepthKeys(paths: ReadonlyArray<string>): Set<string> {
  const keys = new Set<string>();
  for (const path of paths) {
    const key = parseAnyDepthKey(path);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/** A tree of declared paths; `end` marks a path that selects its whole subtree. */
export interface OutputFieldNode {
  end: boolean;
  keys: Map<string, OutputFieldNode>;
  each?: OutputFieldNode;
}

/** The tree of valid exact paths (invalid and any-depth ones are skipped; validate first). */
export function outputFieldTree(paths: ReadonlyArray<string>): OutputFieldNode {
  const root: OutputFieldNode = { end: false, keys: new Map() };
  for (const path of paths) {
    const steps = parseOutputFieldPath(path);
    if (!steps) continue;
    let node = root;
    for (const step of steps) {
      if (step.kind === 'each') node = node.each ??= { end: false, keys: new Map() };
      else {
        let next = node.keys.get(step.key);
        if (!next) {
          next = { end: false, keys: new Map() };
          node.keys.set(step.key, next);
        }
        node = next;
      }
    }
    node.end = true;
  }
  return root;
}

/** Whether the subtree `steps` reaches lies within the tree (a declared path equals it or is above it). */
export function outputFieldCovers(tree: OutputFieldNode, steps: ReadonlyArray<OutputFieldStep>): boolean {
  let node: OutputFieldNode | undefined = tree;
  for (const step of steps) {
    if (node.end) return true;
    node = step.kind === 'each' ? node.each : node.keys.get(step.key);
    if (!node) return false;
  }
  return node.end;
}

function startsWith(steps: ReadonlyArray<OutputFieldStep>, prefix: ReadonlyArray<OutputFieldStep>): boolean {
  return prefix.length <= steps.length && prefix.every((step, index) => {
    const other = steps[index]!;
    return step.kind === other.kind && (step.kind === 'each' || step.key === (other as { key: string }).key);
  });
}

/**
 * The paths of `defaults` that lie within `allowed`, as a set of subtrees: a
 * default path inside an allowed one stays, a default path above allowed
 * ones is replaced by them, any other is dropped. Normalized.
 */
export function intersectOutputFields(defaults: ReadonlyArray<string>, allowed: ReadonlyArray<string>): string[] {
  const tree = outputFieldTree(allowed);
  const allowedSteps = allowed.map((path) => [path, parseOutputFieldPath(path)] as const)
    .filter((entry): entry is readonly [string, OutputFieldStep[]] => entry[1] !== undefined);
  const kept = new Set<string>();
  for (const path of defaults) {
    const steps = parseOutputFieldPath(path);
    if (!steps) continue;
    if (outputFieldCovers(tree, steps)) {
      kept.add(path);
      continue;
    }
    for (const [text, inner] of allowedSteps) {
      if (startsWith(inner, steps)) kept.add(text);
    }
  }
  return [...kept].sort(compareCodeUnits);
}

/** Paths of `paths` that do not lie within `allowed` (see `outputFieldCovers`). */
export function outputFieldsOutside(paths: ReadonlyArray<string>, allowed: ReadonlyArray<string>): string[] {
  const tree = outputFieldTree(allowed);
  return paths.filter((path) => {
    const steps = parseOutputFieldPath(path);
    return steps !== undefined && !outputFieldCovers(tree, steps);
  });
}

/** Top-level keys a projection never alters or removes. */
const PROTECTED_KEYS: ReadonlySet<string> = new Set(['success', 'uiAction']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MISSING = Symbol('missing');

/**
 * `value` reduced to what `node` selects. An array element the path does
 * not reach stays as `{}` (positions and counts of a selected array are part
 * of it); an object on the path keeps only the selected keys (possibly
 * none: `{}`); a value where the path needs an object or array is left out,
 * as if it did not exist.
 */
function project(value: unknown, node: OutputFieldNode): unknown {
  if (node.end) return value;
  if (Array.isArray(value)) {
    if (!node.each) return MISSING;
    const each = node.each;
    return value.map((entry) => {
      const projected = project(entry, each);
      return projected === MISSING ? {} : projected;
    });
  }
  if (isPlainObject(value)) {
    if (node.keys.size === 0) return MISSING;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = node.keys.get(key);
      if (!child) continue;
      const projected = project(value[key], child);
      if (projected !== MISSING) setOwn(output, key, projected);
    }
    return output;
  }
  return MISSING;
}

/**
 * A successful record result reduced to the fields of `tree`. `success` and
 * `uiAction` stay as they are; every other key keeps its position. `record`
 * must be JSON data (see `applyOutputAllowedFields`); the output shares
 * subtrees with it.
 */
export function projectOutputFields(record: Record<string, unknown>, tree: OutputFieldNode): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (PROTECTED_KEYS.has(key)) {
      setOwn(output, key, record[key]);
      continue;
    }
    const child = tree.keys.get(key);
    if (!child) continue;
    const projected = project(record[key], child);
    if (projected !== MISSING) setOwn(output, key, projected);
  }
  return output;
}

/**
 * A successful tool result as JSON data: a copy of everything but `success`
 * and `uiAction` (a `Date` becomes its string, as the transport would send
 * it; those two stay as they are). A result that is not a record travels
 * under `data`, like an endpoint's list or scalar answer. Undefined when it
 * cannot be serialized.
 */
export function toJsonRecord(result: unknown): Record<string, unknown> | undefined {
  const record: Record<string, unknown> = isPlainObject(result) ? result : { data: result };
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (!PROTECTED_KEYS.has(key)) setOwn(payload, key, record[key]);
  }
  let copy: Record<string, unknown>;
  try {
    const text = JSON.stringify(payload);
    if (text === undefined) return undefined;
    copy = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (PROTECTED_KEYS.has(key)) setOwn(output, key, record[key]);
    else if (Object.prototype.hasOwnProperty.call(copy, key)) setOwn(output, key, copy[key]);
  }
  return output;
}

/**
 * `value` without the subtrees `node` ends in, through objects and arrays;
 * any other value stays. An object whose keys were all removed stays as `{}`;
 * an entry a path ending in `[]` removes stays as `{}`, whatever it was.
 */
function withoutDenied(value: unknown, node: OutputFieldNode): unknown {
  if (Array.isArray(value)) {
    const each = node.each;
    if (!each) return value;
    // A path ending in `[]` removes the content of every entry; each entry stays as `{}`,
    // so the array keeps its length (a count is part of the array, not of its entries).
    return value.map((entry) => (each.end ? {} : withoutDenied(entry, each)));
  }
  if (!isPlainObject(value) || node.keys.size === 0) return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const child = node.keys.get(key);
    if (child?.end) continue;
    setOwn(output, key, child ? withoutDenied(value[key], child) : value[key]);
  }
  return output;
}

/**
 * A record (JSON data) without the denied fields of `tree`. `success` and
 * `uiAction` stay as they are; every other key keeps its position.
 */
export function removeDeniedFields(record: Record<string, unknown>, tree: OutputFieldNode): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const child = tree.keys.get(key);
    if (PROTECTED_KEYS.has(key) || !child) setOwn(output, key, record[key]);
    else if (!child.end) setOwn(output, key, withoutDenied(record[key], child));
  }
  return output;
}

/**
 * Containers deeper than this many steps below the root are dropped when an
 * any-depth denied key is declared: a key that deep cannot be checked, so it
 * is not passed through (fail closed). Equal to the deepest `read_result` path.
 */
export const MAX_ANY_DEPTH = MAX_PATH_STEPS;

const DROP = Symbol('drop');

/**
 * `value` without every property named in `keys`, at any depth, through
 * objects and arrays. A container deeper than `MAX_ANY_DEPTH` is dropped (an
 * array keeps its position with `null`). Recursion is bounded by that depth.
 */
function withoutKeys(value: unknown, keys: ReadonlySet<string>, depth: number): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (depth > MAX_ANY_DEPTH) return DROP;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const kept = withoutKeys(entry, keys, depth + 1);
      return kept === DROP ? null : kept;
    });
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (keys.has(key)) continue;
    const kept = withoutKeys((value as Record<string, unknown>)[key], keys, depth + 1);
    if (kept !== DROP) setOwn(output, key, kept);
  }
  return output;
}

/**
 * A record (JSON data) without every property named in `keys`, at any depth,
 * including the top level (except `success` and `uiAction`, which stay).
 */
export function removeDeniedKeys(record: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (PROTECTED_KEYS.has(key)) {
      setOwn(output, key, record[key]);
      continue;
    }
    if (keys.has(key)) continue;
    const kept = withoutKeys(record[key], keys, 1);
    if (kept !== DROP) setOwn(output, key, kept);
  }
  return output;
}

/** The upper bound of a tool's result: the allowed fields (absent: all) minus the denied ones. */
export interface OutputBound {
  allowed?: OutputFieldNode;
  /** Exact denied paths. */
  denied?: OutputFieldNode;
  /** Keys of the any-depth denied paths (`**.fileUrl`). */
  deniedKeys?: ReadonlySet<string>;
}

/**
 * The upper bound of a tool from its declarations. An invalid
 * `outputAllowedFields` or `outputDeniedFields` (a tool not built with
 * `defineTool`) allows nothing: it fails closed. Undefined without either.
 */
export function outputBoundOf(declared: { outputAllowedFields?: unknown; outputDeniedFields?: unknown }): OutputBound | undefined {
  const { outputAllowedFields: allowed, outputDeniedFields: denied } = declared;
  if (allowed === undefined && denied === undefined) return undefined;
  const allowedPaths = allowed === undefined ? undefined : normalizeOutputFields(allowed, 'outputAllowedFields');
  const deniedPaths = denied === undefined ? undefined : normalizeOutputFields(denied, 'outputDeniedFields');
  if ((allowed !== undefined && !allowedPaths) || (denied !== undefined && !deniedPaths)) {
    return { allowed: outputFieldTree([]) };
  }
  const deniedKeys = deniedPaths ? anyDepthKeys(deniedPaths) : new Set<string>();
  return {
    ...(allowedPaths ? { allowed: outputFieldTree(allowedPaths) } : {}),
    ...(deniedPaths && deniedPaths.length > deniedKeys.size ? { denied: outputFieldTree(deniedPaths) } : {}),
    ...(deniedKeys.size > 0 ? { deniedKeys } : {}),
  };
}

/**
 * Applies the upper bound to a successful tool result: its JSON form
 * (`toJsonRecord`) reduced to the allowed fields, without the denied ones.
 * Undefined when the result cannot be serialized (the caller withholds it).
 */
export function applyOutputBound(result: unknown, bound: OutputBound): Record<string, unknown> | undefined {
  const record = toJsonRecord(result);
  if (!record) return undefined;
  const allowed = bound.allowed ? projectOutputFields(record, bound.allowed) : record;
  const denied = bound.denied ? removeDeniedFields(allowed, bound.denied) : allowed;
  const reduced = bound.deniedKeys && bound.deniedKeys.size > 0 ? removeDeniedKeys(denied, bound.deniedKeys) : denied;
  return withinProtected(reduced, bound);
}

/**
 * The protected keys under a bound: `success` only as a boolean (a backend
 * cannot carry data in it), and `uiAction` without the any-depth denied keys
 * (a JSON copy; one that cannot be serialized is dropped). Exact paths and the
 * allow-list do not apply to `uiAction`: its shape is not the result's.
 */
function withinProtected(record: Record<string, unknown>, bound: OutputBound): Record<string, unknown> {
  const keys = bound.deniedKeys;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (key === 'success') {
      if (typeof value === 'boolean') setOwn(output, key, value);
    } else if (key === 'uiAction' && keys && keys.size > 0) {
      let copy: unknown;
      try {
        const text = JSON.stringify(value);
        copy = text === undefined ? undefined : JSON.parse(text);
      } catch {
        continue;
      }
      if (copy === undefined) continue;
      const kept = withoutKeys(copy, keys, 1);
      if (kept !== DROP) setOwn(output, key, kept);
    } else {
      setOwn(output, key, value);
    }
  }
  return output;
}

/** Why a failure body is not shown under a bound (a fixed note for the model). */
export const FAILURE_BODY_WITHHELD = Object.freeze({
  allowed: 'The response body is not shown: this tool declares the only output fields it may show.',
  unchecked: 'The response body is not shown: it is not JSON, so the declared output fields cannot be checked on it.',
});

/**
 * The body of a failed backend call under a bound, before it is serialized
 * and cut: with an allow-list it is withheld (a failure body is not a record
 * of the declared shape); a body that is not a JSON object, array, number,
 * boolean or null (a text, HTML, a JSON string) cannot be checked and is
 * withheld; otherwise the denied paths are removed as far as they match (a
 * list body counts as `data`, as for a result) and every any-depth denied key.
 */
export function reduceFailureBody(data: unknown, bound: OutputBound): { data?: unknown; withheld?: string } {
  if (data === undefined) return {};
  if (bound.allowed) return { withheld: FAILURE_BODY_WITHHELD.allowed };
  if (data === null || typeof data === 'number' || typeof data === 'boolean') return { data };
  if (typeof data !== 'object') return { withheld: FAILURE_BODY_WITHHELD.unchecked };
  let copy: unknown;
  try {
    const text = JSON.stringify(data);
    if (text === undefined) return { withheld: FAILURE_BODY_WITHHELD.unchecked };
    copy = JSON.parse(text);
  } catch {
    return { withheld: FAILURE_BODY_WITHHELD.unchecked };
  }
  const list = Array.isArray(copy);
  let record = (list ? { data: copy } : copy) as Record<string, unknown>;
  if (bound.denied) record = withoutDenied(record, bound.denied) as Record<string, unknown>;
  if (bound.deniedKeys && bound.deniedKeys.size > 0) {
    const kept = withoutKeys(record, bound.deniedKeys, 0);
    if (kept === DROP) return { withheld: FAILURE_BODY_WITHHELD.unchecked };
    record = kept as Record<string, unknown>;
  }
  return { data: list ? record.data : record };
}

/** `applyOutputBound` with only `outputAllowedFields`. */
export function applyOutputAllowedFields(result: unknown, tree: OutputFieldNode): Record<string, unknown> | undefined {
  return applyOutputBound(result, { allowed: tree });
}

/** One field (or subtree) a default view leaves out, aggregated over every entry it occurs in. */
export interface LeftOutField {
  steps: OutputFieldStep[];
  /** The `read_result` path (`data[].owner`). */
  path: string;
  /** Approximate serialized size across all entries. */
  size: number;
  /** Whether a left-out value there is a non-empty object (its keys can be named). */
  parent: boolean;
  /** Direct child keys of a left-out object and their size across all entries, in first-seen order. */
  children: Map<string, number>;
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function formatSteps(steps: ReadonlyArray<OutputFieldStep>): string {
  let text = '';
  for (const step of steps) {
    if (step.kind === 'each') text += '[]';
    else text += text.length > 0 ? `.${step.key}` : step.key;
  }
  return text;
}

/**
 * What projecting `record` (JSON data) onto `tree` leaves out, aggregated by
 * path, largest first (then by path, code-unit order). A field that is left
 * out whole is listed by its own path, not by its contents. `success`,
 * `uiAction` and the marker keys `_result` and `_truncated` are never listed.
 */
export function leftOutFields(record: Record<string, unknown>, tree: OutputFieldNode): LeftOutField[] {
  const byPath = new Map<string, LeftOutField>();
  const add = (steps: OutputFieldStep[], size: number, value: unknown) => {
    const path = formatSteps(steps);
    let known = byPath.get(path);
    if (!known) {
      known = { steps, path, size: 0, parent: false, children: new Map() };
      byPath.set(path, known);
    }
    known.size += size;
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      known.parent = true;
      for (const key of Object.keys(value)) {
        known.children.set(key, (known.children.get(key) ?? 0) + serializedLength(key) + 1 + serializedLength(value[key]) + 1);
      }
    }
  };
  const fieldSize = (key: string, value: unknown) => serializedLength(key) + 1 + serializedLength(value) + 1;
  const walk = (value: unknown, node: OutputFieldNode, steps: OutputFieldStep[]): void => {
    if (node.end) return;
    if (Array.isArray(value)) {
      if (!node.each) {
        add(steps, serializedLength(value), value);
        return;
      }
      const childSteps: OutputFieldStep[] = [...steps, { kind: 'each' }];
      for (const entry of value) walk(entry, node.each, childSteps);
      return;
    }
    if (isPlainObject(value)) {
      if (node.keys.size === 0) {
        add(steps, serializedLength(value), value);
        return;
      }
      for (const key of Object.keys(value)) {
        const child = node.keys.get(key);
        const childSteps: OutputFieldStep[] = [...steps, { kind: 'key', key }];
        if (child) walk(value[key], child, childSteps);
        else add(childSteps, fieldSize(key, value[key]), value[key]);
      }
      return;
    }
    add(steps, serializedLength(value), value);
  };
  for (const key of Object.keys(record)) {
    if (PROTECTED_KEYS.has(key) || key === '_result' || key === '_truncated') continue;
    const child = tree.keys.get(key);
    const steps: OutputFieldStep[] = [{ kind: 'key', key }];
    if (child) walk(record[key], child, steps);
    else add(steps, fieldSize(key, record[key]), record[key]);
  }
  return [...byPath.values()]
    .sort((left, right) => right.size - left.size || compareCodeUnits(left.path, right.path));
}
