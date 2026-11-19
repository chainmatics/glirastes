import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';
import {
  isTechnicalIdKey,
  isUuidLike,
  looksLikeTechnicalId,
  ownLabelOf,
  siblingLabelOf,
  UUID_PATTERN_SOURCE,
} from '../../../contracts/entity-identity.js';
import {
  declarationsForRead,
  declaredRecordsOf,
  entityIdKindOf,
  entityIdText,
  inputRefArgs,
  type InputEntityRef,
  type EntityDeclarationsByTool,
  type OutputEntityDeclaration,
} from '../../../contracts/entity-declaration.js';
import { READ_RESULT_TOOL_NAME } from '../../../contracts/result-handle.js';

/**
 * Keeps technical ids out of the assistant's answers. Tool results teach the
 * transform which id belongs to which readable label; an id the model writes
 * anyway is replaced by that label, or removed when no label is known.
 */

export const HIDE_IDS_PROMPT =
  'Never write technical ids (UUIDs, database ids, userId, teamId and the like) in your answers, '
  + 'not even in parentheses or lists. Name things by their title, name or readable key instead.';

type Part = TextStreamPart<ToolSet>;
type TextDelta = Extract<Part, { type: 'text-delta' }>;

const UUID_SOURCE = UUID_PATTERN_SOURCE;
const MAX_HELD = 80;

export type IdLabels = Map<string, string | undefined>;

/**
 * Ids a declaration calls speaking (`idKind: 'speaking'`, or a `key`, `slug`
 * or `code` id): readable keys the user types, never learnt and never removed,
 * a UUID-shaped one included. Lower-cased.
 */
const readable = new WeakMap<IdLabels, Set<string>>();

function isReadable(labels: IdLabels, id: string): boolean {
  return readable.get(labels)?.has(id.toLowerCase()) ?? false;
}

function remember(labels: IdLabels, id: string, label: string | undefined): void {
  if (!looksLikeTechnicalId(id) || label === id || isReadable(labels, id)) return;
  if (label !== undefined || !labels.has(id)) labels.set(id, label ?? labels.get(id));
}

