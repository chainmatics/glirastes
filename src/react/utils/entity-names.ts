import {
  BROWSER_RECOGNISED_ID_KEYS,
  entityIdKey,
  fallbackText,
  fallbackTextOf,
  idLikeFieldsOf,
  maxIdLength,
  isGenericWrapper,
  kindOfField,
  kindOfToolName,
  NAME_KEYS as NAME_KEY_PROFILES,
  OWN_ID_KEYS,
} from '../../contracts/entity-identity.js';
import { READ_RESULT_TOOL_NAME } from '../../contracts/result-handle.js';
import {
  claimedRecordsOf,
  declarationsForRead,
  entityLookupId,
  type DeclaredRecordIdentity,
  type EntityDeclarationsByTool,
  type EntityIdKind,
} from '../../contracts/entity-declaration.js';
import { parseMentionSegments } from './mention-markup.js';

export { entityIdKey, isUuidLike } from '../../contracts/entity-identity.js';

/** The keys a record carries its own id under (the browser profile: `id`, `_id`, `uuid`). */
const ID_KEYS = OWN_ID_KEYS.browser;
const NAME_KEYS = NAME_KEY_PROFILES.browser;
const MAX_DEPTH = 8;
const MAX_NODES = 20_000;
const MAX_NAMES_PER_ID = 5;
/** Kinds tracked per id value, at most (the newest first). */
const MAX_KINDS_PER_ID = 8;
/** An entry without `id`, `_id` or `uuid` and without any key the result overview recognises carries its id-like fields. */
const RECOGNISED_KEYS: ReadonlyArray<string> = BROWSER_RECOGNISED_ID_KEYS;
const INDEX_KEY = /^\d+$/;

/**
 * The case-sensitive lookup key of a declared opaque id (`AbC-7` and `abc-7`
 * stay apart): its own namespace next to the lower-cased keys, so a declared
 * argument looks its record up exactly, per type.
 */
export function exactEntityKey(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? `\u0001${value}` : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxIdLength(trimmed) ? `\u0001${trimmed}` : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
   * (`contracts/entity-identity.ts`) with the names its records carried (none for a
   * record without a name field). Records count with `id`, `_id` or `uuid`,
   * or, without a recognised id, with every id-like field (`playlist_id`).
   */
  kinds?: EntityKindSighting[];
  /** Set only for a record a tool's `outputEntities` declare: its declared id kind. */
  idKind?: EntityIdKind;
  /**
   * Set only with declarations, when every record that carried the id was of
   * one kind: that kind (`playlist`). An argument of another kind is not
   * named by it.
   */
  kind?: string;
  /** Set when `kind` comes from a declared or mentioned type: that type exactly (`playlist-version`). */
  kindType?: string;
  /**
   * Set only for declared records with an opaque id: the ids exactly as they
   * were shown. An opaque id is case-sensitive (`AbC-7` is not `abc-7`);
   * only a speaking key matches case-insensitively.
   */
  exactIds?: string[];
  /** Set when only an `@` mention of the user named the id, no tool result. */
  mentionedOnly?: true;
}

/** The records of one kind that carried an id value. */
export interface EntityKindSighting {
  /** `user`, `playlist`, `owner`, `playlist version`. */
  kind: string;
  /**
   * Set when the kind comes from a declared `type` or a mention's type, not a
   * guess from a field or tool name: that type exactly, for an exact comparison.
   */
  type?: string;
  /** Their distinct names, newest first (at most five); empty when they had none. */
  names: string[];
  /** Set only with declarations, when only an `@` mention showed this kind for the id. */
  mentionedOnly?: true;
}

/** The declared records of a finished tool part, by the tool its result belongs to. */
function declaredOf(
  part: Record<string, unknown>,
  tools: ReadonlyMap<string, string>,
  declarations: EntityDeclarationsByTool | undefined,
  outputs?: ReadonlyMap<string, unknown>,
): Map<Record<string, unknown>, DeclaredRecordIdentity | null> | undefined {
  if (!declarations) return undefined;
  const tool = resultToolOf(part, tools);
  if (!Object.prototype.hasOwnProperty.call(declarations, tool)) return undefined;
  const own = declarations[tool]!.output;
  // A read keeps the path a path-less declaration had in the producing result.
  const read = (part.type as string) === `tool-${READ_RESULT_TOOL_NAME}` && tool !== READ_RESULT_TOOL_NAME;
  const input = part.input;
  const resultId = isRecord(input) && typeof input.resultId === 'string' ? input.resultId : undefined;
  const list = read ? declarationsForRead(own, resultId !== undefined ? outputs?.get(resultId) : undefined) : own;
  const found = claimedRecordsOf(part.output, list);
  return found.size > 0 ? found : undefined;
}

