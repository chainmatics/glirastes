import type {
  AiEndpointToolDefinition,
  AiUiToolDefinition,
  EndpointMethod,
  Tool,
  ToolContext,
  ToolRegistry,
  UiPattern,
  FilterAndNavigatePattern,
  OpenDetailPattern,
  OpenDialogPattern,
  RefreshPattern,
  ToastPattern,
  AuditEmitter,
  AuditEvent,
  InferSchema,
  SchemaLike,
  TelemetrySink,
} from '../../types.js';
import { defineTool } from '../../types.js';
import { zodToCompactDescription } from './zod-compact.js';
import type { ToolFailureClassifier } from '../../runtime/tool-failure.js';
import {
  assertMaxResultChars,
  DEFAULT_MAX_RESULT_CHARS,
  isValidMaxResultChars,
} from '../../runtime/result-limit.js';
import { truncateToolResult } from './truncate-tool-result.js';
import {
  applyOutputBound,
  type OutputBound,
  assertOutputFields,
  leftOutFields,
  normalizeOutputFields,
  outputBoundOf,
  outputFieldTree,
  toJsonRecord,
} from './output-fields.js';
import { applyDefaultViewWithoutStore } from './default-view.js';
import { UI_ACTION_HANDOFF_MESSAGE } from '../../browser/ui-action-handoff.js';
import {
  boundedToolFailure,
  ENDPOINT_FAILURE,
  ENDPOINT_FAILURE_DATA,
  endpointFailureFields,
  notFoundHint,
} from './tool-failure-result.js';
import type { ResultStore } from './result-store.js';
import { isResultReader } from './read-result-tool.js';
export {
  assertMaxResultChars,
  DEFAULT_MAX_RESULT_CHARS,
  isValidMaxResultChars,
  MAX_MAX_RESULT_CHARS,
  MIN_MAX_RESULT_CHARS,
} from '../../runtime/result-limit.js';
export {
  PAGINATION_PARAMETER_NAMES,
  truncateToolResult,
  type TruncatedMarker,
  type TruncateToolResultOptions,
} from './truncate-tool-result.js';
export {
  createResultStore,
  DEFAULT_RESULT_HANDLE_LIMITS,
  type ResultHandle,
  type ResultHandleLimits,
  type ResultStore,
  type ResultStoreOptions,
} from './result-store.js';
export { createReadResultTool, type ReadResultGuard } from './read-result-tool.js';
export {
  applyOutputBound,
  assertOutputFields,
  isValidOutputFields,
  MAX_OUTPUT_FIELD_CHARS,
  MAX_OUTPUT_FIELDS,
  normalizeOutputFields,
  outputBoundOf,
  type OutputBound,
  type OutputFieldsName,
} from './output-fields.js';
export { type DefaultViewMarker } from './default-view.js';
export { READ_RESULT_TOOL_NAME } from '../../contracts/result-handle.js';
export { createLocalGuardrails } from './local-guardrails.js';
export {
  createAdaptiveFastPath,
  createInMemoryFastPathStorage,
} from './adaptive-fast-path.js';

// ============================================================================
// Transport Types
// ============================================================================

export interface InternalApiRequest {
  method: EndpointMethod;
  path: string;
  body?: unknown;
  /** Cancels this invocation, including response-body reads. */
  signal?: AbortSignal;
}

export interface InternalApiResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
  /**
   * The caller refused the request itself (e.g. a path outside
   * `allowedPathPrefixes`); it never reached the backend. Such a failure is
   * never classified and carries no response body.
   */
  refusedLocally?: true;
}

export type InternalApiCaller = (
  request: InternalApiRequest,
) => Promise<InternalApiResponse>;

export type NodeIncomingHeaders = Record<
  string,
  string | string[] | undefined
>;

// ============================================================================
// Transport Adapter Options
// ============================================================================

export interface HttpExecutionLimits {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Never follow redirects when caller credentials are present. */
  redirect?: 'error' | 'manual';
}

export interface FetchInternalApiCallerOptions extends HttpExecutionLimits {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: Record<string, string>;
}

export interface NextInternalApiCallerOptions extends HttpExecutionLimits {
  origin: string;
  cookieHeader?: string;
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface ExpressInternalApiCallerOptions {
  baseUrl: string;
  reqHeaders?: NodeIncomingHeaders;
  forwardHeaderNames?: string[];
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface HttpEndpointCallerOptions extends HttpExecutionLimits {
  /** Segment-bounded, canonical API path prefixes. Empty list denies all. */
  allowedPathPrefixes?: ReadonlyArray<string>;
  /**
   * Origin of the API the tools call, e.g. `http://127.0.0.1:4000`. The app
   * fixes it; it is never read from the chat request, so a `Host` or
   * `X-Forwarded-Host` header cannot send a tool call elsewhere. Tool paths
   * carry the full API path, so the URL has no path of its own.
   */
  baseUrl: string;
  /** The chat request whose user credentials every call carries. */
  request?: Request;
  /** Headers of `request` forwarded to the API; `cookie` and `authorization` when absent. */
  forwardHeaderNames?: ReadonlyArray<string>;
  /**
   * Extra headers of every call. A default never stands in for a forwarded
   * header: one with a forwarded name is dropped, also when the user sent none.
   */
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

// ============================================================================
// Tool Execution Context (server-side, adds callEndpoint)
// ============================================================================

export interface EndpointToolContext extends ToolContext {
  callEndpoint: InternalApiCaller;
  /**
   * The endpoint refused a call that passed the tool's input schema (400 or
   * 422): the contract is wrong (spec 4.7, `tool_contract_rejected`). Called
   * with the endpoint tool's `toolName` (a dotted definitionId or its
   * model-facing encoding; the turn recorder resolves either); it must not
   * throw.
   */
  onContractRejected?: (rejection: { toolName: string; status: 400 | 422 }) => void;
  /**
   * Classifies a non-2xx backend response as `'error'` (default) or
   * `'expected'`; see `ToolFailureClassifier`.
   */
  classifyToolFailure?: ToolFailureClassifier;
}

// ============================================================================
// Helpers (internal)
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function buildPath(
  pathTemplate: string,
  payload: Record<string, unknown>,
): string {
  return pathTemplate.replace(
    /:([A-Za-z0-9_]+)/g,
    (_full, paramName: string) => {
      const value = payload[paramName];
      if (value === undefined || value === null || value === '') {
        throw new Error(
          `Missing required path parameter: "${paramName}" for ${pathTemplate}`,
        );
      }
      const text = String(value);
      if (isDotSegment(text)) {
        throw new Error(
          `Invalid path parameter "${paramName}" for ${pathTemplate}: "." and ".." segments are not allowed`,
        );
      }
      delete payload[paramName];
      return encodeURIComponent(text);
    },
  );
}

/**
 * `.` and `..` are path segments, not values: a URL parser (or the API's
 * router) resolves them and the request lands on another route. A value is
 * refused when, at any stage of percent-decoding it again and again, one of
 * its segments (split at `/` and `\`) is `.` or `..`, because a proxy or
 * framework in front of the API may decode once or several times, and some
 * treat a backslash as a slash. Decoding is lenient (a malformed escape is
 * left as it is, the valid ones around it are decoded) and stops at a fixed
 * point; a value that has not reached one after a few rounds is refused.
 */
const MAX_DECODING_ROUNDS = 8;

function isDotSegment(value: string): boolean {
  let current = value;
  for (let round = 0; round <= MAX_DECODING_ROUNDS; round += 1) {
    if (current.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) return true;
    const decoded = current.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === current) return false;
    current = decoded;
  }
  return true;
}

export function stripPathParams(
  pathTemplate: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const pathParamNames = new Set<string>();
  for (const match of pathTemplate.matchAll(/:([A-Za-z0-9_]+)/g)) {
    pathParamNames.add(match[1]);
  }
  const remaining: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!pathParamNames.has(key)) {
      remaining[key] = value;
    }
  }
  return remaining;
}