/** Records the ids in a tool input or output, with the label each one has. */
export function collectIdLabels(value: unknown, labels: IdLabels, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectIdLabels(item, labels, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (isTechnicalIdKey(key)) {
      const label = key === 'id' ? ownLabelOf(record) : siblingLabelOf(record, key);
      if (typeof item === 'string') remember(labels, item, label);
      else if (Array.isArray(item)) for (const entry of item) if (typeof entry === 'string') remember(labels, entry, undefined);
    }
    if (item && typeof item === 'object') collectIdLabels(item, labels, depth + 1);
  }
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ids a declaration taught that are no technical id by their shape (an
 * integer, a short string): removed only together with an id prefix
 * (`(ID: 3)`, `ID 3`), never as a bare word, which could be any number.
 */
const prefixedOnly = new WeakMap<IdLabels, Set<string>>();

function idPattern(ids: Iterable<string>): string {
  const known = [...ids].filter((id) => !isUuidLike(id)).sort((a, b) => b.length - a.length);
  if (known.length === 0) return UUID_SOURCE;
  // A declared composite key (`<uuid>/<uuid>`) is tried before a single UUID can split it.
  const composite = known.some((id) => id.includes('/'));
  const alternatives = known.map(escape).join('|');
  return composite ? `(?:${alternatives}|${UUID_SOURCE})` : `(?:${UUID_SOURCE}|${alternatives})`;
}

/** Replaces the ids in a finished piece of text. */
export function redactIds(text: string, labels: IdLabels): string {
  if (!text) return text;
  const keep = readable.get(labels);
  // (A kept id also escapes the UUID rule: it is set aside before any pattern runs.)
  if (keep && keep.size > 0) return redactKeeping(text, labels, keep);
  return redactAll(text, labels);
}

/** `redactIds` with declared speaking ids protected: set aside before, put back after. */
function redactKeeping(text: string, labels: IdLabels, keep: ReadonlySet<string>): string {
  const kept: string[] = [];
  const pattern = new RegExp(String.raw`(?<![\w-])(?:${[...keep].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\w-])`, 'gi');
  // Letters only between NULs: no id pattern (digits, a prefix) can match inside a placeholder.
  const token = (index: number) => `\u0000${index.toString(26).replace(/./g, (digit) => String.fromCharCode(97 + parseInt(digit, 26)))}\u0000`;
  const masked = text.replace(pattern, (found) => token(kept.push(found) - 1));
  return redactAll(masked, labels).replace(/\u0000([a-z]+)\u0000/g, (_match, letters: string) => (
    kept[parseInt(letters.replace(/./g, (letter) => (letter.charCodeAt(0) - 97).toString(26)), 26)] ?? ''));
}

function redactAll(text: string, labels: IdLabels): string {
  const prefix = String.raw`(?:(?:uu)?ids?|kennung)\s*[:=]?\s*`;
  const onlyPrefixed = prefixedOnly.get(labels);
  let wrapped: RegExp;
  let prefixed: RegExp;
  let bare: RegExp;
  if (!onlyPrefixed || onlyPrefixed.size === 0) {
    const id = idPattern(labels.keys());
    wrapped = new RegExp(String.raw`[ \t]*[(\[]\s*(?:${prefix})?\x60?${id}\x60?\s*[)\]]`, 'gi');
    prefixed = new RegExp(String.raw`[ \t]*[,;–-]?[ \t]*\b${prefix}\x60?${id}\x60?`, 'gi');
    bare = new RegExp(String.raw`(?<![\w-])\x60?(${id})\x60?(?![\w-])`, 'gi');
  } else {
    const all = idPattern(labels.keys());
    const word = idPattern([...labels.keys()].filter((id) => !onlyPrefixed.has(id)));
    wrapped = new RegExp(String.raw`[ \t]*[(\[]\s*(?:${prefix}\x60?${all}|\x60?${word})\x60?\s*[)\]]`, 'gi');
    // A whole id only: not the 3 of `3.14` or of `3/7` (a composite key), but the 3 that ends a sentence.
    prefixed = new RegExp(String.raw`[ \t]*[,;–-]?[ \t]*\b${prefix}\x60?${all}\x60?(?![\w-]|[./:,][\w])`, 'gi');
    bare = new RegExp(String.raw`(?<![\w-])\x60?(${word})\x60?(?![\w-])`, 'gi');
  }
  return text
    .replace(wrapped, '')
    .replace(prefixed, '')
    .replace(bare, (_match, found: string) => labelFor(labels, found) ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?)])/g, '$1');
}

/** A speaking id stays readable, also when the guess learnt it before. */
function keepReadable(labels: IdLabels, values: ReadonlyArray<string | number>): void {
  let set = readable.get(labels);
  if (!set) readable.set(labels, set = new Set());
  for (const raw of values) {
    const id = typeof raw === 'string' ? raw.trim() : String(raw);
    set.add(id.toLowerCase());
    labels.delete(id);
    prefixedOnly.get(labels)?.delete(id);
  }
}

/**
 * Keeps the speaking ids a tool's `inputEntities` name in its arguments
 * readable (an order key the user typed): never learnt, never removed, also
 * when the call returns no record. A reference is speaking by its `idKind`,
 * else by the `idKind` its type has in any tool's `outputEntities`, else by
 * its argument names (`key`, `slug`, `code`).
 */
export function keepDeclaredInputIds(
  input: unknown,
  refs: ReadonlyArray<InputEntityRef> | undefined,
  labels: IdLabels,
  entities?: EntityDeclarationsByTool,
): void {
  if (!refs || refs.length === 0 || typeof input !== 'object' || input === null) return;
  for (const ref of refs) {
    const paths = inputRefArgs(ref);
    const typeKind = Object.values(entities ?? {}).flatMap((entry) => entry.output ?? [])
      .find((declaration) => declaration.type === ref.type);
    const kind = ref.idKind ?? (typeKind ? entityIdKindOf(typeKind) : entityIdKindOf({ id: paths.map((path) => path.split('.').at(-1)!) }));
    if (kind !== 'speaking') continue;
    const values: Array<string | number> = [];
    for (const path of paths) {
      let current: unknown = input;
      for (const key of path.split('.')) current = typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined;
      if (typeof current === 'string' || typeof current === 'number') values.push(current);
    }
    keepReadable(labels, values);
  }
}

