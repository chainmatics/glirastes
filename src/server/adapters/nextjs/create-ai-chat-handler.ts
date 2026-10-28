import {
  toolsToAiTools,
  createFollowupTool,
  createClarificationTool,
} from '../../core/index.js';
import { CLARIFICATION_TOOL_NAME } from '../../../contracts/clarification.js';
import {
  applyClarificationResume,
  resolveClarificationResume,
} from './clarification-resume.js';
import { scopePipelineTools } from './scope-pipeline-tools.js';
import {
  pseudonymizeCommandToolInputs,
  resolveDirectCommand,
  runDirectCommand,
  stripChatCommandMessages,
} from './direct-command.js';
import type { ToolToAiToolOptions } from '../../core/index.js';
import type { Tool, ToolRegistry, ConversationMessage, PiiShield, PromptOverride } from '../../../types.js';
import { applyPromptOverride } from '../../../types.js';
import type { Lancer } from '../../lancer/index.js';
import {
  streamText,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from 'ai';
import type {
  AiChatHandlerConfig,
  IntentRoutingResult,
  PipelineStepReport,
  PipelineStreamState,
  PipelineResult,
  StepLimitSource,
} from './types.js';
import {
  buildToolContext,
  createInternalApiCallerFromRequest,
} from './context-helpers.js';
import { prepareModelMessages, wrapToolsForVercelAi } from './prepare-model-messages.js';
import { filterFallbackError } from './filter-fallback-error.js';
import { PrincipalSchema } from '../../../contracts/index.js';
import {
  createManagedTurnGuard,
  createRegistryToolDiscovery,
  createTurnMetricsRecorder,
  createTurnToolDiscovery,
  isToolRevoked,
  rawChunkCostUsd,
  resolveStepCost,
  RuntimePriceTableSchema,
  type BudgetEvaluation,
  type ManagedTurnGuard,
  type RuntimePriceTable,
  type TurnMetricsRecorder,
} from '../../../runtime/index.js';
import {
  createHybridToolDiscovery,
  NON_DOMAIN_TOOL_NAMES,
  type HybridToolDiscovery,
} from './tool-discovery.js';

/**
 * Callback that the consumer provides to stream the AI response.
 * Receives the prepared context and returns a Response.
 *
 * This decouples the adapter from the `ai` SDK — the consumer
 * calls streamText() themselves with full type safety.
 */
export interface StreamHandlerContext {
  /** AI tools (output of toolsToAiTools, RBAC-filtered) */
  tools: Record<string, unknown>;
  /** Processed messages (after guardrails, sliced to context window) */
  messages: unknown[];
  /** Resolved system prompt string */
  systemPrompt: string;
  /** Resolved model (static or from model selector) */
  model: unknown;
  /** Max steps (explicit/module/safety-resolved) */
  maxSteps: number;
  /** Source used to resolve maxSteps */
  stepLimitSource: StepLimitSource;
  /** Whether to emit `data-step-report` events */
  emitStepReports: boolean;
  /** Optional per-step callback */
  onStepReport?: (report: PipelineStepReport) => void;
  /** Max output tokens */
  maxOutputTokens: number;
  /** Temperature */
  temperature: number;
  /** Max context messages for model-message preparation */
  maxContextMessages: number;
  /** Model tier from intent routing or pipeline */
  modelTier?: string;
  /** Intent routing result (legacy mode) */
  routing?: IntentRoutingResult;
  /** Pipeline result (pipeline mode) */
  pipelineResult?: PipelineResult;
  /** PII shield context for response de-anonymization */
  piiShield?: { shield: PiiShield; sessionId: string };
  /** Pinned managed-local turn guard, present when managedRuntime is enabled. */
  managedTurn?: ManagedTurnGuard;
  /** Immutable turn-local controller for custom stream integrations. */
  toolDiscovery?: HybridToolDiscovery;
  /**
   * Identity set of SDK built-ins (`NON_DOMAIN_TOOL_NAMES`) whose tool
   * instance this handler created itself for the turn. Only these run outside
   * the managed guard; a registry- or manifest-supplied tool that merely
   * shares a built-in's name stays fully guarded (revocation, principal
   * re-authorization, budget).
   */
  handlerBuiltinToolNames?: ReadonlyArray<string>;
  /**
   * Content-free metrics of this turn when the handler has `metrics`. The
   * built-in stream handler reports every step and the outcome; a custom
   * stream handler reports through it (`recordStep`, `finish`) itself.
   */
  turnMetrics?: TurnMetricsRecorder;
  /** Price table configured on the handler (`modelPricing`). */
  modelPricing?: RuntimePriceTable;
}

/**
 * Extended config that adds an optional streamHandler for full AI SDK control.
 *
 * When `streamHandler` is not provided, a built-in default is used that:
 * - Converts UI messages to model messages via `prepareModelMessages()`
 * - Wraps SDK tools via `wrapToolsForVercelAi()`
 * - Calls `streamText()` and returns `createUIMessageStreamResponse()`
 */
export interface AiChatHandlerFullConfig extends AiChatHandlerConfig {
  /**
   * Custom stream handler. Receives prepared context, returns Response.
   * This is where the consumer calls streamText() / toDataStreamResponse().
   *
   * When omitted, the built-in default handler is used.
   */
  streamHandler?: (ctx: StreamHandlerContext) => Promise<Response>;
}

/**
 * Default soft cap on reasoning steps when no module-level or explicit
 * `maxSteps` is configured. Acts as a last-line safety against runaway
 * tool loops; not as a normal-operation cap (modules default to 4 via
 * EXECUTION_DEFAULTS). Override per request via `createAiChatHandler({
 * safetyMaxSteps })`.
 */
export const DEFAULT_SAFETY_MAX_STEPS = 24;

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

export function resolveStepLimit(options: {
  moduleMaxSteps?: number | null;
  configuredMaxSteps?: number | null;
  safetyMaxSteps?: number;
  runtimeBudgetMaxSteps?: number | null;
}): { maxSteps: number; stepLimitSource: StepLimitSource } {
  let resolved: { maxSteps: number; stepLimitSource: StepLimitSource };
  const moduleMaxSteps = asPositiveInt(options.moduleMaxSteps);
  if (moduleMaxSteps) {
    resolved = { maxSteps: moduleMaxSteps, stepLimitSource: 'module' };
  } else {
    const configuredMaxSteps = asPositiveInt(options.configuredMaxSteps);
    resolved = configuredMaxSteps
      ? { maxSteps: configuredMaxSteps, stepLimitSource: 'explicit' }
      : {
          maxSteps:
            asPositiveInt(options.safetyMaxSteps)
            ?? DEFAULT_SAFETY_MAX_STEPS,
          stepLimitSource: 'safety',
        };
  }

  const runtimeBudgetMaxSteps = asPositiveInt(
    options.runtimeBudgetMaxSteps,
  );
  return runtimeBudgetMaxSteps && runtimeBudgetMaxSteps < resolved.maxSteps
    ? {
        maxSteps: runtimeBudgetMaxSteps,
        stepLimitSource: 'runtime-budget',
      }
    : resolved;
}

export function resolveTurnTimeout(
  totalTimeoutMs: number | undefined,
): { totalMs: number } | undefined {
  if (totalTimeoutMs === undefined) return undefined;
  if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0) {
    throw new RangeError('totalTimeoutMs must be a positive finite number');
  }
  return { totalMs: totalTimeoutMs };
}