export function buildQueryString(
  payload: Record<string, unknown>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
      continue;
    }
    params.append(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

// ============================================================================
// Template Interpolation
// ============================================================================

export function applyTemplateValue(
  value: unknown,
  input: Record<string, unknown>,
  responseData: Record<string, unknown>,
): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    const key = value.slice(1);
    if (key in responseData) return responseData[key];
    if (key in input) return input[key];
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      applyTemplateValue(item, input, responseData),
    );
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = applyTemplateValue(nested, input, responseData);
    }
    return output;
  }
  return value;
}

function buildSuccessUiAction(
  template: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
  responseData: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!template) return undefined;
  return applyTemplateValue(template, input, responseData) as Record<
    string,
    unknown
  >;
}

// ============================================================================
// UI Pattern Builders
// ============================================================================

function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function buildFilterAndNavigateAction(
  pattern: FilterAndNavigatePattern,
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (pattern.condition) {
    const conditionValue =
      getNestedValue(response, pattern.condition) ??
      getNestedValue(input, pattern.condition);
    if (!conditionValue) return undefined;
  }

  const filters: Record<string, unknown> = {};
  const mapping = pattern.filterMapping ?? {};
  const arrayFields = new Set(
    pattern.arrayFields ?? ['status', 'priority', 'assignee'],
  );

  for (const [filterKey, responseField] of Object.entries(mapping)) {
    const value =
      getNestedValue(response, responseField) ??
      getNestedValue(input, responseField);
    if (value === undefined || value === null) continue;

    if (arrayFields.has(filterKey)) {
      filters[filterKey] = Array.isArray(value) ? value : [value];
    } else if (typeof value === 'string') {
      filters[filterKey] = value;
    }
  }

  const hasFilters = Object.keys(filters).length > 0;
  if (!hasFilters && !pattern.condition) {
    return { type: 'navigate-and-filter', destination: pattern.target };
  }
  if (!hasFilters) return undefined;

  return {
    type: 'navigate-and-filter',
    destination: pattern.target,
    filters,
  };
}

function buildOpenDetailAction(
  pattern: OpenDetailPattern,
  response: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const id = getNestedValue(response, pattern.idField);
  if (!id || typeof id !== 'string') return undefined;

  return {
    type: 'run-client-action',
    actionId: `${pattern.entity}-details.open`,
    payload: { [`${pattern.entity}Id`]: id },
  };
}

function buildOpenDialogAction(
  pattern: OpenDialogPattern,
  response: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const payload: Record<string, unknown> = {};
  if (pattern.idField) {
    const id = getNestedValue(response, pattern.idField);
    if (id && typeof id === 'string') {
      payload.entityId = id;
    }
  }
  return {
    type: 'run-client-action',
    actionId: `${pattern.dialog}-dialog.open`,
    payload: Object.keys(payload).length > 0 ? payload : undefined,
  };
}

function buildRefreshAction(
  pattern: RefreshPattern,
): Record<string, unknown> {
  return {
    type: 'run-client-action',
    actionId: `${pattern.target}.refresh`,
  };
}

function buildToastAction(
  pattern: ToastPattern,
  response: Record<string, unknown>,
): Record<string, unknown> {
  let message = pattern.message;
  if (message.startsWith('$')) {
    const fieldValue = getNestedValue(response, message.slice(1));
    message = typeof fieldValue === 'string' ? fieldValue : pattern.message;
  }
  return {
    type: 'run-client-action',
    actionId: 'toast.show',
    payload: { message, variant: pattern.variant ?? 'default' },
  };
}

/**
 * Build a uiAction from a UiPattern definition + runtime data.
 */
export function buildUiActionFromPattern(
  pattern: UiPattern,
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): Record<string, unknown> | undefined {
  switch (pattern.type) {
    case 'filter-and-navigate':
      return buildFilterAndNavigateAction(pattern, input, response);
    case 'open-detail':
      return buildOpenDetailAction(pattern, response);
    case 'open-dialog':
      return buildOpenDialogAction(pattern, response);
    case 'refresh':
      return buildRefreshAction(pattern);
    case 'toast':
      return buildToastAction(pattern, response);
    default:
      return undefined;
  }
}

/**
 * Build uiActions from an array of UiPattern definitions.
 * Filters out undefined results (patterns whose conditions were not met).
 */
function buildUiActionsFromPatterns(
  patterns: UiPattern[],
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  for (const pattern of patterns) {
    const action = buildUiActionFromPattern(pattern, input, response);
    if (action !== undefined) {
      results.push(action);
    }
  }
  return results;
}

