/**
 * Which fields of a record may be its own id, by field name alone: the one
 * place the result overview, history compaction, `read_result` and the chat
 * UI's approval names share. Dependency-free so the React bundle can import
 * it. Nothing here is part of the Platform wire contract; a declared identity
 * of a tool's result is meant to replace this rule.
 */

/** The identifier keys the result overview recognises as an entry's own id. */
export const RECOGNISED_ID_KEYS: ReadonlyArray<string> = ['id', 'uuid', 'key', 'slug', 'code'];

/**
 * A key that ends in `Id`/`ID` after a lower-case letter, digit or `_`
 * (`playlistId`, `playlistID`, `user_ID`), or in `_id` after at least one
 * character (`playlist_id`). Not a word that merely ends in those letters
 * (`VALID`, `COVID`, `paid`), not the bare `id`/`_id`, and not a plural
 * (`trackIds`, `track_ids`): a list of ids names other records.
 */
const ID_LIKE_KEY = /^(?:.*[a-z0-9_](?:Id|ID)|.+_id)$/;
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
