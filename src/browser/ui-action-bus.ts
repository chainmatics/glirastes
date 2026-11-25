/**
 * Framework-neutral UI action dispatch. React (`glirastes/react`), the chat
 * embed and plain browser code (`glirastes/browser`) share this bus, so a
 * generated navigation, filter or client action reaches the handler the app
 * registered, whatever framework it uses.
 */
import { UiActionRejectedError } from './ui-action-signals.js';

export interface UiAction {
  type: string;
  actionId?: string;
  [key: string]: unknown;
}

/**
 * A bus handler. Returning (or resolving) `false` declines the action: the
 * dispatch rejects as for a handler that threw `UiActionRejectedError`, and
 * the chat reports `rejected-handler`. `true` and nothing count as carried out.
 */
export type UiActionHandler = (action: UiAction) => void | boolean | Promise<void | boolean>;

function addHandler(
  map: Map<string, Set<UiActionHandler>>,
  key: string,
  handler: UiActionHandler,
): () => void {
  const handlers = map.get(key) ?? new Set<UiActionHandler>();
  handlers.add(handler);
  map.set(key, handlers);

  return () => {
    const current = map.get(key);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) map.delete(key);
  };
}

export class UiActionBus {
  private handlersByType = new Map<string, Set<UiActionHandler>>();
  private handlersById = new Map<string, Set<UiActionHandler>>();
  private handlerWaiters = new Map<string, Set<() => void>>();

  subscribeByType(type: string, handler: UiActionHandler): () => void {
    return addHandler(this.handlersByType, type, handler);
  }

  subscribeById(actionId: string, handler: UiActionHandler): () => void {
    const unsubscribe = addHandler(this.handlersById, actionId, handler);
    const waiters = this.handlerWaiters.get(actionId);
    if (waiters) {
      this.handlerWaiters.delete(actionId);
      for (const resolve of waiters) resolve();
    }
    return unsubscribe;
  }

  /**
   * Resolves `true` as soon as a handler for `actionId` is subscribed, or
   * `false` after `timeoutMs`. Used to run a page-bound client action once
   * the chat navigated to its page and the page registered it.
   */
  waitForHandler(actionId: string, timeoutMs: number): Promise<boolean> {
    if (this.handlersById.has(actionId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.handlerWaiters.get(actionId) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.delete(done);
        if (waiters.size === 0 && this.handlerWaiters.get(actionId) === waiters) this.handlerWaiters.delete(actionId);
        resolve(false);
      }, timeoutMs);
      waiters.add(done);
      this.handlerWaiters.set(actionId, waiters);
    });
  }

  /**
   * Client actions that have a handler right now. The chat sends them with
   * each request, so a generated client-action tool can refuse an action the
   * open page does not take instead of reporting it as done.
   */
  registeredActionIds(): string[] {
    return Array.from(this.handlersById.keys());
  }

  /**
   * Runs every handler of the action's type and id one after another and
   * resolves the number that ran; `0` means nothing on the page handles it.
   * The first handler that throws, or returns `false`, stops the rest and
   * rejects the dispatch (`false`: with a `UiActionRejectedError`).
   */
  async dispatch(action: UiAction): Promise<number> {
    const typeHandlers = this.handlersByType.get(action.type);
    const idHandlers = action.actionId
      ? this.handlersById.get(action.actionId)
      : undefined;

    const allHandlers = new Set<UiActionHandler>([
      ...(typeHandlers ? Array.from(typeHandlers) : []),
      ...(idHandlers ? Array.from(idHandlers) : []),
    ]);

    for (const handler of allHandlers) {
      if (await handler(action) === false) {
        throw new UiActionRejectedError('handler', `UI action ${action.actionId ?? action.type} was not carried out`);
      }
    }
    return allHandlers.size;
  }
}

const DEFAULT_BUS = Symbol.for('glirastes.uiActionBus');

/**
 * The page-wide bus that the chat dispatches generated UI actions to. Kept on
 * `globalThis` so two bundled copies of the SDK still share one bus.
 */
function isUiActionBus(value: unknown): value is UiActionBus {
  const candidate = value as Partial<UiActionBus> | null | undefined;
  return typeof candidate?.dispatch === 'function'
    && typeof candidate.subscribeById === 'function'
    && typeof candidate.subscribeByType === 'function';
}

export function getDefaultUiActionBus(): UiActionBus {
  const scope = globalThis as Record<symbol, unknown>;
  const existing = scope[DEFAULT_BUS];
  // A bus of another bundled SDK copy is a different class: check the shape, not instanceof.
  if (isUiActionBus(existing)) return existing;
  const bus = new UiActionBus();
  scope[DEFAULT_BUS] = bus;
  return bus;
}
