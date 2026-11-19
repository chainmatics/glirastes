/**
 * The built-in tool `read_result`: reads omitted fields or further entries
 * of a large tool result that has a handle in the running turn's
 * `ResultStore`. It never calls the backend; it works for read and write
 * origin tools alike.
 */
import { z } from 'zod';
import { MAX_MAX_RESULT_CHARS } from '../../runtime/result-limit.js';
import {
  READ_RESULT_ID_PREFIX,
  READ_RESULT_TOOL_NAME,
} from '../../contracts/result-handle.js';
import { defineTool, type Tool } from '../../types.js';
import { identityFieldsOf } from '../../contracts/entity-identity.js';
import { declarationForEntries, declaredIdentityKeys, type OutputEntityDeclaration } from '../../contracts/entity-declaration.js';
import { dominantArrayRoute } from './result-overview.js';
import {
  describeMissingPath,
  formatResultPath,
  isAnyDepthForm,
  MAX_RESULT_PATH_CHARS,
  MAX_RESULT_PATHS,
  mixedArraySelections,
  parseResultPath,
  projectResult,
  resultPathExists,
  setOwn,
  type ParsedPath,
  type PathStep,
} from './result-paths.js';
import type { ResultHandle, ResultStore } from './result-store.js';
import { truncateToolResult } from './truncate-tool-result.js';

export const MAX_READ_RESULT_LIMIT = 1_000;

export const ReadResultInputSchema = z.object({
  resultId: z.string().min(1).max(64),
  fields: z.array(z.string().min(1).max(MAX_RESULT_PATH_CHARS)).max(MAX_RESULT_PATHS).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_READ_RESULT_LIMIT).optional(),
}).strict();

export type ReadResultInput = z.infer<typeof ReadResultInputSchema>;

/** The `_result` marker of a `read_result` answer. */
export interface ReadResultMarker {
  id: string;
  offset: number;
  /**
   * Entries of the paged array with the most entries in this answer. One
   * window (`offset`, `limit`) applies to every paged array, so this array
   * decides whether more pages follow. 0 when the entry at `offset` does not
   * fit even cut.
   */
  returned?: number;
  /** Entries the paged array with the most entries has. */
  total?: number;
  /**
   * The `offset` of the next page, while any paged array has further
   * entries (past an entry that does not fit even cut).
   */
  nextOffset?: number;
  /** Every paged array (at most five, paths shortened), when more than one was paged. */
  arrays?: Record<string, { returned: number; total: number }>;
  /**
   * Requested paths that select nothing (at most ten): the path re-formatted
   * from its parsed steps when every field name in it is a plain identifier
   * (`[A-Za-z_$][A-Za-z0-9_$]{0,63}`) without a run of three or more digits
   * and it has at most 120 characters, else its 1-based position. The raw
   * text the model wrote never comes back.
   */
  unknownFields?: Array<string | number>;
  /** How many requested paths select nothing, when more than ten or when `unknownFields` had to be left out. */
  unknownCount?: number;
  /**
   * For up to three unknown paths: the nearest parent that exists, with the
   * keys found there (at most twelve, echoable like `unknownFields`). A
   * parent ending in `[]` lists the keys of its entries. Only when it fits
   * next to the whole page; left out first when space runs out.
   */
  parentKeys?: Record<string, string[]>;
  /**
   * Present when the answer is incomplete (further entries, a cut entry, an
   * entry that does not fit at all) or a requested field does not exist; a
   * complete answer has none. An incomplete one always starts with
   * `Incomplete:`.
   */
  hint?: string;
}

/**
 * How the chat handler guards a read. A managed turn runs the origin tool's
 * guard here (budget, fresh principal, pinned snapshot, revocations) and
 * compares the handle's owner with the fresh principal.
 */
