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
import { dominantArrayRoute } from './result-overview.js';
import {
  MAX_RESULT_PATH_CHARS,
  MAX_RESULT_PATHS,
  parseResultPath,
  projectResult,
  resultPathExists,
  setOwn,
  type ParsedPath,
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
  /** Entries of the paged array in this answer. */
  returned?: number;
  /** Entries the paged array has. */
  total?: number;
  /** The `offset` of the next page, when there are further entries. */
  nextOffset?: number;
  /** Every paged array with its length (at most five, paths shortened), when more than one was paged. */
  arrays?: Record<string, number>;
  /**
   * Positions (1-based, at most ten) of requested paths that select nothing.
   * Never the paths themselves: the answer is not shielded again, so nothing
   * the model wrote comes back verbatim.
   */
  unknownFields?: number[];
  /** How many requested paths select nothing, when more than ten. */
  unknownCount?: number;
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
   * A call that reads nothing (unknown or expired id, invalid fields):
   * counted as a tool call and an error of the turn. `'budget_exhausted'`
   * answers that the turn's budget is used up instead.
   */
  failedRead?: () => Promise<'budget_exhausted' | void>;
}

const DESCRIPTION = 'Read more of a large tool result that was shown as an overview with a "_result" marker: '
  + 'omitted fields or further entries. Pass its resultId, optionally "fields" (paths such as "data[].name", '
  + '"data[].owner.name" or "meta"; "[]" means every element of an array) and "offset"/"limit" for the entries. '
  + 'Works only within the current turn and never calls the original tool again.';

const MAX_LISTED_UNKNOWN = 10;
const MAX_LISTED_ARRAYS = 5;
const MAX_LISTED_PATH_CHARS = 120;

function listedPath(text: string): string {
  return text.length > MAX_LISTED_PATH_CHARS ? `${text.slice(0, MAX_LISTED_PATH_CHARS - 1)}…` : text;
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

/** Projects a handle for one read, bounded by the origin tool's limit. */
export function readResultHandle(handle: ResultHandle, input: ReadResultInput, paths: ParsedPath[] | undefined): Record<string, unknown> {
  const source: Record<string, unknown> = {};
  for (const key of Object.keys(handle.value)) {
    if (key !== 'uiAction') setOwn(source, key, handle.value[key]);
  }
  const requested = paths ?? defaultPaths(source);
  const unknown: number[] = [];
  const known = requested.filter((path, index) => {
    const exists = resultPathExists(source, path.steps);
    if (!exists && paths) unknown.push(index + 1);
    return exists;
  });
  const offset = input.offset ?? 0;
  const fits = (output: unknown) => (JSON.stringify(output)?.length ?? 0) <= handle.maxChars;

  /** `detailed`: with the optional marker parts (`arrays`, `unknownFields`); they go first when space runs out. */
  const answer = (limit: number | undefined, detailed: boolean) => {
    const projection = projectResult(source, known, { offset, ...(limit !== undefined ? { limit } : {}) });
    const primary = projection.slices[0];
    const marker: ReadResultMarker = {
      id: handle.id,
      offset,
      ...(primary ? { returned: primary.returned, total: primary.total } : {}),
      ...(primary && offset + primary.returned < primary.total ? { nextOffset: offset + primary.returned } : {}),
      ...(detailed && projection.slices.length > 1
        ? {
            arrays: Object.fromEntries(projection.slices.slice(0, MAX_LISTED_ARRAYS)
              .map((slice) => [listedPath(slice.path), slice.total])),
          }
        : {}),
      ...(detailed && unknown.length > 0 ? { unknownFields: unknown.slice(0, MAX_LISTED_UNKNOWN) } : {}),
      ...(detailed && unknown.length > MAX_LISTED_UNKNOWN ? { unknownCount: unknown.length } : {}),
    };
    const output: Record<string, unknown> = { ...projection.value };
    setOwn(output, '_result', marker);
    return { output, primary, value: projection.value, marker };
  };

  for (const detailed of [true, false]) {
    const full = answer(input.limit, detailed);
    if (fits(full.output)) return full.output;
    // Fewer entries per page until the answer fits.
    if (full.primary && full.primary.returned > 1) {
      let low = 1;
      let high = full.primary.returned - 1;
      let best: ReturnType<typeof answer> | undefined;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = answer(mid, detailed);
        if (fits(candidate.output)) {
          best = candidate;
          low = mid + 1;
        } else high = mid - 1;
      }
      if (best) return best.output;
    }
  }
  // Not even one entry fits: cut that one entry like any large result.
  const single = answer(1, false);
  const markerChars = JSON.stringify(single.marker).length + 12;
  const cut = truncateToolResult(single.value, Math.max(1, handle.maxChars - markerChars), {
    readOnly: true,
    nextStep: `Select fewer fields with ${READ_RESULT_TOOL_NAME} (fields), or read the next entries with a higher offset.`,
  }) as Record<string, unknown>;
  const output: Record<string, unknown> = { ...cut };
  setOwn(output, '_result', single.marker);
  if (fits(output)) return output;
  // The last resort always fits the smallest limit: the marker and a short instruction.
  return {
    _result: { id: handle.id, offset, ...(single.primary ? { total: single.primary.total } : {}) },
    hint: 'The selection does not fit the size limit. Select fewer fields or deeper paths.',
  };
}

/**
 * Creates the `read_result` tool for one turn's store. Its own results are
 * marked as issued (cut from sealed data), so `toolToAiTool` never makes a
 * handle of them and the PII shield does not seal them again.
 */
export function createReadResultTool(store: ResultStore, guard: ReadResultGuard = {}): Tool {
  return defineTool({
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
      let paths: ParsedPath[] | undefined;
      if (input.fields && input.fields.length > 0) {
        paths = [];
        const invalid: number[] = [];
        input.fields.forEach((text, index) => {
          const parsed = parseResultPath(text);
          if (parsed) paths!.push(parsed);
          else invalid.push(index + 1);
        });
        if (invalid.length > 0) {
          if (await guard.failedRead?.() === 'budget_exhausted') return { ...BUDGET_EXHAUSTED };
          return {
            error: 'invalid_fields',
            hint: `Field path(s) number ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ', …' : ''} are not valid. `
              + 'Join field names with "." and add "[]" to read every element of an array, e.g. "data[].name" or "meta".',
          };
        }
      }
      const handle = store.get(input.resultId);
      if (!handle) {
        if (await guard.failedRead?.() === 'budget_exhausted') return { ...BUDGET_EXHAUSTED };
        return expired(input.resultId);
      }
      const decision = await guard.beforeRead?.({ handle, input });
      if (decision === 'denied') return { ...DENIED };
      if (decision === 'budget_exhausted') return { ...BUDGET_EXHAUSTED };
      const startedAt = Date.now();
      // A private copy: nothing of the stored result leaves by reference.
      const result = JSON.parse(JSON.stringify(readResultHandle(handle, input, paths))) as Record<string, unknown>;
      store.markIssued(result);
      await guard.afterRead?.({ handle, input, result, durationMs: Date.now() - startedAt });
      return result;
    },
  });
}
