/**
 * The one place that guesses a record's identity from field names and value
 * shapes: which field is its own id, which one names it for a person, which
 * fields refer to other records, which values are technical ids, and which
 * kind of record a field or tool holds.
 *
 * Every consumer (result overview, history compaction, `read_result`,
 * `hideIds`, the chat UI's names and approval subjects, the codegen entity
 * catalog, the entity-action check) reads its rule from here. Where two of
 * them guess differently today, the difference is an explicit, named profile
 * below, not a second copy of the rule; a declared identity is meant to
 * replace the guess.
 *
 * Dependency-free (no engine, provider or React import), so the React bundle
 * can import it. Nothing here is part of the Platform wire contract.
 *
 * @module
 */

// ============================================================================
// Value shapes
// ============================================================================

/** Source of a UUID (any version), without anchors or flags. */
export const UUID_PATTERN_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_PATTERN_SOURCE}$`, 'i');
/** Long hex strings (hashes, Mongo object ids). */
const HEX = /^[0-9a-f]{16,}$/i;
/** Long tokens with letters and digits (cuid, nanoid, base64 ids). */
const TOKEN = /^(?=[^\s]*\d)(?=[^\s]*[a-z])[A-Za-z0-9_-]{20,}$/i;

/** Whether a string has the shape of a UUID. */
export function isUuidLike(value: string): boolean {
  return UUID.test(value);
}

/** Whether a string is an opaque id by its shape: a UUID, a long hex string or a long letter-digit token. */
export function isOpaqueIdText(text: string): boolean {
  return UUID.test(text) || HEX.test(text) || TOKEN.test(text);
}

/**
 * Whether a value written into an answer counts as a technical id (`hideIds`):
 * a UUID, or a word of at least eight characters without whitespace, with a
 * digit, made of letters, digits, `_` and `-`. A shorter or digit-free value
 * can be an ordinary word.
 */
export function looksLikeTechnicalId(value: string): boolean {
  if (UUID.test(value)) return true;
  return value.length >= 8 && !/\s/.test(value) && /\d/.test(value) && /^[\w-]+$/.test(value);
}

/** Longest id value the browser tracks. */
const MAX_ID_LENGTH = 200;

/**
 * The lookup key of an id value in the browser: a non-empty string of at most
 * 200 characters (trimmed) or a safe integer, lower-cased. Anything else is no id.
 */
export function entityIdKey(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxIdLength(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

/** Marks the lookup form of a declared composite key (`entityLookupId`); never part of a real id. */
export const COMPOSITE_ID_MARK = '\u0002';
/** A composite key's lookup form holds up to four ids of 200 characters each. */
const MAX_COMPOSITE_ID_LENGTH = 1_024;

/** The longest id text a key is formed from: 200 characters, a composite key's lookup form 1,024. */
export function maxIdLength(text: string): number {
  return text.startsWith(COMPOSITE_ID_MARK) ? MAX_COMPOSITE_ID_LENGTH : MAX_ID_LENGTH;
}

/**
 * The lookup key of an id argument in `createApprovalDescriptionGenerator`'s
 * `nameLabels`: a string, lower-cased, not trimmed; a number is no key there
 * (divergence from {@link entityIdKey}, kept until the declared identity).
 */
export function approvalNameLookupKey(value: unknown): string | undefined {
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

// ============================================================================
// Field-name profiles
// ============================================================================

/**
 * The keys a record carries its own id under, per consumer. The two lists
 * differ today and each consumer keeps its own outcome:
 * - `result`: result overview, history compaction, `read_result` (and the
 *   id-like rule's default): `id`, `uuid`, `key`, `slug`, `code`; no `_id`.
 * - `browser`: the chat UI's names, seen ids and kinds: `id`, `_id`, `uuid`;
 *   no speaking keys.
 */
export const OWN_ID_KEYS = {
  result: ['id', 'uuid', 'key', 'slug', 'code'],
  browser: ['id', '_id', 'uuid'],
} as const satisfies Record<string, ReadonlyArray<string>>;

/**
 * The keys that name a record for a person, per consumer, in priority order
 * where the consumer takes the first one:
 * - `result`: overview, history compaction, `read_result` (the order of the
 *   `_history.keys` names; the entry's own key order decides which one a pair keeps).
 * - `browser`: the chat UI's names and `hideIds` labels.
 * - `search`: the codegen entity catalog's `labelField` (also `subject`, `email`).
 */
export const NAME_KEYS = {
  result: ['name', 'title', 'label', 'displayName'],
  browser: ['title', 'name', 'displayName', 'label'],
  search: ['title', 'name', 'displayName', 'label', 'subject', 'email'],
} as const satisfies Record<string, ReadonlyArray<string>>;

/** The identifier keys the result overview recognises as an entry's own id (`OWN_ID_KEYS.result`). */
export const RECOGNISED_ID_KEYS: ReadonlyArray<string> = OWN_ID_KEYS.result;

/**
 * The keys that count as a recognised identifier when the browser decides
 * whether a record falls back to its id-like fields: both profiles together.
 */
export const BROWSER_RECOGNISED_ID_KEYS: ReadonlyArray<string> = [
  ...new Set<string>([...OWN_ID_KEYS.browser, ...OWN_ID_KEYS.result]),
];

/** The fields the codegen entity catalog takes as a search hit's id, best first (`taskId` for type `task`). */
export function searchIdFieldCandidates(type: string): string[] {
  return ['id', 'uuid', `${type}Id`];
}

// ============================================================================
// Id-like and reference keys
// ============================================================================

/**
 * A key that ends in `Id`/`ID` after a lower-case letter, digit or `_`
 * (`playlistId`, `playlistID`, `user_ID`), or in `_id` after at least one
 * character (`playlist_id`). Not a word that merely ends in those letters
 * (`VALID`, `COVID`, `paid`), not the bare `id`/`_id`, and not a plural
 * (`trackIds`, `track_ids`): a list of ids names other records.
 */
const ID_LIKE_KEY = /^(?:.*[a-z0-9_](?:Id|ID)|.+_id)$/;
/** {@link ID_LIKE_KEY} including plurals: a field that refers to other records (`folderId`, `brandKitIDs`). */
const REFERENCE_KEY = /^(?:.*[a-z0-9_](?:Id|ID)|.+_id)s?$/;
/** Serialized `"key":value` of an id-like field, at most (the overview's identity bound). */
const MAX_ID_LIKE_FIELD_CHARS = 200;
/**
 * Id-like fields kept per entry, at most, in the entry's key order. A safety
 * bound only, set far above any real record; ids beyond it are not kept.
 */
export const MAX_ID_LIKE_FIELDS = 16;

/** Whether a key is id-like by its form (`playlist_id`, `playlistId`), see {@link ID_LIKE_KEY}. */
export function isIdLikeKey(key: string): boolean {
  return ID_LIKE_KEY.test(key);
}

/** Whether a key refers to other records by its form (`folderId`, `tenant_id`, `brandKitIDs`); not `VALID`. */
export function isReferenceKey(key: string): boolean {
  return REFERENCE_KEY.test(key);
}

/** An id value: a non-empty string or a safe integer, the field (`"key":value`) at most 200 characters. */
function isIdValue(key: string, value: unknown): boolean {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return false;
  } else if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }
  // Same measure as the overview's identity fields: `"key":value,`.
  return JSON.stringify(key).length + 1 + JSON.stringify(value).length + 1 <= MAX_ID_LIKE_FIELD_CHARS;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The id-like fields of an entry that has no recognised identifier: when
 * none of `recognised` (default {@link RECOGNISED_ID_KEYS}) holds an id value
 * (a non-empty string or a safe integer), every own field whose key is
 * id-like ({@link isIdLikeKey}) and whose value is an id value, in the
 * entry's key order, at most {@link MAX_ID_LIKE_FIELDS}. Empty when the entry
 * has a recognised identifier or is no object.
 *
 * Deliberately not clever: an entry whose own id is `playlist_id` cannot be
 * told apart from one that only refers to a playlist, so every such field is
 * kept. One field too many costs a few characters; no id at all leaves the
 * model without a value for the next call.
 */
export function idLikeFieldsOf(
  entry: unknown,
  recognised: ReadonlyArray<string> = RECOGNISED_ID_KEYS,
): string[] {
  if (!isPlainObject(entry)) return [];
  if (recognised.some((key) => Object.prototype.hasOwnProperty.call(entry, key) && isIdValue(key, entry[key]))) return [];
  const keys: string[] = [];
  for (const key of Object.keys(entry)) {
    if (keys.length >= MAX_ID_LIKE_FIELDS) break;
    if (isIdLikeKey(key) && isIdValue(key, entry[key])) keys.push(key);
  }
  return keys;
}

// ============================================================================
// Identity fields of a result entry (overview, history, read_result)
// ============================================================================

/** Identity keys that identify an entry (its id), and those that name it for a person. */
const RESULT_IDENTITY_KEY = new RegExp(`^(${[...OWN_ID_KEYS.result, ...NAME_KEYS.result].join('|')})$`);
/** Serialized `"key":value,` of an identity field, at most. */
export const MAX_IDENTITY_FIELD_CHARS = 200;

/** Whether a key is one of the result profile's own id or name keys (`id`, `key`, `name`, `displayName`, …). */
export function isResultIdentityKey(key: string): boolean {
  return RESULT_IDENTITY_KEY.test(key);
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * The identity fields of one entry that name it: an identity key with a
 * scalar value whose field (key and value, serialized) is at most 200
 * characters, in the entry's key order. An entry without a recognised
 * identifier (`id`, `uuid`, `key`, `slug`, `code`) adds every id-like field
 * (`playlist_id`, `ownerId`: `idLikeFieldsOf`). `read_result` adds them to the
 * entries of an array it reads below; the overview keeps the same keys.
 */
export function identityFieldsOf(entry: Record<string, unknown>): Array<[string, unknown]> {
  const fields: Array<[string, unknown]> = [];
  const idLike = new Set(idLikeFieldsOf(entry, OWN_ID_KEYS.result));
  for (const key of Object.keys(entry)) {
    if (!RESULT_IDENTITY_KEY.test(key) && !idLike.has(key)) continue;
    const value = entry[key];
    const scalar = value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (scalar && serializedLength(key) + 1 + serializedLength(value) + 1 <= MAX_IDENTITY_FIELD_CHARS) fields.push([key, value]);
  }
  return fields;
}

// ============================================================================
// hideIds: id keys and labels
// ============================================================================

/** `hideIds`: whether a key holds ids (`id`, or ending in `Id`, `_id`, `Ids`, `_ids`). */
export function isTechnicalIdKey(key: string): boolean {
  return key === 'id' || /(?:Id|_id|Ids|_ids)$/.test(key);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * `hideIds`: the readable label of a record's own `id`: the first field in key
 * order whose key ends in `identifier` or is `key`, else the first
 * `NAME_KEYS.browser` field; strings only, trimmed.
 */
export function ownLabelOf(record: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(record)) {
    if (/identifier$/i.test(key) || key === 'key') {
      const value = stringField(record, key);
      if (value) return value;
    }
  }
  for (const key of NAME_KEYS.browser) {
    const value = stringField(record, key);
    if (value) return value;
  }
  return undefined;
}

/** `hideIds`: the label next to a reference key (`ownerId` → `ownerDisplayName`, `ownerName`, …). */
export function siblingLabelOf(record: Record<string, unknown>, idKey: string): string | undefined {
  const stem = idKey.replace(/(?:Id|_id)$/, '');
  for (const suffix of ['DisplayName', 'Name', 'Title', 'Label', '_name', '_title']) {
    const value = stringField(record, `${stem}${suffix}`);
    if (value) return value;
  }
  return undefined;
}

// ============================================================================
// Approval arguments: id keys
// ============================================================================

/** `id`, `ids`, `ID`, `IDs`, `_id`. */
const BARE_ID_ARGUMENT = /^(?:id|ids|ID|IDs|Id|Ids|_id)$/;
/** `playlistId`, `playlist_id`, `playlistID` and their plurals `playlistIds`, `playlist_ids`, `playlistIDs`. */
const ID_ARGUMENT_SUFFIX = /^(.+?)(?:Id|_id|ID)(s?)$/;

/** Whether an argument key is a bare id (`id`, `ids`, `ID`, `_id`). */
export function isBareIdArgumentKey(key: string): boolean {
  return BARE_ID_ARGUMENT.test(key);
}

/** Whether an argument key names an id by its form alone. */
export function isIdArgumentKey(key: string): boolean {
  return BARE_ID_ARGUMENT.test(key) || ID_ARGUMENT_SUFFIX.test(key);
}

/** The stem and plural `s` of an id argument key (`trackIds` → `track`, `s`), or undefined. */
export function idArgumentStem(key: string): { stem: string; plural: string } | undefined {
  const match = ID_ARGUMENT_SUFFIX.exec(key);
  return match ? { stem: match[1]!, plural: match[2]! } : undefined;
}

/**
 * Codegen: the entity stem of a path or input parameter that holds one
 * entity's id (`taskId`, `params.task_id` → `task`), or undefined.
 */
export function idParameterStem(name: string): string | undefined {
  const match = /^(?:params\.)?([A-Za-z][A-Za-z0-9]*?)(?:Id|_id)$/.exec(name);
  return match ? match[1]! : undefined;
}

/** Codegen: whether a path parameter is the bare `id` of the segment before it. */
export function isBareIdParameter(name: string): boolean {
  return name === 'id';
}

// ============================================================================
// Fallback fields (a record without a name)
// ============================================================================

/**
 * Fields that stand in for a missing name, in this order: a version or a
 * number tells records of one type apart (`versionNumber: 3`). Never a name.
 */
const FALLBACK_KEYS = ['versionNumber', 'version', 'number', 'code', 'slug'] as const;
const MAX_FALLBACK_LENGTH = 80;

/** `versionNumber` → `Version number`. */
function fallbackLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A fallback field and its value as text (`versionNumber`, 3 → `Version number 3`). */
export function fallbackText(field: string, value: string | number): string {
  return `${fallbackLabel(field)} ${typeof value === 'string' ? value.trim() : String(value)}`;
}

/** The first fallback field of a record as text (`Version number 3`), at most 80 characters of value. */
export function fallbackTextOf(record: Record<string, unknown>): string | undefined {
  for (const key of FALLBACK_KEYS) {
    const value = record[key];
    const text = typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string' ? value.trim() : '';
    if (text && text.length <= MAX_FALLBACK_LENGTH) return `${fallbackLabel(key)} ${text}`;
  }
  return undefined;
}

// ============================================================================
// Kinds (the type of a record without a declaration)
// ============================================================================

/*
 * The kind of a record the browser saw, from what it has without a declared
 * identity: the field that holds the record and the name of the tool that
 * returned it. Used only to tell whether one id value stood for records of
 * different kinds (user 3, playlist 3) and whether an argument picks one.
 *
 * Assumptions (stated, not declared by the app):
 * - A record held by a named field is of the kind that field names, singular
 *   (`users[]` → `user`, `owner` → `owner`, `items[]` inside a playlist → `item`).
 * - A record at the root of a result, or held only by a generic wrapper at the
 *   top (`data`, `items`, `results`, …), is of the kind the tool name names
 *   once its action words are dropped (`playlists_list`, `playlists_get`,
 *   `delete_playlist` → `playlist`), so a list and a get of one resource
 *   are one kind. `read_result` answers take the tool that produced the result.
 * - An argument picks a kind by its key (`playlist_id`, `playlistId` →
 *   `playlist`), a bare `id` by its parent object (`playlist: { id }`) or by
 *   the approved tool's name (`playlists_delete({ id })` → `playlist`).
 * Two kinds match when their last words agree (`playlist version` and
 * `version_id`). Anything else counts as undetermined.
 */

/** Wrappers that hold the records of a result without naming their kind (top level only). */
const GENERIC_WRAPPERS: ReadonlySet<string> = new Set([
  'data', 'items', 'item', 'results', 'result', 'records', 'record', 'rows', 'entries', 'content', 'payload',
  'response', 'body', 'value', 'values', 'nodes', 'node', 'edges', 'hits', 'list', 'page', 'docs', 'documents',
  'objects', 'collection', 'elements',
]);

/** Action words of a tool name; what remains names the resource. */
const ACTION_WORDS: ReadonlySet<string> = new Set([
  'list', 'get', 'find', 'search', 'read', 'fetch', 'show', 'view', 'query', 'lookup', 'load', 'count',
  'create', 'add', 'new', 'insert', 'post', 'update', 'edit', 'patch', 'put', 'set', 'modify', 'rename',
  'upsert', 'save', 'delete', 'remove', 'destroy', 'archive', 'unarchive', 'restore', 'rollback', 'revert',
  'move', 'copy', 'duplicate', 'clone', 'publish', 'unpublish', 'approve', 'reject', 'assign', 'unassign',
  'export', 'import', 'bulk', 'batch', 'all', 'many', 'one', 'by',
]);

/** `playlistsVersions_list` → `playlists`, `versions`, `list`. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

/** A plain English singular, good enough for field and tool names (`entries` → `entry`, `classes` → `class`). */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The kind a field names (`playlists` → `playlist`, `ownerUsers` → `owner user`), or undefined for none. */
export function kindOfField(key: string): string | undefined {
  const parts = words(key).map(singular);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Whether a key is a generic wrapper at the top of a result (`data`, `items`). */
export function isGenericWrapper(key: string): boolean {
  return GENERIC_WRAPPERS.has(key.toLowerCase());
}

/** The resource a tool name names (`playlists_list` → `playlist`, `delete_playlist` → `playlist`). */
export function kindOfToolName(toolName: string): string | undefined {
  const all = words(toolName);
  const kept = all.filter((word) => !ACTION_WORDS.has(word)).map(singular);
  if (kept.length > 0) return kept.join(' ');
  return all.length > 0 ? all.map(singular).join(' ') : undefined;
}

/** Whether two kinds can be the same: their last words agree (a declared `playlist-version` counts as words). */
export function kindsMatch(left: string, right: string): boolean {
  const last = (kind: string) => kind.split(/[ _.-]+/).at(-1);
  return last(left) === last(right);
}

/** `user` → `User`, `playlist version` → `Playlist version`. */
export function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