export function shouldStopManagedExecution(options: {
  stepCount: number;
  maxSteps: number;
  budgetState?: BudgetEvaluation['state'];
  /** Tool names called in the latest step; a clarification ends the turn. */
  lastStepToolNames?: ReadonlyArray<string>;
}): boolean {
  return options.stepCount >= options.maxSteps
    || options.budgetState === 'hard-limit'
    || (options.lastStepToolNames ?? []).includes(CLARIFICATION_TOOL_NAME);
}

/** Model id of a finished step; AI SDK 6 versions differ in where they put it. */
function stepModelId(event: unknown): string | null {
  const record = event as {
    model?: { modelId?: unknown };
    response?: { modelId?: unknown };
  };
  const modelId = record.model?.modelId ?? record.response?.modelId;
  return typeof modelId === 'string' ? modelId : null;
}

/**
 * Names of the tool calls of a step that failed: thrown errors and the
 * `{ error }` results SDK tools return. Only names leave this function.
 */
function failedToolNames(content: ReadonlyArray<unknown>): string[] {
  const names: string[] = [];
  for (const part of content) {
    const record = part as { type?: unknown; toolName?: unknown; output?: unknown };
    if (typeof record?.toolName !== 'string') continue;
    const output = record.output as { error?: unknown } | null | undefined;
    if (
      record.type === 'tool-error'
      || (
        record.type === 'tool-result'
        && typeof output === 'object'
        && output !== null
        && typeof output.error === 'string'
      )
    ) {
      names.push(record.toolName);
    }
  }
  return names;
}

/** Hands endpoint contract rejections to the turn's metrics, when the app reports metrics. */
function contractRejectionReporter(
  turnMetrics: TurnMetricsRecorder | undefined,
): { onContractRejected?: (rejection: { toolName: string; status: 400 | 422 }) => void } {
  return turnMetrics
    ? { onContractRejected: ({ toolName, status }) => { turnMetrics.recordToolContractRejected(toolName, status); } }
    : {};
}

function compactToolNames(toolCalls: Array<{ toolName: string }>): string[] {
  const unique = new Set<string>();
  for (const call of toolCalls) {
    if (typeof call.toolName === 'string' && call.toolName.length > 0) {
      unique.add(call.toolName);
    }
  }
  return Array.from(unique);
}

function shorten(text: string, maxLength = 120): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function buildStepSummary(args: {
  finishReason: string;
  text: string;
  toolNames: string[];
  toolCallCount: number;
  toolResultCount: number;
  requiresApproval: boolean;
}): string {
  if (args.requiresApproval) {
    if (args.toolNames.length > 0) {
      return `Awaiting approval: ${args.toolNames.join(', ')}`;
    }
    return 'Awaiting approval.';
  }

  if (args.toolCallCount > 0) {
    const label = args.toolNames.length > 0
      ? args.toolNames.join(', ')
      : `${args.toolCallCount} tool call(s)`;
    return `Executed tools: ${label}`;
  }

  if (args.text.trim().length > 0) {
    return shorten(args.text);
  }

  return `Finished step (${args.finishReason}).`;
}

function buildStepReport(step: {
  stepNumber: number;
  finishReason: string;
  toolCalls: Array<{ toolName: string }>;
  toolResults: unknown[];
  text: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}): PipelineStepReport {
  const toolNames = compactToolNames(step.toolCalls);
  const toolCallCount = step.toolCalls.length;
  const toolResultCount = step.toolResults.length;
  const pendingApprovals = Math.max(toolCallCount - toolResultCount, 0);
  const requiresApproval =
    step.finishReason === 'tool-calls' && pendingApprovals > 0;

  return {
    stepNumber: step.stepNumber,
    finishReason: step.finishReason,
    toolCalls: toolNames,
    toolResults: toolResultCount,
    requiresApproval,
    pendingApprovals,
    summary: buildStepSummary({
      finishReason: step.finishReason,
      text: step.text,
      toolNames,
      toolCallCount,
      toolResultCount,
      requiresApproval,
    }),
    usage: {
      inputTokens: step.usage.inputTokens ?? 0,
      outputTokens: step.usage.outputTokens ?? 0,
      totalTokens: step.usage.totalTokens ?? 0,
    },
    createdAt: new Date().toISOString(),
  };
}

