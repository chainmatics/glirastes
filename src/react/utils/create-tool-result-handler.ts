/** Schema-like object that can validate values (compatible with Zod, Valibot, etc.) */
interface SafeParseable {
  safeParse(value: unknown): { success: true; data: Record<string, unknown> } | { success: false; error: { issues: unknown[] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractUiAction(result: Record<string, unknown>): unknown {
  if (result.uiAction !== undefined) return result.uiAction;
  if (isRecord(result.data) && result.data.uiAction !== undefined) {
    return result.data.uiAction;
  }
  return undefined;
}

function hasSuccessfulResult(result: Record<string, unknown>): boolean {
  if (result.success === true) return true;
  return isRecord(result.data) && result.data.success === true;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

// ============================================================================
// Types
// ============================================================================

export interface ToolResultHandlerConfig {
  /** Schema to validate uiActions (compatible with Zod `.safeParse()`). When omitted, uiActions are not validated. */
  uiActionSchema?: SafeParseable;

  /**
   * Custom action handlers by uiAction type.
   * Called with the full validated uiAction object.
   *
   * @example
   * ```ts
   * actionHandlers: {
   *   'set-filters': (action) => {
   *     window.dispatchEvent(new CustomEvent('ai-set-filters', { detail: action.filters }));
   *   },
   * }
   * ```
   */
  actionHandlers?: Record<string, (action: Record<string, unknown>) => void>;

  /**
   * Map of entity names to list page destinations.
   * Used by convention-based `{entity}-created` actions.
   *
   * @example `{ task: '/tasks', group: '/groups' }`
   */
  entityListDestinations?: Record<string, string>;

  /** Called when an entity-created or entity-deleted action requires navigation */
  onNavigate?: (destination: string, entity: string) => void;

  /** Called when an entity-updated action requires opening a detail view */
  onOpenDetail?: (entity: string, entityId: string) => void;

  /** Called for `run-client-action` uiAction types */
  onClientAction?: (actionId: string, payload?: Record<string, unknown>) => void;

  /** Called for any successful tool result */
  onSuccess?: (toolName: string, result: Record<string, unknown>) => void;

  /**
   * Fallback handlers for specific tool names.
   * Called when a tool succeeds but has no uiAction to process.
   */
  toolFallbacks?: Record<string, (result: Record<string, unknown>) => void>;

  /** Optional dedupe guard for duplicate `run-client-action` dispatches. */
  clientActionDedupe?: {
    enabled?: boolean;
    windowMs?: number;
    actionIds?: string[];
  };
}

/**
 * Create a tool result handler that processes tool outputs for UI-side actions.
 *
 * Extracts `uiAction` from tool results, validates against an optional schema,
 * and routes to the appropriate handler based on action type.
 *
 * Supports convention-based entity actions (`{entity}-created`, `{entity}-updated`,
 * `{entity}-deleted`), `run-client-action`, and custom action handlers.
 *
 * @example
 * ```ts
 * import { createToolResultHandler } from '../index.js';
 * import { dispatchAiClientAction } from '../ui/index.js';
 *
 * const handleToolResult = createToolResultHandler({
 *   uiActionSchema: mySchema,
 *   entityListDestinations: { task: '/tasks', group: '/groups' },
 *   onNavigate: (dest) => router.push(dest),
 *   onOpenDetail: (entity, id) => openPanel(entity, id),
 *   onClientAction: (actionId, payload) => dispatchAiClientAction({ actionId, payload }),
 *   onSuccess: () => window.dispatchEvent(new CustomEvent('data-refresh')),
 *   actionHandlers: {
 *     'set-filters': (action) => {
 *       window.dispatchEvent(new CustomEvent('ai-set-filters', { detail: action.filters }));
 *     },
 *   },
 * });
 *
 * // Wire into AiChatProvider or use in useEffect:
 * <AiChatProvider onToolResult={handleToolResult} ... />
 * ```
 */
export function createToolResultHandler(
  config: ToolResultHandlerConfig,
): (toolName: string, result: unknown) => void {
  const {
    uiActionSchema,
    actionHandlers = {},
    entityListDestinations = {},
    onNavigate,
    onOpenDetail,
    onClientAction,
    onSuccess,
    toolFallbacks = {},
    clientActionDedupe,
  } = config;

  const dedupeEnabled = clientActionDedupe?.enabled ?? false;
  const dedupeWindowMs = clientActionDedupe?.windowMs ?? 1500;
  const dedupeActionIds = clientActionDedupe?.actionIds ?? ['navigate'];
  const recentClientActions = new Map<string, number>();

  return (toolName: string, result: unknown) => {
    if (!isRecord(result)) return;

    let handledByAction = false;
    const uiActionCandidate = extractUiAction(result);

    if (uiActionCandidate !== undefined) {
      // Normalize to array for uniform processing (supports compound actions)
      const candidates = Array.isArray(uiActionCandidate)
        ? uiActionCandidate
        : [uiActionCandidate];

      for (const candidate of candidates) {
        // Validate if schema provided
        let uiAction: Record<string, unknown>;
        if (uiActionSchema) {
          const parsed = uiActionSchema.safeParse(candidate);
          if (!parsed.success) {
            console.warn('[AI Chat] Invalid uiAction dropped:', parsed.error.issues);
            continue;
          }
          uiAction = parsed.data;
        } else {
          if (!isRecord(candidate)) continue;
          uiAction = candidate;
        }

        const actionType = typeof uiAction.type === 'string' ? uiAction.type : '';

        // Convention-based entity actions: {entity}-{created|updated|deleted}
        const entityMatch = actionType.match(/^(\w+)-(created|updated|deleted)$/);
        if (entityMatch) {
          const [, entity, action] = entityMatch;
          const idKey = `${entity}Id`;
          const entityId = uiAction[idKey];

          if (action === 'created' && entityListDestinations[entity] && onNavigate) {
            onNavigate(entityListDestinations[entity], entity);
            handledByAction = true;
          }

          if (action === 'updated' && typeof entityId === 'string' && onOpenDetail) {
            onOpenDetail(entity, entityId);
            handledByAction = true;
          }

          if (action === 'deleted' && entityListDestinations[entity] && onNavigate) {
            onNavigate(entityListDestinations[entity], entity);
            handledByAction = true;
          }
        }

        // run-client-action
        if (actionType === 'run-client-action' && onClientAction) {
          const actionId = typeof uiAction.actionId === 'string' ? uiAction.actionId : '';
          const payload = isRecord(uiAction.payload) ? uiAction.payload : undefined;
          if (actionId) {
            if (dedupeEnabled && dedupeActionIds.includes(actionId)) {
              const key = `${actionId}:${safeStringify(payload)}`;
              const now = Date.now();
              const lastSeen = recentClientActions.get(key);
              if (lastSeen && now - lastSeen < dedupeWindowMs) {
                handledByAction = true;
                continue;
              }
              recentClientActions.set(key, now);
            }
            onClientAction(actionId, payload);
            handledByAction = true;
          }
        }

        // Built-in navigate: route through onClientAction so consumers
        // only need useAiClientAction('navigate', ...) — no raw CustomEvent.
        if (actionType === 'navigate' && onClientAction) {
          const path = typeof uiAction.path === 'string' ? uiAction.path : '';
          if (path) {
            if (dedupeEnabled && dedupeActionIds.includes('navigate')) {
              const key = `navigate:${path}`;
              const now = Date.now();
              const lastSeen = recentClientActions.get(key);
              if (lastSeen && now - lastSeen < dedupeWindowMs) {
                handledByAction = true;
                continue;
              }
              recentClientActions.set(key, now);
            }
            onClientAction('navigate', { path });
            handledByAction = true;
            continue; // skip actionHandlers fallback for navigate
          }
        }

        // Custom action handlers
        if (actionHandlers[actionType]) {
          actionHandlers[actionType](uiAction);
          handledByAction = true;
        }
      }
    }

    const successful = hasSuccessfulResult(result);

    // Tool-specific fallback when no action was processed
    if (!handledByAction && successful && toolFallbacks[toolName]) {
      toolFallbacks[toolName](result);
    }

    // Global success callback
    if (successful && onSuccess) {
      onSuccess(toolName, result);
    }
  };
}