/**
 * Records the opaque ids of the records a tool's `outputEntities` declare in
 * its result (`value`), labelled with their declared name. Speaking ids
 * (`idKind: 'speaking'`, or a `key`/`slug`/`code` id) stay readable and are
 * not learnt. An id that is no technical id by its shape (an integer, a short
 * string) is only removed with an id prefix (`(ID: 3)`).
 */
export function collectDeclaredIdLabels(
  value: unknown,
  declarations: ReadonlyArray<OutputEntityDeclaration> | undefined,
  labels: IdLabels,
): void {
  if (!declarations || declarations.length === 0) return;
  for (const identity of declaredRecordsOf(value, declarations).values()) {
    if (identity.idKind !== 'opaque') {
      keepReadable(labels, identity.idValues);
      continue;
    }
    // A composite key: the whole key (`abc123456/def123456`) carries the name, its parts are
    // removed without one (a shared parent is no record of its own).
    const composite = identity.idValues.length > 1;
    // A number (also as digits only) is never removed as a bare word: it could be any count.
    const technicalText = (id: string) => looksLikeTechnicalId(id) && !/^-?\d+$/.test(id);
    const technical = (raw: string | number) => typeof raw === 'string' && technicalText(raw.trim());
    const learn = (id: string, label: string | undefined, technical = technicalText(id)) => {
      if (!id || id === identity.name) return;
      // The declaration decides: a number stays a number, also when the guess learnt it as an id.
      if (!technical) {
        let set = prefixedOnly.get(labels);
        if (!set) prefixedOnly.set(labels, set = new Set());
        set.add(id);
      }
      // A part of a composite key names no record: a name the guess gave it is dropped.
      if (composite && label === undefined) labels.set(id, undefined);
      else if (label !== undefined || !labels.has(id)) labels.set(id, label ?? labels.get(id));
    };
    for (const raw of identity.idValues) learn(typeof raw === 'string' ? raw.trim() : String(raw), composite ? undefined : identity.name, technical(raw));
    // The whole key is technical when each part is (`abc123456/def123456`), else only removed with a prefix.
    if (composite) {
      learn(entityIdText(identity.idValues), identity.name, identity.idValues.every(technical));
    }
  }
}

/** The declared ids of the finished tool parts of UI messages (`tool-<name>`), see {@link collectDeclaredIdLabels}. */
export function collectDeclaredIdLabelsFromMessages(
  messages: unknown,
  entities: EntityDeclarationsByTool | undefined,
  labels: IdLabels,
): void {
  if (!entities || !Array.isArray(messages)) return;
  const producers = new ResultProducers();
  const toolParts: Array<{ name: string; part: Record<string, unknown> }> = [];
  for (const message of messages) {
    const parts = (message as { parts?: unknown } | null)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const type = (part as { type?: unknown } | null)?.type;
      if (typeof type !== 'string' || !type.startsWith('tool-')) continue;
      const name = type.slice('tool-'.length);
      producers.note(name, (part as { output?: unknown }).output);
      toolParts.push({ name, part: part as Record<string, unknown> });
    }
  }
  for (const { name, part } of toolParts) {
    collectDeclaredIdLabels(part.output, producers.declarationsFor(entities, name, part.input), labels);
    if (Object.prototype.hasOwnProperty.call(entities, name)) keepDeclaredInputIds(part.input, entities[name]!.input, labels, entities);
  }
}

/** The tool that produced each result handle: a `read_result` answer is read with that tool's declarations. */
class ResultProducers {
  private readonly byId = new Map<string, string>();
  private readonly outputs = new Map<string, unknown>();

  note(toolName: string, output: unknown): void {
    if (toolName === READ_RESULT_TOOL_NAME || typeof output !== 'object' || output === null) return;
    const marker = (output as { _result?: unknown })._result;
    const id = typeof marker === 'object' && marker !== null ? (marker as { id?: unknown }).id : undefined;
    if (typeof id === 'string') {
      this.byId.set(id, toolName);
      this.outputs.set(id, output);
    }
  }

  /** The declarations to read a part with: a read keeps the paths path-less ones had in the producing result. */
  declarationsFor(
    entities: EntityDeclarationsByTool,
    toolName: string,
    input: unknown,
  ): ReadonlyArray<OutputEntityDeclaration> | undefined {
    const producer = this.of(toolName, input);
    if (!Object.prototype.hasOwnProperty.call(entities, producer)) return undefined;
    const own = entities[producer]!.output;
    if (toolName !== READ_RESULT_TOOL_NAME || producer === toolName) return own;
    const id = (input as { resultId?: unknown }).resultId as string;
    return declarationsForRead(own, this.outputs.get(id));
  }