export interface ReadResultGuard {
  /**
   * Checked when the AI SDK asks whether the call needs approval (reading
   * never does): throws for the conditions that end the turn, like the guard
   * of a domain tool. Anything else is left to `beforeRead`.
   */
  precheck?: (read: { handle: ResultHandle; input: ReadResultInput }) => Promise<void>;
  /**
   * Before reading: `'denied'` answers `result_denied`, `'budget_exhausted'`
   * answers that the turn's tool-call budget is used up; a throw refuses
   * the call.
   */
  beforeRead?: (read: { handle: ResultHandle; input: ReadResultInput }) => Promise<'denied' | 'budget_exhausted' | void>;
  /** After reading, with the answer (loop detection). */
  afterRead?: (read: { handle: ResultHandle; input: ReadResultInput; result: unknown; durationMs: number }) => Promise<void>;
  /**
   * A call refused before a handle is read (unknown or expired id, invalid
   * fields): counted as a tool call and an error of the turn. A read whose
   * answer is an error (`unknown_fields`, `index_out_of_range`) goes through
   * `beforeRead`/`afterRead` and counts by its `error`. `'budget_exhausted'`
   * answers that the turn's budget is used up instead.
   */
  failedRead?: () => Promise<'budget_exhausted' | void>;
  /**
   * The hint of a `budget_exhausted` answer: the reached limits and their
   * use. Without it (or for undefined) the answer keeps a fixed hint.
   */
  budgetExhaustedHint?: () => string | undefined;
}

const DESCRIPTION = 'Read more of a large tool result that was shown as an overview with a "_result" marker: '
  + 'omitted fields or further entries. Pass its resultId, optionally "fields" (paths such as "data[].name", '
  + '"data[].owner.name" or "meta"; "[]" means every element of an array, "[2]" one element, returned keyed by its index: "data[2].items") '
  + 'and "offset"/"limit" for the entries; entries read below an array keep their id and name. '
  + 'Works only within the current turn and never calls the original tool again.';

const MAX_LISTED_UNKNOWN = 10;
const MAX_LISTED_ARRAYS = 5;
const MAX_LISTED_PATH_CHARS = 120;
const MAX_LISTED_PARENTS = 3;
const MAX_LISTED_PARENT_KEYS = 12;
/**
 * A field name that may be echoed: an identifier without a run of three
 * digits. Every pseudonym the built-in generators make contains a space,
 * `@`, `.`, `+`, `-`, `/`, `,`, `(` or `[`, or a run of three or more digits
 * (CVVs, tax and social ids), so no echoed name can contain one, and
 * `inbound`, which replaces pseudonyms inside longer strings, finds nothing.
 */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const DIGIT_RUN = /\d{3}/;

function echoableKey(key: string): boolean {
  return IDENTIFIER.test(key) && !DIGIT_RUN.test(key);
}

const INVALID_FIELDS_FORMS = 'Accepted forms: "data[].name" (a field of every entry), "data[2].items" (one entry, index from 0) '
  + 'and "meta" (a field); join field names with ".". Page through entries with offset and limit.';

function listedPath(text: string): string {
  return text.length > MAX_LISTED_PATH_CHARS ? `${text.slice(0, MAX_LISTED_PATH_CHARS - 1)}…` : text;
}

/**
 * The normalized form of parsed steps when it may be echoed (every field name
 * an identifier, at most 120 characters), else undefined. Built from the
 * parsed steps, never from the text the model wrote.
 */
function echoablePath(steps: ReadonlyArray<PathStep>): string | undefined {
  if (!steps.every((step) => step.kind !== 'key' || echoableKey(step.key))) return undefined;
  const text = formatResultPath(steps);
  return text.length <= MAX_LISTED_PATH_CHARS ? text : undefined;
}

interface UnknownState {
  count: number;
  /** Whether the marker lists `unknownFields` (else only `unknownCount`). */
  listed: boolean;
  /** Whether `unknownFields` holds a position. */
  positions: boolean;
  parentKeys: boolean;
}

/** What to say about requested fields that do not exist; `all`: none of them exists. */
function unknownHint(state: UnknownState, all = false): string {
  const one = state.count === 1;
  const list = state.listed ? 'unknownFields' : 'unknownCount';
  const subject = all
    ? (one ? 'The requested field does not exist' : 'None of the requested fields exist')
    : (one ? 'A requested field does not exist' : `${state.count} requested fields do not exist`);
  return `${subject} in this result (${list}): do not infer ${one ? 'it' : 'them'} from other fields; `
    + `say ${one ? 'it is' : 'they are'} not known${state.parentKeys ? ' or pick a field from parentKeys' : ''}.`
    + (state.listed && state.positions ? ' A number in unknownFields is a position in fields.' : '');
}

