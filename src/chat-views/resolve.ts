/**
 * Chat Views reference resolution: turns a validated `render_view` spec into
 * a self-contained `ResolvedChatView` by reading every reference from the tool
 * results of the conversation. Only referenced fields reach the view, table
 * rows are capped and the whole projection is size-capped. Values are copied
 * as they are (shielded values stay shielded; nothing is rehydrated).
 * Neutral module: the caller supplies the tool results through a lookup.
 */
import {
  CHAT_VIEW_LIMITS,
  type ChatComponentManifest,
  type ChatComponentManifestEntry,
  type ChatValueRef,
  type ChatViewSpec,
  type ResolvedChatView,
} from '../contracts/chat-view.js';
import {
  describeMissingPath,
  formatResultPath,
  isAnyDepthForm,
  parseResultPath,
  readResultPath,
  resultPathExists,
  setOwn,
  type PathStep,
} from '../contracts/result-paths.js';
import { cellIdFields, chatRefKind, resolveChatComponentEntry } from './validate.js';

/** A tool result a view may reference. */
export interface ChatViewSource {
  toolName: string;
  /** The result as the model saw it, or the full result when the server holds it. */
  value: unknown;
  /**
   * Whether `value` is a cut or overview form of the result (it carries a
   * `_truncated` or `_result` marker), so a missing field may exist in the
   * full result.
   */
  truncated: boolean;
}

/** Finds the result of a tool call of this conversation; undefined when there is none. */
export type ChatViewSourceLookup = (toolCallId: string) => Promise<ChatViewSource | undefined>;

export type ChatViewResolution =
  | { ok: true; view: ResolvedChatView; sources: string[] }
  | { ok: false; errors: string[] };

const MAX_REPORTED_ERRORS = 20;
const MAX_LISTED_FIELDS = 20;
const TOO_LARGE = 'view too large; reference fewer fields or rows';

type Json = Record<string, unknown>;
type ResolvedElement = ResolvedChatView['elements'][string];

/** Marks a value left out of the output (a `$item` outside a row, a field a row lacks). */
const OMIT = Symbol('omit');

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Call ids of all references in `value`, in document order. */
function collectCallIds(value: unknown, into: string[]): void {
  const kind = chatRefKind(value);
  if (kind === '$ref') into.push((value as ChatValueRef).$ref);
  else if (kind === '$count' || kind === '$sum') collectCallIds((value as Json)[kind], into);
  else if (kind === '$said') collectCallIds((value as Json).basis, into);
  else if (kind === '$item') return;
  else if (Array.isArray(value)) for (const item of value) collectCallIds(item, into);
  else if (isRecord(value)) for (const child of Object.values(value)) collectCallIds(child, into);
}

/** Every `$item` path in `value`. */
function collectItemPaths(value: unknown, into: string[]): void {
  const kind = chatRefKind(value);
  if (kind === '$item') into.push((value as { $item: string }).$item);
  else if (kind) return;
  else if (Array.isArray(value)) for (const item of value) collectItemPaths(item, into);
  else if (isRecord(value)) for (const child of Object.values(value)) collectItemPaths(child, into);
}

interface TableRows {
  rows: unknown[];
  /** Steps that reach every row (`data[]`), for naming `$item` paths in errors. */
  rowSteps: PathStep[];
}

/**
 * Resolves a spec that passed `validateChatViewSpec` against the same
 * manifest. Every source is looked up once, in order of first use.
 */
