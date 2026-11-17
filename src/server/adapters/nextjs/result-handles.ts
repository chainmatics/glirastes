/**
 * Result handles of one chat turn: the turn's `ResultStore`, the
 * `read_result` tool bound to it, and the guard that makes every read count
 * as a call of the origin tool in a managed turn.
 */
import type { Principal } from '../../../contracts/index.js';
import type { ManagedTurnGuard } from '../../../runtime/index.js';
import { isRecoverableToolDenial, ToolExecutionDeniedError } from '../../../runtime/tool-denial.js';
import {
  createReadResultTool,
  createResultStore,
  type ReadResultGuard,
  type ResultHandle,
  type ResultHandleLimits,
  type ResultStore,
} from '../../core/index.js';
import { assertResultHandleLimits } from '../../core/result-store.js';
import type { Tool } from '../../../types.js';
import { READ_RESULT_TOOL_NAME } from '../../../contracts/result-handle.js';

const LIMIT_KEYS: ReadonlySet<string> = new Set(['maxResults', 'maxResultBytes', 'maxTotalBytes']);

/**
 * The limits of `AiChatHandlerConfig.resultHandles`, or null when the
 * feature is off. Throws for an invalid value.
 */
export function resolveResultHandles(value: unknown, label: string): ResultHandleLimits | null {
  if (value === undefined || value === true) return {};
  if (value === false) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: resultHandles must be a boolean or an object with maxResults, maxResultBytes, maxTotalBytes`);
  }
  for (const key of Object.keys(value)) {
    if (!LIMIT_KEYS.has(key)) throw new Error(`${label}: resultHandles.${key} is not an option`);
  }
  assertResultHandleLimits(value as ResultHandleLimits, label);
  return { ...(value as ResultHandleLimits) };
}

export interface TurnResults {
  store: ResultStore;
  tool: Tool;
}

/**
 * Creates the store and `read_result` of one turn. In a managed turn every
 * read runs the guard of the origin tool (budget, freshly resolved principal,
 * pinned snapshot, revocations) and is recorded with it, so reads count
 * toward `maxToolCalls` and repeated identical reads toward
 * `maxRepeatedFingerprint`; a handle also answers only the principal (subject
 * and tenant) it was created for. Without a managed turn there is no
 * principal: the handle is bound to the request alone.
 */
export function createTurnResults(options: {
  limits: ResultHandleLimits;
  seal?: (value: unknown) => Promise<unknown>;
  managedTurn?: ManagedTurnGuard;
  resolvePrincipal?: () => Promise<Principal | undefined>;
}): TurnResults {
  const { managedTurn, resolvePrincipal } = options;
  const owner = managedTurn && resolvePrincipal
    ? async () => {
        const principal = await resolvePrincipal();
        return principal ? { subjectId: principal.subjectId, tenantId: principal.tenantId } : undefined;
      }
    : undefined;
  const store = createResultStore({
    ...options.limits,
    ...(options.seal ? { seal: options.seal } : {}),
    ...(owner ? { owner } : {}),
  });
  /** Whether the freshly resolved principal is the one the handle was created for. */
  const ownerMatches = async (handle: ResultHandle): Promise<boolean> => {
    const principal = await resolvePrincipal!();
    return Boolean(principal && handle.owner
      && principal.subjectId === handle.owner.subjectId
      && principal.tenantId === handle.owner.tenantId);
  };
  /**
   * A read that reads nothing counts like a denied domain tool call: a call
   * and an error on the turn's budget, so `maxToolCalls` and
   * `maxConsecutiveErrors` bound a model that keeps asking. At the budget it
   * is answered with budget_exhausted and not counted again.
   */
  const countFailedRead = async (): Promise<'budget_exhausted' | void> => {
    if (!managedTurn) return undefined;
    if (managedTurn.tracker.evaluate().state === 'hard-limit') return 'budget_exhausted';
    managedTurn.tracker.recordToolCall();
    await managedTurn.onToolError({ toolName: READ_RESULT_TOOL_NAME, input: undefined, error: new Error('result_unreadable'), durationMs: 0 });
    return undefined;
  };
  const guard: ReadResultGuard = managedTurn && resolvePrincipal
    ? {
        failedRead: countFailedRead,
        // Like a domain tool's approval check: the conditions that end the
        // turn throw here. A handle of another principal is answered with
        // result_denied by execute instead.
        precheck: async ({ handle, input }) => {
          if (!await ownerMatches(handle)) return;
          try {
            await managedTurn.resolveApproval({ toolName: handle.toolName, input });
          } catch (error) {
            if (!isRecoverableToolDenial(error)) throw error;
          }
        },
        beforeRead: async ({ handle, input }) => {
          if (!await ownerMatches(handle)) return await countFailedRead() ?? 'denied';
          try {
            await managedTurn.beforeToolCall({ toolName: handle.toolName, input });
          } catch (error) {
            // Counted by the guard as a call and an error, like a denied domain tool.
            if (isRecoverableToolDenial(error)) return 'denied';
            // The model gets it as the answer (as a domain tool gets it as its error); the next step offers no tools.
            if (error instanceof ToolExecutionDeniedError && error.reason === 'budget_exhausted') return 'budget_exhausted';
            throw error;
          }
          // Checked again right before the data is projected (synchronously after this): a principal
          // that changed while the guard ran gets nothing. The call is counted already; add the error.
          if (!await ownerMatches(handle)) {
            await managedTurn.onToolError({ toolName: handle.toolName, input, error: new Error('result_denied'), durationMs: 0 });
            return 'denied';
          }
          return undefined;
        },
        afterRead: async ({ handle, input, result, durationMs }) => {
          await managedTurn.afterToolCall({ toolName: handle.toolName, input, result, durationMs });
        },
      }
    : {};
  return { store, tool: createReadResultTool(store, guard) };
}

/**
 * Clears `store` once the response body of the turn is done: finished,
 * failed or cancelled. A response without a body ends the turn at once.
 */
export function clearWhenDone(response: Response, store: ResultStore | undefined): Response {
  if (!store) return response;
  if (!response.body) {
    store.clear();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          store.clear();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        store.clear();
        controller.error(error);
      }
    },
    async cancel(reason) {
      store.clear();
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