function createPipelineState(options: {
  status: PipelineStreamState['status'];
  totalSteps: number;
  maxSteps: number;
  stepLimitSource: StepLimitSource;
  finishReason?: string;
  message?: string;
}): PipelineStreamState {
  return {
    status: options.status,
    totalSteps: options.totalSteps,
    finishReason: options.finishReason,
    maxSteps: options.maxSteps,
    stepLimitSource: options.stepLimitSource,
    message: options.message,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Built-in default stream handler.
 *
 * Converts UI messages → model messages, wraps tools, calls streamText,
 * and returns a UI message stream response.
 */
async function defaultStreamHandler(
  ctx: StreamHandlerContext,
  onFinish?: AiChatHandlerConfig['onFinish'],
  onStreamError?: (error: unknown) => void,
): Promise<Response> {
  // SDK built-ins the handler created itself are not manifest tools, so the
  // managed guard would deny them. Everything else stays guarded.
  const builtinNames = new Set(ctx.handlerBuiltinToolNames ?? []);
  const builtinTools: Record<string, unknown> = {};
  const domainTools: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(ctx.tools)) {
    (builtinNames.has(name) ? builtinTools : domainTools)[name] = tool;
  }
  const vercelTools = wrapToolsForVercelAi(
    domainTools,
    ctx.managedTurn
      ? {
          beforeToolCall: ctx.managedTurn.beforeToolCall,
          afterToolCall: ctx.managedTurn.afterToolCall,
          onToolError: ctx.managedTurn.onToolError,
          resolveApproval: ctx.managedTurn.resolveApproval,
          toolTimeoutMs: ctx.managedTurn.toolTimeoutMs,
        }
      : undefined,
  );
  if (Object.keys(builtinTools).length > 0) {
    Object.assign(vercelTools, wrapToolsForVercelAi(builtinTools));
  }
  const modelMessages = await prepareModelMessages(
    ctx.messages as UIMessage[],
    { maxContextMessages: ctx.maxContextMessages },
  );

  let wasTruncated = false;
  const shouldStop = (event: {
    steps: Array<{ toolCalls: Array<{ toolName: string }> }>;
  }) => shouldStopManagedExecution({
    stepCount: event.steps.length,
    maxSteps: ctx.maxSteps,
    budgetState: ctx.managedTurn?.tracker.evaluate().state,
    lastStepToolNames: event.steps.at(-1)?.toolCalls.map((call) => call.toolName),
  });

  const stream = createUIMessageStream({
    onError: () => 'AI request failed',
    execute: async ({ writer }) => {
      let totalSteps = 0;
      let finalStateWritten = false;
      let providerErrorReported = false;
      // Cost of the running model step, read from its raw stream chunks.
      let stepRawCostUsd: number | null = null;

      const writePipelineState = (
        state: PipelineStreamState,
        transient = false,
      ) => {
        writer.write({
          type: 'data-pipeline-state',
          data: state,
          transient,
        });
      };

      writePipelineState(
        createPipelineState({
          status: 'running',
          totalSteps: 0,
          maxSteps: ctx.maxSteps,
          stepLimitSource: ctx.stepLimitSource,
        }),
        true,
      );

      const result = streamText({
        model: ctx.model as Parameters<typeof streamText>[0]['model'],
        messages: modelMessages as NonNullable<Parameters<typeof streamText>[0]['messages']>,
        system: ctx.systemPrompt,
        tools: vercelTools as Parameters<typeof streamText>[0]['tools'],
        ...(ctx.toolDiscovery
          ? {
            activeTools: [...ctx.toolDiscovery.activeToolNames()],
            prepareStep: () => ({
              activeTools: [...ctx.toolDiscovery!.activeToolNames()],
            }),
          }
          : {}),
        maxOutputTokens: ctx.maxOutputTokens,
        temperature: ctx.temperature,
        timeout: resolveTurnTimeout(
          ctx.managedTurn?.snapshot.budget.totalTimeoutMs,
        ),
        stopWhen: shouldStop,
        // OpenRouter reports `usage.cost` only in the raw final chunk when the
        // OpenAI-compatible provider is used; the UI stream drops raw chunks.
        includeRawChunks: Boolean(ctx.managedTurn || ctx.turnMetrics),
        onChunk: ({ chunk }) => {
          if (chunk.type === 'raw') {
            stepRawCostUsd = rawChunkCostUsd(chunk.rawValue) ?? stepRawCostUsd;
            return;
          }
          ctx.turnMetrics?.markFirstChunk();
        },
        // AI SDK's default logs the complete provider error, including
        // request/response content. Only the local consumer owns diagnostics.
        onError: ({ error }) => {
          providerErrorReported = true;
          onStreamError?.(error);
        },
        onStepFinish: async (event) => {
          const inputTokens = event.usage.inputTokens ?? 0;
          const outputTokens = event.usage.outputTokens ?? 0;
          const model = stepModelId(event);
          const rawCostUsd = stepRawCostUsd;
          stepRawCostUsd = null;
          const cost = resolveStepCost({
            model,
            inputTokens,
            outputTokens,
            providerMetadata: event.providerMetadata,
            usageRaw: event.usage.raw,
            rawChunkCostUsd: rawCostUsd,
          }, ctx.modelPricing);
          // A known cost counts against maxEstimatedCostUsd; an unknown one
          // is never recorded as 0.
          await ctx.managedTurn?.afterModelStep({
            inputTokens,
            outputTokens,
            ...(cost.usd !== null ? { estimatedCostUsd: cost.usd } : {}),
          });
          ctx.turnMetrics?.recordStep({
            model,
            inputTokens,
            outputTokens,
            cost,
            toolNames: event.toolCalls.map((call) => call.toolName),
            failedToolNames: failedToolNames(event.content),
          });
          const report = buildStepReport({
            stepNumber: event.stepNumber,
            finishReason: event.finishReason,
            toolCalls: event.toolCalls.map((call) => ({
              toolName: call.toolName,
            })),
            toolResults: event.toolResults,
            text: event.text,
            usage: {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              totalTokens: event.usage.totalTokens,
            },
          });
          totalSteps = Math.max(totalSteps, report.stepNumber + 1);
          if (ctx.emitStepReports) {
            writer.write({
              type: 'data-step-report',
              data: report,
            });
          }
          ctx.onStepReport?.(report);
        },
        onAbort: (event) => {
          // The runtime time budget is the only abort source of this handler,
          // so an abort at the hard limit is a budget stop, not a user abort.
          const abortedByBudget =
            ctx.managedTurn?.tracker.evaluate().state === 'hard-limit';
          ctx.turnMetrics?.finish(
            abortedByBudget
              ? { status: 'safety-stop', errorCode: 'budget_exhausted' }
              : { status: 'aborted', errorCode: null },
          );
          if (finalStateWritten) return;
          totalSteps = Math.max(totalSteps, event.steps.length);
          writePipelineState(
            createPipelineState({
              status: 'aborted',
              totalSteps,
              finishReason: 'stop',
              maxSteps: ctx.maxSteps,
              stepLimitSource: ctx.stepLimitSource,
              message: 'Stopped by user.',
            }),
          );
          finalStateWritten = true;
        },
        onFinish: (event) => {
          const budgetEvaluation = ctx.managedTurn?.tracker.evaluate();
          const stoppedByBudget =
            budgetEvaluation?.state === 'hard-limit';
          wasTruncated =
            event.finishReason === 'tool-calls' &&
            (event.steps.length >= ctx.maxSteps || stoppedByBudget);
          totalSteps = Math.max(totalSteps, event.steps.length);

          const isSafetyStop =
            wasTruncated
            && (
              ctx.stepLimitSource === 'safety'
              || ctx.stepLimitSource === 'runtime-budget'
              || stoppedByBudget
            );
          const status: PipelineStreamState['status'] =
            isSafetyStop
                ? 'safety-stop'
                : event.finishReason === 'error'
                  ? 'error'
                  : 'completed';
          ctx.turnMetrics?.finish({
            status,
            errorCode: status === 'safety-stop'
              ? stoppedByBudget ? 'budget_exhausted' : 'step_limit'
              : status === 'error' ? 'model_error' : null,
          });

          if (!finalStateWritten) {
            writePipelineState(
              createPipelineState({
                status,
                totalSteps,
                finishReason: event.finishReason,
                maxSteps: ctx.maxSteps,
                stepLimitSource: ctx.stepLimitSource,
                message: stoppedByBudget
                  ? `Stopped at runtime budget: ${
                      budgetEvaluation.reasons.join(', ')
                    }.`
                  : wasTruncated
                    ? isSafetyStop
                      ? 'Paused at step safety cap. You can continue or stop.'
                      : 'Paused at configured step cap.'
                    : undefined,
              }),
            );
            finalStateWritten = true;
          }

          onFinish?.({
            totalSteps: event.steps.length,
            finishReason: event.finishReason,
            usage: {
              inputTokens: event.totalUsage.inputTokens ?? 0,
              outputTokens: event.totalUsage.outputTokens ?? 0,
              totalTokens: event.totalUsage.totalTokens ?? 0,
            },
            wasTruncated,
            maxSteps: ctx.maxSteps,
            stepLimitSource: ctx.stepLimitSource,
          });
        },
      });

      writer.merge(result.toUIMessageStream({ onError: () => 'AI request failed' }));
      try {
        await result.response;
      } catch (error) {
        ctx.turnMetrics?.finish({ status: 'error', errorCode: 'model_error' });
        if (finalStateWritten) return;
        writePipelineState(
          createPipelineState({
            status: 'error',
            totalSteps,
            finishReason: 'error',
            maxSteps: ctx.maxSteps,
            stepLimitSource: ctx.stepLimitSource,
            message: 'Pipeline failed.',
          }),
        );
        finalStateWritten = true;
        if (!providerErrorReported) throw error;
      }
    },
  });

  // Wrap the outer stream so the filter sees BOTH the inner result chunks AND
  // the error chunk that createUIMessageStream emits when execute() throws —
  // the latter is where the duplicate "No output generated" event comes from.
  return createUIMessageStreamResponse({ stream: filterFallbackError(stream) });
}

/**
 * Creates a complete Next.js App Router POST handler for AI chat.
 *
 * Supports two modes:
 *
 * **Pipeline mode** (Pro): When `pipeline` is provided, uses the server-pro
 * pipeline for guardrails, intent classification, tool selection, and model
 * selection.
 *
 * **Legacy mode**: When no `pipeline` is provided, uses the original
 * `guardrails` + `intentRouter` flow.
 *
 * The SDK does not perform authentication or authorization. Tools forward the
 * caller's cookies to backend APIs via `runtime.cookieHeader`; permission
 * checks happen on the backend.
 */
export function createAiChatHandler(config: AiChatHandlerFullConfig) {
  const {
    tools: staticTools,
    managedRuntime,
    pipeline,
    followups,
    clarification,

    loadTools,

    // PII Shield
    piiShield,

    // Audit & Telemetry
    onAudit,
    telemetry,

    // Lancer (Pro: runtime prompt + model overrides)
    lancer,
    modelDefaults,
    modelInstanceFactory,

    // Shared
    model: modelConfig,
    systemPrompt: systemPromptConfig,
    locale = 'en-US',
    uiActionSchema,
    maxOutputTokens = 600,
    temperature = 0.2,
    maxSteps: configuredMaxSteps,
    safetyMaxSteps = DEFAULT_SAFETY_MAX_STEPS,
    emitStepReports = true,
    maxContextMessages = 12,
    maxConversationHistoryPairs = 4,
    guardrails,
    intentRouter,
    wrapHandler,
    onError,
    onToolError,
    onPipelineResult,
    onStepReport,
    onFinish,
    streamHandler: customStreamHandler,
    toolDiscovery: enableToolDiscovery = false,
    toolSemantics,
    metrics,
    modelPricing: configuredModelPricing,
    directCommands = true,
    endpointCaller = createInternalApiCallerFromRequest,
  } = config;

  // The Proctor endpoint behind Lancer telemetry is not served by the
  // Foundation control plane and its audit payloads are not content-free;
  // the managed-local path reports through `metrics` instead.
  if (managedRuntime && telemetry) {
    throw new Error(
      'createAiChatHandler: telemetry (legacy Lancer) cannot be combined with '
      + 'managedRuntime; use metrics for content-free runtime metrics',
    );
  }
  const modelPricing = configuredModelPricing
    ? RuntimePriceTableSchema.parse(configuredModelPricing)
    : undefined;

  // Report model defaults to Glirastes (fire-and-forget, once)
  let defaultsReported = false;
  function reportDefaultsOnce() {
    if (defaultsReported || !lancer || !modelDefaults) return;
    defaultsReported = true;
    lancer.config.reportModels(modelDefaults).catch(() => {});
  }

  // Build stream handler factory — per-request to allow session.ended audit
  function createStreamHandler(req: Request, auditContext?: {
    sessionId: string;
    requestStart: number;
    modelId?: string;
  }) {
    const wrappedOnFinish: typeof onFinish = (event) => {
      onFinish?.(event);
      if (auditContext && (onAudit || telemetry)) {
        const sessionEndEvent = {
          type: 'session.ended' as const,
          timestamp: new Date().toISOString(),
          sessionId: auditContext.sessionId,
          source: 'adapter' as const,
          details: {
            totalSteps: event.totalSteps,
            totalTokens: event.usage.totalTokens,
            durationMs: Date.now() - auditContext.requestStart,
          },
        };
        onAudit?.(sessionEndEvent);
        try {
          telemetry?.emit({
            eventType: 'session.ended',
            traceId: auditContext.sessionId,
            tokensIn: event.usage.inputTokens,
            tokensOut: event.usage.outputTokens,
            latencyMs: Date.now() - auditContext.requestStart,
            modelId: auditContext.modelId,
            timestamp: new Date().toISOString(),
            payload: sessionEndEvent.details,
            actor: { sessionId: auditContext.sessionId },
          });
          void telemetry?.flush();
        } catch {
          // Telemetry is fire-and-forget
        }
      }
    };
    return customStreamHandler
      ? customStreamHandler
      : (ctx: StreamHandlerContext) => defaultStreamHandler(
          ctx, wrappedOnFinish, (error) => onError?.(error, req),
        );
  }

  if (!staticTools && !loadTools) {
    throw new Error(
      'createAiChatHandler: either tools or loadTools must be provided',
    );
  }

  const clarificationTool = clarification
    ? createClarificationTool(clarification)
    : null;
  const withClarification = (registry: ToolRegistry): ToolRegistry =>
    clarificationTool && !registry[CLARIFICATION_TOOL_NAME]
      ? { ...registry, [CLARIFICATION_TOOL_NAME]: clarificationTool }
      : registry;

  async function handler(req: Request): Promise<Response> {
    reportDefaultsOnce();
    let turnMetrics: TurnMetricsRecorder | undefined;
    try {
      const { messages: requestMessages, glirastesClientActions } = await req.json();

      if (!Array.isArray(requestMessages)) {
        return new Response(
          JSON.stringify({ error: 'messages must be an array' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // A direct command (`/` command or entity action) runs its tool without
      // the model; the model sees earlier commands only by their label.
      const directCommand = directCommands ? resolveDirectCommand(requestMessages) : undefined;

      // A clarification answer resumes its original request: routing sees
      // request + answer, the model sees an explicit continuation. The client
      // session keeps the untouched messages.
      const clarificationResume = directCommand ? undefined : resolveClarificationResume(requestMessages);
      const messages: unknown[] = directCommand
        ? requestMessages
        : stripChatCommandMessages(clarificationResume
          ? applyClarificationResume(requestMessages, clarificationResume)
          : requestMessages);

      // Build tool context
      const toolContext = buildToolContext(req, { locale });
      const clientActions = readClientActions(glirastesClientActions);
      if (clientActions) toolContext.runtime = { ...toolContext.runtime, clientActions };
      const requestStart = Date.now();
      const turnId = deriveSessionId(messages);

      let managedTurn: ManagedTurnGuard | undefined;
      if (managedRuntime) {
        const principalResult = PrincipalSchema.safeParse(
          await managedRuntime.resolvePrincipal(req),
        );
        if (!principalResult.success) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const snapshot = await managedRuntime.resolveTurnSnapshot({
          request: req,
          turnId,
          principal: principalResult.data,
        });
        if (
          snapshot.turnId !== turnId
          || snapshot.principal.subjectId !== principalResult.data.subjectId
          || snapshot.principal.tenantId !== principalResult.data.tenantId
        ) {
          return new Response(
            JSON.stringify({ error: 'Turn snapshot identity mismatch' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }

        managedTurn = createManagedTurnGuard({
          snapshot,
          resolvePrincipal: async () => {
            const current = PrincipalSchema.safeParse(
              await managedRuntime.resolvePrincipal(req),
            );
            return current.success ? current.data : undefined;
          },
          loadRevocations: managedRuntime.loadRevocations
            ? () => managedRuntime.loadRevocations!({ request: req, snapshot })
            : undefined,
          onBudgetSignal: managedRuntime.onBudgetSignal,
        });
      }

      turnMetrics = metrics
        ? createTurnMetricsRecorder({
            sink: metrics,
            snapshot: managedTurn?.snapshot,
            startedAtMs: requestStart,
          })
        : undefined;

      const buildDiscovery = async (
        registry: ToolRegistry,
        initialToolNames: ReadonlyArray<string>,
        handlerBuiltinNames: ReadonlyArray<string>,
      ): Promise<HybridToolDiscovery | undefined> => {
        if (!enableToolDiscovery) return undefined;
        // Handler-created SDK built-ins stay active next to the searchable
        // domain tools: clarification whenever configured, follow-ups when
        // this turn's pipeline selected them. Registry-supplied tools sharing
        // a built-in's name are never listed here and stay discoverable only
        // through the manifest-checked index.
        const builtinToolNames = handlerBuiltinNames.filter((name) =>
          name === CLARIFICATION_TOOL_NAME || initialToolNames.includes(name));
        if (!managedTurn) {
          return createHybridToolDiscovery({
            discovery: createRegistryToolDiscovery({
              turnId,
              registry,
              excludeNames: NON_DOMAIN_TOOL_NAMES,
              semantics: toolSemantics,
            }),
            initialToolNames,
            builtinToolNames,
          });
        }
        const revocations = managedRuntime?.loadRevocations
          ? await managedRuntime.loadRevocations({
            request: req,
            snapshot: managedTurn.snapshot,
          })
          : [];
        const revokedToolIds = managedTurn.snapshot.manifestRevision.tools
          .filter((tool) => isToolRevoked(
            managedTurn!.snapshot,
            tool.toolId,
            revocations,
          ))
          .map((tool) => tool.toolId);
        return createHybridToolDiscovery({
          discovery: createTurnToolDiscovery({
            snapshot: managedTurn.snapshot,
            registry,
            revokedToolIds,
            semantics: toolSemantics,
          }),
          initialToolNames,
          builtinToolNames,
        });
      };

      // Derive session ID — stable per conversation turn (groups approval flows)
      const sessionId = (onAudit || piiShield || telemetry) ? turnId : '';

      const toolOptions: ToolToAiToolOptions = {
        uiActionSchema,
        onError: onToolError,
        onAudit,
        sessionId,
        traceId: sessionId || undefined,
        telemetry,
      };

      // Emit session.started for audit + telemetry
      if (sessionId && (onAudit || telemetry)) {
        const sessionStartEvent = {
          type: 'session.started' as const,
          timestamp: new Date().toISOString(),
          sessionId,
          source: 'adapter' as const,
          details: { locale },
        };
        onAudit?.(sessionStartEvent);
        try {
          telemetry?.emit({
            eventType: 'session.started',
            traceId: sessionId,
            timestamp: new Date().toISOString(),
            payload: sessionStartEvent.details,
            actor: { sessionId },
          });
        } catch {
          // Telemetry is fire-and-forget
        }
      }

      // ================================================================
      // Direct command: no routing, no guardrails, no model call. The tool
      // runs on the registry and wrappers of a model turn, so authorization,
      // confirmation, revocation, budget, audit, the PII shield and metrics
      // stay the same.
      // ================================================================
      if (directCommand) {
        const callEndpoint = endpointCaller(req);
        const endpointToolContext = {
          ...toolContext,
          callEndpoint,
          ...(managedTurn
            ? { turnSnapshot: managedTurn.snapshot }
            : {}),
          ...contractRejectionReporter(turnMetrics),
        };
        const registry = staticTools ?? await loadTools!(endpointToolContext);
        let commandTools: Record<string, unknown> = toolsToAiTools(registry, endpointToolContext, toolOptions);
        // The result stays in the chat history that later model turns send to the model.
        if (piiShield) {
          commandTools = wrapToolsWithShield(commandTools, piiShield, sessionId);
        }
        if (lancer?.approvals) {
          commandTools = wrapToolsWithLancerApprovals(commandTools, lancer.approvals, sessionId);
        }
        return await runDirectCommand({
          command: directCommand,
          registry,
          tools: commandTools,
          managedTurn,
          turnMetrics,
          onError: (error) => onError?.(error, req),
        });
      }

      // ================================================================
      // Pipeline mode
      // ================================================================
      if (pipeline) {

        // Create callEndpoint for endpoint tools (needed regardless of static/dynamic)
        const callEndpoint = endpointCaller(req);
        const endpointToolContext = {
          ...toolContext,
          callEndpoint,
          ...(managedTurn
            ? { turnSnapshot: managedTurn.snapshot }
            : {}),
          ...contractRejectionReporter(turnMetrics),
        };

        // Get tools (static or dynamic)
        let registry: ToolRegistry;
        if (staticTools) {
          registry = staticTools;
        } else {
          registry = await loadTools!(endpointToolContext);
        }

        // Add followup tool if configured
        const followupTool = followups ? createFollowupTool(followups) : null;
        if (followupTool && !registry[followupTool.id]) {
          registry = { ...registry, [followupTool.id]: followupTool };
        }
        registry = withClarification(registry);
        const handlerBuiltinNames = findHandlerBuiltins(
          registry,
          [followupTool, clarificationTool],
        );

        // Extract user input for pipeline
        let userText = clarificationResume?.routingText
          ?? extractLastUserText(messages);
        if (piiShield) {
          userText = await piiShield.outbound(userText, sessionId);
        }

        // Build lightweight conversation history for intent classification.
        // Include the last few user/assistant text exchanges (excluding the
        // current message) so the classifier can understand follow-ups.
        const conversationHistory = extractConversationHistory(messages, maxConversationHistoryPairs);

        // Run pipeline: guardrails + classification + routing + model selection
        const pipelineResult = await pipeline.process(
          userText,
          toolContext,
          conversationHistory.length > 0 ? conversationHistory : undefined,
        );

        // Notify consumer about pipeline decision
        onPipelineResult?.(pipelineResult);

        // Emit pipeline-stage telemetry events for request trace
        if (telemetry && sessionId) {
          const pipelineActor = { sessionId };
          try {
            // Use explicit blocked flag from pipeline instead of heuristic
            const wardenBlocked = pipelineResult.blocked === true;
            telemetry.emit({
              eventType: wardenBlocked ? 'warden.block' : 'warden.pass',
              traceId: sessionId,
              timestamp: new Date().toISOString(),
              payload: { blocked: wardenBlocked, inputLength: userText.length },
              actor: pipelineActor,
            });
            // Primus classification
            telemetry.emit({
              eventType: 'primus.classify',
              traceId: sessionId,
              timestamp: new Date().toISOString(),
              payload: {
                moduleId: pipelineResult.intent.intent,
                confidence: pipelineResult.intent.confidence,
                module: pipelineResult.module?.id ?? null,
              },
              actor: pipelineActor,
            });
            // Tool routing
            telemetry.emit({
              eventType: 'pipeline.routing',
              traceId: sessionId,
              timestamp: new Date().toISOString(),
              payload: {
                toolCount: pipelineResult.tools.length,
                tools: pipelineResult.tools,
                module: pipelineResult.module?.id ?? null,
                modelId: pipelineResult.model.modelId,
              },
              actor: pipelineActor,
            });
          } catch {
            // Telemetry is fire-and-forget
          }
        }

        const hasExplicitSelection = pipelineResult.toolSelection === 'explicit';
        const initialToolNames = pipelineResult.blocked
          ? []
          : hasExplicitSelection || pipelineResult.tools.length > 0
          ? pipelineResult.tools
          : Object.keys(registry);
        const discoveryController = pipelineResult.blocked
          ? undefined
          : await buildDiscovery(registry, initialToolNames, handlerBuiltinNames);

        // Convert all tools to AI tools
        let aiTools = await toolsToAiTools(registry, endpointToolContext, toolOptions);
        const clarificationAiTool = aiTools[CLARIFICATION_TOOL_NAME];

        // Scope tools to pipeline selection
        if (pipelineResult.blocked) {
          // Guardrails blocked — no tools allowed
          aiTools = {};
        } else if (!discoveryController && (hasExplicitSelection || pipelineResult.tools.length > 0)) {
          aiTools = scopePipelineTools({
            aiTools,
            registryToolNames: new Set(Object.keys(registry)),
            selected: pipelineResult.tools,
            fallbackToAll: !hasExplicitSelection,
          });
          // Clarification stays callable, also for an empty focused selection.
          if (clarificationAiTool) {
            aiTools = { ...aiTools, [CLARIFICATION_TOOL_NAME]: clarificationAiTool };
          }
        }

        // Resolve model — config callback > pipeline instance > error
        let model: unknown;
        if (modelConfig) {
          model =
            typeof modelConfig === 'function'
              ? modelConfig({ pipelineResult })
              : modelConfig;
        } else if (pipelineResult.model.instance) {
          model = pipelineResult.model.instance;
        } else {
          turnMetrics?.finish({ status: 'error', errorCode: 'pipeline_error' });
          return new Response(
            JSON.stringify({
              error:
                'No model configured. Provide model on handler config or as instance on ModelSelectorConfig.',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Resolve system prompt
        let systemPrompt =
          typeof systemPromptConfig === 'function'
            ? systemPromptConfig({
                pipelineResult,
                currentDate: new Date(),
                ...(managedTurn ? { turnSnapshot: managedTurn.snapshot } : {}),
              })
            : systemPromptConfig;

        // Track the actual model ID used (may be overridden by Glirastes config)
        let resolvedModelId = pipelineResult.model.modelId;

        // Apply runtime prompt + model overrides from Glirastes (Pro feature)
        if (lancer) {
          try {
            const configResult = await lancer.config.fetch(['prompts', 'models']);

            // Prompt overrides
            if (pipelineResult.module) {
              const prompts = (configResult as { prompts?: PromptOverride[] }).prompts;
              if (prompts) {
                const override = prompts.find(
                  (p) => p.moduleId === pipelineResult.module!.id,
                );
                if (override) {
                  systemPrompt = applyPromptOverride(systemPrompt, override);
                }
              }
            }

            // Model overrides — resolve tier from pipeline, apply override if configured
            if (modelInstanceFactory) {
              const modelOverrides = (configResult as { models?: Record<string, string> }).models;
              if (modelOverrides) {
                const tier = pipelineResult.module?.executionDefaults?.modelTier ?? 'standard';
                const overrideModelId = modelOverrides[tier];
                if (overrideModelId) {
                  resolvedModelId = overrideModelId;
                  model = modelInstanceFactory(overrideModelId);
                }
              }
            }
          } catch {
            // Graceful degradation: use local prompt/model if Glirastes is unreachable
          }
        }

        const stepLimit = resolveStepLimit({
          moduleMaxSteps: pipelineResult.module?.executionDefaults?.maxSteps,
          configuredMaxSteps,
          safetyMaxSteps,
          runtimeBudgetMaxSteps:
            managedTurn?.snapshot.budget.maxModelSteps,
        });
        const contextWindow =
          pipelineResult.module?.executionDefaults?.contextWindow ??
          maxContextMessages;
        let recentMessages = messages.slice(-contextWindow);

        // PII Shield: anonymize message history + wrap tools
        if (piiShield) {
          recentMessages = await anonymizeMessages(recentMessages, piiShield, sessionId);
          aiTools = wrapToolsWithShield(aiTools, piiShield, sessionId) as typeof aiTools;
        }

        // Lancer Approvals: delegate approval decisions to Glirastes
        if (lancer?.approvals) {
          aiTools = wrapToolsWithLancerApprovals(aiTools, lancer.approvals, sessionId) as typeof aiTools;
        }

        const pipelineStreamHandler = createStreamHandler(req, (onAudit || telemetry) ? {
          sessionId,
          requestStart,
          modelId: resolvedModelId,
        } : undefined);

        return await pipelineStreamHandler({
          tools: discoveryController
            ? { ...aiTools, find_tools: discoveryController.tool }
            : aiTools as Record<string, unknown>,
          messages: recentMessages,
          systemPrompt,
          model,
          maxSteps: stepLimit.maxSteps,
          stepLimitSource: stepLimit.stepLimitSource,
          emitStepReports,
          onStepReport,
          maxOutputTokens,
          temperature,
          maxContextMessages,
          modelTier: pipelineResult.model.modelId,
          pipelineResult,
          piiShield: piiShield ? { shield: piiShield, sessionId } : undefined,
          managedTurn,
          turnMetrics,
          modelPricing,
          toolDiscovery: discoveryController,
          handlerBuiltinToolNames: discoveryController
            ? [...handlerBuiltinNames, 'find_tools']
            : handlerBuiltinNames,
        });
      }

      // ================================================================
      // Legacy mode (without pipeline)
      // ================================================================

      // Guardrails
      let processedMessages = messages;
      if (guardrails) {
        const check = await guardrails(messages);
        if (!check.ok) {
          return new Response(
            JSON.stringify({ error: check.reason ?? 'Invalid input' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (check.sanitizedMessages) {
          processedMessages = check.sanitizedMessages;
        }
      }

      // Create callEndpoint for endpoint tools (needed regardless of static/dynamic)
      const callEndpoint = endpointCaller(req);
      const endpointToolContext = {
        ...toolContext,
        callEndpoint,
        ...(managedTurn
          ? { turnSnapshot: managedTurn.snapshot }
          : {}),
        ...contractRejectionReporter(turnMetrics),
      };

      // Load tools
      let registry: ToolRegistry;
      if (staticTools) {
        registry = staticTools;
      } else {
        registry = await loadTools!(endpointToolContext);
      }
      registry = withClarification(registry);
      const handlerBuiltinNames = findHandlerBuiltins(registry, [clarificationTool]);
      const allToolNames = Object.keys(registry)
        .filter((name) => name !== CLARIFICATION_TOOL_NAME);

      // PII Shield: anonymize for legacy mode
      const legacySessionId = piiShield ? deriveSessionId(processedMessages) : '';
      if (piiShield) {
        const lastUserText = extractLastUserText(processedMessages);
        await piiShield.outbound(lastUserText, legacySessionId);
      }

      // Intent routing
      let routing: IntentRoutingResult | undefined;
      if (intentRouter) {
        const text = clarificationResume?.routingText
          ?? extractLastUserText(processedMessages);
        routing = await intentRouter(text, allToolNames);
      }

      // Convert to AI tools
      let aiTools = await toolsToAiTools(registry, endpointToolContext, toolOptions);

      // Scope tools by intent
      if (routing?.toolNames && routing.toolNames.length > 0) {
        const scoped: typeof aiTools = {};
        for (const name of routing.toolNames) {
          if (aiTools[name]) scoped[name] = aiTools[name];
        }
        if (Object.keys(scoped).length > 0) {
          aiTools = aiTools[CLARIFICATION_TOOL_NAME]
            ? { ...scoped, [CLARIFICATION_TOOL_NAME]: aiTools[CLARIFICATION_TOOL_NAME] }
            : scoped;
        }
      }

      const discoveryController = await buildDiscovery(
        registry,
        routing?.toolNames?.length ? routing.toolNames : allToolNames,
        handlerBuiltinNames,
      );
      if (discoveryController) {
        // Discovery needs the full eligible server-side set; `activeTools`
        // preserves the intent router's fast initial scope.
        aiTools = await toolsToAiTools(registry, endpointToolContext, toolOptions);
      }

      // Resolve model + system prompt (legacy mode — no pipeline fallback)
      if (!modelConfig) {
        turnMetrics?.finish({ status: 'error', errorCode: 'pipeline_error' });
        return new Response(
          JSON.stringify({
            error:
              'No model configured. In legacy mode (without pipeline), model is required.',
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const model =
        typeof modelConfig === 'function'
          ? modelConfig({ routing })
          : modelConfig;

      const systemPrompt =
        typeof systemPromptConfig === 'function'
          ? systemPromptConfig({
              routing,
              currentDate: new Date(),
              ...(managedTurn ? { turnSnapshot: managedTurn.snapshot } : {}),
            })
          : systemPromptConfig;

      const stepLimit = resolveStepLimit({
        configuredMaxSteps: routing?.maxSteps ?? configuredMaxSteps,
        safetyMaxSteps,
        runtimeBudgetMaxSteps:
          managedTurn?.snapshot.budget.maxModelSteps,
      });
      const contextWindow = routing?.contextWindow ?? maxContextMessages;
      let recentMessages = processedMessages.slice(-contextWindow);

      // PII Shield: anonymize message history + wrap tools (legacy mode)
      if (piiShield) {
        recentMessages = await anonymizeMessages(recentMessages, piiShield, legacySessionId);
        aiTools = wrapToolsWithShield(aiTools, piiShield, legacySessionId) as typeof aiTools;
      }

      // Lancer Approvals: delegate approval decisions to Glirastes (legacy mode)
      if (lancer?.approvals) {
        aiTools = wrapToolsWithLancerApprovals(aiTools, lancer.approvals, legacySessionId || sessionId) as typeof aiTools;
      }

      const legacyStreamHandler = createStreamHandler(req, (onAudit || telemetry) ? {
        sessionId: legacySessionId || sessionId,
        requestStart,
      } : undefined);

      // Delegate streaming to consumer's handler
      return await legacyStreamHandler({
        tools: discoveryController
          ? { ...aiTools, find_tools: discoveryController.tool }
          : aiTools as Record<string, unknown>,
        messages: recentMessages,
        systemPrompt,
        model,
        maxSteps: stepLimit.maxSteps,
        stepLimitSource: stepLimit.stepLimitSource,
        emitStepReports,
        onStepReport,
        maxOutputTokens,
        temperature,
        maxContextMessages,
        modelTier: routing?.modelTier,
        routing,
        piiShield: piiShield ? { shield: piiShield, sessionId: legacySessionId } : undefined,
        managedTurn,
        turnMetrics,
        modelPricing,
        toolDiscovery: discoveryController,
        handlerBuiltinToolNames: discoveryController
          ? [...handlerBuiltinNames, 'find_tools']
          : handlerBuiltinNames,
      });
    } catch (error) {
      turnMetrics?.finish({ status: 'error', errorCode: 'pipeline_error' });
      onError?.(error, req);
      return new Response(
        JSON.stringify({ error: 'AI request failed' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  if (wrapHandler) {
    return async (req: Request) => wrapHandler(() => handler(req), req);
  }

  return handler;
}

/**
 * SDK built-ins whose tool instance the handler itself put into the registry.
 * Instance identity decides, not the name: a registry- or manifest-supplied
 * tool that shares a built-in's name is never listed and stays fully guarded.
 */
function findHandlerBuiltins(
  registry: ToolRegistry,
  created: ReadonlyArray<Tool | null>,
): string[] {
  return NON_DOMAIN_TOOL_NAMES.filter((name) =>
    created.some((tool) => tool !== null && registry[name] === tool));
}

// ============================================================================
// PII Shield Helpers
// ============================================================================

function deriveSessionId(messages: unknown[]): string {
  // Use the last user message's ID — groups approval continuations (same
  // last user message) but separates distinct questions (new user message).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown> | undefined;
    if (msg?.role === 'user' && msg?.id && typeof msg.id === 'string') {
      return `ai-${msg.id}`;
    }
  }
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function anonymizeMessages(
  messages: unknown[],
  shield: PiiShield,
  sessionId: string,
): Promise<unknown[]> {
  const result: unknown[] = [];

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) {
      result.push(msg);
      continue;
    }

    const record = msg as Record<string, unknown>;

    // Only user messages carry text to anonymize; of the others, only the
    // arguments of a direct command's tool call are the user's own words.
    if (record.role !== 'user') {
      result.push(await pseudonymizeCommandToolInputs(record, shield, sessionId));
      continue;
    }

    // Anonymize string content
    if (typeof record.content === 'string') {
      const anonymized = await shield.outbound(record.content, sessionId);
      result.push({ ...record, content: anonymized });
      continue;
    }

    // Anonymize parts array
    if (Array.isArray(record.parts)) {
      const anonParts = await Promise.all(
        record.parts.map(async (part: unknown) => {
          if (
            typeof part === 'object' && part !== null &&
            (part as Record<string, unknown>).type === 'text'
          ) {
            const p = part as Record<string, unknown>;
            if (typeof p.text === 'string') {
              const anonymized = await shield.outbound(p.text as string, sessionId);
              return { ...p, text: anonymized };
            }
          }
          return part;
        }),
      );
      result.push({ ...record, parts: anonParts });
      continue;
    }

    result.push(msg);
  }

  return result;
}

interface SdkAiToolForShield {
  description: string;
  parameters: unknown;
  needsApproval?: unknown;
  execute: (...args: unknown[]) => unknown;
}

function wrapToolsWithShield(
  aiTools: Record<string, unknown>,
  shield: PiiShield,
  sessionId: string,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};

  for (const [name, raw] of Object.entries(aiTools)) {
    const sdkTool = raw as SdkAiToolForShield;
    const originalExecute = sdkTool.execute;

    wrapped[name] = {
      ...sdkTool,
      execute: async (...executeArgs: unknown[]) => {
        // Rehydrate args (first argument is the tool input).
        // Uses the async path for Lancer Aegis rehydration.
        // The sync rehydrateArgs is a legacy no-op kept for backward compat.
        let args = executeArgs[0];
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          if (shield.rehydrateArgsAsync) {
            args = await shield.rehydrateArgsAsync(
              args as Record<string, unknown>,
              sessionId,
            );
          } else {
            args = shield.rehydrateArgs(
              args as Record<string, unknown>,
              sessionId,
            );
          }
        }

        // Execute with real args
        const result = await (originalExecute as Function)(args, ...executeArgs.slice(1));

        // Anonymize result before LLM sees it
        return shield.anonymizeResult(result, sessionId);
      },
    };
  }

  return wrapped;
}

interface SdkAiToolForApprovals {
  _toolId?: string;
  description: string;
  parameters: unknown;
  needsApproval?: unknown;
  execute: (...args: unknown[]) => unknown;
}

/**
 * Wrap tool `needsApproval` with Lancer approval checks.
 *
 * When Lancer approvals are configured, each tool's approval decision is
 * delegated to Glirastes instead of relying on the local `needsApproval` flag.
 * If Lancer is unreachable, falls back to the existing local approval check.
 *
 * When a tool requires approval (Lancer returns `required: true`), the
 * requestId is stored so that `decide()` can be called when the user
 * approves and the tool's `execute` fires.
 */
function wrapToolsWithLancerApprovals(
  aiTools: Record<string, unknown>,
  approvals: NonNullable<import('../../lancer/index.js').Lancer['approvals']>,
  traceId?: string,
): Record<string, unknown> {
  // Map toolName → requestId for pending approvals (cleared after decide)
  const pendingRequestIds = new Map<string, string>();
  // Track tools that actually required approval (survives cross-request boundary via resolve fallback)
  const approvalRequired = new Set<string>();

  const wrapped: Record<string, unknown> = {};

  for (const [name, raw] of Object.entries(aiTools)) {
    const sdkTool = raw as SdkAiToolForApprovals;
    const originalNeedsApproval = sdkTool.needsApproval;
    const originalExecute = sdkTool.execute;

    // Respect local needsApproval: false — never delegate to Lancer for these tools
    if (originalNeedsApproval === false) {
      wrapped[name] = sdkTool;
      continue;
    }

    wrapped[name] = {
      ...sdkTool,

      // Override needsApproval with Lancer check
      needsApproval: async (input: unknown) => {
        try {
          const inputHash = approvals.hashInput(
            (input && typeof input === 'object' ? input : {}) as Record<string, unknown>,
          );
          const check = await approvals.check({
            toolId: sdkTool._toolId ?? name,
            inputHash,
            ...(traceId ? { traceId } : {}),
          });

          if (check.required) {
            // Store requestId for later decide() call
            if (check.requestId) {
              pendingRequestIds.set(name, check.requestId);
            }
            approvalRequired.add(name);
            return true;
          }

          // Lancer says no approval required (auto-approved or no matching flow)
          return false;
        } catch {
          // Graceful degradation: fall back to local needsApproval
          if (typeof originalNeedsApproval === 'function') {
            return originalNeedsApproval(input);
          }
          return originalNeedsApproval === true;
        }
      },

      // Wrap execute to call decide() when approved.
      // The requestId may be missing because needsApproval and execute run in
      // different HTTP requests (Vercel AI SDK approval flow), so the in-memory
      // pendingRequestIds map is recreated empty on the second request.
      // Fallback: resolve by toolId + inputHash via the /v1/approvals/resolve endpoint.
      execute: async (...executeArgs: unknown[]) => {
        const requestId = pendingRequestIds.get(name);
        const toolId = sdkTool._toolId ?? name;
        const decidedBy = 'unknown';

        if (requestId) {
          pendingRequestIds.delete(name);
          try {
            await approvals.decide(requestId, {
              decision: 'approved',
              decidedBy,
            });
          } catch {
            // Fire-and-forget: don't block tool execution if decide fails
          }
        } else if (approvalRequired.has(name)) {
          // Cross-request fallback: resolve pending approval by toolId + inputHash.
          // Only attempt when needsApproval previously returned true (the requestId
          // may be missing because needsApproval and execute run in different HTTP
          // requests, recreating the in-memory map).
          approvalRequired.delete(name);
          try {
            const input = executeArgs[0];
            const inputHash = approvals.hashInput(
              (input && typeof input === 'object' ? input : {}) as Record<string, unknown>,
            );
            await approvals.resolve({
              toolId,
              inputHash,
              decision: 'approved',
              decidedBy,
            });
          } catch {
            // Fire-and-forget: don't block tool execution if resolve fails
          }
        }
        return (originalExecute as Function)(...executeArgs);
      },
    };
  }

  return wrapped;
}

function extractLastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== 'object' || msg === null) continue;
    const record = msg as Record<string, unknown>;
    if (record.role !== 'user') continue;

    if (typeof record.content === 'string') return record.content;

    if (Array.isArray(record.parts)) {
      for (const part of record.parts) {
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, unknown>).type === 'text'
        ) {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === 'string') return text;
        }
      }
    }

    if (Array.isArray(record.content)) {
      for (const part of record.content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, unknown>).type === 'text'
        ) {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === 'string') return text;
        }
      }
    }
  }
  return '';
}

/**
 * Extract a lightweight conversation history from UIMessages for intent
 * classification. Returns the last `maxPairs` user/assistant text exchanges
 * EXCLUDING the current (latest) user message.
 *
 * Tool calls/results are stripped — only human-readable text is included
 * to keep the classification prompt small and fast.
 */
function extractConversationHistory(
  messages: unknown[],
  maxPairs: number,
): ConversationMessage[] {
  // Collect text from all messages except the last user message
  const textMessages: ConversationMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg !== 'object' || msg === null) continue;
    const record = msg as Record<string, unknown>;
    const role = record.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const text = extractTextFromMessage(record);
    if (!text.trim()) continue;

    textMessages.push({ role: role as 'user' | 'assistant', content: text });
  }

  // Remove the last user message (that's the current input, not history)
  if (textMessages.length > 0 && textMessages[textMessages.length - 1].role === 'user') {
    textMessages.pop();
  }

  // Return the last N messages (up to maxPairs * 2 for user+assistant pairs)
  return textMessages.slice(-(maxPairs * 2));
}

function extractTextFromMessage(msg: Record<string, unknown>): string {
  if (typeof msg.content === 'string') return msg.content;

  const parts = Array.isArray(msg.parts)
    ? msg.parts
    : Array.isArray(msg.content)
      ? msg.content
      : [];

  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === 'object' && part !== null) {
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string') {
        texts.push(p.text);
      }
    }
  }
  return texts.join(' ');
}

/**
 * The client actions the chat reported for the open page, or undefined when
 * the report is missing or malformed (then client-action tools run as before).
 */
function readClientActions(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 500) return undefined;
  if (!value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 200)) return undefined;
  return value as string[];
}
