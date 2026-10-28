/**
 * Framework-neutral UI action dispatch. React (`glirastes/react`), the chat
 * embed and plain browser code (`glirastes/browser`) share this bus, so a
 * generated navigation, filter or client action reaches the handler the app
 * registered, whatever framework it uses.
 */
export interface UiAction {
  type: string;
  actionId?: string;
  [key: string]: unknown;
}

export type UiActionHandler = (action: UiAction) => void | Promise<void>;

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

  subscribeByType(type: string, handler: UiActionHandler): () => void {
    return addHandler(this.handlersByType, type, handler);
  }

  subscribeById(actionId: string, handler: UiActionHandler): () => void {
    return addHandler(this.handlersById, actionId, handler);
  }

  /**
   * Client actions that have a handler right now. The chat sends them with
   * each request, so a generated client-action tool can refuse an action the
   * open page does not take instead of reporting it as done.
   */
  registeredActionIds(): string[] {
    return Array.from(this.handlersById.keys());
  }

  async dispatch(action: UiAction): Promise<void> {
    const typeHandlers = this.handlersByType.get(action.type);
    const idHandlers = action.actionId
      ? this.handlersById.get(action.actionId)
      : undefined;

    const allHandlers = new Set<UiActionHandler>([
      ...(typeHandlers ? Array.from(typeHandlers) : []),
      ...(idHandlers ? Array.from(idHandlers) : []),
    ]);

    for (const handler of allHandlers) {
      await handler(action);
    }
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
