import type { ApprovalSubject } from '../types.js';
import { entityIdKey, isUuidLike, type EntitySighting } from './entity-names.js';

const MAX_DEPTH = 4;
/** Id values checked per approval; a call with more ids is rare and the rest are not listed. */
const MAX_IDS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `id`, `ids`, `ID`, `IDs`, `_id`. */
const BARE_ID_KEY = /^(?:id|ids|ID|IDs|Id|Ids|_id)$/;
/** `playlistId`, `playlist_id`, `playlistID` and their plurals `playlistIds`, `playlist_ids`, `playlistIDs`. */
const ID_SUFFIX = /^(.+?)(?:Id|_id|ID)(s?)$/;

/** Whether an argument key names an id by its form alone. */
export function isIdKey(key: string): boolean {
  return BARE_ID_KEY.test(key) || ID_SUFFIX.test(key);
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
  if (BARE_ID_KEY.test(key)) return undefined;
  const match = ID_SUFFIX.exec(key);
  if (match) return humanize(match[1] + match[2]) || undefined;
  return humanize(key) || undefined;
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
 * Status:
 * - `named`: the id was shown with one name (or a UUID with several: a rename,
 *   the most recent name is shown).
 * - `ambiguous`: a non-UUID id was shown with different names. Short ids repeat
 *   across entity types (playlist 7, user 7), so the most recent name is shown
 *   with the id and a warning.
 * - `unknown`: no name was shown for the id; the card warns and shows the id.
 */
export function resolveApprovalSubjects(
  args: unknown,
  sightings: ReadonlyMap<string, EntitySighting>,
): ApprovalSubject[] {
  const subjects: ApprovalSubject[] = [];

  const add = (path: string, label: string | undefined, raw: unknown) => {
    const key = entityIdKey(raw);
    if (key === undefined) return;
    const id = typeof raw === 'string' ? raw.trim() : String(raw);
    const seen = sightings.get(key);
    if (!seen) {
      subjects.push({ path, id, status: 'unknown', ...(label ? { label } : {}) });
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

  const walk = (obj: Record<string, unknown>, prefix: string, parentLabel: string | undefined, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const [key, value] of Object.entries(obj)) {
      if (subjects.length >= MAX_IDS) return;
      if (value === undefined || value === null) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      // A bare `id` inside `playlist: { id }` takes the label of its object.
      const label = BARE_ID_KEY.test(key) ? parentLabel : labelOfKey(key);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (subjects.length >= MAX_IDS) break;
          if (isRecord(item)) walk(item, `${path}[]`, labelOfKey(key), depth + 1);
          else if (isIdValue(key, item)) add(path, label, item);
        }
        continue;
      }
      if (isRecord(value)) {
        walk(value, path, labelOfKey(key), depth + 1);
        continue;
      }
      if (isIdValue(key, value)) add(path, label, value);
    }
  };

  if (isRecord(args)) walk(args, '', undefined, 0);
  return subjects;
}
