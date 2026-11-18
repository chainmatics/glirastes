/**
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

/** Whether two kinds can be the same: their last words agree. */
export function kindsMatch(left: string, right: string): boolean {
  return left.split(' ').at(-1) === right.split(' ').at(-1);
}

/** `user` → `User`, `playlist version` → `Playlist version`. */
export function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