/** The output of the part that produced each result handle, by result id. */
function producingOutputs(messages: ReadonlyArray<unknown>): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts as unknown[]) {
      if (!isRecord(part) || typeof part.type !== 'string' || !part.type.startsWith('tool-')) continue;
      const marker = isRecord(part.output) ? part.output._result : undefined;
      if (isRecord(marker) && typeof marker.id === 'string' && part.type !== `tool-${READ_RESULT_TOOL_NAME}`) outputs.set(marker.id, part.output);
    }
  }
  return outputs;
}

/** The lookup id of a declared record: its id, or a composite key's JSON tuple. */
function declaredId(identity: DeclaredRecordIdentity): string | number {
  return entityLookupId(identity.idValues);
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
  declarations?: EntityDeclarationsByTool,
): Map<string, EntitySighting> {
  const sightings = new Map<string, EntitySighting>();
  /** Per id value: the kinds of the records that carried it as their own id, with their names. */
  const kinds = new Map<string, Map<string, string[]>>();
  /** Per lower-cased id: the declared opaque ids exactly as shown. */
  const exactIds = new Map<string, Set<string>>();
  /** `id key` + NUL + kind → the exact type a declaration or a mention gave for it. */
  const declaredKinds = new Map<string, string>();
  let budget = MAX_NODES;
  const tools = producingTools(messages);
  const outputs = declarations ? producingOutputs(messages) : undefined;

  /** `id key` + NUL + kind for every kind a tool result (not only a mention) showed. */
  const toolKinds = new Set<string>();
  const addKind = (id: unknown, kind: string | undefined, name: string | undefined, exact = false, mention = false) => {
    const key = exact ? exactEntityKey(id) : entityIdKey(id);
    if (!key || !kind) return;
    if (!mention) toolKinds.add(`${key}\u0000${kind}`);
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

  /** Ids a tool result named (not only a mention), and the id kind a declaration gave. */
  const fromTools = new Set<string>();
  const idKinds = new Map<string, EntityIdKind>();
  const add = (id: unknown, name: string, type?: string, mention = false, exact = false) => {
    const key = exact ? exactEntityKey(id) : entityIdKey(id);
    const trimmed = name.trim();
    if (!key || !trimmed) return;
    if (!mention) fromTools.add(key);
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
  const walk = (
    value: unknown, depth: number, holder?: string, inRecord = false, stem?: string,
    declared?: ReadonlyMap<Record<string, unknown>, DeclaredRecordIdentity | null>,
  ): void => {
    if (depth > MAX_DEPTH || budget <= 0) return;
    budget -= 1;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, holder, inRecord, stem, declared);
      return;
    }
    if (!isRecord(value)) return;
    const identity = declared?.get(value);
    let below: boolean;
    if (identity === null) {
      // A declared record without its id (not shown): no other field is guessed as its id.
      below = true;
    } else if (identity) {
      // A declared record: its declared id, name and type, no guess.
      const id = declaredId(identity);
      // An opaque id also under its exact key: a declared argument finds its own record, per type.
      for (const exact of identity.idKind === 'opaque' ? [false, true] : [false]) {
        const key = exact ? exactEntityKey(id) : entityIdKey(id);
        if (!key) continue;
        if (identity.name) add(id, identity.name, undefined, false, exact);
        else fromTools.add(key);
        addKind(id, identity.declaration.type ?? holder ?? stem, identity.name, exact);
        if (!exact && identity.idKind === 'opaque') {
          const shown = exactIds.get(key) ?? new Set<string>();
          shown.add(String(id).trim());
          exactIds.set(key, shown);
        }
        if (identity.declaration.type) declaredKinds.set(`${key}\u0000${identity.declaration.type}`, identity.declaration.type);
        if (!idKinds.has(key)) idKinds.set(key, identity.idKind);
      }
      below = true;
    } else {
      const idKey = ID_KEYS.find((key) => entityIdKey(value[key]) !== undefined);
      const nameKey = NAME_KEYS.find((key) => typeof value[key] === 'string' && (value[key] as string).trim() !== '');
      const name = nameKey ? value[nameKey] as string : undefined;
      if (idKey && name) add(value[idKey], name);
      const ownIds = idKey ? [idKey] : idLikeFieldsOf(value, RECOGNISED_KEYS);
      for (const key of ownIds) addKind(value[key], holder ?? stem, name);
      below = inRecord || ownIds.length > 0;
    }
    for (const [key, child] of Object.entries(value)) {
      if (typeof child !== 'object' || child === null) continue;
      // An index (`{ "2": { … } }`) and a generic wrapper at the top keep the kind of their holder.
      const childHolder = INDEX_KEY.test(key) || (!below && isGenericWrapper(key)) ? holder : kindOfField(key);
      walk(child, depth + 1, childHolder, below, stem, declared);
    }
  };

  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const message = messages[m];
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (let p = message.parts.length - 1; p >= 0; p -= 1) {
      const part: unknown = message.parts[p];
      if (!isRecord(part) || typeof part.type !== 'string') continue;
      if (part.type.startsWith('tool-') && part.state === 'output-available') {
        walk(part.output, 0, undefined, false, kindOfToolName(resultToolOf(part, tools)), declaredOf(part, tools, declarations, outputs));
      } else if (message.role === 'user' && part.type === 'text' && typeof part.text === 'string') {
        for (const segment of parseMentionSegments(part.text)) {
          if (segment.kind !== 'mention' || segment.mention.type === 'command') continue;
          add(segment.mention.id, segment.mention.displayName, segment.mention.type, true);
          // A mention names its type explicitly: with declarations it is that type as written (as a
          // declared record's kind is, so the two are one kind), compared exactly too.
          const mentionKind = declarations ? segment.mention.type : kindOfField(segment.mention.type);
          addKind(segment.mention.id, mentionKind, segment.mention.displayName, false, true);
          const mentioned = entityIdKey(segment.mention.id);
          if (declarations && mentioned && mentionKind) declaredKinds.set(`${mentioned}\u0000${mentionKind}`, segment.mention.type);
          // A picked id is exact: also under its exact key, for a declared argument.
          const exactMention = declarations ? exactEntityKey(segment.mention.id) : undefined;
          if (exactMention && mentioned) {
            // Picked exactly: an opaque argument of other case is not this record.
            const shown = exactIds.get(mentioned) ?? new Set<string>();
            shown.add(String(segment.mention.id).trim());
            exactIds.set(mentioned, shown);
          }
          if (exactMention) {
            add(segment.mention.id, segment.mention.displayName, segment.mention.type, true, true);
            addKind(segment.mention.id, mentionKind, segment.mention.displayName, true, true);
            if (mentionKind) declaredKinds.set(`${exactMention}\u0000${mentionKind}`, segment.mention.type);
          }
        }
      }
    }
  }
  // Only a collision is recorded: one kind is what every sighting had before.
  for (const [key, sighting] of sightings) {
    const byKind = kinds.get(key);
    if (byKind && byKind.size > 1) {
      sighting.kinds = [...byKind].map(([kind, names]) => ({
        kind, names: [...names], ...(declaredKinds.has(`${key}\u0000${kind}`) ? { type: declaredKinds.get(`${key}\u0000${kind}`)! } : {}),
        ...(declarations && !toolKinds.has(`${key}\u0000${kind}`) ? { mentionedOnly: true as const } : {}),
      }));
    }
    // Only with a declaration: an app without one sees the sightings it always had.
    if (declarations) {
      if (byKind && byKind.size === 1) {
        sighting.kind = [...byKind.keys()][0]!;
        const kindType = declaredKinds.get(`${key}\u0000${sighting.kind}`);
        if (kindType) sighting.kindType = kindType;
      }
      const exact = exactIds.get(key);
      if (exact) sighting.exactIds = [...exact];
      const idKind = idKinds.get(key);
      if (idKind) sighting.idKind = idKind;
      if (!fromTools.has(key)) sighting.mentionedOnly = true;
    }
  }
  return sightings;
}

