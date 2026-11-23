/**
 * The browser side of glirastes 0.17.3, VERBATIM, for the model-free check
 * that a 0.17 browser runs the UI actions of a 0.18 server.
 *
 * - `dispatchToolResultUiActions` and its helpers: `src/browser/client-actions.ts`
 *   of tag `v0.17.3`, lines 55-133 (`git show v0.17.3:src/browser/client-actions.ts`).
 *   The 0.17.3 provider (`src/react/provider/ai-chat-provider.tsx`, line 862)
 *   calls it for every `output-available` tool part whose output is a record.
 * - `hasSuccessfulResult`: `src/react/utils/create-tool-result-handler.ts` of
 *   tag `v0.17.3`, lines 20-23 (renamed `hasSuccessfulResultV0173`, its
 *   `isRecord` of lines 8-10 renamed `isHandlerRecord`); it gates
 *   `onSuccess` and the tool fallbacks of `createToolResultHandler`, the path
 *   of hand-written UI tools in an app.
 *
 * Only the imports, the export keywords and those names are changed;
 * `ui-result-shape-v0173.test.ts` compares the copied lines with the tag
 * when the tag is available. Do not edit the copied code.
 */
import { GLIRASTES_NAVIGATE_ACTION_ID, isSafeAppHref } from '../../../../../browser/navigation.js';
import type { UiAction, UiActionBus } from '../../../../../browser/ui-action-bus.js';

const CLIENT_ACTION_ROUTE_TIMEOUT_MS = 5_000;
function getDefaultUiActionBus(): UiActionBus {
  throw new Error('client-v0173: pass a bus');
}

// ---- v0.17.3 src/browser/client-actions.ts, lines 55-133 (verbatim) ----
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
  if (!isSafeAppHref(action.route)) throw new Error(`UI action ${action.actionId} has an unsafe route`);
  await bus.dispatch({
    type: 'glirastes.navigate',
    actionId: GLIRASTES_NAVIGATE_ACTION_ID,
    payload: { href: action.route },
  });
  if (!await waitForHandler(bus, action.actionId, timeoutMs)) {
    throw new Error(`UI action ${action.actionId} was not registered on ${action.route} within ${timeoutMs} ms`);
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

// That file's own `isRecord` (its lines 8-10), which lets arrays through.
function isHandlerRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---- v0.17.3 src/react/utils/create-tool-result-handler.ts, lines 20-23 (verbatim but the names) ----
export function hasSuccessfulResultV0173(result: Record<string, unknown>): boolean {
  if (result.success === true) return true;
  return isHandlerRecord(result.data) && result.data.success === true;
}