  /** Notes the producers of the finished tool parts of UI messages (`tool-<name>`). */
  noteMessages(messages: unknown): void {
    if (!Array.isArray(messages)) return;
    for (const message of messages) {
      const parts = (message as { parts?: unknown } | null)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const type = (part as { type?: unknown } | null)?.type;
        if (typeof type === 'string' && type.startsWith('tool-')) this.note(type.slice('tool-'.length), (part as { output?: unknown }).output);
      }
    }
  }

  of(toolName: string, input: unknown): string {
    if (toolName !== READ_RESULT_TOOL_NAME || typeof input !== 'object' || input === null) return toolName;
    const id = (input as { resultId?: unknown }).resultId;
    return (typeof id === 'string' && this.byId.get(id)) || toolName;
  }
}

function labelFor(labels: IdLabels, id: string): string | undefined {
  if (labels.has(id)) return labels.get(id);
  for (const [known, label] of labels) if (known.toLowerCase() === id.toLowerCase()) return label;
  return undefined;
}

/** Where the text may still grow into an id or its wrapper; the rest is safe to emit. */
export function holdFrom(text: string): number {
  const match = /[ \t]*(?:[,;–-][ \t]*)?(?:[(\[]\s*)?(?:\b(?:u|uu|uui|uuid|i|id|ids|k|ke|ken|kenn|kennu|kennun|kennung)\s*[:=]?\s*)?\x60?[\w-]*$/i.exec(text);
  const index = match ? match.index : text.length;
  return Math.max(index, text.length - MAX_HELD);
}

/**
 * `experimental_transform` for `streamText`: holds back the end of each text
 * part until it can no longer grow into an id, and emits it with ids replaced.
 */
export function createHideIdsTransform(
  labels: IdLabels = new Map(),
  options: {
    entities?: EntityDeclarationsByTool;
    /** The UI messages of the conversation so far: the producers of result handles a read in this turn may name. */
    messages?: unknown;
  } = {},
): StreamTextTransform<ToolSet> {
  const producers = new ResultProducers();
  if (options.entities) producers.noteMessages(options.messages);
  const keepInputIds = (toolName: unknown, input: unknown) => {
    if (typeof toolName !== 'string' || !options.entities || !Object.prototype.hasOwnProperty.call(options.entities, toolName)) return;
    keepDeclaredInputIds(input, options.entities[toolName]!.input, labels, options.entities);
  };
  const declaredOf = (toolName: unknown, input: unknown, output: unknown) => {
    if (typeof toolName !== 'string' || !options.entities) return undefined;
    producers.note(toolName, output);
    return producers.declarationsFor(options.entities, toolName, input);
  };
  return () => {
    const held = new Map<string, { part: TextDelta; text: string }>();
    const flush = (controller: TransformStreamDefaultController<Part>, id?: string) => {
      for (const [key, entry] of held) {
        if (id !== undefined && key !== id) continue;
        const text = redactIds(entry.text, labels);
        if (text) controller.enqueue({ ...entry.part, text });
        held.delete(key);
      }
    };
    return new TransformStream<Part, Part>({
      transform(part, controller) {
        if (part.type === 'text-delta') {
          const key = part.id;
          const text = (held.get(key)?.text ?? '') + part.text;
          const cut = holdFrom(text);
          const ready = redactIds(text.slice(0, cut), labels);
          if (ready) controller.enqueue({ ...part, text: ready });
          held.set(key, { part, text: text.slice(cut) });
          return;
        }
        if (part.type === 'tool-call') {
          collectIdLabels(part.input, labels);
          keepInputIds(part.toolName, part.input);
        }
        if (part.type === 'tool-result') {
          collectIdLabels(part.input, labels);
          collectIdLabels(part.output, labels);
          collectDeclaredIdLabels(part.output, declaredOf(part.toolName, part.input, part.output), labels);
          keepInputIds(part.toolName, part.input);
        }
        flush(controller, part.type === 'text-end' ? part.id : undefined);
        controller.enqueue(part);
      },
      flush(controller) {
        flush(controller);
      },
    });
  };
}
