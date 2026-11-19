import {
  buildNavigationHref,
  GLIRASTES_NAVIGATE_ACTION_ID,
  type QueryValue,
} from '../../browser/navigation.js';
import { UI_ACTION_HANDOFF_MESSAGE, uiActionHandoffToRouteMessage } from '../../browser/ui-action-handoff.js';
import { defineTool, type SchemaLike, type Tool } from '../../types.js';

/** What a generated UI tool asks the browser to do. */
export type GeneratedUiAction =
  | { kind: 'navigate' }
  | {
    kind: 'filter';
    /** Route spelling of the filtered page, e.g. `/tasks` or `/projects/:id/tasks`. */
    destination: string;
    keys: ReadonlyArray<{ key: string; array?: 'comma' | 'repeat' }>;
  }
  | {
    kind: 'client-action';
    actionId: string;
    /** Static path of the page that registers the action; the browser opens it when the handler is missing. */
    route?: string;
  };

export interface GeneratedUiToolDefinition {
  id: string;
  toolName: string;
  description: string;
  inputSchema: SchemaLike;
  outputSchema?: SchemaLike;
  needsApproval: boolean;
  action: GeneratedUiAction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringParams(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/**
 * Runtime of the tools that `glirastes tools refresh` generates from pages,
 * URL filters and client actions. They never call a server: the result
 * carries a `glirastes.*` uiAction that the chat hands to the app's bridge.
 * The server does not learn whether the app carried it out, so the result
 * text tells the model it was handed over, not that it happened.
 */
export function uiActionToolToTool(definition: GeneratedUiToolDefinition): Tool {
  return { ...generatedUiTool(definition), uiTool: {} };
}

function generatedUiTool(definition: GeneratedUiToolDefinition): Tool {
  return defineTool({
    id: definition.id,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
    needsApproval: definition.needsApproval,
    execute: async (rawInput: unknown, context) => {
      const input = isRecord(rawInput) ? rawInput : {};
      const action = definition.action;
      if (action.kind === 'client-action') {
        const available = context?.runtime?.clientActions;
        const route = action.route;
        const uiAction = {
          type: 'glirastes.action',
          actionId: action.actionId,
          payload: { ...input },
          ...(route ? { route } : {}),
        };
        if (available && !available.includes(action.actionId)) {
          if (route) {
            return {
              success: true,
              message: uiActionHandoffToRouteMessage(route),
              uiAction,
            };
          }
          return {
            success: false,
            error: 'This action is not available on the page the user has open. Do not claim it happened; navigate to a page that offers it, or use another tool.',
            retryable: false,
          };
        }
        return { success: true, message: UI_ACTION_HANDOFF_MESSAGE, uiAction };
      }
      const params = stringParams(input.params);
      try {
        if (action.kind === 'navigate') {
          const destination = typeof input.destination === 'string' ? input.destination : '';
          const href = buildNavigationHref({ destination, ...(params ? { params } : {}) });
          return {
            success: true,
            message: UI_ACTION_HANDOFF_MESSAGE,
            uiAction: {
              type: 'glirastes.navigate',
              actionId: GLIRASTES_NAVIGATE_ACTION_ID,
              payload: { href, destination, ...(params ? { params } : {}) },
            },
          };
        }
        const query: Record<string, QueryValue> = {};
        const arrayFormats: Record<string, 'comma' | 'repeat'> = {};
        for (const { key, array } of action.keys) {
          if (input[key] !== undefined) query[key] = input[key] as QueryValue;
          if (array) arrayFormats[key] = array;
        }
        const href = buildNavigationHref({
          destination: action.destination,
          ...(params ? { params } : {}),
          query,
          arrayFormats,
        });
        return {
          success: true,
          message: UI_ACTION_HANDOFF_MESSAGE,
          uiAction: {
            type: 'glirastes.navigate',
            actionId: GLIRASTES_NAVIGATE_ACTION_ID,
            payload: { href, destination: action.destination, ...(params ? { params } : {}), query },
          },
        };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Navigation failed' };
      }
    },
  });
}
