import { GLIRASTES_NAVIGATE_ACTION_ID, isSafeAppHref } from './navigation.js';
import { getDefaultUiActionBus, type UiAction, type UiActionBus } from './ui-action-bus.js';

export type UiActionFailureStatus = 'rejected' | 'missing-handler' | 'exception' | 'timeout' | 'cancelled';
export class UiActionDispatchError extends Error {
  constructor(public readonly status: UiActionFailureStatus, message: string) {
    super(message);
    this.name = 'UiActionDispatchError';
  }
}

/** Any schema with `safeParse`, e.g. a Zod object; it types and validates the payload. */
export interface PayloadContract<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error?: unknown };
}

/** A client action handler; returning `false` reports that the action was not carried out. */
export type ClientActionHandler<T> = (payload: T) => void | boolean | Promise<void | boolean>;

export interface ClientActionOptions {
  bus?: UiActionBus;
  /**
   * The static app path of the page that registers this action, e.g.
   * `/templates`. `glirastes tools refresh` reads the literal; when the user
   * is elsewhere the chat opens this page first and runs the action there.
   */
  route?: string;
}

/** Default wait for a page-bound client action to register after navigating to its route. */
export const CLIENT_ACTION_ROUTE_TIMEOUT_MS = 5_000;

/**
 * Registers a client action the chat may run (`ui.<actionId>`). The literal
 * id, the contract and `options.route` are read by `glirastes tools refresh`;
 * at runtime the contract validates the payload before the handler runs. A
 * handler that returns `false` makes the dispatch fail, so the chat does not
 * report an action that did not happen.
 */
export function registerAiClientAction<T = Record<string, unknown>>(
  actionId: string,
  handler: ClientActionHandler<T>,
  contract?: PayloadContract<T>,
  options: ClientActionOptions = {},
): () => void {
  const bus = options.bus ?? getDefaultUiActionBus();
  return bus.subscribeById(actionId, async (action) => {
    const payload = action.payload ?? {};
    let data = payload as T;
    if (contract) {
      const parsed = contract.safeParse(payload);
      if (!parsed.success) throw new UiActionDispatchError('rejected', `Invalid payload for UI action ${actionId}`);
      data = parsed.data;
    }
    if (await handler(data) === false) throw new UiActionDispatchError('rejected', `UI action ${actionId} was not executed`);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface DispatchToolResultOptions {
  /** How long a page-bound client action may take to register after navigating; default 5000 ms. */
  routeTimeoutMs?: number;
  /** Bounds waiting only: an already running app handler cannot be undone or retried safely. */
  executionTimeoutMs?: number;
  /** Cancel pending navigation/dispatch when the originating chat is left. */
  signal?: AbortSignal;
}

const POLL_INTERVAL_MS = 50;

/** `undefined` when the bus (another SDK copy) cannot tell. */
function hasHandler(bus: UiActionBus, actionId: string): boolean | undefined {
  const registered = (bus as Partial<UiActionBus>).registeredActionIds;
  return typeof registered === 'function' ? registered.call(bus).includes(actionId) : undefined;
}

async function waitForHandler(bus: UiActionBus, actionId: string, timeoutMs: number): Promise<boolean> {
  const wait = (bus as Partial<UiActionBus>).waitForHandler;
  if (typeof wait === 'function') return wait.call(bus, actionId, timeoutMs);
  // A bus of an older SDK copy has no waitForHandler: poll its registered ids.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (hasHandler(bus, actionId)) return true;
  }
  return false;
}

/** A page-bound client action whose page is not open: navigate there, wait for its handler, then run it. */
async function dispatchRoutedAction(
  bus: UiActionBus,
  action: UiAction & { actionId: string; route: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (hasHandler(bus, action.actionId) === true) {
    await bus.dispatch(action);
    return;
  }
  if (!isSafeAppHref(action.route)) throw new UiActionDispatchError('rejected', `UI action ${action.actionId} has an unsafe route`);
  if (hasHandler(bus, GLIRASTES_NAVIGATE_ACTION_ID) !== true) throw new UiActionDispatchError('missing-handler', 'Navigation bridge is not registered');
  await bus.dispatch({
    type: 'glirastes.navigate',
    actionId: GLIRASTES_NAVIGATE_ACTION_ID,
    payload: { href: action.route },
  });
  if (!await waitForHandler(bus, action.actionId, timeoutMs)) {
    throw new UiActionDispatchError('timeout', `UI action ${action.actionId} was not registered on ${action.route} within ${timeoutMs} ms`);
  }
  if (signal?.aborted) throw new UiActionDispatchError('cancelled', 'Originating chat is no longer active');
  await bus.dispatch(action);
}

/**
 * Hands the UI actions of a successful tool result to the bus. Only actions
 * of generated Glirastes tools (`glirastes.*`) are dispatched; app-specific
 * uiActions stay with the app's own result handler. A client action with a
 * `route` whose handler is not registered opens that route first and runs
 * once the page registered it. Returns the count.
 */
export async function dispatchToolResultUiActions(
  result: unknown,
  bus: UiActionBus = getDefaultUiActionBus(),
  options: DispatchToolResultOptions = {},
): Promise<number> {
  if (!isRecord(result) || result.success !== true) return 0;
  const actions = Array.isArray(result.uiAction) ? result.uiAction : [result.uiAction];
  let dispatched = 0;
  const signal = options.signal;
  for (const action of actions) {
    if (!isRecord(action) || typeof action.type !== 'string' || !action.type.startsWith('glirastes.')) continue;
    if (signal?.aborted) throw new UiActionDispatchError('cancelled', 'Originating chat is no longer active');
    const execution = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        (async () => {
          if (action.type === 'glirastes.action' && typeof action.actionId === 'string' && typeof action.route === 'string') {
            await dispatchRoutedAction(bus, action as UiAction & { actionId: string; route: string }, options.routeTimeoutMs ?? CLIENT_ACTION_ROUTE_TIMEOUT_MS, execution.signal);
          } else {
            if (typeof bus.hasHandler === 'function' ? !bus.hasHandler(action as UiAction) : (typeof action.actionId !== 'string' || hasHandler(bus, action.actionId) !== true)) {
              throw new UiActionDispatchError('missing-handler', 'No handler is registered for this action');
            }
            await bus.dispatch(action as UiAction);
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { execution.abort(); reject(new UiActionDispatchError('timeout', 'Browser execution could not be confirmed in time')); }, options.executionTimeoutMs ?? 10_000);
          abort = () => { execution.abort(); reject(new UiActionDispatchError('cancelled', 'Originating chat is no longer active')); };
          signal?.addEventListener('abort', abort, { once: true });
          // Navigation can synchronously leave the origin before this listener is installed.
          if (signal?.aborted) abort();
        }),
      ]);
      dispatched += 1;
    } catch (error) {
      if (error instanceof UiActionDispatchError) throw error;
      throw new UiActionDispatchError('exception', 'Browser action handler threw an exception');
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  return dispatched;
}
