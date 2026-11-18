import { parseMentionSegments } from './mention-markup.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The keys a record carries its own id under (the identity keys of an overview entry). */
const ID_KEYS = ['id', '_id', 'uuid'] as const;
const NAME_KEYS = ['title', 'name', 'displayName', 'label'] as const;
const MAX_DEPTH = 8;
const MAX_NODES = 20_000;
const MAX_ID_LENGTH = 200;
const MAX_NAMES_PER_ID = 5;

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
  let budget = MAX_NODES;

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
      for (const key of NAME_KEYS) {
        const name = value[key];
        if (typeof name === 'string' && name.trim()) {
          add(value[idKey], name);
          break;
        }
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
      if (part.type.startsWith('tool-') && part.state === 'output-available') {
        walk(part.output, 0);
      } else if (message.role === 'user' && part.type === 'text' && typeof part.text === 'string') {
        for (const segment of parseMentionSegments(part.text)) {
          if (segment.kind !== 'mention' || segment.mention.type === 'command') continue;
          add(segment.mention.id, segment.mention.displayName, segment.mention.type);
        }
      }
    }
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
