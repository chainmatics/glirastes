import { getDefaultUiActionBus, type UiAction, type UiActionBus } from './ui-action-bus.js';

/** Any schema with `safeParse`, e.g. a Zod object; it types and validates the payload. */
export interface PayloadContract<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error?: unknown };
}

export interface ClientActionOptions {
  bus?: UiActionBus;
}

/**
 * Registers a client action the chat may run (`ui.<actionId>`). The literal
 * id and the contract are read by `glirastes tools refresh`; at runtime the
 * contract validates the payload before the handler runs.
 */
export function registerAiClientAction<T = Record<string, unknown>>(
  actionId: string,
  handler: (payload: T) => void | Promise<void>,
  contract?: PayloadContract<T>,
  options: ClientActionOptions = {},
): () => void {
  const bus = options.bus ?? getDefaultUiActionBus();
  return bus.subscribeById(actionId, async (action) => {
    const payload = action.payload ?? {};
    if (!contract) {
      await handler(payload as T);
      return;
    }
    const parsed = contract.safeParse(payload);
    if (!parsed.success) throw new Error(`Invalid payload for UI action ${actionId}`);
    await handler(parsed.data);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Hands the UI actions of a successful tool result to the bus. Only actions
 * of generated Glirastes tools (`glirastes.*`) are dispatched; app-specific
 * uiActions stay with the app's own result handler. Returns the count.
 */
export async function dispatchToolResultUiActions(
  result: unknown,
  bus: UiActionBus = getDefaultUiActionBus(),
): Promise<number> {
  if (!isRecord(result) || result.success !== true) return 0;
  const actions = Array.isArray(result.uiAction) ? result.uiAction : [result.uiAction];
  let dispatched = 0;
  for (const action of actions) {
    if (!isRecord(action) || typeof action.type !== 'string' || !action.type.startsWith('glirastes.')) continue;
    await bus.dispatch(action as UiAction);
    dispatched += 1;
  }
  return dispatched;
}