/** The instruction of a read answer; undefined for a complete answer that requested only existing fields. */
function readHint(state: {
  offset: number; returned?: number; total?: number; nextOffset?: number; fields: boolean; unknown: UnknownState;
  /** Without the sentence about the content of all entries. */
  short?: boolean;
  /** Set when the one entry of the page was shortened: what reads more of it. */
  cut?: string;
}): string | undefined {
  const parts: string[] = [];
  const { offset, returned, total, nextOffset } = state;
  const same = `the same resultId${state.fields ? ' and fields' : ''}`;
  // nextOffset implies returned > 0: an offset at or past the end returns nothing and has no next one.
  if (nextOffset !== undefined && returned !== undefined && total !== undefined) {
    parts.push(`Incomplete: entries ${offset} to ${offset + returned - 1} of ${total}${state.short ? '' : ' (total exact)'}. `
      + `Call ${READ_RESULT_TOOL_NAME} again with ${same} and offset ${nextOffset}.`
      + (state.short ? '' : ' Before the rest is read, say nothing about the content of all entries (which match, all, none, only).'));
  }
  if (state.cut !== undefined) {
    const entry = parts.length > 0
      ? `Entry ${offset}`
      : `Incomplete: ${returned && total !== undefined ? `entry ${offset} of ${total}` : 'the answer'}`;
    parts.push(`${entry} is shortened (see _truncated); ${state.cut}.`);
  }
  if (state.unknown.count > 0) parts.push(unknownHint(state.unknown));
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Leaf values in `value`, counted up to `stop`. */
function countLeaves(value: unknown, stop: number, skipPlaceholders = false): number {
  let count = 0;
  const visit = (node: unknown): void => {
    if (count >= stop) return;
    if (Array.isArray(node)) node.forEach(visit);
    else if (typeof node === 'object' && node !== null) Object.values(node).forEach(visit);
    // What a cut puts in place of an object or array is not a value of the entry.
    else if (!(skipPlaceholders && typeof node === 'string' && node.startsWith('[omitted: '))) count += 1;
  };
  visit(value);
  return count;
}

function listedPositions(positions: number[]): string {
  return `${positions.slice(0, 5).join(', ')}${positions.length > 5 ? ', …' : ''}`;
}

/** Only the prefix of the id decides the instruction; the id itself is never echoed. */
function expired(resultId: string): Record<string, unknown> {
  const hint = resultId.startsWith(READ_RESULT_ID_PREFIX)
    ? 'This result is no longer available: results can only be read during the turn that produced them. '
      + 'Call the original tool again to get the data.'
    : 'This result is no longer available: results can only be read during the turn that produced them. '
      + 'Do not call the tool that produced it again, it has already run. Tell the user the remaining details '
      + 'are no longer available, or look them up with a read tool.';
  return { error: 'result_expired', hint };
}

const BUDGET_EXHAUSTED = Object.freeze({
  error: 'budget_exhausted',
  hint: 'The tool budget of this turn is used up. Do not read further; answer with what you have.',
});

const DENIED = Object.freeze({
  error: 'result_denied',
  hint: 'This result may not be read in this turn (the user or the permissions changed). Do not try to read it again.',
});

/** All of the result but `uiAction`, with the dominant array as the paged one. */
function defaultPaths(root: Record<string, unknown>): ParsedPath[] {
  const route = dominantArrayRoute(root);
  const paths: ParsedPath[] = [];
  const add = (keys: string[]) => {
    paths.push({ text: keys.join('.'), steps: keys.map((key) => ({ kind: 'key' as const, key })) });
  };
  const visit = (object: Record<string, unknown>, keys: string[]) => {
    for (const key of Object.keys(object)) {
      if (keys.length === 0 && key === 'uiAction') continue;
      const depth = keys.length;
      if (route && depth < route.length && route.slice(0, depth).every((part, index) => part === keys[index]) && route[depth] === key) {
        if (depth + 1 === route.length) add([...keys, key]);
        else visit(object[key] as Record<string, unknown>, [...keys, key]);
      } else {
        add([...keys, key]);
      }
    }
  };
  visit(root, []);
  return paths;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `prefix` selects the subtree `steps` reach (equal or above it). */
function selects(prefix: ReadonlyArray<PathStep>, steps: ReadonlyArray<PathStep>): boolean {
  return prefix.length <= steps.length && prefix.every((step, index) => {
    const other = steps[index]!;
    if (step.kind !== other.kind) return false;
    if (step.kind === 'key') return step.key === (other as { key: string }).key;
    if (step.kind === 'index') return step.index === (other as { index: number }).index;
    return true;
  });
}

/**
 * Adds the identity fields of each entry (`identityFieldsOf`, read from the
 * stored value, so always inside the tool's upper bound) to the entries of
 * the outermost array a selected path reads below (`data[].owner.name`,
 * `data[3].items`), so the model knows which entry each value belongs to.
 * Not for a path that selects whole entries, not for a field a selected path
 * already covers, not for an entry that is no object. Changes `value` (a
 * fresh projection or cut) in place; the identity fields come first.
 */
function identityAdder(
  source: Record<string, unknown>,
  known: ReadonlyArray<ParsedPath>,
  offset: number,
  entities?: ReadonlyArray<OutputEntityDeclaration>,
) {
  const targets = new Map<string, { route: string[]; step: PathStep }>();
  for (const path of known) {
    const at = path.steps.findIndex((step) => step.kind !== 'key');
    if (at < 0 || at === path.steps.length - 1) continue;
    const route = path.steps.slice(0, at).map((step) => (step as { key: string }).key);
    const step = path.steps[at]!;
    targets.set(JSON.stringify([route, step]), { route, step });
  }
  const covered = (steps: PathStep[]) => known.some((path) => selects(path.steps, steps));
  /** The declared identity fields of an entry, scalars only; the heuristic's without a declaration. */
  const identityOf = (original: Record<string, unknown>, declared: OutputEntityDeclaration | undefined): Array<[string, unknown]> => {
    if (!declared) return identityFieldsOf(original);
    return declaredIdentityKeys(declared)
      .filter((key) => Object.prototype.hasOwnProperty.call(original, key))
      .map((key): [string, unknown] => [key, original[key]])
      .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value));
  };
  const enrich = (entry: unknown, original: unknown, routeSteps: PathStep[], declared?: OutputEntityDeclaration): unknown => {
    if (!isPlainRecord(entry) || !isPlainRecord(original)) return entry;
    const added = identityOf(original, declared).filter(([key]) => (
      !Object.prototype.hasOwnProperty.call(entry, key) && !covered([...routeSteps, { kind: 'key', key }])
    ));
    if (added.length === 0) return entry;
    const output: Record<string, unknown> = {};
    for (const [key, field] of added) setOwn(output, key, field);
    for (const key of Object.keys(entry)) setOwn(output, key, entry[key]);
    return output;
  };
  return (value: Record<string, unknown>): Record<string, unknown> => {
    for (const { route, step } of targets.values()) {
      let projected: unknown = value;
      let original: unknown = source;
      let holder: Record<string, unknown> | undefined;
      let last = '';
      for (const key of route) {
        if (!isPlainRecord(projected) || !isPlainRecord(original)
          || !Object.prototype.hasOwnProperty.call(projected, key) || !Object.prototype.hasOwnProperty.call(original, key)) {
          projected = undefined;
          break;
        }
        holder = projected;
        last = key;
        projected = projected[key];
        original = original[key];
      }
      if (!holder || !Array.isArray(original)) continue;
      const routeSteps: PathStep[] = route.map((key) => ({ kind: 'key', key }));
      const declared = declarationForEntries(entities, route, source);
      if (step.kind === 'each' && Array.isArray(projected)) {
        const start = Math.min(offset, original.length);
        const entries = original;
        setOwn(holder, last, projected.map((entry, index) => enrich(entry, entries[start + index], [...routeSteps, step], declared)));
      } else if (step.kind === 'index' && isPlainRecord(projected)) {
        const key = String(step.index);
        if (Object.prototype.hasOwnProperty.call(projected, key)) {
          const copy: Record<string, unknown> = { ...projected };
          setOwn(copy, key, enrich(projected[key], original[step.index], [...routeSteps, step], declared));
          setOwn(holder, last, copy);
        }
      }
    }
    return value;
  };
}