// ============================================================================
// UI Action Validation
// ============================================================================

/**
 * Validates and normalizes optional uiAction inside tool results.
 * Invalid actions are dropped so frontend event handling stays deterministic.
 *
 * @param result - Tool execution result (may contain uiAction)
 * @param uiActionSchema - Zod schema to validate against (from createUiActionSchema)
 */
export function normalizeResultUiAction(
  result: unknown,
  uiActionSchema?: SchemaLike,
): unknown {
  if (!isRecord(result) || !('uiAction' in result)) return result;
  if (!uiActionSchema) return result; // No schema provided, pass through

  const candidate = result.uiAction;

  // Array of uiActions: validate each element, keep valid ones
  if (Array.isArray(candidate)) {
    const validActions: unknown[] = [];
    for (const item of candidate) {
      const parsed = uiActionSchema.safeParse(item);
      if (parsed.success) {
        validActions.push(parsed.data);
      }
    }
    if (validActions.length > 0) {
      return { ...result, uiAction: validActions };
    }
    const { uiAction: _invalid, ...rest } = result;
    return { ...rest, warning: 'All UI actions in array were invalid and dropped.' };
  }

  // Single uiAction: existing logic
  const parsed = uiActionSchema.safeParse(candidate);
  if (parsed.success) {
    return { ...result, uiAction: parsed.data };
  }

  const { uiAction: _invalid, ...rest } = result;
  return { ...rest, warning: 'Invalid UI action dropped.' };
}

// ============================================================================
// Endpoint Tool Definition → Tool Conversion
// ============================================================================

/**
 * `glirastes.*` UI actions belong to the generated UI tools (`ui.navigate`,
 * `ui.filter.<view>`, `ui.<actionId>`), whose results the chat hands to the
 * app's bridge without asking again. An endpoint result never carries one, so
 * data an endpoint returns can neither navigate nor run a client action past
 * that action's confirmation.
 */
function withoutReservedUiActions(
  uiAction: Record<string, unknown> | Record<string, unknown>[] | undefined,
): Record<string, unknown> | Record<string, unknown>[] | undefined {
  const reserved = (action: Record<string, unknown>): boolean => (
    typeof action.type === 'string' && action.type.startsWith('glirastes.')
  );
  if (Array.isArray(uiAction)) {
    const kept = uiAction.filter((action) => !reserved(action));
    return kept.length > 0 ? kept : undefined;
  }
  return uiAction && !reserved(uiAction) ? uiAction : undefined;
}

/**
 * Convert an endpoint tool definition into a Tool.
 * Uses callEndpoint from the ToolContext to execute HTTP requests.
 */
export function endpointToolToTool<TInput extends SchemaLike>(
  endpointTool: AiEndpointToolDefinition<TInput>,
): Tool {
  const label = `endpointToolToTool(${endpointTool.id})`;
  assertMaxResultChars(endpointTool.maxResultChars, label);
  assertOutputFields(endpointTool.outputAllowedFields, label, 'outputAllowedFields');
  assertOutputFields(endpointTool.outputDeniedFields, label, 'outputDeniedFields');
  assertOutputFields(endpointTool.outputDefaultFields, label, 'outputDefaultFields');
  const outputAllowedFields = endpointTool.outputAllowedFields !== undefined
    ? normalizeOutputFields(endpointTool.outputAllowedFields)!
    : undefined;
  const outputDeniedFields = endpointTool.outputDeniedFields !== undefined
    ? normalizeOutputFields(endpointTool.outputDeniedFields, 'outputDeniedFields')!
    : undefined;
  const outputDefaultFields = endpointTool.outputDefaultFields !== undefined
    ? normalizeOutputFields(endpointTool.outputDefaultFields, 'outputDefaultFields')!
    : undefined;
  const ownBound = outputBoundOf({ outputAllowedFields, outputDeniedFields });
  // Fixed per route: only a route with path parameters addresses one record.
  const pathNotFoundHint = notFoundHint(endpointTool.path);
  let description = endpointTool.description;
  if (endpointTool.outputSchema) {
    // The model is told only about the fields it can get.
    description += `\n\nReturns: ${zodToCompactDescription(endpointTool.outputSchema, 3, ownBound)}`;
  }

  return defineTool({
    id: endpointTool.id,
    description,
    inputSchema: endpointTool.inputSchema,
    outputSchema: endpointTool.outputSchema,
    method: endpointTool.method,
    ...(endpointTool.maxResultChars !== undefined ? { maxResultChars: endpointTool.maxResultChars } : {}),
    ...(outputAllowedFields ? { outputAllowedFields } : {}),
    ...(outputDeniedFields ? { outputDeniedFields } : {}),
    ...(outputDefaultFields ? { outputDefaultFields } : {}),
    needsApproval:
      endpointTool.needsApproval ??
      (endpointTool.method === 'GET' || endpointTool.method === 'HEAD' ? false : true),
    execute: async (
      rawInput: InferSchema<TInput>,
      context: ToolContext,
    ) => {
      const endpointContext = context as EndpointToolContext;
      if (!endpointContext.callEndpoint) {
        throw new Error(
          'EndpointToolContext with callEndpoint is required for endpoint tools.',
        );
      }

      const inputPayload = isRecord(rawInput) ? { ...rawInput } : {};
      const endpointPath = buildPath(endpointTool.path, inputPayload);
      const requestPayload = stripPathParams(
        endpointTool.path,
        inputPayload,
      );

      const queryOnly = endpointTool.method === 'GET'
        || endpointTool.method === 'HEAD'
        || endpointTool.method === 'DELETE';
      const requestPath = queryOnly
        ? `${endpointPath}${buildQueryString(requestPayload)}`
        : endpointPath;

      const requestBody =
        queryOnly
          ? undefined
          : Object.keys(requestPayload).length > 0
            ? requestPayload
            : undefined;

      const response = await endpointContext.callEndpoint({
        method: endpointTool.method,
        path: requestPath,
        body: requestBody,
      });

      if (!response.ok) {
        if (response.status === 400 || response.status === 422) {
          try {
            endpointContext.onContractRejected?.({ toolName: endpointTool.toolName, status: response.status });
          } catch {
            // Metrics never change a tool result.
          }
        }
        const fromBackend = response.refusedLocally !== true && Number.isInteger(response.status);
        let expected = false;
        if (fromBackend && endpointContext.classifyToolFailure) {
          try {
            expected = endpointContext.classifyToolFailure({
              toolName: endpointTool.toolName,
              status: response.status,
              body: response.data,
            }) === 'expected';
          } catch {
            // A failing classifier counts the failure as an error.
          }
        }
        const failure: Record<string, unknown> = {
          success: false,
          error: response.error ?? `Endpoint failed (${response.status})`,
          ...(Number.isInteger(response.status) ? { status: response.status } : {}),
          // Under the tool's bound the body is reduced before it is serialized and cut.
          ...(fromBackend ? endpointFailureFields(response.data, ownBound) : {}),
          ...(fromBackend && response.status === 404 && pathNotFoundHint ? { hint: pathNotFoundHint } : {}),
          ...(expected ? { expectedFailure: true } : {}),
        };
        Object.defineProperty(failure, ENDPOINT_FAILURE, { value: true });
        // Kept unserialized (non-enumerable) so the bound of the tool that shows it can reduce it.
        if (fromBackend) Object.defineProperty(failure, ENDPOINT_FAILURE_DATA, { value: response.data });
        return failure;
      }

      // A list or scalar answer has no fields of its own, so it travels under `data`.
      const responseData = isRecord(response.data) && !Array.isArray(response.data)
        ? (response.data as Record<string, unknown>)
        : { data: response.data };

      // Priority: 1) Response uiAction, 2) uiPattern, 3) uiActionOnSuccess template
      let uiAction: Record<string, unknown> | Record<string, unknown>[] | undefined;

      if ('uiAction' in responseData && responseData.uiAction !== undefined) {
        // Response-provided uiAction: pass through as-is (single or array)
        if (Array.isArray(responseData.uiAction)) {
          const filtered = (responseData.uiAction as unknown[]).filter(isRecord) as Record<string, unknown>[];
          uiAction = filtered.length > 0 ? filtered : undefined;
        } else if (isRecord(responseData.uiAction)) {
          uiAction = responseData.uiAction as Record<string, unknown>;
        }
      } else if (endpointTool.uiPattern) {
        if (Array.isArray(endpointTool.uiPattern)) {
          const actions = buildUiActionsFromPatterns(
            endpointTool.uiPattern,
            inputPayload,
            responseData,
          );
          uiAction = actions.length > 0 ? actions : undefined;
        } else {
          uiAction = buildUiActionFromPattern(
            endpointTool.uiPattern,
            inputPayload,
            responseData,
          );
        }
      } else if (endpointTool.uiActionOnSuccess) {
        if (Array.isArray(endpointTool.uiActionOnSuccess)) {
          const actions: Record<string, unknown>[] = [];
          for (const template of endpointTool.uiActionOnSuccess) {
            const action = buildSuccessUiAction(template, inputPayload, responseData);
            if (action) actions.push(action);
          }
          uiAction = actions.length > 0 ? actions : undefined;
        } else {
          uiAction = buildSuccessUiAction(
            endpointTool.uiActionOnSuccess,
            inputPayload,
            responseData,
          );
        }
      }

      // The response's own uiAction field never reaches the chat unfiltered.
      const { uiAction: _responseUiAction, ...responseFields } = responseData;
      const resultUiAction = withoutReservedUiActions(uiAction);
      return {
        success: true,
        ...responseFields,
        ...(resultUiAction ? { uiAction: resultUiAction } : {}),
      };
    },
  });
}

