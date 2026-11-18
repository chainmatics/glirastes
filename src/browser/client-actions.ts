import { GLIRASTES_NAVIGATE_ACTION_ID, isSafeAppHref } from './navigation.js';
import { getDefaultUiActionBus, type UiAction, type UiActionBus } from './ui-action-bus.js';
import {
  isUiActionRejectedError,
  isUiActionUnavailableError,
  UiActionRejectedError,
  UiActionUnavailableError,
  wasUiActionInitiated,
  type UiOutcomeCode,
} from './ui-action-signals.js';

/** Any schema with `safeParse`, e.g. a Zod object; it types and validates the payload. */
export interface PayloadContract<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error?: unknown };
}

/** A client action handler; returning `false` reports that the action was not carried out. */
export type ClientActionHandler<T> = (payload: T) => void | boolean | Promise<void | boolean>;

/**
 * What a client action does, in the words of an endpoint contract's
 * `effect`: `read` (shows or selects), `write` (changes data), `destructive`,
 * `external` or `financial`. Declared, it replaces the generator's guess.
 */
export type ClientActionEffect = 'read' | 'write' | 'destructive' | 'external' | 'financial';

export interface ClientActionOptions {
  bus?: UiActionBus;
  /**
   * The static app path of the page that registers this action, e.g.
   * `/templates`. `glirastes tools refresh` reads the literal; when the user
   * is elsewhere the chat opens this page first and runs the action there.
   */
  route?: string;
  /**
   * What the handler does, read as a literal by `glirastes tools refresh`
   * and ignored at runtime. It replaces the guess behind
   * `ui-action-write-unproven` and can only raise the tool's risk: `write`
   * makes the chat ask before it runs the action (like a handler that
   * provably writes), `destructive`, `external` and `financial` always ask;
   * `read` never lowers a handler that provably writes.
   */
  effect?: ClientActionEffect;
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
      if (!parsed.success) throw new UiActionRejectedError('contract', `Invalid payload for UI action ${actionId}`);
      data = parsed.data;
    }
    if (await handler(data) === false) {
      throw new UiActionRejectedError('handler', `UI action ${actionId} was not executed`);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface DispatchToolResultOptions {
  /** How long a page-bound client action may take to register after navigating; default 5000 ms. */
  routeTimeoutMs?: number;
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
): Promise<void> {
  if (hasHandler(bus, action.actionId) !== false) {
    await bus.dispatch(action);
    return;
  }
  if (!isSafeAppHref(action.route)) {
    throw new UiActionRejectedError('contract', `UI action ${action.actionId} has an unsafe route`);
  }
  await bus.dispatch({
    type: 'glirastes.navigate',
    actionId: GLIRASTES_NAVIGATE_ACTION_ID,
    payload: { href: action.route },
  });
  if (!await waitForHandler(bus, action.actionId, timeoutMs)) {
    throw new UiActionUnavailableError(
      `UI action ${action.actionId} was not registered on ${action.route} within ${timeoutMs} ms`,
    );
  }
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
  for (const action of actions) {
    if (!isRecord(action) || typeof action.type !== 'string' || !action.type.startsWith('glirastes.')) continue;
    if (action.type === 'glirastes.action' && typeof action.actionId === 'string' && typeof action.route === 'string') {
      await dispatchRoutedAction(
        bus,
        action as UiAction & { actionId: string; route: string },
        options.routeTimeoutMs ?? CLIENT_ACTION_ROUTE_TIMEOUT_MS,
      );
    } else {
      await bus.dispatch(action as UiAction);
    }
    dispatched += 1;
  }
  return dispatched;
}

/** Default time a dispatched UI action may take before the chat stops waiting for it. */
export const UI_ACTION_OUTCOME_TIMEOUT_MS = 10_000;

/**
 * What became of the UI actions of one tool result: an outcome code, or
 * `timeout` (a handler did not settle in time) or `unconfirmed` (a bus of
 * an older SDK copy that cannot tell whether a handler ran).
 */
export type UiActionRunCode = UiOutcomeCode | 'timeout' | 'unconfirmed';

export interface UiActionRunResult {
  code: UiActionRunCode;
  /** Actions that were handed to a handler without failing. */
  dispatched: number;
  durationMs: number;
  /** The error a refusing or failing handler threw. */
  error?: unknown;
}

export interface RunToolResultUiActionsOptions extends DispatchToolResultOptions {
  /**
   * How long the handlers may take, default 10 000 ms. A page-bound client
   * action gets `routeTimeoutMs` on top for its page to register it.
   */
  timeoutMs?: number;
  /**
   * Stops the run before its next action (and before a page-bound action
   * that waited for its page); the outcome is then `unconfirmed`.
   */
  signal?: AbortSignal;
}

/** The Glirastes UI actions (`glirastes.*`) of a successful tool result, in order. */
export function toolResultUiActions(result: unknown): UiAction[] {
  if (!isRecord(result) || result.success !== true) return [];
  const actions = Array.isArray(result.uiAction) ? result.uiAction : [result.uiAction];
  return actions.filter((action): action is UiAction => (
    isRecord(action) && typeof action.type === 'string' && action.type.startsWith('glirastes.')
  ));
}

function isRoutedAction(action: UiAction): action is UiAction & { actionId: string; route: string } {
  return action.type === 'glirastes.action' && typeof action.actionId === 'string' && typeof action.route === 'string';
}

type StepCode = 'ok' | 'unconfirmed' | 'unavailable' | 'initiated';

/** Outcome of a dispatch that did not throw: a bus of an older SDK copy resolves `undefined`. */
function dispatchCode(count: unknown, action: UiAction): StepCode {
  // A reloading bridge marks the action on any bus, also one that does not count handlers.
  if (wasUiActionInitiated(action)) return 'initiated';
  if (typeof count !== 'number') return 'unconfirmed';
  return count === 0 ? 'unavailable' : 'ok';
}

async function runAction(
  bus: UiActionBus,
  action: UiAction,
  routeTimeoutMs: number,
  cancelled: () => boolean,
): Promise<StepCode | 'cancelled'> {
  if (isRoutedAction(action) && hasHandler(bus, action.actionId) === false) {
    if (!isSafeAppHref(action.route)) {
      throw new UiActionRejectedError('contract', `UI action ${action.actionId} has an unsafe route`);
    }
    const navigation: UiAction = {
      type: 'glirastes.navigate',
      actionId: GLIRASTES_NAVIGATE_ACTION_ID,
      payload: { href: action.route },
    };
    const navigated = dispatchCode(await bus.dispatch(navigation), navigation);
    if (navigated === 'unavailable') return 'unavailable';
    // A full page load ends this page before the action could run here.
    if (navigated === 'initiated') return 'initiated';
    if (!await waitForHandler(bus, action.actionId, routeTimeoutMs)) return 'unavailable';
    if (cancelled()) return 'cancelled';
  }
  return dispatchCode(await bus.dispatch(action), action);
}

function failureCode(error: unknown): UiActionRunCode {
  if (isUiActionRejectedError(error)) return error.reason === 'contract' ? 'rejected-contract' : 'rejected-handler';
  if (isUiActionUnavailableError(error)) return 'unavailable';
  return 'failed';
}

/**
 * Runs the Glirastes UI actions of a tool result like
 * `dispatchToolResultUiActions`, one after another, and classifies what
 * happened instead of throwing: `ok` every handler resolved;
 * `rejected-contract` / `rejected-handler` a contract check failed or a
 * handler returned `false`; `failed` a handler threw; `unavailable` nothing
 * on the page handles an action (no navigation bridge, a page-bound action
 * that never registered); `initiated` a reloading navigation started;
 * `timeout` a handler did not settle within `timeoutMs`. The first action
 * that does not succeed stops the rest. Resolves `null` when the result has
 * no Glirastes UI action.
 */
export async function runToolResultUiActions(
  result: unknown,
  bus: UiActionBus = getDefaultUiActionBus(),
  options: RunToolResultUiActionsOptions = {},
): Promise<UiActionRunResult | null> {
  const actions = toolResultUiActions(result);
  if (actions.length === 0) return null;
  const started = Date.now();
  const routeTimeoutMs = options.routeTimeoutMs ?? CLIENT_ACTION_ROUTE_TIMEOUT_MS;
  const budgetMs = (options.timeoutMs ?? UI_ACTION_OUTCOME_TIMEOUT_MS)
    + (actions.some(isRoutedAction) ? routeTimeoutMs : 0);
  let timedOut = false;
  let dispatched = 0;

  const run = async (): Promise<Pick<UiActionRunResult, 'code' | 'error'>> => {
    let unconfirmed = false;
    const stopped = () => timedOut || options.signal?.aborted === true;
    for (const action of actions) {
      if (timedOut) break;
      if (stopped()) return { code: 'unconfirmed' };
      let step: StepCode | 'cancelled';
      try {
        step = await runAction(bus, action, routeTimeoutMs, stopped);
      } catch (error) {
        return { code: failureCode(error), error };
      }
      if (step === 'cancelled') {
        if (timedOut) break;
        return { code: 'unconfirmed' };
      }
      if (step === 'unavailable') return { code: 'unavailable' };
      dispatched += 1;
      if (step === 'initiated') return { code: 'initiated' };
      if (step === 'unconfirmed') unconfirmed = true;
    }
    return { code: unconfirmed ? 'unconfirmed' : 'ok' };
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Pick<UiActionRunResult, 'code'>>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ code: 'timeout' });
    }, budgetMs);
  });
  try {
    const outcome = await Promise.race([run(), timeout]);
    return { ...outcome, dispatched, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