/**
 * Adds the declared identity fields to entries of arrays nested below the
 * outermost one a selected path reads through (`playlists[].items[].duration`
 * with a declaration at `playlists[].items[]`). Only declared levels: below
 * the outermost array the guess never added identity, so an app without a
 * declaration reads as before. Projected entries are matched to the stored
 * ones by position (the outermost array from `offset`). Changes `value` in place.
 */
function nestedDeclaredIdentityAdder(
  source: Record<string, unknown>,
  known: ReadonlyArray<ParsedPath>,
  offset: number,
  entities: ReadonlyArray<OutputEntityDeclaration> | undefined,
) {
  const levels: Array<{ steps: PathStep[]; declared: OutputEntityDeclaration }> = [];
  const seen = new Set<string>();
  for (const path of known) {
    const first = path.steps.findIndex((step) => step.kind !== 'key');
    if (first < 0) continue;
    // Every deeper level a path reads below the outermost array, an array's entries (`items[]`)
    // or one object (`owner`); not the last step: a whole entry or object needs no identity.
    for (let at = first + 1; at < path.steps.length - 1; at += 1) {
      const prefix = path.steps.slice(0, at + 1);
      const text = prefix.map((step) => (step.kind === 'key' ? `.${step.key}` : '[]')).join('').replace(/^\./, '');
      const declared = entities?.find((declaration) => declaration.path === text);
      if (!declared || seen.has(JSON.stringify(prefix))) continue;
      seen.add(JSON.stringify(prefix));
      levels.push({ steps: prefix, declared });
    }
  }
  const keysOf = (declared: OutputEntityDeclaration) => declaredIdentityKeys(declared);
  const enrich = (entry: unknown, original: unknown, declared: OutputEntityDeclaration): unknown => {
    if (!isPlainRecord(entry) || !isPlainRecord(original)) return entry;
    const added = keysOf(declared).filter((key) => Object.prototype.hasOwnProperty.call(original, key)
      && !Object.prototype.hasOwnProperty.call(entry, key)
      && (original[key] === null || ['string', 'number', 'boolean'].includes(typeof original[key])));
    if (added.length === 0) return entry;
    const output: Record<string, unknown> = {};
    for (const key of added) setOwn(output, key, original[key]);
    for (const key of Object.keys(entry)) setOwn(output, key, entry[key]);
    return output;
  };
  return (value: Record<string, unknown>): Record<string, unknown> => {
    for (const { steps, declared } of levels) {
      const visit = (projected: unknown, original: unknown, index: number, outer: boolean): unknown => {
        const step = steps[index]!;
        const last = index === steps.length - 1;
        if (step.kind === 'key') {
          if (!isPlainRecord(projected) || !isPlainRecord(original)
            || !Object.prototype.hasOwnProperty.call(projected, step.key) || !Object.prototype.hasOwnProperty.call(original, step.key)) return projected;
          const child = last
            ? enrich(projected[step.key], original[step.key], declared)
            : visit(projected[step.key], original[step.key], index + 1, outer);
          if (child !== projected[step.key]) setOwn(projected, step.key, child);
          return projected;
        }
        if (step.kind === 'index') {
          if (!isPlainRecord(projected) || !Array.isArray(original)) return projected;
          const key = String(step.index);
          if (!Object.prototype.hasOwnProperty.call(projected, key)) return projected;
          const next = last ? enrich(projected[key], original[step.index], declared) : visit(projected[key], original[step.index], index + 1, false);
          if (next !== projected[key]) setOwn(projected, key, next);
          return projected;
        }
        if (!Array.isArray(projected) || !Array.isArray(original)) return projected;
        const start = outer ? Math.min(offset, original.length) : 0;
        return projected.map((entry, position) => (last
          ? enrich(entry, original[start + position], declared)
          : visit(entry, original[start + position], index + 1, false)));
      };
      visit(value, source, 0, true);
    }
    return value;
  };
}