/**
 * Convert an array of endpoint tools into a ToolRegistry.
 */
export function endpointToolsToRegistry(
  endpointTools: ReadonlyArray<AiEndpointToolDefinition>,
): ToolRegistry {
  const registry: ToolRegistry = {};
  for (const endpointTool of endpointTools) {
    if (registry[endpointTool.toolName]) {
      throw new Error(
        `Duplicate endpoint toolName: ${endpointTool.toolName}`,
      );
    }
    registry[endpointTool.toolName] = endpointToolToTool(endpointTool);
  }
  return registry;
}

// ============================================================================
// UI Tool Definition → Tool Conversion
// ============================================================================

function applyUiTemplateValue(
  value: unknown,
  input: Record<string, unknown>,
): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    const key = value.slice(1);
    return key in input ? input[key] : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyUiTemplateValue(item, input));
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = applyUiTemplateValue(nested, input);
    }
    return output;
  }
  return value;
}

/**
 * Convert a UI tool definition into a Tool.
 * UI tools never call external services — they only produce uiActions.
 */
export function uiToolToTool<TInput extends SchemaLike>(
  uiTool: AiUiToolDefinition<TInput>,
): Tool {
  let description = uiTool.description;
  if (uiTool.outputSchema) {
    description += `\n\nReturns: ${zodToCompactDescription(uiTool.outputSchema)}`;
  }

  return defineTool({
    id: uiTool.id,
    description,
    inputSchema: uiTool.inputSchema,
    outputSchema: uiTool.outputSchema,
    needsApproval: uiTool.needsApproval ?? false,
    execute: async (rawInput: InferSchema<TInput>) => {
      const inputPayload = isRecord(rawInput) ? { ...rawInput } : {};

      // Priority: 1) uiPattern (dynamic), 2) uiAction (static template)
      let uiAction: Record<string, unknown> | Record<string, unknown>[] | undefined;

      if (uiTool.uiPattern) {
        if (Array.isArray(uiTool.uiPattern)) {
          const actions = buildUiActionsFromPatterns(
            uiTool.uiPattern,
            inputPayload,
            {},
          );
          uiAction = actions.length > 0 ? actions : undefined;
        } else {
          uiAction = buildUiActionFromPattern(
            uiTool.uiPattern,
            inputPayload,
            {},
          );
        }
      } else if (uiTool.uiAction) {
        if (Array.isArray(uiTool.uiAction)) {
          const actions: Record<string, unknown>[] = [];
          for (const template of uiTool.uiAction) {
            const resolved = applyUiTemplateValue(template, inputPayload) as Record<string, unknown>;
            if (resolved) actions.push(resolved);
          }
          uiAction = actions.length > 0 ? actions : undefined;
        } else {
          uiAction = applyUiTemplateValue(
            uiTool.uiAction,
            inputPayload,
          ) as Record<string, unknown>;
        }
      }

      // The server only hands the action to the browser and does not learn
      // whether the app carried it out; an app's own successMessage wins.
      const message = uiTool.successMessage
        ? (applyUiTemplateValue(uiTool.successMessage, inputPayload) as string) || UI_ACTION_HANDOFF_MESSAGE
        : UI_ACTION_HANDOFF_MESSAGE;

      return {
        success: true,
        message,
        ...(uiAction ? { uiAction } : {}),
      };
    },
  });
}

