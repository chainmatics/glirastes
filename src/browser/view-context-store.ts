/**
 * The page-wide state of the view context and the request body field, without
 * the contract: the chat transport imports only this module, so an app that
 * never registers a view context does not load the sanitizer (and zod) for
 * it. `registerViewContext` (`view-context.ts`) fills the registry and puts
 * its cleaning snapshot here.
 *
 * @module
 */
import type { ViewContextEntry } from '../contracts/view-context.js';

/** One registration of a source; the token tells a stale unregister apart. */
export interface ViewContextRegistration {
  readonly token: object;
  readonly entry: ViewContextEntry;
}

/** Shared by every copy of the SDK on the page (`globalThis`). */
export interface ViewContextState {
  /** By source, in the order the sources first registered. */
  readonly entries: Map<string, ViewContextRegistration>;
  /** The cleaned snapshot, set by `registerViewContext`; without it nothing is sent. */
  snapshot?: () => ViewContextEntry[];
}

const STATE = Symbol.for('glirastes.viewContext');

/** The state if a registration created it, without creating it. @internal */
export function peekViewContextState(): ViewContextState | undefined {
  const found = (globalThis as Record<symbol, unknown>)[STATE] as ViewContextState | undefined;
  return found && found.entries instanceof Map ? found : undefined;
}

/** @internal */
export function viewContextState(): ViewContextState {
  const found = peekViewContextState();
  if (found) return found;
  const state: ViewContextState = { entries: new Map() };
  (globalThis as Record<symbol, unknown>)[STATE] = state;
  return state;
}

/** The body field the chat handler reads (`createAiChatHandler`). @internal */
export const VIEW_CONTEXT_REQUEST_FIELD = 'glirastesViewContext';

/**
 * The view context to freeze with a message the user submits: an own cleaned
 * copy, or undefined when nothing is registered, nothing is left after
 * cleaning, or no cleaning snapshot is there (fail closed: nothing uncleaned
 * is sent). Read only: a page that never registers anything gets no global
 * state from it. @internal
 */
export function viewContextSnapshot(): ViewContextEntry[] | undefined {
  const state = peekViewContextState();
  if (!state || state.entries.size === 0 || typeof state.snapshot !== 'function') return undefined;
  let current: ViewContextEntry[];
  try {
    current = state.snapshot();
  } catch {
    return undefined;
  }
  return Array.isArray(current) && current.length > 0 ? current : undefined;
}

/**
 * The body fields of a new user message for the view context it carries:
 * `glirastesViewContext: { version: 1, current }`, or undefined without one
 * (the request body then stays exactly as without the feature). Never reads
 * the registry: a message carries what was frozen when the user submitted
 * it. `byMessage` is reserved and never sent. @internal
 */
export function viewContextRequestBody(current: ReadonlyArray<ViewContextEntry> | undefined): Record<string, unknown> | undefined {
  return Array.isArray(current) && current.length > 0
    ? { [VIEW_CONTEXT_REQUEST_FIELD]: { version: 1, current: [...current] } }
    : undefined;
}
