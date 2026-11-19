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