/**
 * Convert an array of UI tools into a ToolRegistry.
 */
export function uiToolsToRegistry(
  uiTools: ReadonlyArray<AiUiToolDefinition>,
): ToolRegistry {
  const registry: ToolRegistry = {};
  for (const uiTool of uiTools) {
    if (registry[uiTool.toolName]) {
      throw new Error(`Duplicate UI toolName: ${uiTool.toolName}`);
    }
    registry[uiTool.toolName] = uiToolToTool(uiTool);
  }
  return registry;
}

// ============================================================================
// Tool → AI SDK Tool Bridge
// ============================================================================

/**
 * Options for converting tools to AI SDK tools.
 */
export interface ToolToAiToolOptions {
  /** Host schema for validating uiActions at runtime */
  uiActionSchema?: SchemaLike;
  /** Called when a tool execution fails */
  onError?: (toolId: string, error: unknown) => void;
  /**
   * When true, validate tool results against outputSchema in dev mode.
   * Defaults to true when NODE_ENV !== 'production'.
   */
  validateOutputSchemas?: boolean;
  /** Audit event emitter for PCI DSS / compliance logging */
  onAudit?: AuditEmitter;
  /** Session ID for audit context */
  sessionId?: string;
  /** Trace ID for correlating events within a single request */
  traceId?: string;
  /**
   * Remote telemetry sink for forwarding audit events to Glirastes.
   * Compatible with `lancer.telemetry`. Fire-and-forget — never blocks
   * tool execution. Enables monitoring dashboard for Free-tier users.
   */
  telemetry?: TelemetrySink;
  /**
   * Upper bound of a serialized successful tool result, in characters
   * (integer from 1,000 to 200,000; default 16,000). A tool's own
   * `maxResultChars` wins. See `truncateToolResult`.
   */
  maxResultChars?: number;
  /**
   * The result store of the running turn (`createResultStore`). With it, a
   * successful record result larger than the tool's limit is kept in the
   * store and the model gets an overview with a `_result` handle that
   * `read_result` (`createReadResultTool`) reads from; when the store
   * refuses it, the result is cut as without a store. `createAiChatHandler`
   * creates one per turn (`resultHandles`); without it nothing changes.
   */
  resultStore?: ResultStore;
}

/** What the model gets for a successful result whose details may not be shown. */
/**
 * The `uiAction` of a withheld result under an output bound: the any-depth
 * deny keys are removed as in every other result, and an action that cannot
 * be serialized (so cannot be checked) is left out.
 */
function boundedUiAction(uiAction: unknown, bound: OutputBound | undefined): unknown {
  if (!bound || !uiAction) return uiAction;
  return applyOutputBound({ success: true, uiAction }, bound)?.uiAction;
}

function withheldResult(uiAction: unknown): Record<string, unknown> {
  return {
    success: true,
    outputWithheld: true,
    message: 'The tool ran, but its result did not match its declared output, so the details are withheld. Do not call it again for the same request.',
    ...(uiAction ? { uiAction } : {}),
  };
}

/** Whether `value` serializes to more than `limit` characters (false when it cannot be serialized). */
function exceedsLimit(value: unknown, limit: number): boolean {
  try {
    return (JSON.stringify(value)?.length ?? 0) > limit;
  } catch {
    return false;
  }
}

/**
 * Convert a Tool to an AI SDK-compatible tool object.
 *
 * Returns a plain object with `description`, `parameters`, `execute` that
 * can be passed to any AI SDK that follows the Vercel AI SDK convention.
 *
 * @param tool - The tool to convert
 * @param context - Runtime context (currentDate, locale, runtime)
 * @param toolName - Override tool name (defaults to tool.id)
 * @param options - Additional options
 */
