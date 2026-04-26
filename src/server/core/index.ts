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
  TelemetrySink,
} from '../../types.js';
import { defineTool } from '../../types.js';
import { z } from 'zod';
import { zodToCompactDescription } from './zod-compact.js';

// ============================================================================
// Transport Types
// ============================================================================

export interface InternalApiRequest {
  method: EndpointMethod;
  path: string;
  body?: unknown;
}

export interface InternalApiResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
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

export interface FetchInternalApiCallerOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: Record<string, string>;
}

export interface NextInternalApiCallerOptions {
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

// ============================================================================
// Tool Execution Context (server-side, adds callEndpoint)
// ============================================================================

export interface EndpointToolContext extends ToolContext {
  callEndpoint: InternalApiCaller;
}

// ============================================================================
// Helpers (internal)
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Default max characters for a serialized tool result (~4000 tokens).
 * Arrays exceeding this are truncated with a `_truncated` marker.
 */
const DEFAULT_MAX_RESULT_CHARS = 16_000;

/**
 * Truncate large tool results to prevent LLM context overflow.
 *
 * Strategy: find the largest array in the top-level result and
 * progressively remove items from the end until the serialized
 * size is under the limit. A `_truncated` object is appended so the
 * LLM knows the data was cut.
 */
export function truncateToolResult(
  result: unknown,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS,
): unknown {
  if (!isRecord(result)) return result;

  const serialized = JSON.stringify(result);
  if (serialized.length <= maxChars) return result;

  // Find the largest array at the top level
  let largestKey: string | null = null;
  let largestLen = 0;
  const rec = result as Record<string, unknown>;
  for (const [key, value] of Object.entries(rec)) {
    if (Array.isArray(value) && value.length > largestLen) {
      largestKey = key;
      largestLen = value.length;
    }
  }

  if (!largestKey || largestLen === 0) return result;

  // Binary-search for the right array length
  const arr = rec[largestKey] as unknown[];
  let lo = 1;
  let hi = arr.length;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = {
      ...rec,
      [largestKey]: arr.slice(0, mid),
      _truncated: { field: largestKey, showing: mid, total: arr.length },
    };
    if (JSON.stringify(candidate).length <= maxChars) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const finalCount = Math.max(lo - 1, 1);
  return {
    ...rec,
    [largestKey]: arr.slice(0, finalCount),
    _truncated: { field: largestKey, showing: finalCount, total: arr.length },
  };
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
      delete payload[paramName];
      return encodeURIComponent(String(value));
    },
  );
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
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
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
  uiActionSchema?: z.ZodTypeAny,
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
 * Convert an endpoint tool definition into a Tool.
 * Uses callEndpoint from the ToolContext to execute HTTP requests.
 */
export function endpointToolToTool<TInput extends z.ZodTypeAny>(
  endpointTool: AiEndpointToolDefinition<TInput>,
): Tool {
  let description = endpointTool.description;
  if (endpointTool.outputSchema) {
    description += `\n\nReturns: ${zodToCompactDescription(endpointTool.outputSchema)}`;
  }

  return defineTool({
    id: endpointTool.id,
    description,
    inputSchema: endpointTool.inputSchema,
    outputSchema: endpointTool.outputSchema,
    method: endpointTool.method,
    needsApproval:
      endpointTool.needsApproval ??
      (endpointTool.method === 'GET' ? false : true),
    execute: async (
      rawInput: z.infer<TInput>,
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

      const requestPath =
        endpointTool.method === 'GET' || endpointTool.method === 'DELETE'
          ? `${endpointPath}${buildQueryString(requestPayload)}`
          : endpointPath;

      const requestBody =
        endpointTool.method === 'GET' || endpointTool.method === 'DELETE'
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
        return {
          success: false,
          error: response.error ?? `Endpoint failed (${response.status})`,
        };
      }

      const responseData = isRecord(response.data)
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

      return {
        success: true,
        ...responseData,
        ...(uiAction ? { uiAction } : {}),
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
export function uiToolToTool<TInput extends z.ZodTypeAny>(
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
    execute: async (rawInput: z.infer<TInput>) => {
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

      const message = uiTool.successMessage
        ? (applyUiTemplateValue(uiTool.successMessage, inputPayload) as string) || 'Action executed.'
        : 'Action executed.';

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
  /** Zod schema for validating uiActions at runtime */
  uiActionSchema?: z.ZodTypeAny;
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
  const requiresApproval = !!needsApproval;

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
    execute: async (input: unknown) => {
      const startTime = Date.now();
      try {
        const result = await tool.execute(input, context);

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
        if (
          tool.outputSchema &&
          isRecord(result) &&
          (result as Record<string, unknown>).success !== false
        ) {
          const parsed = tool.outputSchema.safeParse(result);
          if (parsed.success) {
            // Use parsed data (extra fields stripped by Zod)
            const rec = result as Record<string, unknown>;
            cleanResult = {
              ...parsed.data as Record<string, unknown>,
              // Preserve success flag
              ...(rec.success !== undefined ? { success: rec.success } : {}),
              // Re-attach uiAction for client stream (stripped by schema parse)
              ...(rec.uiAction ? { uiAction: rec.uiAction } : {}),
            };
          } else {
            // Schema mismatch — warn but pass through unmodified
            console.warn(
              `[glirastes] Output schema mismatch for tool "${name}":`,
              parsed.error.issues.map(
                (i) => `${i.path.join('.')}: ${i.message}`,
              ),
            );
          }
        }

        // Truncate large arrays to prevent context overflow
        cleanResult = truncateToolResult(cleanResult);

        return options?.uiActionSchema
          ? normalizeResultUiAction(cleanResult, options.uiActionSchema)
          : cleanResult;
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
  }
  return fallback;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
  const text = await response.text();
  return text.length > 0 ? text : undefined;
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

  return async (request) => {
    const url = new URL(request.path, options.baseUrl).toString();
    const methodAllowsBody =
      request.method !== 'GET' && request.method !== 'DELETE';

    const headers: Record<string, string> = {
      ...(options.defaultHeaders ?? {}),
    };

    const init: RequestInit = { method: request.method, headers };

    if (methodAllowsBody && request.body !== undefined) {
      if (!headers['content-type']) {
        headers['content-type'] = 'application/json';
      }
      init.body = JSON.stringify(request.body);
    }

    const response = await fetchImpl(url, init);
    const data = await parseResponseBody(response);

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

// ============================================================================
// Re-exports
// ============================================================================

export { zodToCompactDescription } from './zod-compact.js';

// ============================================================================
// Followup Tool
// ============================================================================

export { createFollowupTool } from './followup-tool.js';

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
