import { idLikeFieldsOf, RECOGNISED_ID_KEYS } from '../../contracts/record-identity.js';
import { READ_RESULT_TOOL_NAME } from '../../contracts/result-handle.js';
import { isGenericWrapper, kindOfField, kindOfToolName } from './entity-kinds.js';
import { parseMentionSegments } from './mention-markup.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The keys a record carries its own id under (the identity keys of an overview entry). */
const ID_KEYS = ['id', '_id', 'uuid'] as const;
const NAME_KEYS = ['title', 'name', 'displayName', 'label'] as const;
const MAX_DEPTH = 8;
const MAX_NODES = 20_000;
const MAX_ID_LENGTH = 200;
const MAX_NAMES_PER_ID = 5;
/** Kinds tracked per id value, at most (the newest first). */
const MAX_KINDS_PER_ID = 8;
/** An entry without `id`, `_id` or `uuid` and without any key the result overview recognises carries its id-like fields. */
const RECOGNISED_KEYS: ReadonlyArray<string> = [...new Set<string>([...ID_KEYS, ...RECOGNISED_ID_KEYS])];
const INDEX_KEY = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a string has the shape of a UUID. */
export function isUuidLike(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * The lookup key of an id value: a non-empty string of at most 200 characters
 * or an integer, lower-cased. Anything else is no id.
 */
export function entityIdKey(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return undefined;
  return trimmed.toLowerCase();
}

/** What the conversation showed for one record id. */
export interface EntitySighting {
  /** The most recent name. */
  name: string;
  /** Every distinct name, most recent first (at most five). */
  names: string[];
  /** The entity type, when a mention the user picked named it (`playlist`). */
  type?: string;
  /**
   * Set only when this id value was seen as the own id of records of more
   * than one kind (user 3 and playlist 3), newest first: each kind
   * (`entity-kinds.ts`) with the names its records carried (none for a
   * record without a name field). Records count with `id`, `_id` or `uuid`,
   * or, without a recognised id, with every id-like field (`playlist_id`).
   */
  kinds?: EntityKindSighting[];
}

/** The records of one kind that carried an id value. */
export interface EntityKindSighting {
  /** `user`, `playlist`, `owner`, `playlist version`. */
  kind: string;
  /** Their distinct names, newest first (at most five); empty when they had none. */
  names: string[];
}

/** The tool whose overview a `read_result` answer reads, by result id. */
function producingTools(messages: ReadonlyArray<unknown>): Map<string, string> {
  const tools = new Map<string, string>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts as unknown[]) {
      if (!isRecord(part) || typeof part.type !== 'string' || !part.type.startsWith('tool-')) continue;
      const output = part.output;
      const marker = isRecord(output) ? output._result : undefined;
      const name = part.type.slice('tool-'.length);
      if (isRecord(marker) && typeof marker.id === 'string' && name !== READ_RESULT_TOOL_NAME) tools.set(marker.id, name);
    }
  }
  return tools;
}

/** The tool a part's result belongs to: for `read_result`, the tool that produced the result it reads. */
function resultToolOf(part: Record<string, unknown>, tools: ReadonlyMap<string, string>): string {
  const name = (part.type as string).slice('tool-'.length);
  if (name !== READ_RESULT_TOOL_NAME) return name;
  const input = part.input;
  const id = isRecord(input) && typeof input.resultId === 'string' ? input.resultId : undefined;
  return (id && tools.get(id)) ?? name;
}

/**
 * The records this conversation showed with a name, by lower-case record id:
 * every object in a finished tool result that carries `id`, `_id` or `uuid`
 * (string or integer) next to `title`, `name`, `displayName` or `label`, at any
 * depth — entries of `data[]`, the entries an overview (`_result`) kept, the
 * answers of `read_result` including indexed reads (`{ data: { "2": { id, name } } }`)
 * and nested records — plus the `{{mention:type:id:label}}` markers in the
 * user's own messages.
 *
 * Never what the model put into a call or wrote into its text: a name found
 * here is one the app reported or the user picked. It is still client-side
 * data the browser holds, so it serves as a convenience for the person who
 * approves, never as a trust boundary.
 *
 * Messages are read newest first, so the bounded walk keeps the recent ones.
 */