export function toolToAiTool(
  tool: Tool,
  context: ToolContext,
  toolName?: string,
  options?: ToolToAiToolOptions,
) {
  const name = toolName ?? tool.id;
  const needsApproval = tool.needsApproval;
  // Per tool, then global, then the default; an invalid value is never used.
  const resultLimit = isValidMaxResultChars(tool.maxResultChars)
    ? tool.maxResultChars
    : isValidMaxResultChars(options?.maxResultChars)
      ? options.maxResultChars
      : DEFAULT_MAX_RESULT_CHARS;
  // Only a read tool may be called again to page through a cut result:
  // GET and HEAD endpoint tools, and tools without a method that need no
  // approval (UI and custom read tools). Every other tool may have written.
  const method = tool.method?.toUpperCase();
  const readOnly = method !== undefined
    ? method === 'GET' || method === 'HEAD'
    : !tool.needsApproval;
  const requiresApproval = !!needsApproval;
  // Declared output fields. An invalid allow- or deny-list (a tool not built
  // with defineTool) allows nothing: it fails closed. An invalid default view is ignored.
  const bound = outputBoundOf(tool);
  const defaultFields = tool.outputDefaultFields !== undefined
    ? normalizeOutputFields(tool.outputDefaultFields, 'outputDefaultFields')
    : undefined;
  const defaultTree = defaultFields ? outputFieldTree(defaultFields) : undefined;

  return {
    _toolId: tool.id,
    description: tool.description,
    parameters: tool.inputSchema,
    needsApproval: requiresApproval
      ? async (input: unknown) => {
          const needed = typeof needsApproval === 'boolean'
            ? needsApproval
            : await needsApproval!(input, context);

          if (needed) {
            options?.onAudit?.({
              type: 'approval.requested',
              timestamp: new Date().toISOString(),
              sessionId: options.sessionId ?? '',
              source: 'server-core',
              details: {
                toolId: tool.id,
                toolName: name,
              },
            });
          }
          return needed;
        }
      : undefined,
    execute: async (input: unknown, executionOptions?: { abortSignal?: AbortSignal }) => {
      const signals = [context.abortSignal, executionOptions?.abortSignal].filter((value): value is AbortSignal => Boolean(value));
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      signal?.throwIfAborted();
      const endpoint = context as Partial<EndpointToolContext>;
      const executionContext = signal ? {
        ...context, abortSignal: signal,
        ...(endpoint.callEndpoint ? { callEndpoint: (request: InternalApiRequest) => endpoint.callEndpoint!({
          ...request, signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal,
        }) } : {}),
      } : context;
      const startTime = Date.now();
      try {
        // A handle belongs to the principal the tool runs for: captured before it runs.
        const store = options?.resultStore;
        const capturedOwner = store && !isResultReader(tool) ? await store.captureOwner() : undefined;
        const result = await tool.execute(input, executionContext);

        // Audit: tool executed successfully
        options?.onAudit?.({
          type: 'tool.executed',
          timestamp: new Date().toISOString(),
          sessionId: options.sessionId ?? '',
          source: 'server-core',
          details: {
            toolId: tool.id,
            toolName: name,
            method: tool.method,
            latencyMs: Date.now() - startTime,
            success: true,
            approvalRequired: !!requiresApproval,
          },
        });

        // Output schema: parse to strip extra fields, re-attach uiAction for client
        let cleanResult: unknown = result;
        // A successful result of the declared shape (not a failure, not withheld): output fields apply to it.
        let successful = !(isRecord(result) && result.success === false);
        if (isRecord(result) && result.success === false) {
          cleanResult = boundedToolFailure(result, bound);
        } else if (
          tool.outputSchema &&
          isRecord(result)
        ) {
          const rec = result as Record<string, unknown>;
          let parsed = tool.outputSchema.safeParse(result);
          if (
            !parsed.success
            && rec.uiAction !== undefined
          ) {
            const {
              uiAction: _transportUiAction,
              ...payloadWithoutUiAction
            } = rec;
            parsed = tool.outputSchema.safeParse(payloadWithoutUiAction);
          }
          if (!parsed.success && rec.success !== undefined) {
            const {
              success: _transportSuccess,
              uiAction: _transportUiAction,
              ...declaredPayload
            } = rec;
            parsed = tool.outputSchema.safeParse(declaredPayload);
          }
          const carriedUnderData = !parsed.success
            && rec.data !== undefined
            && (!isRecord(rec.data) || Array.isArray(rec.data));
          if (carriedUnderData) parsed = tool.outputSchema.safeParse(rec.data);
          if (parsed.success) {
            // Use parsed data (extra fields stripped by Zod)
            cleanResult = {
              ...(carriedUnderData ? { data: parsed.data } : parsed.data as Record<string, unknown>),
              // Preserve success flag
              ...(rec.success !== undefined ? { success: rec.success } : {}),
              // Re-attach uiAction for client stream (stripped by schema parse)
              ...(rec.uiAction ? { uiAction: rec.uiAction } : {}),
            };
          } else {
            // Schema mismatch — retain bounded diagnostics locally, but never
            // expose an undeclared backend payload to the model.
            // Validation paths and messages may embed backend data (including
            // object keys and custom validator messages). Keep diagnostics
            // technical; never print those values from a runtime process.
            console.warn(`[glirastes] Output schema mismatch for tool "${name}": ${parsed.error.issues.length} issue(s).`);
            // The tool ran, and a write may already have happened: report it
            // as done, so the model neither claims a failure nor calls again.
            cleanResult = withheldResult(boundedUiAction(rec.uiAction, bound));
            successful = false;
          }
        }

        // The upper bound comes first: nothing outside outputAllowedFields, and
        // nothing in outputDeniedFields, reaches the PII shield, the store, the
        // overview, the cut or the browser.
        if (bound && successful) {
          const bounded = applyOutputBound(cleanResult, bound);
          if (bounded) cleanResult = bounded;
          else {
            // Not serializable, so it cannot be bounded: withheld.
            cleanResult = withheldResult(boundedUiAction(isRecord(cleanResult) ? cleanResult.uiAction : undefined, bound));
            successful = false;
          }
        }
        const fromStore = store?.isIssued(result) === true;
        // The default view needs the record form: a list or scalar result travels
        // under `data`, as it does under a bound (which has normalized it already).
        if (defaultTree && successful && !fromStore && !bound
          && !(isRecord(cleanResult) && !Array.isArray(cleanResult) && cleanResult.success === false)) {
          cleanResult = toJsonRecord(cleanResult) ?? cleanResult;
        }
        const payloadRecord = isRecord(cleanResult) && !Array.isArray(cleanResult) && cleanResult.success !== false;
        const viewed = defaultTree !== undefined && successful && payloadRecord && !fromStore
          && leftOutFields(cleanResult as Record<string, unknown>, defaultTree).length > 0;

        // Bound the result so it cannot overflow the model context: with a
        // result store an oversized record result keeps its handle and the
        // model gets an overview, otherwise (or when the store refuses) it is cut.
        const overview = store && !fromStore && payloadRecord
          // A payload with its own `_result` keeps it: no overview would replace it.
          && !Object.prototype.hasOwnProperty.call(cleanResult, '_result')
          && (viewed || exceedsLimit(cleanResult, resultLimit))
          ? await store.put({
              toolName: name, readOnly, maxChars: resultLimit, value: cleanResult as Record<string, unknown>,
              ...(viewed ? { defaultFields: defaultFields! } : {}),
              ...(capturedOwner ? { owner: capturedOwner } : {}),
            })
          : undefined;
        // Without a handle the default view still applies; the rest cannot be read.
        const unreadableView = !overview && viewed
          ? applyDefaultViewWithoutStore(cleanResult as Record<string, unknown>, defaultTree!, resultLimit, { readOnly, inputSchema: tool.inputSchema })
          : undefined;
        cleanResult = overview ?? unreadableView
          ?? truncateToolResult(cleanResult, resultLimit, { inputSchema: tool.inputSchema, readOnly });

        const output = options?.uiActionSchema
          ? normalizeResultUiAction(cleanResult, options.uiActionSchema)
          : cleanResult;
        // Cut from the sealed copy in the store: the PII shield must not seal it again.
        if (overview || fromStore) store!.markIssued(output);
        return output;
      } catch (error) {
        // Audit: tool execution failed
        options?.onAudit?.({
          type: 'tool.failed',
          timestamp: new Date().toISOString(),
          sessionId: options.sessionId ?? '',
          source: 'server-core',
          details: {
            toolId: tool.id,
            toolName: name,
            error: error instanceof Error ? error.message : String(error),
            latencyMs: Date.now() - startTime,
          },
        });

        options?.onError?.(tool.id, error);
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        return normalizeResultUiAction(
          {
            error: `Error in ${tool.id}: ${errorMessage}`,
            hint: 'Check the parameters and try again.',
          },
          options?.uiActionSchema,
        );
      }
    },
  };
}

