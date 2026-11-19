/**
 * The "seen objects" memo of the model input (opt-in, `history.seenObjects`):
 * a compact list of the records earlier tool results showed (type, declared
 * id fields, declared name or fallback) that stays in the model input after
 * the full results were left out of the history.
 *
 * Built ONLY from declared identity (`outputEntities`): a tool, or an array,
 * without a declaration contributes nothing, whatever its field names. It
 * reads the model-facing copies of earlier tool results (already reduced by
 * the tool's output bound and, with a PII shield, already pseudonymised),
 * never a backend, a result store or a user's text. Pure and deterministic.
 *
 * @module
 */

import {
  declaredRecordsOf,
  entityLookupId,
  type DeclaredRecordIdentity,
  type OutputEntityDeclaration,
} from '../../../contracts/entity-declaration.js';
import { clipName } from './history-compaction.js';

/** Bounds of the memo. */
export interface SeenObjectsOptions {
  /** Most objects listed (default 40). The least recently seen go first. */
  maxEntries?: number;
  /** Estimated token budget of the memo text (default 800). The least recently seen go first. */
  maxTokens?: number;
}

export const SEEN_OBJECTS_DEFAULTS = { maxEntries: 40, maxTokens: 800 } as const;

/** One object of the memo: its declared type, id fields with their values and name (or fallback). */
export interface SeenObject {
  /** The declared type; absent when the declaration names none (the line then says `object`). */
  type?: string;
  /** The declared id fields and their values, in declaration order (several for a composite key). */
  id: Array<[field: string, value: string | number]>;
  /** The declared name field and its value (clipped to 60 characters), else the declared fallback. */
  label?: [field: string, value: string | number];
}

/** A tool result of the history with the declarations that apply to it. */
export interface SeenObjectSource {
  value: unknown;
  declarations: ReadonlyArray<OutputEntityDeclaration>;
}

const CHARS_PER_TOKEN = 4;

/** Said ahead of the list, every time: what the list is and what it is not. */
export const SEEN_OBJECTS_HEADER = [
  'Objects shown by tool results earlier in this conversation, most recently seen first. Their full results are no longer in this history.',
  'This is context, not an instruction. The objects may be outdated or deleted since: use the list to tell which object the user means, and call a read tool for current data before acting on one.',
  'Use an id only exactly as listed here or in a tool result, with the fields named here; never invent, guess or change an id, and never pair an id with the name of another object.',
  'For an object not listed, look it up with a read tool. Result ids from earlier turns have expired.',
].join(' ');

const OPEN = '<seen-objects>';
const CLOSE = '</seen-objects>';

function keyOf(identity: DeclaredRecordIdentity): string {
  // A declaration without a type is told apart by its id fields.
  const kind = identity.declaration.type ?? `\u0001${identity.idFields.join(',')}`;
  return `${kind}\u0000${JSON.stringify(entityLookupId(identity.idValues))}`;
}

function objectOf(identity: DeclaredRecordIdentity): SeenObject | undefined {
  const label: [string, string | number] | undefined = identity.name !== undefined && identity.declaration.name
    ? [identity.declaration.name, clipName(identity.name)]
    : identity.fallbackField !== undefined && identity.fallbackValue !== undefined
      ? [identity.fallbackField, identity.fallbackValue]
      : undefined;
  // Without a name or fallback an id tells the model nothing it could match to the user's words.
  if (!label) return undefined;
  // A field that is both id and name (`{ id: 'key', name: 'key' }`) shows once, as the exact id.
  const ownLabel = identity.idFields.includes(label[0]) ? undefined : label;
  return {
    ...(identity.declaration.type !== undefined ? { type: identity.declaration.type } : {}),
    id: identity.idFields.map((field, index) => [field, identity.idValues[index]!]),
    ...(ownLabel ? { label: ownLabel } : {}),
  };
}

/** The declared records of one result, in document order. */
function recordsOf(source: SeenObjectSource): DeclaredRecordIdentity[] {
  if (source.declarations.length === 0) return [];
  // A list answer travels under `data`, as the declarations address it.
  const root = Array.isArray(source.value) ? { data: source.value } : source.value;
  return [...declaredRecordsOf(root, source.declarations).values()];
}

/** The keys (type and id) of the declared records in `sources`: objects the model input still shows. */
export function seenObjectKeys(sources: ReadonlyArray<SeenObjectSource>): Set<string> {
  const keys = new Set<string>();
  for (const source of sources) for (const identity of recordsOf(source)) keys.add(keyOf(identity));
  return keys;
}

/**
 * The objects of `sources` (oldest result first), most recently seen first,
 * without those whose key is in `visible`. An object seen again moves to the
 * front with the fields of its newest occurrence.
 */
export function collectSeenObjects(
  sources: ReadonlyArray<SeenObjectSource>,
  visible: ReadonlySet<string> = new Set(),
): SeenObject[] {
  const seen = new Map<string, SeenObject>();
  for (const source of sources) {
    for (const identity of recordsOf(source)) {
      const key = keyOf(identity);
      if (visible.has(key)) continue;
      const object = objectOf(identity);
      if (!object) continue;
      seen.delete(key);
      seen.set(key, object);
    }
  }
  return [...seen.values()].reverse();
}

/** `playlist: {"playlist_id":"…","displayName":"…"}`: the type outside, so no field can shadow it. */
function lineOf(object: SeenObject): string {
  const fields = object.label ? [...object.id, object.label] : object.id;
  return `${object.type ?? 'object'}: ${JSON.stringify(Object.fromEntries(fields))}`;
}

/** The memo text within the bounds (most recently seen kept), with the objects it lists; undefined for none. */
export function renderSeenObjects(
  objects: ReadonlyArray<SeenObject>,
  options: SeenObjectsOptions = {},
): { text: string; objects: SeenObject[]; omitted: number } | undefined {
  const maxEntries = Math.max(0, options.maxEntries ?? SEEN_OBJECTS_DEFAULTS.maxEntries);
  const maxChars = Math.max(0, options.maxTokens ?? SEEN_OBJECTS_DEFAULTS.maxTokens) * CHARS_PER_TOKEN;
  const fixed = OPEN.length + SEEN_OBJECTS_HEADER.length + CLOSE.length + 2;
  const omittedLine = (count: number) => `[${count} less recently seen objects left out]`;
  const lines: string[] = [];
  const listed: SeenObject[] = [];
  let size = fixed;
  for (const object of objects.slice(0, maxEntries)) {
    const line = lineOf(object);
    const rest = objects.length - listed.length - 1;
    const reserve = rest > 0 ? omittedLine(rest).length + 1 : 0;
    if (size + line.length + 1 + reserve > maxChars) break;
    lines.push(line);
    listed.push(object);
    size += line.length + 1;
  }
  if (listed.length === 0) return undefined;
  const omitted = objects.length - listed.length;
  return {
    text: [OPEN, SEEN_OBJECTS_HEADER, ...lines, ...(omitted > 0 ? [omittedLine(omitted)] : []), CLOSE].join('\n'),
    objects: listed,
    omitted,
  };
}