export function collectEntitySightings(
  messages: ReadonlyArray<unknown>,
): Map<string, EntitySighting> {
  const sightings = new Map<string, EntitySighting>();
  /** Per id value: the kinds of the records that carried it as their own id, with their names. */
  const kinds = new Map<string, Map<string, string[]>>();
  let budget = MAX_NODES;
  const tools = producingTools(messages);

  const addKind = (id: unknown, kind: string | undefined, name: string | undefined) => {
    const key = entityIdKey(id);
    if (!key || !kind) return;
    let byKind = kinds.get(key);
    if (!byKind) kinds.set(key, byKind = new Map());
    let names = byKind.get(kind);
    if (!names) {
      if (byKind.size >= MAX_KINDS_PER_ID) return;
      byKind.set(kind, names = []);
    }
    const trimmed = name?.trim();
    if (trimmed && !names.includes(trimmed) && names.length < MAX_NAMES_PER_ID) names.push(trimmed);
  };

  const add = (id: unknown, name: string, type?: string) => {
    const key = entityIdKey(id);
    const trimmed = name.trim();
    if (!key || !trimmed) return;
    const known = sightings.get(key);
    if (!known) {
      sightings.set(key, { name: trimmed, names: [trimmed], ...(type ? { type } : {}) });
      return;
    }
    // Read newest first: what is already known is more recent.
    if (!known.names.includes(trimmed) && known.names.length < MAX_NAMES_PER_ID) known.names.push(trimmed);
    if (!known.type && type) known.type = type;
  };

  /**
   * `holder`: the kind the field holding this value names (undefined at the
   * root and below generic wrappers at the top); `inRecord`: below a record;
   * `stem`: the kind the result's tool name names.
   */
  const walk = (value: unknown, depth: number, holder?: string, inRecord = false, stem?: string): void => {
    if (depth > MAX_DEPTH || budget <= 0) return;
    budget -= 1;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, holder, inRecord, stem);
      return;
    }
    if (!isRecord(value)) return;
    const idKey = ID_KEYS.find((key) => entityIdKey(value[key]) !== undefined);
    const nameKey = NAME_KEYS.find((key) => typeof value[key] === 'string' && (value[key] as string).trim() !== '');
    const name = nameKey ? value[nameKey] as string : undefined;
    if (idKey && name) add(value[idKey], name);
    const ownIds = idKey ? [idKey] : idLikeFieldsOf(value, RECOGNISED_KEYS);
    for (const key of ownIds) addKind(value[key], holder ?? stem, name);
    const below = inRecord || ownIds.length > 0;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child !== 'object' || child === null) continue;
      // An index (`{ "2": { … } }`) and a generic wrapper at the top keep the kind of their holder.
      const childHolder = INDEX_KEY.test(key) || (!below && isGenericWrapper(key)) ? holder : kindOfField(key);
      walk(child, depth + 1, childHolder, below, stem);
    }
  };

  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const message = messages[m];
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (let p = message.parts.length - 1; p >= 0; p -= 1) {
      const part: unknown = message.parts[p];
      if (!isRecord(part) || typeof part.type !== 'string') continue;
      if (part.type.startsWith('tool-') && part.state === 'output-available') {
        walk(part.output, 0, undefined, false, kindOfToolName(resultToolOf(part, tools)));
      } else if (message.role === 'user' && part.type === 'text' && typeof part.text === 'string') {
        for (const segment of parseMentionSegments(part.text)) {
          if (segment.kind !== 'mention' || segment.mention.type === 'command') continue;
          add(segment.mention.id, segment.mention.displayName, segment.mention.type);
          addKind(segment.mention.id, kindOfField(segment.mention.type), segment.mention.displayName);
        }
      }
    }
  }
  // Only a collision is recorded: one kind is what every sighting had before.
  for (const [key, sighting] of sightings) {
    const byKind = kinds.get(key);
    if (byKind && byKind.size > 1) sighting.kinds = [...byKind].map(([kind, names]) => ({ kind, names: [...names] }));
  }
  return sightings;
}

/**
 * Fields that stand in for a missing name, in this order: a version or a
 * number tells records of one type apart (`versionNumber: 3`). Never a name.
 */
const FALLBACK_KEYS = ['versionNumber', 'version', 'number', 'code', 'slug'] as const;
const MAX_FALLBACK_LENGTH = 80;

/** A record id a tool result of this conversation carried, with or without a name. */
export interface SeenEntity {
  /** A short field of the same record that tells it apart (`Version number 3`), when it has one. */
  fallback?: string;
}

/** `versionNumber` → `Version number`. */
function fallbackLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fallbackOf(record: Record<string, unknown>): string | undefined {
  for (const key of FALLBACK_KEYS) {
    const value = record[key];
    const text = typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string' ? value.trim() : '';
    if (text && text.length <= MAX_FALLBACK_LENGTH) return `${fallbackLabel(key)} ${text}`;
  }
  return undefined;
}

/**
 * Every record id (`id`, `_id` or `uuid`) the finished tool results of this
 * conversation carried, at the depths {@link collectEntitySightings} reads,
 * also without a name: a version record has none. The newest result wins for
 * the fallback. Tool results only, never mentions, calls or the model's text.
 */
export function collectSeenEntityIds(
  messages: ReadonlyArray<unknown>,
): Map<string, SeenEntity> {
  const seen = new Map<string, SeenEntity>();
  let budget = MAX_NODES;

  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || budget <= 0) return;
    budget -= 1;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    const idKey = ID_KEYS.find((key) => entityIdKey(value[key]) !== undefined);
    if (idKey) {
      const key = entityIdKey(value[idKey])!;
      const known = seen.get(key);
      if (!known) {
        const fallback = fallbackOf(value);
        seen.set(key, fallback ? { fallback } : {});
      } else if (!known.fallback) {
        const fallback = fallbackOf(value);
        if (fallback) known.fallback = fallback;
      }
    }
    for (const child of Object.values(value)) {
      if (typeof child === 'object' && child !== null) walk(child, depth + 1);
    }
  };

  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const message = messages[m];
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (let p = message.parts.length - 1; p >= 0; p -= 1) {
      const part: unknown = message.parts[p];
      if (!isRecord(part) || typeof part.type !== 'string') continue;
      if (part.type.startsWith('tool-') && part.state === 'output-available') walk(part.output, 0);
    }
  }
  return seen;
}

/**
 * The display names of the records the tools of this conversation returned
 * (and the user mentioned), by lower-case record id; the most recent name wins.
 * See {@link collectEntitySightings}.
 */
export function collectEntityNames(
  messages: ReadonlyArray<unknown>,
): Map<string, string> {
  return new Map([...collectEntitySightings(messages)].map(([id, sighting]) => [id, sighting.name]));
}