/**
 * Forward an audit event to the remote telemetry sink (fire-and-forget).
 */
function forwardToTelemetry(
  telemetry: TelemetrySink,
  event: AuditEvent,
  traceId?: string,
): void {
  try {
    telemetry.emit({
      eventType: event.type,
      traceId: traceId ?? event.sessionId,
      toolId: (event.details?.toolId ?? event.details?.toolName) as string | undefined,
      latencyMs: event.details?.latencyMs as number | undefined,
      timestamp: event.timestamp,
      payload: event.details,
      actor: { sessionId: event.sessionId },
    });
  } catch {
    // Telemetry is fire-and-forget, never block tool execution
  }
}

/**
 * Wrap options to auto-forward audit events to remote telemetry.
 * Returns options with an augmented `onAudit` that calls both
 * the original callback and the telemetry sink.
 */
function withTelemetryForwarding(options?: ToolToAiToolOptions): ToolToAiToolOptions | undefined {
  if (!options?.telemetry) return options;
  const { telemetry, onAudit: originalOnAudit } = options;
  return {
    ...options,
    onAudit: (event) => {
      originalOnAudit?.(event);
      forwardToTelemetry(telemetry, event, options.traceId);
    },
  };
}

/**
 * Convert a registry of tools to AI SDK tools.
 * The SDK does not perform authorization — the backend API that each tool
 * calls is responsible for permission enforcement.
 */
export function toolsToAiTools(
  registry: ToolRegistry,
  context: ToolContext,
  options?: ToolToAiToolOptions,
): Record<string, ReturnType<typeof toolToAiTool>> {
  const resolvedOptions = withTelemetryForwarding(options);
  const tools: Record<string, ReturnType<typeof toolToAiTool>> = {};

  for (const [name, tool] of Object.entries(registry)) {
    tools[name] = toolToAiTool(tool, context, name, resolvedOptions);
  }

  return tools;
}

// ============================================================================
// Transport Adapters
// ============================================================================

function toErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === 'string' && data.trim()) return data;
  if (isRecord(data)) {
    // NestJS ValidationPipe returns: { statusCode, message: string[], error: "Bad Request" }
    // Prefer the detailed message(s) over the generic error string.
    const message = data.message;
    if (Array.isArray(message) && message.length > 0) {
      const details = message
        .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        .join('; ');
      if (details) {
        const prefix =
          typeof data.error === 'string' && data.error.trim()
            ? `${data.error}: `
            : '';
        return `${prefix}${details}`;
      }
    }
    if (typeof message === 'string' && message.trim()) return message;
    if (typeof data.error === 'string' && data.error.trim())
      return data.error;
    // FastAPI: HTTPException returns { detail: string }, a validation error { detail: [{ loc, msg }] }.
    const detail = data.detail;
    if (typeof detail === 'string' && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const details = detail
        .filter(isRecord)
        .filter((item) => typeof item.msg === 'string' && item.msg.trim())
        .map((item) => {
          const location = Array.isArray(item.loc) ? item.loc.filter((part) => typeof part === 'string' || typeof part === 'number').join('.') : '';
          return location ? `${location}: ${item.msg as string}` : item.msg as string;
        });
      if (details.length > 0) return details.join('; ');
    }
  }
  return fallback;
}

async function parseResponseBody(response: Response, maxBytes?: number): Promise<unknown> {
  let text: string;
  if (maxBytes !== undefined && response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error('Endpoint response exceeds maxResponseBytes');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    text = new TextDecoder().decode(bytes);
  } else { text = await response.text(); }
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    try { return JSON.parse(text); } catch { return undefined; }
  }
  return text.length ? text : undefined;
}

function positiveLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export function normalizeNodeHeaders(
  headers: NodeIncomingHeaders,
  allowedHeaderNames?: string[],
): Record<string, string> {
  const allowlist = allowedHeaderNames
    ? new Set(allowedHeaderNames.map((n) => n.toLowerCase()))
    : undefined;
  const normalized: Record<string, string> = {};

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (allowlist && !allowlist.has(name)) continue;
    if (rawValue === undefined) continue;
    if (Array.isArray(rawValue)) {
      normalized[name] = rawValue.join(
        name === 'cookie' ? '; ' : ', ',
      );
      continue;
    }
    normalized[name] = rawValue;
  }

  return normalized;
}

export function createFetchInternalApiCaller(
  options: FetchInternalApiCallerOptions,
): InternalApiCaller {
  const fetchImpl = options.fetchImpl ?? fetch;
  positiveLimit(options.timeoutMs, 'timeoutMs');
  positiveLimit(options.maxResponseBytes, 'maxResponseBytes');

  return async (request) => {
    const url = new URL(request.path, options.baseUrl).toString();
    const methodAllowsBody = request.method !== 'GET'
      && request.method !== 'HEAD'
      && request.method !== 'DELETE';

    const headers: Record<string, string> = {
      ...(options.defaultHeaders ?? {}),
    };

    const timeout = new AbortController();
    const signals = [options.signal, request.signal, ...(options.timeoutMs ? [timeout.signal] : [])]
      .filter((value): value is AbortSignal => Boolean(value));
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    signal?.throwIfAborted();
    const timer = options.timeoutMs ? setTimeout(() => timeout.abort(new DOMException('Endpoint timed out', 'TimeoutError')), options.timeoutMs) : undefined;
    timer?.unref();
    const init: RequestInit = { method: request.method, headers,
      ...(signal ? { signal } : {}), ...(options.redirect ? { redirect: options.redirect } : {}),
    };

    try {
      if (methodAllowsBody && request.body !== undefined) {
        if (!headers['content-type']) {
          headers['content-type'] = 'application/json';
        }
        init.body = JSON.stringify(request.body);
      }

      const response = await fetchImpl(url, init);
      const data = await parseResponseBody(response, options.maxResponseBytes);

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          data,
          error: toErrorMessage(
            data,
            `Endpoint failed (${response.status})`,
          ),
        };
      }

      return { ok: true, status: response.status, data };
    } finally { if (timer) clearTimeout(timer); }
  };
}

