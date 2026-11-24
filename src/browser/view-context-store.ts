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

/** @internal */
export function viewContextState(): ViewContextState {
  const scope = globalThis as Record<symbol, unknown>;
  const found = scope[STATE] as ViewContextState | undefined;
  if (found && found.entries instanceof Map) return found;
  const state: ViewContextState = { entries: new Map() };
  scope[STATE] = state;
  return state;
}

/** The body field the chat handler reads (`createAiChatHandler`). @internal */
export const VIEW_CONTEXT_REQUEST_FIELD = 'glirastesViewContext';

/**
 * The body fields of a new user message: `glirastesViewContext` with the
 * cleaned snapshot, or undefined when nothing is registered (the request
 * body then stays exactly as without the feature) or no cleaning snapshot
 * is there (fail closed: nothing uncleaned is sent). `byMessage` is reserved
 * and never sent. @internal
 */
export function viewContextRequestBody(): Record<string, unknown> | undefined {
  const state = viewContextState();
  if (state.entries.size === 0 || typeof state.snapshot !== 'function') return undefined;
  let current: ViewContextEntry[];
  try {
    current = state.snapshot();
  } catch {
    return undefined;
  }
  return Array.isArray(current) && current.length > 0
    ? { [VIEW_CONTEXT_REQUEST_FIELD]: { version: 1, current } }
    : undefined;
}
