import type { ApprovalSubject } from '../types.js';
import {
  entityIdKey,
  idArgumentStem,
  isBareIdArgumentKey,
  isIdArgumentKey,
  isUuidLike,
  kindLabel,
  kindOfField,
  kindOfToolName,
  kindsMatch,
} from '../../contracts/entity-identity.js';
import type { EntitySighting, SeenEntity } from './entity-names.js';

const MAX_DEPTH = 4;
/** Id values checked per approval; a call with more ids is rare and the rest are not listed. */
const MAX_IDS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether an argument key names an id by its form alone (`id`, `ids`, `_id`, `playlistId`, `track_ids`). */
export function isIdKey(key: string): boolean {
  return isIdArgumentKey(key);
}

/** `targetFolder` → `Target folder`, `play_list` → `Play list`. */
function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** The entity an id key names (`playlistId` → `Playlist`, `trackIds` → `Tracks`), or undefined for a bare `id`. */
function labelOfKey(key: string): string | undefined {
  if (isBareIdArgumentKey(key)) return undefined;
  const match = idArgumentStem(key);
  if (match) return humanize(match.stem + match.plural) || undefined;
  return humanize(key) || undefined;
}

/** What the approved call itself says about its ids. */
export interface ApprovalSubjectOptions {
  /**
   * The name of the tool the approval is for (`playlists_delete`): a bare
   * `id` at the top of its arguments addresses the kind this name names.
   */
  toolName?: string;
}

/** The kind an id argument addresses (`playlist_id` → `playlist`), or undefined when the key does not say. */
function kindOfKey(key: string): string | undefined {
  if (isBareIdArgumentKey(key)) return undefined;
  const match = idArgumentStem(key);
  return match ? kindOfField(match.stem) : undefined;
}

/**
 * The ids a pending tool call carries, each with what this conversation showed
 * for it. An argument is an id when
 * - its key is `id`/`ids`/`ID`, or ends in `Id`, `_id` or `ID` (plural with `s`),
 *   and its value is a non-empty string of at most 200 characters or an integer, or
 * - its value is a UUID-shaped string, whatever the key.
 * Arrays of such values count element by element; nested objects and arrays of
 * objects are followed four levels deep. At most 100 id values are checked.
 *
 * A name comes only from `sightings`, i.e. from the browser's own message
 * history (see `collectEntitySightings`). This is client-side data and a
 * convenience for the person approving — never a trust boundary. The server
 * still executes exactly the signed arguments; nothing here changes them.
 *
 * Ids that collide: a non-UUID id value seen as the own id of records of more
 * than one kind (`EntitySighting.kinds`: user 3 and playlist 3) names the
 * record only when the argument picks exactly one of those kinds: by its key
 * (`playlist_id`, `playlistId` → `playlist`), or for a bare `id` by its parent
 * object (`playlist: { id }`) or the approved tool's name
 * (`options.toolName`, `playlists_delete` → `playlist`). Otherwise it is
 * `ambiguous` without a `name`, with every candidate in `candidates`. A UUID
 * is the same record wherever it occurs, so it never collides.
 *
 * Status:
 * - `named`: the id was shown with one name (or a UUID with several: a rename,
 *   the most recent name is shown); for a colliding id, the one kind the
 *   argument picks had one name.
 * - `ambiguous`: a non-UUID id was shown with different names. Short ids repeat
 *   across entity types (playlist 7, user 7), so the most recent name is shown
 *   with the id and a warning. A colliding id the argument does not pick a
 *   kind for has no `name`, but `names` and `candidates`.
 * - `seen`: no name was shown, but a tool result of this conversation carried
 *   the id as a record id (`seenIds`, e.g. a version without a name field); no
 *   warning, with a fallback field of that record when it has one.
 * - `unknown`: the id occurred nowhere; the card warns and shows the id.
 */