export function createNextInternalApiCaller(
  options: NextInternalApiCallerOptions,
): InternalApiCaller {
  const headers: Record<string, string> = {
    ...(options.defaultHeaders ?? {}),
  };
  if (options.cookieHeader) headers.cookie = options.cookieHeader;

  return createFetchInternalApiCaller({
    ...options,
    baseUrl: options.origin,
    fetchImpl: options.fetchImpl,
    defaultHeaders: headers,
  });
}

export function createExpressInternalApiCaller(
  options: ExpressInternalApiCallerOptions,
): InternalApiCaller {
  const forwardHeaderNames = options.forwardHeaderNames ?? [
    'cookie',
    'authorization',
    'x-request-id',
  ];
  const forwardedHeaders = options.reqHeaders
    ? normalizeNodeHeaders(options.reqHeaders, forwardHeaderNames)
    : {};

  return createFetchInternalApiCaller({
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    defaultHeaders: {
      ...forwardedHeaders,
      ...(options.defaultHeaders ?? {}),
    },
  });
}

const HTTP_FORWARDED_HEADERS = ['cookie', 'authorization'];

/**
 * Endpoint caller for an API on its own origin (a NestJS or FastAPI backend
 * next to the chat handler): every call goes to the fixed `baseUrl` and
 * carries only the `cookie` and `authorization` headers the user sent with
 * the chat request, so the API authorizes the user, never a substitute.
 */
export function createHttpEndpointCaller(options: HttpEndpointCallerOptions): InternalApiCaller {
  const base = new URL(options.baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('createHttpEndpointCaller: baseUrl must be an http or https URL');
  }
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) {
    throw new Error('createHttpEndpointCaller: baseUrl is an origin; tool paths carry the full API path');
  }
  const prefixes = options.allowedPathPrefixes?.map((prefix) => {
    if (!staysOnOrigin(prefix, base.origin) || prefix.includes('?') || prefix.includes('#') || /[%]/.test(prefix)
      || new URL(prefix, base.origin).pathname !== prefix) throw new Error('Invalid allowedPathPrefixes');
    return prefix === '/' ? '/' : prefix.replace(/\/$/, '');
  });
  const names = new Set((options.forwardHeaderNames ?? HTTP_FORWARDED_HEADERS).map((name) => name.toLowerCase()));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.defaultHeaders ?? {})) {
    if (!names.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
  }
  for (const name of [...names].sort()) {
    const value = options.request?.headers.get(name);
    if (value) headers[name] = value;
  }
  const call = createFetchInternalApiCaller({
    baseUrl: base.origin,
    signal: options.signal && options.request ? AbortSignal.any([options.signal, options.request.signal]) : options.signal ?? options.request?.signal,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxResponseBytes: options.maxResponseBytes ?? 2 * 1024 * 1024,
    redirect: options.redirect ?? 'error',
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    defaultHeaders: headers,
  });
  return async (request) => {
    if (!staysOnOrigin(request.path, base.origin)) {
      return { ok: false, status: 400, error: 'Endpoint path must be relative to the API', refusedLocally: true };
    }
    if (prefixes) {
      const rawPath = request.path.split(/[?#]/, 1)[0]!;
      const pathname = new URL(request.path, base.origin).pathname;
      // Do not let upstream double decoding or encoded separators escape a prefix.
      if (/%(?:2e|2f|5c|25)/i.test(rawPath) || rawPath !== pathname
        || !prefixes.some((prefix) => prefix === '/' || pathname === prefix || pathname.startsWith(`${prefix}/`))) {
        return { ok: false, status: 403, error: 'Endpoint path is not allowed', refusedLocally: true };
      }
    }
    return call(request);
  };
}

/**
 * A tool path is relative to the API. An absolute or protocol-relative one
 * would leave it, and so would one that a URL parser rewrites: it drops tab,
 * CR and LF anywhere and reads `\` as `/`, so `/<tab>/host` becomes `//host`.
 * Control characters and `\` are therefore refused, and the resolved URL must
 * still be on the API's origin.
 */
function staysOnOrigin(path: string, origin: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  for (const char of path) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || char === '\\') return false;
  }
  try {
    return new URL(path, origin).origin === origin;
  } catch {
    return false;
  }
}

// ============================================================================
// Re-exports
// ============================================================================

export { zodToCompactDescription } from './zod-compact.js';
export type {
  ToolFailureClassification,
  ToolFailureClassifier,
  ToolFailureInfo,
} from '../../runtime/tool-failure.js';
export {
  uiActionToolToTool,
  type GeneratedUiAction,
  type GeneratedUiToolDefinition,
} from './generated-ui-tool.js';

// ============================================================================
// Followup Tool
// ============================================================================

export { createFollowupTool } from './followup-tool.js';

// ============================================================================
// Clarification Tool
// ============================================================================

export {
  createClarificationTool,
  ClarificationInputSchema,
  type ClarificationConfig,
} from './clarification-tool.js';

// ============================================================================
// Plan Tool
// ============================================================================

export {
  createPlanTool,
  PlanInputSchema,
  type PlanningConfig,
} from './plan-tool.js';

// ============================================================================
// Module Routing
// ============================================================================

export { defineModule, createAiRouter } from './module-router.js';

// ============================================================================
// Model Selection
// ============================================================================

export { createModelSelector, createModelSelectorFromMap } from './model-selector.js';

// ============================================================================
// Intent Classification
// ============================================================================

export {
  createIntentClassifier,
  tokenize,
  jaccardSimilarity,
  classifyWithHeuristics,
  buildClassificationPrompt,
  parseJsonResponse,
} from './intent-classifier.js';
export type { LocalClassifierConfig } from './intent-classifier.js';
