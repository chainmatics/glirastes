/**
 * Browser side of the view context: what the user currently looks at, as
 * the app declares it. Nothing is read from the page or the URL; only what a
 * page registers is sent, with the next chat message, to the app's own chat
 * endpoint (never to the Platform, telemetry, logs or storage).
 *
 * One registry per page (on `globalThis`, so several copies of the SDK
 * share it): one entry per source, in the order the sources first
 * registered. The snapshot is cleaned and bounded with the contract
 * (`sanitizeViewContext`, `VIEW_CONTEXT_LIMITS`); the server checks it again
 * against the entity types and facts schemas it knows and stays the
 * authority.
 *
 * @module
 */
import {
  sanitizeViewContext,
  type ViewContextEntry,
  type ViewContextFactsSchema,
} from '../contracts/view-context.js';

const REGISTRY = Symbol.for('glirastes.viewContext');

interface Registration {
  readonly token: object;
  readonly entry: ViewContextEntry;
}

function registry(): Map<string, Registration> {
  const scope = globalThis as Record<symbol, unknown>;
  let map = scope[REGISTRY] as Map<string, Registration> | undefined;
  if (!(map instanceof Map)) {
    map = new Map();
    scope[REGISTRY] = map;
  }
  return map;
}

/**
 * Registers what the user looks at for `source` (a name the caller owns,
 * such as `'order-page'`), replacing that source's earlier entry in place;
 * `null` unregisters it. Returns a function that unregisters this
 * registration (and nothing a later call for the same source registered).
 *
 * The entry names a record of an entity type the server declares (tool
 * `outputEntities` / `inputEntities`) by its id exactly as the app has it,
 * and/or a selection of such records; optionally a short `label`, `facts`
 * (kept by the server only against a facts schema in its handler config),
 * `unsaved` and the route path. Read when a new chat message is sent.
 */
export function registerViewContext(source: string, entry: ViewContextEntry | null): () => void {
  if (typeof source !== 'string' || source === '') throw new TypeError('registerViewContext needs a non-empty source name');
  const map = registry();
  if (entry === null || entry === undefined) {
    map.delete(source);
    return () => {};
  }
  const token = {};
  // `set` on a present key keeps its place: an update does not reorder.
  map.set(source, { token, entry });
  return () => {
    if (map.get(source)?.token === token) map.delete(source);
  };
}

/** Facts pass unchanged here: only the server knows the schemas; the contract still bounds and cleans them. */
const ANY_FACTS: ViewContextFactsSchema = { safeParse: (value) => ({ success: true, data: value }) };

/** A plain JSON copy of an entry, or undefined when it has none (getters that throw, cycles, BigInt). */
function plainCopy(entry: unknown): unknown {
  try {
    const text = JSON.stringify(entry);
    return text === undefined ? undefined : JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function typesOf(entries: ReadonlyArray<unknown>): Set<string> {
  const types = new Set<string>();
  for (const entry of entries) {
    const { entity, selection } = (entry ?? {}) as { entity?: { type?: unknown }; selection?: { type?: unknown } };
    if (typeof entity?.type === 'string') types.add(entity.type);
    if (typeof selection?.type === 'string') types.add(selection.type);
  }
  return types;
}

/**
 * The registered view context as it would be sent now: an own copy, cleaned
 * and bounded by the contract (at most 8 entries in registration order,
 * duplicates after the first dropped, 50 selection ids, labels of at most 60
 * code points, routes and ids that are not valid dropped). Empty when
 * nothing is registered; never throws.
 */
export function currentViewContext(): ViewContextEntry[] {
  try {
    const plain = [...registry().values()]
      .map((registration) => plainCopy(registration.entry))
      .filter((entry) => entry !== undefined);
    if (plain.length === 0) return [];
    const types = typesOf(plain);
    const factsSchemas = Object.fromEntries([...types].map((type) => [type, ANY_FACTS]));
    return sanitizeViewContext(plain, { declaredTypes: types, factsSchemas }).entries;
  } catch {
    return [];
  }
}

/** The body field the chat handler reads (`createAiChatHandler`). @internal */
export const VIEW_CONTEXT_REQUEST_FIELD = 'glirastesViewContext';

/**
 * The body fields of a new user message: `glirastesViewContext` with the
 * current snapshot, or undefined when nothing is registered (the request
 * body then stays exactly as without the feature). `byMessage` is reserved
 * and never sent. @internal
 */
export function viewContextRequestBody(): Record<string, unknown> | undefined {
  const current = currentViewContext();
  return current.length === 0 ? undefined : { [VIEW_CONTEXT_REQUEST_FIELD]: { version: 1, current } };
}