/**
 * Projects a handle for one read, bounded by the origin tool's limit. A path
 * whose index is beyond its array answers `index_out_of_range` instead.
 */
export function readResultHandle(handle: ResultHandle, input: ReadResultInput, paths: ParsedPath[] | undefined): Record<string, unknown> {
  const source: Record<string, unknown> = {};
  for (const key of Object.keys(handle.value)) {
    if (key !== 'uiAction') setOwn(source, key, handle.value[key]);
  }
  const requested = paths ?? defaultPaths(source);
  const unknown: Array<{ position: number; path: ParsedPath }> = [];
  const known = requested.filter((path, index) => {
    const exists = resultPathExists(source, path.steps);
    if (!exists && paths) unknown.push({ position: index + 1, path });
    return exists;
  });
  const unknownFields: Array<string | number> = [];
  const parentKeys: Record<string, string[]> = {};
  for (const [listed, { position, path }] of unknown.entries()) {
    // Keys are gathered only for a path that may still get parentKeys; every path is checked for its index.
    const wantsKeys = listed < MAX_LISTED_UNKNOWN && Object.keys(parentKeys).length < MAX_LISTED_PARENTS;
    const missing = describeMissingPath(source, path.steps, wantsKeys);
    const parentSteps = path.steps.slice(0, missing.reached);
    if (missing.arrayLength !== undefined) {
      const step = path.steps[missing.reached] as { kind: 'index'; index: number };
      const array = parentSteps.length > 0 ? echoablePath(parentSteps) : undefined;
      const most = parentSteps.some((parentStep) => parentStep.kind === 'each') ? 'at most ' : '';
      return {
        error: 'index_out_of_range',
        hint: `Field path number ${position}${array ? ` (${array})` : ''} selects entry ${step.index}, but `
          + (missing.arrayLength > 0
            ? `the array there has ${most}${missing.arrayLength} entries: use an index from 0 to ${missing.arrayLength - 1}.`
            : 'the array there is empty.'),
      };
    }
    if (listed >= MAX_LISTED_UNKNOWN) continue;
    unknownFields.push(echoablePath(path.steps) ?? position);
    if (!wantsKeys || parentSteps.length === 0) continue;
    const parent = echoablePath(missing.entryKeys ? [...parentSteps, { kind: 'each' }] : parentSteps);
    const keys = missing.keys.filter(echoableKey).slice(0, MAX_LISTED_PARENT_KEYS);
    if (parent && keys.length > 0 && !Object.prototype.hasOwnProperty.call(parentKeys, parent)) setOwn(parentKeys, parent, keys);
  }
  const hasParentKeys = Object.keys(parentKeys).length > 0;
  const offset = input.offset ?? 0;
  const fits = (output: unknown) => (JSON.stringify(output)?.length ?? 0) <= handle.maxChars;
  const positions = unknownFields.some((field) => typeof field === 'number');
  /** `detail`: 2 with `parentKeys`, 1 with `unknownFields`, 0 with `unknownCount` only. */
  const unknownState = (detail: 0 | 1 | 2): UnknownState => ({
    count: unknown.length, listed: detail > 0 && unknownFields.length > 0, positions, parentKeys: detail === 2 && hasParentKeys,
  });
  const unknownParts = (detail: 0 | 1 | 2) => ({
    ...(detail > 0 && unknownFields.length > 0 ? { unknownFields } : {}),
    // Without the list, the count still says that some paths matched nothing.
    ...(unknown.length > 0 && (detail === 0 || unknown.length > MAX_LISTED_UNKNOWN) ? { unknownCount: unknown.length } : {}),
    ...(detail === 2 && hasParentKeys ? { parentKeys } : {}),
  });

  // Nothing requested exists: an error, so a managed turn counts it as one.
  if (paths && known.length === 0) {
    for (const detail of [2, 1, 0] as const) {
      const output = { error: 'unknown_fields', ...unknownParts(detail), hint: unknownHint(unknownState(detail), true) };
      if (detail === 0 || fits(output)) return output;
    }
  }

  /**
   * `detail`: 2 with every optional marker part, 1 without `parentKeys`, 0
   * also without `arrays` and `unknownFields` (then `unknownCount`). The
   * hint is part of every level: it outranks entries. `mode`: the hint
   * without the sentence about all entries (`short`), or for a shortened
   * entry (`cut`, with what reads more of it).
   */
  // Identity fields of the entries read below an array: only when the model chose the fields.
  const outerIdentity = paths ? identityAdder(source, known, offset, handle.entities) : undefined;
  const nestedIdentity = paths ? nestedDeclaredIdentityAdder(source, known, offset, handle.entities) : undefined;
  const addIdentity = (value: Record<string, unknown>): Record<string, unknown> => (
    outerIdentity ? nestedIdentity!(outerIdentity(value)) : value);
  const answer = (limit: number | undefined, detail: 0 | 1 | 2, mode?: { short: true } | { cut: string }, identity = true) => {
    const projection = projectResult(source, known, { offset, ...(limit !== undefined ? { limit } : {}) });
    // They count against the limit like all data: the fit loop below sees them.
    if (identity) addIdentity(projection.value);
    // The array with the most entries decides the paging: with one window for all, it has more iff any has.
    const primary = projection.slices.reduce<typeof projection.slices[number] | undefined>(
      (best, slice) => (!best || slice.total > best.total ? slice : best), undefined,
    );
    const nextOffset = primary && offset + primary.returned < primary.total ? offset + primary.returned : undefined;
    const hint = readHint({
      offset,
      ...(primary ? { returned: primary.returned, total: primary.total } : {}),
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      fields: paths !== undefined,
      unknown: unknownState(detail),
      ...(mode && 'short' in mode ? { short: true } : {}),
      ...(mode && 'cut' in mode ? { short: true, cut: mode.cut } : {}),
    });
    const marker: ReadResultMarker = {
      id: handle.id,
      offset,
      ...(primary ? { returned: primary.returned, total: primary.total } : {}),
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      ...(detail > 0 && projection.slices.length > 1
        ? {
            arrays: Object.fromEntries(projection.slices.slice(0, MAX_LISTED_ARRAYS)
              .map((slice) => [listedPath(slice.path), { returned: slice.returned, total: slice.total }])),
          }
        : {}),
      ...unknownParts(detail),
      ...(hint !== undefined ? { hint } : {}),
    };
    const output: Record<string, unknown> = { ...projection.value };
    setOwn(output, '_result', marker);
    return { output, primary, value: projection.value, marker };
  };

  // The nearest parents only when they fit next to the whole page.
  if (hasParentKeys) {
    const full = answer(input.limit, 2);
    if (fits(full.output)) return full.output;
  }
  for (const detail of [1, 0] as const) {
    const full = answer(input.limit, detail);
    if (fits(full.output)) return full.output;
    // Fewer entries per page until the answer fits.
    if (full.primary && full.primary.returned > 1) {
      let low = 1;
      let high = full.primary.returned - 1;
      let best: ReturnType<typeof answer> | undefined;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = answer(mid, detail);
        if (fits(candidate.output)) {
          best = candidate;
          low = mid + 1;
        } else high = mid - 1;
      }
      if (best) return best.output;
    }
  }
  // One entry with the short hint.
  const short = answer(1, 0, { short: true });
  if (fits(short.output)) return short.output;
  // Not even that fits: cut that one entry like any large result. The cut hint holds the short one,
  // so the cut always shortens something.
  const leaves = countLeaves(answer(1, 0, { short: true }, false).value, 2);
  const remedy = leaves <= 1
    ? 'it cannot be read in full'
    : known.length === 1 && paths ? 'for more, read a narrower path below it' : 'for more, select fewer fields';
  // The entry is cut without its identity fields, which are added back after the cut: they are the
  // last thing of an entry to go (only when nothing of the entry fits next to them).
  const single = answer(1, 0, { cut: remedy }, false);
  const identityChars = JSON.stringify(addIdentity(JSON.parse(JSON.stringify(single.value)) as Record<string, unknown>)).length
    - JSON.stringify(single.value).length;
  const markerChars = JSON.stringify(single.marker).length + 12;
  const pageLeaves = countLeaves(single.value, 1);
  /**
   * The cut within `budget`, or undefined when it holds nothing of the page.
   * `_truncated` keeps only what was cut: no hint of its own (`_result.hint`
   * is the one instruction) and, for the paged array, no field, showing or
   * total (`_result` has them; the cut saw a one-entry page). `freed` is the
   * space that removal gave back.
   */
  const cutWithin = (budget: number, identity: boolean) => {
    const reserve = identity ? identityChars : 0;
    const cut = truncateToolResult(single.value, Math.max(1, budget - reserve), { readOnly: true }) as Record<string, unknown>;
    const output: Record<string, unknown> = { ...cut };
    const marker = output._truncated as { field?: string; showing?: number; total?: number; hint?: string } | undefined;
    if (!marker) return { freed: 0 };
    // The cut names its array with dots ("data.0.items"), the page with brackets ("data[0].items").
    const paged = single.primary !== undefined
      && marker.field === single.primary.path.replace(/\[(\d+)\]/g, '.$1');
    const { hint: _hint, field, showing, total, ...rest } = marker;
    const kept = paged ? rest : { ...(field !== undefined ? { field, showing, total } : {}), ...rest };
    const freed = JSON.stringify(marker).length - JSON.stringify(kept).length;
    delete output._truncated;
    if ((paged && showing === 0) || (pageLeaves > 0 && countLeaves(output, 1, true) === 0)) return { freed };
    if (identity) addIdentity(output);
    output._truncated = kept;
    setOwn(output, '_result', single.marker);
    return { output: fits(output) ? output : undefined, freed };
  };
  // The space the removed marker parts took goes back to the entry (a few passes; deterministic).
  // First with the identity fields kept; only when that holds nothing, without them.
  let best: Record<string, unknown> | undefined;
  for (const identity of identityChars > 0 ? [true, false] : [false]) {
    let budget = handle.maxChars - markerChars;
    for (let pass = 0; pass < 3; pass += 1) {
      const attempt = cutWithin(budget, identity);
      if (attempt.output) best = attempt.output;
      if (attempt.freed === 0) break;
      budget += attempt.freed;
    }
    if (best) return best;
  }
  // The last resort always fits the smallest limit: the marker and a short instruction.
  const entry = single.primary && single.primary.returned > 0 ? `entry ${offset} of ${single.primary.total}` : 'the selection';
  const next = single.marker.nextOffset;
  return {
    _result: {
      id: handle.id, offset,
      ...(single.primary ? { returned: 0, total: single.primary.total } : {}),
      ...(next !== undefined ? { nextOffset: next } : {}),
      ...(unknown.length > 0 ? { unknownCount: unknown.length } : {}),
      hint: `Incomplete: ${entry} does not fit the size limit even shortened; select fewer or narrower fields.`
        + (next !== undefined ? ` Next entries: offset ${next}.` : '')
        + (unknown.length > 0 ? ` ${unknownHint(unknownState(0))}` : ''),
    },
  };
}