export async function resolveChatView(
  spec: ChatViewSpec,
  manifest: ChatComponentManifest,
  lookup: ChatViewSourceLookup,
): Promise<ChatViewResolution> {
  const ids = Object.keys(spec.elements);
  const order: string[] = [];
  for (const id of ids) collectCallIds(spec.elements[id]!.props, order);
  const sources = new Map<string, ChatViewSource | undefined>();
  for (const callId of order) {
    if (!sources.has(callId)) sources.set(callId, await lookup(callId));
  }

  const errors = new Set<string>();
  const entries = new Map<string, ChatComponentManifestEntry>();
  for (const id of ids) {
    const type = spec.elements[id]!.type;
    const entry = resolveChatComponentEntry(manifest, type);
    if (entry) entries.set(id, entry);
    else errors.add(`element "${id}": unknown component "${type}"`);
  }

  const missingMessage = (path: string, callId: string, source: ChatViewSource, steps: PathStep[]) => {
    if (source.truncated) {
      return `path "${path}" is not in the shown result of ${callId}; call read_result for these fields first, then reference the read_result call`;
    }
    const info = describeMissingPath(source.value, steps);
    const parent = formatResultPath(steps.slice(0, info.reached)) + (info.entryKeys ? '[]' : '');
    const fields = info.keys.slice(0, MAX_LISTED_FIELDS).join(', ');
    const where = parent ? `at "${parent}"` : 'at the top level';
    return `path "${path}" is not in the result of ${callId}${fields ? ` (fields ${where}: ${fields})` : ''}`;
  };

  const invalidPath = (path: string) =>
    `path "${path}" is not a valid path; use field names joined by "." and [] for list entries, e.g. data[].total`;

  /** Reads a `$ref`; undefined (with an error) when it does not resolve. */
  const readRef = (
    ref: ChatValueRef,
    report: (message: string) => void,
  ): { value: unknown; steps: PathStep[]; source: ChatViewSource } | undefined => {
    const source = sources.get(ref.$ref);
    if (!source) {
      report(`no tool result "${ref.$ref}" in this conversation`);
      return undefined;
    }
    const parsed = parseResultPath(ref.path);
    if (!parsed || isAnyDepthForm(parsed.steps)) {
      report(invalidPath(ref.path));
      return undefined;
    }
    const read = readResultPath(source.value, parsed.steps);
    if (!read.found) {
      report(missingMessage(ref.path, ref.$ref, source, parsed.steps));
      return undefined;
    }
    return { value: read.value, steps: parsed.steps, source };
  };

  const readOperator = (kind: '$count' | '$sum', ref: ChatValueRef, report: (message: string) => void): unknown => {
    const read = readRef(ref, report);
    if (!read) return OMIT;
    if (read.source.truncated) {
      report(
        `"${kind}" over ${ref.$ref} would use only the shown part of a cut result; call read_result for the full list first, then reference the read_result call`,
      );
      return OMIT;
    }
    if (!Array.isArray(read.value)) {
      report(`"${kind}" needs a list; path "${ref.path}" of ${ref.$ref} is not a list`);
      return OMIT;
    }
    if (kind === '$count') return read.value.length;
    if (!read.value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
      report(`"$sum" needs numbers; path "${ref.path}" of ${ref.$ref} holds a value that is not a number`);
      return OMIT;
    }
    return (read.value as number[]).reduce((sum, item) => sum + item, 0);
  };

  /**
   * Resolves the references in `value`. With `row`, `$item` reads from that
   * row (a field the row lacks is left out); without, `$item` is left out.
   */
  const resolveValue = (
    value: unknown,
    row: { value: unknown } | undefined,
    report: (message: string) => void,
    flags: { said: boolean },
  ): unknown => {
    const kind = chatRefKind(value);
    if (kind === '$ref') {
      const read = readRef(value as ChatValueRef, report);
      return read ? read.value : OMIT;
    }
    if (kind === '$item') {
      if (!row) return OMIT;
      const parsed = parseResultPath((value as { $item: string }).$item);
      if (!parsed) return OMIT;
      const read = readResultPath(row.value, parsed.steps);
      return read.found ? read.value : OMIT;
    }
    if (kind === '$count' || kind === '$sum') {
      return readOperator(kind, (value as Json)[kind] as ChatValueRef, report);
    }
    if (kind === '$said') {
      const said = value as { $said: string; basis: ChatValueRef };
      if (!readRef(said.basis, report)) return OMIT;
      flags.said = true;
      return said.$said;
    }
    if (Array.isArray(value)) {
      return value.map((item) => {
        const resolved = resolveValue(item, row, report, flags);
        return resolved === OMIT ? null : resolved;
      });
    }
    if (isRecord(value)) {
      const output: Json = {};
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        const resolved = resolveValue(child, row, report, flags);
        if (resolved !== OMIT) setOwn(output, key, resolved);
      }
      return output;
    }
    return value;
  };

  // Tables first: their rows scope the `$item` references of their cell elements.
  const tables = new Map<string, TableRows>();
  const cellsOf = new Map<string, string[]>();
  for (const [id, entry] of entries) {
    const scope = entry.itemScope;
    if (!scope) continue;
    const element = spec.elements[id]!;
    const label = `element "${id}" (${entry.id})`;
    const report = (message: string) => errors.add(`${label}: ${message}`);
    const rowsRef = element.props[scope.rowsProp];
    if (chatRefKind(rowsRef) !== '$ref') {
      report(`${scope.rowsProp} needs a reference {"$ref": "<toolCallId>", "path": "…"}`);
      continue;
    }
    const read = readRef(rowsRef as ChatValueRef, report);
    if (!read) continue;
    if (!Array.isArray(read.value)) {
      report(`path "${(rowsRef as ChatValueRef).path}" of ${(rowsRef as ChatValueRef).$ref} is not a list`);
      continue;
    }
    const rowSteps: PathStep[] = read.steps.some((step) => step.kind === 'each')
      ? read.steps
      : [...read.steps, { kind: 'each' }];
    tables.set(id, { rows: read.value, rowSteps });
    const cells: string[] = [];
    const columns = element.props[scope.cellsProp];
    const fields = cellIdFields(entry);
    if (Array.isArray(columns)) {
      for (const column of columns) {
        if (!isRecord(column)) continue;
        for (const field of fields) {
          if (typeof column[field] === 'string' && spec.elements[column[field] as string]) {
            cells.push(column[field] as string);
          }
        }
      }
    }
    cellsOf.set(id, cells);

    // A `$item` path must exist in at least one row: a typo is an error, not empty cells.
    for (const cellId of cells) {
      const cellEntry = entries.get(cellId);
      const reportCell = (message: string) =>
        errors.add(`element "${cellId}"${cellEntry ? ` (${cellEntry.id})` : ''}: ${message}`);
      const itemPaths: string[] = [];
      collectItemPaths(spec.elements[cellId]!.props, itemPaths);
      for (const itemPath of itemPaths) {
        const parsed = parseResultPath(itemPath);
        if (!parsed || isAnyDepthForm(parsed.steps)) {
          reportCell(invalidPath(itemPath));
          continue;
        }
        if (read.value.length === 0) continue;
        if (!resultPathExists(read.value, [{ kind: 'each' }, ...parsed.steps])) {
          const steps = [...rowSteps, ...parsed.steps];
          reportCell(missingMessage(formatResultPath(steps), (rowsRef as ChatValueRef).$ref, read.source, steps));
        }
      }
    }
  }

  const elements: Record<string, ResolvedElement> = {};
  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry) continue;
    const element = spec.elements[id]!;
    const label = `element "${id}" (${entry.id})`;
    const report = (message: string) => errors.add(`${label}: ${message}`);
    const flags = { said: false };
    const scope = entry.itemScope;
    const ownProps = scope
      ? Object.fromEntries(Object.entries(element.props).filter(([key]) => key !== scope.rowsProp))
      : element.props;
    const props = resolveValue(ownProps, undefined, report, flags) as Json;
    const resolved: ResolvedElement = { type: entry.id, schemaVersion: entry.schemaVersion, props };
    if (element.children) resolved.children = [...element.children];

    const table = tables.get(id);
    if (table) {
      const shown = table.rows.slice(0, CHAT_VIEW_LIMITS.maxTableRows);
      if (table.rows.length > shown.length) props.truncatedRows = table.rows.length - shown.length;
      resolved.rows = shown.map((row) => {
        const output: Json = {};
        for (const cellId of cellsOf.get(id) ?? []) {
          const cellEntry = entries.get(cellId);
          const reportCell = (message: string) =>
            errors.add(`element "${cellId}"${cellEntry ? ` (${cellEntry.id})` : ''}: ${message}`);
          setOwn(output, cellId, resolveValue(spec.elements[cellId]!.props, { value: row }, reportCell, { said: false }));
        }
        return output;
      });
    }
    if (flags.said) resolved.said = true;
    setOwn(elements, id, resolved);
  }

  if (errors.size > 0) {
    const list = [...errors];
    return {
      ok: false,
      errors:
        list.length <= MAX_REPORTED_ERRORS
          ? list
          : [...list.slice(0, MAX_REPORTED_ERRORS), `… and ${list.length - MAX_REPORTED_ERRORS} more errors`],
    };
  }

  const view: ResolvedChatView = {
    v: 1,
    root: spec.root,
    ...(spec.caption !== undefined ? { caption: spec.caption } : {}),
    elements,
  };
  const serialized = JSON.stringify(view);
  if (new TextEncoder().encode(serialized).length > CHAT_VIEW_LIMITS.maxProjectionBytes) {
    return { ok: false, errors: [TOO_LARGE] };
  }
  // A plain JSON copy: the view shares no objects with the sources.
  return { ok: true, view: JSON.parse(serialized) as ResolvedChatView, sources: [...new Set(order)] };
}
