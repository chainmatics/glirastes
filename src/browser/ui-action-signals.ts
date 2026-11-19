/**
 * How a UI action handler tells the chat what became of an action, beyond
 * resolving (carried out) and throwing (failed). Errors are recognised by
 * their `code`, not `instanceof`: several bundled SDK copies may share one
 * page and one bus.
 */
import type { UiAction } from './ui-action-bus.js';

/**
 * Outcome codes of protocol version 1, the same union as `UiOutcomeCode` of
 * `glirastes/contracts` (kept here so `glirastes/browser` imports nothing
 * outside itself; a type test keeps both equal).
 */
export type UiOutcomeCode =
  | 'ok'
  | 'rejected-contract'
  | 'rejected-handler'
  | 'unavailable'
  | 'failed'
  | 'initiated';

export const UI_ACTION_REJECTED_ERROR_CODE = 'glirastes.ui-action-rejected' as const;

/** `contract`: the payload did not match the app's contract; `handler`: the handler declined it. */
export type UiActionRejectionReason = 'contract' | 'handler';

/** The app refused a UI action, so it did not happen. */
export class UiActionRejectedError extends Error {
  readonly code = UI_ACTION_REJECTED_ERROR_CODE;
  readonly reason: UiActionRejectionReason;

  constructor(reason: UiActionRejectionReason, message: string) {
    super(message);
    this.name = 'UiActionRejectedError';
    this.reason = reason;
  }
}

/** True for a `UiActionRejectedError` of any SDK copy. */
export function isUiActionRejectedError(
  error: unknown,
): error is { code: typeof UI_ACTION_REJECTED_ERROR_CODE; reason: UiActionRejectionReason; message?: string } {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; reason?: unknown };
  return candidate.code === UI_ACTION_REJECTED_ERROR_CODE
    && (candidate.reason === 'contract' || candidate.reason === 'handler');
}

const UNAVAILABLE_CODE = 'glirastes.ui-action-unavailable';

/** Nothing on the page took the action, e.g. a page-bound action never registered. @internal */
export class UiActionUnavailableError extends Error {
  readonly code = UNAVAILABLE_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'UiActionUnavailableError';
  }
}

/** @internal */
export function isUiActionUnavailableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === UNAVAILABLE_CODE;
}

const INITIATED_KEY = Symbol.for('glirastes.initiatedUiActions');

function initiatedActions(): WeakSet<object> {
  const scope = globalThis as Record<symbol, unknown>;
  const existing = scope[INITIATED_KEY];
  if (existing instanceof WeakSet) return existing as WeakSet<object>;
  const created = new WeakSet<object>();
  scope[INITIATED_KEY] = created;
  return created;
}

/** A handler started a full page load for this action. @internal */
export function markUiActionInitiated(action: UiAction): void {
  initiatedActions().add(action);
}

/** @internal */
export function wasUiActionInitiated(action: UiAction): boolean {
  return initiatedActions().has(action);
}

const BEFORE_LOAD_KEY = Symbol.for('glirastes.beforeUiActionPageLoad');

/**
 * Longest a bridge waits for the chat before it loads the next page: the end
 * of the running step (at most the 10 s outcome timeout) plus 500 ms to save.
 */
export const BEFORE_PAGE_LOAD_TIMEOUT_MS = 10_500;

type BeforePageLoad = (action: UiAction) => void | Promise<void>;

function beforePageLoadListeners(): Set<BeforePageLoad> {
  const scope = globalThis as Record<symbol, unknown>;
  const existing = scope[BEFORE_LOAD_KEY];
  if (existing instanceof Set) return existing as Set<BeforePageLoad>;
  const created = new Set<BeforePageLoad>();
  scope[BEFORE_LOAD_KEY] = created;
  return created;
}

/**
 * Called before a reloading bridge (`reloads`) loads the next page for an
 * action, so the chat can write and save the action's outcome while the
 * page still runs. Shared by every SDK copy on the page. @internal
 */
export function onBeforeUiActionPageLoad(listener: BeforePageLoad): () => void {
  const listeners = beforePageLoadListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const PAGE_LOAD_RESULT_KEY = Symbol.for('glirastes.uiActionPageLoadResult');

/** What became of a page load a reloading bridge prepared: started, refused (`push` returned `false`) or failed (threw). */
export type UiActionPageLoadResult = 'started' | 'refused' | 'failed';

type PageLoadResultListener = (action: UiAction, result: UiActionPageLoadResult) => void;

function pageLoadResultListeners(): Set<PageLoadResultListener> {
  const scope = globalThis as Record<symbol, unknown>;
  const existing = scope[PAGE_LOAD_RESULT_KEY];
  if (existing instanceof Set) return existing as Set<PageLoadResultListener>;
  const created = new Set<PageLoadResultListener>();
  scope[PAGE_LOAD_RESULT_KEY] = created;
  return created;
}

/** Called once a reloading bridge called `push` for a prepared page load. @internal */
export function onUiActionPageLoadResult(listener: PageLoadResultListener): () => void {
  const listeners = pageLoadResultListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** @internal */
export function uiActionPageLoadResult(action: UiAction, result: UiActionPageLoadResult): void {
  for (const listener of [...pageLoadResultListeners()]) {
    try {
      listener(action, result);
    } catch {
      // A listener's failure does not stop the navigation.
    }
  }
}

/** Runs the listeners, at most `BEFORE_PAGE_LOAD_TIMEOUT_MS`; a listener that throws is skipped. @internal */
export async function beforeUiActionPageLoad(action: UiAction): Promise<void> {
  const listeners = [...beforePageLoadListeners()];
  if (listeners.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, BEFORE_PAGE_LOAD_TIMEOUT_MS); });
  const all = Promise.all(listeners.map(async (listener) => {
    try {
      await listener(action);
    } catch {
      // Saving is best effort; the page load goes on.
    }
  }));
  try {
    await Promise.race([all, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
