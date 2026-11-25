/**
 * Browser side of the view context: what the user currently looks at, as
 * the app declares it. Nothing is read from the page or the URL; only what a
 * page registers is sent, with the next new chat message, to the app's own
 * chat endpoint (never to the Platform, telemetry, logs or storage).
 *
 * One registry per page (on `globalThis`, so several copies of the SDK
 * share it): one entry per source, in the order the sources first
 * registered. The registry holds a reference to each entry; it is read and
 * copied when a message is sent. The snapshot is cleaned and bounded with the
 * contract (`sanitizeViewContext`, `VIEW_CONTEXT_LIMITS`); the server checks
 * it again against the entity types and facts schemas it knows and stays the
 * authority.
 *
 * @module
 */
import {
  sanitizeViewContext,
  type ViewContextEntry,
  type ViewContextFactsSchema,
  type ViewContextSanitizeResult,
} from '../contracts/view-context.js';
import { viewContextState } from './view-context-store.js';

/**
 * Registers what the user looks at for `source` (a name the caller owns,
 * such as `'order-page'`; development builds show it in console warnings,
 * so it holds no record id or personal data), replacing that source's earlier entry in place;
 * `null` unregisters it (registered again, it comes last). Returns a function
 * that unregisters this registration (and nothing a later call for the same
 * source registered).
 *
 * The entry names a record of an entity type the server declares (tool
 * `outputEntities` / `inputEntities`) by its id exactly as the app has it,
 * and/or a selection of such records; optionally a short `label`, `facts`
 * (kept by the server only against a facts schema in its handler config),
 * `unsaved` and the route path. The registry keeps a reference: it is read
 * when a new chat message is sent.
 */
export function registerViewContext(source: string, entry: ViewContextEntry | null): () => void {
  if (typeof source !== 'string' || source === '') throw new TypeError('registerViewContext needs a non-empty source name');
  const state = viewContextState();
  state.snapshot = currentViewContext;
  state.sanitize = sanitizeForSend;
  const map = state.entries;
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

function sanitize(plain: ReadonlyArray<unknown>): ViewContextSanitizeResult {
  const types = typesOf(plain);
  const factsSchemas = Object.fromEntries([...types].map((type) => [type, ANY_FACTS]));
  return sanitizeViewContext(plain, { declaredTypes: types, factsSchemas });
}

function isDevelopment(): boolean {
  try {
    return process.env.NODE_ENV === 'development';
  } catch {
    return false;
  }
}

/** Source and reason pairs already named; bounded, so remounting sources do not grow it without end. */
const warned = new Set<string>();
const MAX_WARNED = 200;
const WARNED_FIELD_REASONS = new Set(['facts-too-large', 'facts-invalid']);

/** Development only, once per source and reason; names the source and reason codes, never a value. */
function warnDropped(sources: ReadonlyArray<string>, copies: ReadonlyArray<unknown>, kept: ViewContextSanitizeResult): void {
  const keptLines = new Set(kept.entries.map((entry) => JSON.stringify(entry)));
  const warn = (source: string, reasons: ReadonlyArray<string>) => {
    const fresh = reasons.filter((reason) => !warned.has(`${source}\u0000${reason}`));
    if (fresh.length === 0) return;
    if (warned.size + fresh.length > MAX_WARNED) warned.clear();
    for (const reason of fresh) warned.add(`${source}\u0000${reason}`);
    console.warn(`[glirastes] View context of "${source}" not sent as registered: ${fresh.join(', ')}`);
  };
  sources.forEach((source, index) => {
    const copy = copies[index];
    if (copy === undefined) { warn(source, ['not-serializable']); return; }
    const alone = sanitize([copy]);
    const reasons = Object.keys(alone.dropped);
    if (alone.entries.length === 0) { warn(source, reasons); return; }
    const fieldReasons = reasons.filter((reason) => WARNED_FIELD_REASONS.has(reason));
    if (fieldReasons.length > 0) warn(source, fieldReasons);
    // Valid alone but not kept together: past the 8th entry, the size bound or a duplicate.
    if (!keptLines.has(JSON.stringify(alone.entries[0]))) {
      const together = ['over-limit', 'over-size', 'duplicate'].filter((reason) => reason in kept.dropped);
      warn(source, together.length > 0 ? together : ['dropped']);
    }
  });
}

/** Cleans what the transport sends, whatever it got: a plain JSON copy, bounded by the contract; never warns. */
function sanitizeForSend(value: unknown): ViewContextEntry[] {
  const copy = plainCopy(value);
  return Array.isArray(copy) ? sanitize(copy).entries : [];
}

/**
 * The registered view context as it would be sent now: an own copy, cleaned
 * and bounded by the contract (at most 8 entries in registration order,
 * duplicates after the first dropped, 50 selection ids, labels of at most 60
 * code points, routes and ids that are not valid dropped). Empty when
 * nothing is registered; never throws. In development a dropped entry is
 * named once per source and reason in the console.
 */
export function currentViewContext(): ViewContextEntry[] {
  try {
    const registrations = [...viewContextState().entries];
    if (registrations.length === 0) return [];
    const copies = registrations.map(([, registration]) => plainCopy(registration.entry));
    const result = sanitize(copies.filter((entry) => entry !== undefined));
    if (isDevelopment()) {
      try {
        warnDropped(registrations.map(([source]) => source), copies, result);
      } catch {
        // A warning never stops a message.
      }
    }
    return result.entries;
  } catch {
    return [];
  }
}