/**
 * Creates the `read_result` tool for one turn's store. Its own results are
 * marked as issued (cut from sealed data), so `toolToAiTool` never makes a
 * handle of them and the PII shield does not seal them again.
 */
export function createReadResultTool(store: ResultStore, guard: ReadResultGuard = {}): Tool {
  const tool = defineTool({
    id: READ_RESULT_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: ReadResultInputSchema,
    // Its answers are bounded by the origin tool's limit, which may exceed the global one.
    maxResultChars: MAX_MAX_RESULT_CHARS,
    ...(guard.precheck
      ? {
          needsApproval: async (input: ReadResultInput) => {
            const handle = store.get(input.resultId);
            if (handle) await guard.precheck!({ handle, input });
            return false;
          },
        }
      : {}),
    execute: async (input) => {
      const budgetExhausted = () => ({ ...BUDGET_EXHAUSTED, hint: guard.budgetExhaustedHint?.() ?? BUDGET_EXHAUSTED.hint });
      let paths: ParsedPath[] | undefined;
      if (input.fields && input.fields.length > 0) {
        paths = [];
        const invalid: number[] = [];
        input.fields.forEach((text, index) => {
          const parsed = parseResultPath(text);
          // "**.key" is no read path (only outputDeniedFields knows it): invalid, never a field named "**".
          if (parsed && !isAnyDepthForm(parsed.steps)) paths!.push(parsed);
          else invalid.push(index + 1);
        });
        if (invalid.length > 0) {
          if (await guard.failedRead?.() === 'budget_exhausted') return budgetExhausted();
          return {
            error: 'invalid_fields',
            hint: `Field path(s) number ${listedPositions(invalid)} are not valid. ${INVALID_FIELDS_FORMS}`,
          };
        }
        const mixed = mixedArraySelections(paths);
        if (mixed.length > 0) {
          if (await guard.failedRead?.() === 'budget_exhausted') return budgetExhausted();
          return {
            error: 'invalid_fields',
            hint: `Field paths number ${listedPositions(mixed)} select both every entry ("[]") and single entries ("[2]") `
              + 'of the same array, which one call cannot combine: read them in separate calls. '
              + INVALID_FIELDS_FORMS,
          };
        }
      }
      const handle = store.get(input.resultId);
      if (!handle) {
        if (await guard.failedRead?.() === 'budget_exhausted') return budgetExhausted();
        return expired(input.resultId);
      }
      const decision = await guard.beforeRead?.({ handle, input });
      if (decision === 'denied') return { ...DENIED };
      if (decision === 'budget_exhausted') return budgetExhausted();
      const startedAt = Date.now();
      // A private copy: nothing of the stored result leaves by reference.
      const result = JSON.parse(JSON.stringify(readResultHandle(handle, input, paths))) as Record<string, unknown>;
      store.markIssued(result);
      await guard.afterRead?.({ handle, input, result, durationMs: Date.now() - startedAt });
      return result;
    },
  });
  RESULT_READERS.add(tool);
  return tool;
}

const RESULT_READERS = new WeakSet<object>();

/** Whether `tool` is a `read_result` instance (it needs no owner capture: it never creates a handle). */
export function isResultReader(tool: unknown): boolean {
  return typeof tool === 'object' && tool !== null && RESULT_READERS.has(tool);
}