/** A record id a tool result of this conversation carried, with or without a name. */
export interface SeenEntity {
  /** A short field of the same record that tells it apart (`Version number 3`), when it has one. */
  fallback?: string;
  /** Set only for a declared record with a declared fallback: the field it came from (`versionNumber`). */
  fallbackField?: string;
  /** Set only for a declared record: its declared type and id kind. */
  type?: string;
  idKind?: EntityIdKind;
  /**
   * Set only for declared records: what each declared type that carried this
   * id showed (two nameless records of different types can share an id).
   */
  byType?: Record<string, { fallback?: string; fallbackField?: string; idKind: EntityIdKind }>;
  /** Set only for declared records with an opaque id: the ids exactly as shown (see `EntitySighting.exactIds`). */
  exactIds?: string[];
}

/**
 * Every record id (`id`, `_id` or `uuid`) the finished tool results of this
 * conversation carried, at the depths {@link collectEntitySightings} reads,
 * also without a name: a version record has none. The newest result wins for
 * the fallback. Tool results only, never mentions, calls or the model's text.
 */
export function collectSeenEntityIds(
  messages: ReadonlyArray<unknown>,
  declarations?: EntityDeclarationsByTool,
): Map<string, SeenEntity> {
  const seen = new Map<string, SeenEntity>();
  let budget = MAX_NODES;
  const tools = declarations ? producingTools(messages) : new Map<string, string>();
  const outputs = declarations ? producingOutputs(messages) : undefined;

  const walk = (value: unknown, depth: number, declared?: ReadonlyMap<Record<string, unknown>, DeclaredRecordIdentity | null>): void => {
    if (depth > MAX_DEPTH || budget <= 0) return;
    budget -= 1;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, declared);
      return;
    }
    if (!isRecord(value)) return;
    const identity = declared?.get(value);
    // A declared record without its id (`null`): nothing is guessed for it.
    const idKey = identity !== undefined ? undefined : ID_KEYS.find((key) => entityIdKey(value[key]) !== undefined);
    if (identity) {
      for (const key of [entityIdKey(declaredId(identity)), ...(identity.idKind === 'opaque' ? [exactEntityKey(declaredId(identity))] : [])]) {
      if (key) {
        const fallback = identity.fallbackField !== undefined
          ? { fallback: fallbackText(identity.fallbackField, identity.fallbackValue!), fallbackField: identity.fallbackField }
          : {};
        const type = identity.declaration.type;
        let known = seen.get(key);
        // The newest record is read first: it wins, an older one only fills a missing fallback of its own type.
        if (!known) seen.set(key, known = { ...fallback, ...(type ? { type } : {}), idKind: identity.idKind });
        else if (!known.fallback && (known.type === undefined || known.type === type)) Object.assign(known, fallback);
        if (identity.idKind === 'opaque') {
          const exact = String(declaredId(identity));
          if (!(known.exactIds ??= []).includes(exact)) known.exactIds.push(exact);
        }
        if (type) {
          // No prototype: a type may be called `constructor`.
          known.byType ??= Object.create(null) as NonNullable<SeenEntity['byType']>;
          const entry = Object.prototype.hasOwnProperty.call(known.byType, type) ? known.byType[type] : undefined;
          if (!entry) known.byType[type] = { ...fallback, idKind: identity.idKind };
          else if (!entry.fallback) Object.assign(entry, fallback);
        }
      }
      }
    } else if (idKey) {
      const key = entityIdKey(value[idKey])!;
      const known = seen.get(key);
      if (!known) {
        const fallback = fallbackTextOf(value);
        seen.set(key, fallback ? { fallback } : {});
      } else if (!known.fallback) {
        const fallback = fallbackTextOf(value);
        if (fallback) known.fallback = fallback;
      }
    }
    for (const child of Object.values(value)) {
      if (typeof child === 'object' && child !== null) walk(child, depth + 1, declared);
    }
  };

  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const message = messages[m];
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (let p = message.parts.length - 1; p >= 0; p -= 1) {
      const part: unknown = message.parts[p];
      if (!isRecord(part) || typeof part.type !== 'string') continue;
      if (part.type.startsWith('tool-') && part.state === 'output-available') walk(part.output, 0, declaredOf(part, tools, declarations, outputs));
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
  declarations?: EntityDeclarationsByTool,
): Map<string, string> {
  return new Map([...collectEntitySightings(messages, declarations)].map(([id, sighting]) => [id, sighting.name]));
}

/**
 * What the user typed in their own messages, newest first (at most 50): the
 * text segments only, never the markup of an `@` mention (its id was picked,
 * not typed; a mention counts as its own provenance).
 */
export function userTextsOf(messages: ReadonlyArray<unknown>): string[] {
  const texts: string[] = [];
  for (let m = messages.length - 1; m >= 0 && texts.length < 50; m -= 1) {
    const message = messages[m];
    if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.parts)) continue;
    for (const part of message.parts as unknown[]) {
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
      texts.push(parseMentionSegments(part.text).map((segment) => (segment.kind === 'text' ? segment.text : ' ')).join(''));
    }
  }
  return texts;
}
