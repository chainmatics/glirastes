/**
 * The default view of a tool result when no result handle can be created
 * (no result store: `resultHandles: false`, a direct command, `toolsToAiTools`
 * without a store, a registry tool named `read_result`; or a store that
 * refuses it: handle or size limits). The view is applied all the same; what
 * it leaves out cannot be read in this turn, so the answer does not point to
 * `read_result`. Pure and deterministic.
 */
import { isSelectablePath } from './result-paths.js';
import { leftOutFields, projectOutputFields, type OutputFieldNode } from './output-fields.js';
import { approx } from './result-overview.js';
import { truncateToolResult, type TruncatedMarker } from './truncate-tool-result.js';

const MAX_LISTED_OMITTED = 20;
const MAX_LISTED_PATH_CHARS = 120;

/** The `_truncated` marker of a default view without a handle. */
export interface DefaultViewMarker extends TruncatedMarker {
  /** Fields the default view left out, largest first, with their approximate size (no `keys`). */
  omitted?: Array<{ path: string; approxChars: number }>;
  /** Further left-out fields: beyond the listed ones, or not writable as a path. */
  omittedMore?: number;
}

function viewHint(readOnly: boolean): string {
  return 'Default view: the fields in omitted are left out of this result and cannot be read in this turn. '
    + 'Do not infer them from other fields; say they are not known.'
    + (readOnly
      ? ' Calling the tool again shows the same fields.'
      : ' The tool has already run: do not call it again to see them.');
}

/**
 * `value` (a successful record result, already within `outputAllowedFields`)
 * reduced to the default view `tree`, within `maxChars` like
 * `truncateToolResult`. When the view leaves something out, a `_truncated`
 * marker lists it (`omitted`, at most twenty paths and a quarter of the
 * limit, the rest counted in `omittedMore`) with a hint that it cannot be
 * read; when the view itself is too large, it is cut and the marker of the
 * cut carries the same fields. Returns undefined when the view leaves
 * nothing out (the caller handles the result as before).
 */
export function applyDefaultViewWithoutStore(
  value: Record<string, unknown>,
  tree: OutputFieldNode,
  maxChars: number,
  options: { readOnly: boolean; inputSchema?: unknown },
): Record<string, unknown> | undefined {
  const fields = leftOutFields(value, tree);
  if (fields.length === 0) return undefined;
  const view = projectOutputFields(value, tree);
  const listable = fields.filter((field) => isSelectablePath(field.steps, MAX_LISTED_PATH_CHARS));
  const hint = viewHint(options.readOnly);
  const noteOf = (count: number): { omitted?: Array<{ path: string; approxChars: number }>; omittedMore?: number } => {
    const omitted = listable.slice(0, count).map((field) => ({ path: field.path, approxChars: approx(field.size) }));
    return {
      ...(omitted.length > 0 ? { omitted } : {}),
      ...(fields.length > omitted.length ? { omittedMore: fields.length - omitted.length } : {}),
    };
  };
  // The list takes at most a quarter of the limit; the hint always stays.
  let count = Math.min(MAX_LISTED_OMITTED, listable.length);
  while (count > 0 && JSON.stringify(noteOf(count)).length > Math.floor(maxChars / 4)) count -= 1;
  const note = noteOf(count);
  const reserved = JSON.stringify({ ...note, hint }).length + 16;
  const cut = truncateToolResult(view, Math.max(1, maxChars - reserved), {
    readOnly: options.readOnly,
    ...(options.inputSchema !== undefined ? { inputSchema: options.inputSchema } : {}),
  }) as Record<string, unknown>;
  const cutMarker = cut !== view ? cut._truncated as TruncatedMarker | undefined : undefined;
  const marker: DefaultViewMarker = cutMarker
    ? { ...cutMarker, ...note, hint: `${cutMarker.hint} ${hint}` }
    : { ...note, hint };
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(cut)) {
    if (key !== '_truncated') Object.defineProperty(output, key, { value: cut[key], writable: true, enumerable: true, configurable: true });
  }
  Object.defineProperty(output, '_truncated', { value: marker, writable: true, enumerable: true, configurable: true });
  return output;
}