export function resolveApprovalSubjects(
  args: unknown,
  sightings: ReadonlyMap<string, EntitySighting>,
  seenIds: ReadonlyMap<string, SeenEntity> = new Map(),
  options: ApprovalSubjectOptions = {},
): ApprovalSubject[] {
  const subjects: ApprovalSubject[] = [];
  const toolKind = options.toolName ? kindOfToolName(options.toolName) : undefined;

  const add = (path: string, label: string | undefined, raw: unknown, kind: string | undefined) => {
    const key = entityIdKey(raw);
    if (key === undefined) return;
    const id = typeof raw === 'string' ? raw.trim() : String(raw);
    const seen = sightings.get(key);
    if (seen?.kinds && seen.kinds.length > 1 && !isUuidLike(id)) {
      const resolvedLabel = label ?? (seen.type ? humanize(seen.type) : undefined);
      const picked = kind ? seen.kinds.filter((candidate) => kindsMatch(candidate.kind, kind)) : [];
      const one = picked.length === 1 ? picked[0]! : undefined;
      if (one && one.names.length === 1) {
        subjects.push({ path, id, status: 'named', name: one.names[0]!, ...(resolvedLabel ? { label: resolvedLabel } : {}) });
      } else if (one && one.names.length > 1) {
        // One kind, several names: as for any short id shown with different names.
        subjects.push({
          path, id, status: 'ambiguous', name: one.names[0]!, names: [...one.names], ...(resolvedLabel ? { label: resolvedLabel } : {}),
        });
      } else if (one) {
        subjects.push({ path, id, status: 'seen', ...(resolvedLabel ? { label: resolvedLabel } : {}) });
      } else {
        const candidates = seen.kinds.flatMap((candidate) => (candidate.names.length > 0
          ? candidate.names.map((name) => ({ label: kindLabel(candidate.kind), name }))
          : [{ label: kindLabel(candidate.kind) }]));
        const names = [...new Set(seen.kinds.flatMap((candidate) => candidate.names))];
        subjects.push({ path, id, status: 'ambiguous', names, candidates, ...(resolvedLabel ? { label: resolvedLabel } : {}) });
      }
      return;
    }
    if (!seen) {
      const record = seenIds.get(key);
      subjects.push(record
        ? { path, id, status: 'seen', ...(label ? { label } : {}), ...(record.fallback ? { fallback: record.fallback } : {}) }
        : { path, id, status: 'unknown', ...(label ? { label } : {}) });
      return;
    }
    const resolvedLabel = label ?? (seen.type ? humanize(seen.type) : undefined);
    const ambiguous = seen.names.length > 1 && !isUuidLike(id);
    subjects.push({
      path,
      id,
      status: ambiguous ? 'ambiguous' : 'named',
      name: seen.name,
      ...(ambiguous ? { names: [...seen.names] } : {}),
      ...(resolvedLabel ? { label: resolvedLabel } : {}),
    });
  };

  const isIdValue = (key: string, value: unknown) =>
    isIdKey(key) || (typeof value === 'string' && isUuidLike(value));

  /** `parentKind`: the kind the object's own key names (`playlist: { id }`); the tool's kind at the top. */
  const walk = (
    obj: Record<string, unknown>, prefix: string, parentLabel: string | undefined, parentKind: string | undefined, depth: number,
  ) => {
    if (depth > MAX_DEPTH) return;
    for (const [key, value] of Object.entries(obj)) {
      if (subjects.length >= MAX_IDS) return;
      if (value === undefined || value === null) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      // A bare `id` inside `playlist: { id }` takes the label of its object.
      const label = isBareIdArgumentKey(key) ? parentLabel : labelOfKey(key);
      const kind = isBareIdArgumentKey(key) ? parentKind : kindOfKey(key);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (subjects.length >= MAX_IDS) break;
          if (isRecord(item)) walk(item, `${path}[]`, labelOfKey(key), kindOfField(key), depth + 1);
          else if (isIdValue(key, item)) add(path, label, item, kind);
        }
        continue;
      }
      if (isRecord(value)) {
        walk(value, path, labelOfKey(key), kindOfField(key), depth + 1);
        continue;
      }
      if (isIdValue(key, value)) add(path, label, value, kind);
    }
  };

  if (isRecord(args)) walk(args, '', undefined, toolKind, 0);
  return subjects;
}
