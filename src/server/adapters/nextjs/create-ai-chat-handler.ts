import {
  toolsToAiTools,
  createFollowupTool,
  createClarificationTool,
  createPlanTool,
  assertMaxResultChars,
} from '../../core/index.js';
import { CLARIFICATION_TOOL_NAME } from '../../../contracts/clarification.js';
import { PLAN_TOOL_NAME } from '../../../contracts/plan.js';
import { MEMORY_FORGET_TOOL_NAME, MEMORY_REMEMBER_TOOL_NAME } from '../../../contracts/memory.js';
import { READ_RESULT_TOOL_NAME } from '../../../contracts/result-handle.js';
import { createChatMemory, type ChatMemoryTurn, type PreparedChatMemory } from './chat-memory.js';
import { clearWhenDone, createTurnResults, resolveResultHandles, type TurnResults } from './result-handles.js';
import type { ResultStore } from '../../core/index.js';

/** Handler-created built-ins that stay callable for every tool selection. */
const ALWAYS_ON_BUILTINS: ReadonlyArray<string> = [
  CLARIFICATION_TOOL_NAME,
  PLAN_TOOL_NAME,
  MEMORY_REMEMBER_TOOL_NAME,
  MEMORY_FORGET_TOOL_NAME,
  READ_RESULT_TOOL_NAME,
];
import {
  applyClarificationResume,
  resolveClarificationResume,
} from './clarification-resume.js';
import { scopePipelineTools } from './scope-pipeline-tools.js';
import {
  DEFAULT_ATTACHMENT_MAX_BODY_BYTES,
  checkRequestHeaders,
  readJsonBody,
  validateAttachments,
} from './request-guards.js';
import {
  ApprovalHistoryError,
  ApprovalSecretMissingError,
  approvalScope,
  assertApprovalMaxAge,
  assertUnambiguousToolHistory,
  bindApprovalRequests,
  createApprovalExecutionGate,
  defaultApprovalStore,
  enforceApprovalBindings,
  gateApprovalTools,
  resolveApprovalBinder,
  type ApprovalBinder,
  type VerifiedApproval,
} from './approval-binding.js';
import {
  pseudonymizeCommandToolInputs,
  resolveDirectCommand,
  runDirectCommand,
  stripChatCommandMessages,
} from './direct-command.js';
import { collectIdLabels, createHideIdsTransform, HIDE_IDS_PROMPT, type IdLabels } from './hide-ids.js';
import { createToolStreamErrorMask, streamErrorText } from './stream-error-text.js';
import {
  budgetStopText,
  resolveBudgetStopTexts,
  withStopNotice,
  type BudgetStopLimit,
  type BudgetStopTexts,
} from './budget-stop-notice.js';
import { finalSummaryInstruction } from '../../../runtime/tool-denial.js';
import type { BudgetLimitState } from '../../../runtime/budget.js';
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
  AiChatErrorInfo,
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
import {
  prepareModelMessages,
  wrapToolsForVercelAi,
  type HistoryOptions,
} from './prepare-model-messages.js';
import { filterFallbackError } from './filter-fallback-error.js';
import {
  isSilentTurn,
  resumesToolApprovals,
  silentTurnFallbackText,
  withSilentTurnFallback,
} from './silent-turn-fallback.js';
import { toolPresentationOf, type ToolPresentationPart } from './tool-presentation.js';
import {
  PrincipalSchema,
  type Principal,
  type SecurityRevocation,
} from '../../../contracts/index.js';
import { z } from 'zod';
import { authorizedTurnToolIds } from '../../../runtime/authorization.js';
import { modelFacingToolName } from '../../../runtime/local-tool-bindings.js';
import { withTurnPrincipal } from '../../../runtime/turn-snapshot.js';
import {
  createManagedTurnGuard,
  createRegistryToolDiscovery,
  createTurnMetricsRecorder,
  createTurnToolDiscovery,
  rawChunkCostUsd,
  resolveStepCost,
  RuntimePriceTableSchema,
  type BudgetEvaluation,
  type ManagedTurnGuard,
  type RuntimePriceTable,
  type TurnMetricsRecorder,
} from '../../../runtime/index.js';
import { toolResultFailure } from '../../../runtime/tool-failure.js';
import {
  createHybridToolDiscovery,
  NON_DOMAIN_TOOL_NAMES,
  type HybridToolDiscovery,
} from './tool-discovery.js';
import { defaultIntentRouterFor, previousTurnScope } from './default-intent-routing.js';

/**
 * Callback that the consumer provides to stream the AI response.
 * Receives the prepared context and returns a Response.
 *
 * This decouples the adapter from the `ai` SDK — the consumer
 * calls streamText() themselves with full type safety.
 */
export interface StreamHandlerContext {
  /** Cancellation from the browser/HTTP host. Custom stream handlers must honor it. */
  abortSignal?: AbortSignal;
  /** Locale of the chat, for texts the handler writes itself. */
  locale?: string;
  /** How earlier turns are sent to the model (see `AiChatHandlerConfig.history`). */
  history?: HistoryOptions | false;
  /**
   * Chat memory of this turn (see `AiChatHandlerConfig.memory`). A custom
   * stream handler sends `preamble` ahead of the messages, passes
   * `historyTokens` on as `history.maxTokens`, and calls `connect` with its
   * stream writer, awaiting `done()` before the stream closes.
   */
  memory?: PreparedChatMemory;
  /** Cache breakpoints and a stable tool order (see `AiChatHandlerConfig.promptCaching`). */
  promptCaching?: boolean;
  /** Keep technical ids out of answers (see `AiChatHandlerConfig.hideIds`). */
  hideIds?: boolean;
  /**
   * AI tools (output of toolsToAiTools, RBAC-filtered). Every tool that can
   * ask for approval carries the execution gate of this request: it executes
   * only for an approval the handler verified (exact tool call id, tool name
   * and input, once) or for a live call whose `needsApproval` answered false,
   * and refuses with `approval_not_verified` otherwise, also when the stream
   * handler builds its own AI SDK tools from these objects. The gate needs the
   * options the AI SDK passes (`toolCallId`): a stream handler that calls
   * `tools[name].execute(input)` itself, without them, is refused for every
   * tool that can ask for approval.
   */
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
   * Labels of the tools the principal of this managed turn may use (pinned
   * revisions, principal and revocations as of the start of the request). The
   * built-in stream handler sends it as a transient `data-tool-presentation`
   * part ahead of the answer.
   */
  toolPresentation?: ToolPresentationPart;
  /**
   * Set in a managed turn (unless `authorizedToolsOnly: false` without
   * `toolDiscovery`): the names in `tools` the principal may use right now,
   * that is the handler's built-ins plus the manifest tools the guard's
   * decision allows for a freshly resolved principal and freshly loaded
   * revocations. Only the built-ins when the principal cannot be resolved.
   * The built-in stream handler asks it before every model step and offers
   * no other tool; a custom one should intersect its `activeTools` with it.
   */
  authorizedToolNames?: () => Promise<ReadonlySet<string>>;
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
  /**
   * Binds the approval requests of a UI message stream to the tool calls
   * they announce. The built-in stream handler pipes its UI stream through
   * this. A custom stream handler that lets tools ask for approval must do
   * the same with the stream it returns; an approval it issues otherwise is
   * refused on the next request (`approval_not_issued`).
   */
  bindApprovalRequests?: <T extends { type: string }>(stream: ReadableStream<T>) => ReadableStream<T>;
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
   *
   * The handler ignores a client-set `providerExecuted` flag only on tools of
   * its own registry: for an approval-gated tool that a custom stream handler
   * adds itself, a client can set the flag on the approved part, and the
   * approval is then consumed without the call running.
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
 * Names of the tool calls of a step that failed (`'error'`: thrown errors
 * and the `{ error }` results SDK tools return) or ended in a failure the
 * app classified as expected (`'expected'`). Only names leave this function.
 */
function failedToolNames(
  content: ReadonlyArray<unknown>,
  kind: 'error' | 'expected' = 'error',
): string[] {
  const names: string[] = [];
  for (const part of content) {
    const record = part as { type?: unknown; toolName?: unknown; output?: unknown };
    if (typeof record?.toolName !== 'string') continue;
    const outcome = record.type === 'tool-error'
      ? 'error'
      : record.type === 'tool-result' ? toolResultFailure(record.output) : undefined;
    if (outcome === kind) names.push(record.toolName);
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

// Namespaces of providers with explicit breakpoints; other providers ignore
// them and cache a stable prefix on their own (OpenAI, Gemini, DeepSeek).
const CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
  openrouter: { cacheControl: { type: 'ephemeral' } },
} as const;

function mergeCacheBreakpoint(
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...providerOptions };
  for (const [provider, options] of Object.entries(CACHE_BREAKPOINT)) {
    const existing = merged[provider];
    merged[provider] = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      ...options,
    };
  }
  return merged;
}

/** System prompt (with the tools before it) and the newest message as cache breakpoints. */
export function withCacheBreakpoints(systemPrompt: string, messages: unknown[]): unknown[] {
  const marked = messages.map((message, index) => {
    if (index !== messages.length - 1) return message;
    const record = message as { providerOptions?: Record<string, unknown> };
    return { ...record, providerOptions: mergeCacheBreakpoint(record.providerOptions) };
  });
  return systemPrompt
    ? [{ role: 'system', content: systemPrompt, providerOptions: CACHE_BREAKPOINT }, ...marked]
    : marked;
}

/**
 * Providers serialize tools in object order. Active tools first, the rest
 * behind them, so tools discovered mid-turn append instead of shifting the
 * cached prefix.
 */
function orderToolsForCaching(
  tools: Record<string, unknown>,
  activeNames: ReadonlyArray<string>,
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const name of activeNames) if (name in tools) ordered[name] = tools[name];
  for (const [name, tool] of Object.entries(tools)) if (!(name in ordered)) ordered[name] = tool;
  return ordered;
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
  onStreamError?: (error: unknown, info?: AiChatErrorInfo) => void,
  budgetStopTexts: BudgetStopTexts = resolveBudgetStopTexts(ctx.locale, undefined),
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
  const orderedTools = ctx.toolDiscovery
    ? orderToolsForCaching(vercelTools, ctx.toolDiscovery.activeToolNames())
    : vercelTools;
  const promptCaching = ctx.promptCaching !== false;
  const hideIds = ctx.hideIds !== false;
  const systemPrompt = hideIds && ctx.systemPrompt
    ? `${ctx.systemPrompt}\n\n${HIDE_IDS_PROMPT}`
    : ctx.systemPrompt;
  const idLabels: IdLabels = new Map();
  if (hideIds) collectIdLabels(ctx.messages, idLabels);
  const preparedMessages = await prepareModelMessages(
    ctx.messages as UIMessage[],
    ctx.memory?.historyTokens
      // Chat memory decides what stays; counts no longer drop earlier turns.
      ? {
          maxContextMessages: Number.MAX_SAFE_INTEGER,
          history: ctx.history === false ? false : {
            ...ctx.history,
            maxTurns: Number.MAX_SAFE_INTEGER,
            maxTokens: ctx.memory.historyTokens,
          },
        }
      : { maxContextMessages: ctx.maxContextMessages, history: ctx.history },
  );
  // User role, not system: memory is background a user could have written.
  const modelMessages = ctx.memory?.preamble
    ? [{ role: 'user', content: ctx.memory.preamble }, ...preparedMessages]
    : preparedMessages;
  // Executed approvals are visible output for the stream and the metric alike.
  const resumedApprovals = resumesToolApprovals(modelMessages);
  const promptMessages = promptCaching
    ? withCacheBreakpoints(systemPrompt, modelMessages)
    : modelMessages;

  let wasTruncated = false;
  // At a tool limit of the runtime budget the turn blocks further tools and
  // gets one bounded final summary, so it still ends with an answer instead
  // of silence. `stepNumber` is the summary's step, `answered` whether it
  // said anything.
  let finalSummaryClaimed = false;
  let finalSummary: { budget: BudgetLimitState[]; stepNumber: number; answered: boolean } | null = null;
  // Set when the turn stops at a limit without a summary call: the handler
  // closes the answer with the notice of these limits.
  let stopLimits: BudgetStopLimit[] | null = null;
  const budgetExhausted = () =>
    ctx.managedTurn?.tracker.evaluate().state === 'hard-limit';
  const shouldStop = (event: {
    steps: Array<{ toolCalls: Array<{ toolName: string }> }>;
  }) => {
    const tracker = ctx.managedTurn?.tracker;
    const evaluation = tracker?.evaluate();
    const budgetState = evaluation?.state;
    const stepCount = event.steps.length;
    const atStepCap = stepCount >= ctx.maxSteps;
    // At the step cap no further step runs, so no summary is claimed.
    const summarize = budgetState === 'hard-limit' && !atStepCap && tracker!.claimFinalSummary();
    if (summarize) {
      finalSummaryClaimed = true;
      finalSummary = { budget: tracker!.limitStates(evaluation!.reasons), stepNumber: stepCount, answered: false };
    }
    const lastStepToolNames = event.steps.at(-1)?.toolCalls.map((call) => call.toolName);
    const stop = shouldStopManagedExecution({
      stepCount,
      maxSteps: ctx.maxSteps,
      budgetState: summarize ? undefined : budgetState,
      lastStepToolNames,
    });
    // A clarification ends the turn on purpose; it needs no notice.
    if (stop && !(lastStepToolNames ?? []).includes(CLARIFICATION_TOOL_NAME)) {
      stopLimits = budgetState === 'hard-limit'
        ? tracker!.limitStates(evaluation!.reasons)
        : atStepCap ? [{ dimension: 'maxSteps', limit: ctx.maxSteps }] : null;
    }
    return stop;
  };
  /**
   * The closing notice for the turn's last stream part, if it ends at a
   * limit without a final answer: stopped without a summary call, a summary
   * that failed or said nothing, or the turn's time limit.
   */
  const stopNotice = (terminal: 'finish' | 'error' | 'abort', hadText: boolean): string | undefined => {
    let limits: ReadonlyArray<BudgetStopLimit> | null = null;
    if (terminal === 'abort') {
      // Only the turn timeout aborts a request the browser did not cancel.
      const tracker = ctx.managedTurn?.tracker;
      if (!ctx.abortSignal?.aborted && tracker) {
        const evaluation = tracker.evaluate();
        limits = tracker.limitStates(evaluation.state === 'hard-limit' ? evaluation.reasons : ['totalTimeoutMs']);
      }
    } else if (stopLimits) {
      limits = stopLimits;
    } else if (finalSummary && !finalSummary.answered) {
      limits = finalSummary.budget;
    }
    return limits && limits.length > 0 ? budgetStopText(limits, budgetStopTexts, ctx.locale, hadText) : undefined;
  };

  let providerErrorReported = false;
  // Each failure reaches the app's callback once, even when the AI SDK hands
  // the same error to several of its error hooks. A throwing callback must
  // not break the stream.
  const reportedErrors = new Set<unknown>();
  // `failure` is the error as a hook received it; `error` what the app gets for it.
  const reportError = (failure: unknown, info?: AiChatErrorInfo, error: unknown = failure) => {
    if (reportedErrors.has(failure)) return;
    reportedErrors.add(failure);
    try {
      onStreamError?.(error, info);
    } catch {
      // The app's diagnostics failed; the turn goes on.
    }
  };
  // Failed tool calls pass the UI stream's error mask: the chat gets a fixed
  // text, the app's callback the cause (see createToolStreamErrorMask).
  const toolErrorMask = createToolStreamErrorMask();
  const maskToolStreamError = (error: unknown) => {
    const masked = toolErrorMask(error);
    if (masked.report) reportError(error, masked.report.info, masked.report.error);
    return masked.text;
  };
  const stream = createUIMessageStream({
    // Approval responses continue the last assistant message instead of appending
    // another snapshot with the same tool call IDs.
    originalMessages: ctx.messages as UIMessage[],
    // A turn can also fail outside the provider call, e.g. on a model object
    // from an unsupported AI SDK version. The client gets the generic text,
    // the app's error callback the cause.
    onError: (error) => {
      if (!providerErrorReported) {
        providerErrorReported = true;
        reportError(error);
      }
      return streamErrorText(error);
    },
    execute: async ({ writer }) => {
      let totalSteps = 0;
      let finalStateWritten = false;
      // Cost of the running model step, read from its raw stream chunks.
      let stepRawCostUsd: number | null = null;

      const memoryUpdates = ctx.memory?.connect((part) => {
        writer.write(part as Parameters<typeof writer.write>[0]);
      });

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

      // Ahead of the first chunk, so the UI can name a tool the moment it is called.
      const presentation = ctx.toolPresentation;
      if (presentation) {
        writer.write({ type: 'data-tool-presentation', data: presentation, transient: true });
      }

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
        abortSignal: ctx.abortSignal,
        model: ctx.model as Parameters<typeof streamText>[0]['model'],
        messages: promptMessages as NonNullable<Parameters<typeof streamText>[0]['messages']>,
        ...(promptCaching ? {} : { system: systemPrompt }),
        ...(hideIds ? { experimental_transform: createHideIdsTransform(idLabels) } : {}),
        tools: orderedTools as Parameters<typeof streamText>[0]['tools'],
        ...(ctx.toolDiscovery
          ? { activeTools: [...ctx.toolDiscovery.activeToolNames()] }
          : {}),
        prepareStep: async ({ messages }) => {
          if (budgetExhausted()) {
            // The summary call: no tools, and the instruction to close the
            // answer (for this call only; it is no part of the chat).
            return {
              activeTools: [],
              toolChoice: 'none' as const,
              ...(finalSummary
                ? { messages: [...messages, { role: 'user' as const, content: finalSummaryInstruction(finalSummary.budget) }] }
                : {}),
            };
          }
          // A role lost or a revocation loaded since the request started
          // takes the tool away from the next step, not only from its call.
          const permitted = await ctx.authorizedToolNames?.();
          const active = ctx.toolDiscovery
            ? [...ctx.toolDiscovery.activeToolNames()]
            : permitted ? Object.keys(orderedTools) : undefined;
          if (!active) return {};
          return { activeTools: permitted ? active.filter((name) => permitted.has(name)) : active };
        },
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
          reportError(error);
        },
        onStepFinish: async (event) => {
          if (finalSummary && event.stepNumber === finalSummary.stepNumber && event.text.trim() !== '') {
            finalSummary.answered = true;
          }
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
          // Distinguish request cancellation from a runtime budget stop.
          const budgetEvaluation = ctx.managedTurn?.tracker.evaluate();
          const abortedByBudget =
            !ctx.abortSignal?.aborted && budgetEvaluation?.state === 'hard-limit';
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
              message: abortedByBudget
                ? `Stopped at runtime budget: ${budgetEvaluation!.reasons.join(', ')}.`
                : 'Stopped by user.',
            }),
          );
          finalStateWritten = true;
        },
        onFinish: (event) => {
          const budgetEvaluation = ctx.managedTurn?.tracker.evaluate();
          const stoppedByBudget =
            budgetEvaluation?.state === 'hard-limit';
          wasTruncated = finalSummaryClaimed || (
            event.finishReason === 'tool-calls' &&
            (event.steps.length >= ctx.maxSteps || stoppedByBudget)
          );
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
          // The user gets the fallback text; the Platform sees the failure.
          const silent = status === 'completed'
            && !resumedApprovals
            && isSilentTurn(event.steps);
          ctx.turnMetrics?.finish({
            status: silent ? 'error' : status,
            errorCode: status === 'safety-stop'
              ? stoppedByBudget ? 'budget_exhausted' : 'step_limit'
              : status === 'error' || silent ? 'model_error' : null,
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
                    : silent
                      ? 'The model returned no answer.'
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
            expectedToolFailureCount: event.steps.reduce(
              (count, step) => count + failedToolNames(step.content, 'expected').length,
              0,
            ),
          });
        },
      });

      const answerStream = withStopNotice(result.toUIMessageStream({ onError: maskToolStreamError }), stopNotice);
      const uiStream = resumedApprovals
        ? answerStream
        : withSilentTurnFallback(answerStream, silentTurnFallbackText(ctx.locale));
      writer.merge(ctx.bindApprovalRequests ? ctx.bindApprovalRequests(uiStream) : uiStream);
      try {
        await result.response;
        await memoryUpdates?.done();
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
    planning,

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
    intentRouting = true,
    history,
    promptCaching,
    hideIds = true,
    wrapHandler,
    onError: onErrorConfig,
    onToolError,
    classifyToolFailure,
    maxResultChars,
    resultHandles,
    onPipelineResult,
    onStepReport,
    onFinish,
    streamHandler: customStreamHandler,
    toolDiscovery: enableToolDiscovery = false,
    authorizedToolsOnly = true,
    toolSemantics,
    metrics,
    modelPricing: configuredModelPricing,
    directCommands = true,
    trustForwardedHeaders = false,
    endpointCaller = (request: Request) => createInternalApiCallerFromRequest(request, { trustForwardedHeaders }),
    approvalSecret,
    approvalMaxAgeMs,
    approvalStore: configuredApprovalStore,
    approvalScope: approvalScopeOf,
    allowedOrigins,
    crossOriginProtection,
    maxBodyBytes: configuredMaxBodyBytes,
    attachments,
    memory: memoryConfig,
    budgetStopTexts: budgetStopTextsConfig,
  } = config;
  assertMaxResultChars(maxResultChars, 'createAiChatHandler');
  const budgetStopTexts = resolveBudgetStopTexts(locale, budgetStopTextsConfig);
  const resultHandleLimits = resolveResultHandles(resultHandles, 'createAiChatHandler');
  const chatMemory = memoryConfig ? createChatMemory(memoryConfig) : null;
  if (approvalMaxAgeMs !== undefined) assertApprovalMaxAge(approvalMaxAgeMs);
  if (attachments?.enabled && piiShield && attachments.allowWithPiiShield !== true) {
    throw new Error(
      'createAiChatHandler: attachments bypass the PII shield; set '
      + 'attachments.allowWithPiiShield: true to accept them next to piiShield',
    );
  }
  const maxBodyBytes = configuredMaxBodyBytes
    ?? (attachments?.enabled ? DEFAULT_ATTACHMENT_MAX_BODY_BYTES : undefined);
  // Without a callback a failed turn would only say "AI request failed" to
  // the user and nothing to the developer. Name only: provider errors can
  // carry request and response content.
  const onError = onErrorConfig ?? ((error: unknown, _req: Request, info?: AiChatErrorInfo) => {
    const name = error instanceof Error ? error.name : typeof error;
    const what = info?.source === 'tool-call' ? 'tool call' : 'turn';
    console.error(`[glirastes] AI chat ${what} failed (${name}). Pass onError to createAiChatHandler to see the cause.`);
  });

  // The Proctor endpoint behind Lancer telemetry is not served by the
  // Foundation control plane and its audit payloads are not content-free;
  // the managed-local path reports through `metrics` instead.
  if (managedRuntime && telemetry) {
    throw new Error(
      'createAiChatHandler: telemetry (legacy Lancer) cannot be combined with '
      + 'managedRuntime; use metrics for content-free runtime metrics',
    );
  }
  // Single use without configuration: one process's memory. Instances that
  // share a secret need a shared store to refuse a replay across instances.
  const approvalStore = configuredApprovalStore ?? defaultApprovalStore();
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
    return (ctx: StreamHandlerContext) => {
      const context = { ...ctx, abortSignal: req.signal };
      return customStreamHandler ? customStreamHandler(context) : defaultStreamHandler(
        context, wrappedOnFinish, (error, info) => (info ? onError?.(error, req, info) : onError?.(error, req)),
        budgetStopTexts,
      );
    };
  }

  if (!staticTools && !loadTools) {
    throw new Error(
      'createAiChatHandler: either tools or loadTools must be provided',
    );
  }

  const clarificationTool = clarification
    ? createClarificationTool(clarification)
    : null;
  const planTool = planning ? createPlanTool(planning) : null;
  const withAlwaysOnBuiltins = (registry: ToolRegistry): ToolRegistry => {
    let next = registry;
    for (const tool of [clarificationTool, planTool]) {
      if (tool && !next[tool.id]) next = { ...next, [tool.id]: tool };
    }
    return next;
  };
  /** Keeps the always-on built-ins of `source` next to a scoped selection. */
  const keepAlwaysOn = <T,>(scoped: Record<string, T>, source: Record<string, T>) => {
    const kept = { ...scoped };
    for (const name of ALWAYS_ON_BUILTINS) {
      if (source[name]) kept[name] = source[name];
    }
    return kept;
  };
  /**
   * Keeps the tools with an approval verified for this request next to a
   * scoped selection. An approval verified (and consumed) for this request
   * answers a call that an earlier request already routed. Routing for this
   * request must not drop that tool: the AI SDK runs approved calls from
   * `tools` (not `activeTools`) and drops an approved call whose tool is
   * missing without a tool result, which leaves the earlier call unanswered.
   * `source` is the unscoped set after `offeredTools`, so a tool the
   * principal may no longer use comes back as its stub and the guard ends
   * the call as a tool error. Only tools with a verified approval come back;
   * a new call to one of them still needs its own approval.
   */
  const keepApproved = <T,>(
    scoped: Record<string, T>,
    source: Record<string, T>,
    verified: ReadonlyArray<VerifiedApproval>,
  ) => {
    let kept = scoped;
    for (const { toolName } of verified) {
      const approvedTool = source[toolName];
      if (approvedTool && !kept[toolName]) kept = { ...kept, [toolName]: approvedTool };
    }
    return kept;
  };

  /**
   * The approval binder of a request, and the history with every approved
   * call that this server did not issue (or that is expired or used) denied.
   * Runs once the registry is known: whether tools can ask for approval
   * decides if a missing secret is an error.
   */
  /**
   * Who an approval of this request is for: the managed principal, else the
   * app's `approvalScope(req)` (encoded as a one-element JSON array, so it
   * cannot equal a managed scope), else `''`: the approval is then bound to
   * no user, and `storeScopeOf` keeps the quota per caller instead.
   */
  async function requestApprovalScope(req: Request, managedTurn: ManagedTurnGuard | undefined): Promise<string> {
    if (managedTurn) return approvalScope(managedTurn.snapshot.principal);
    if (!approvalScopeOf) return '';
    const scope = await approvalScopeOf(req);
    if (typeof scope !== 'string') throw new TypeError('approvalScope must return a string');
    return JSON.stringify([scope]);
  }

  /**
   * The scope the approval store counts a request's approvals under. With a
   * managed principal or `approvalScope`, the signed scope. Otherwise a key
   * per caller derived from the request's credentials (`Authorization`, else
   * `Cookie`), HMAC-ed with the approval secret and never kept raw, so one
   * caller with fixed credentials cannot use up everyone's quota (varying
   * them gives a fresh quota; only the store's global limit bounds that).
   * It only partitions the quota: it
   * is not signed into the approval id (a cookie may rotate between the
   * approval request and its answer), and single use is checked by the
   * approval id across all keys. A request without credentials has `''`.
   */
  function storeScopeOf(req: Request, scope: string, binder: ApprovalBinder): string {
    if (scope !== '') return scope;
    const credentials = req.headers.get('authorization') ?? req.headers.get('cookie');
    if (!credentials || !binder.callerQuotaKey) return '';
    return binder.callerQuotaKey(credentials);
  }

  async function secureApprovals(
    req: Request,
    registry: ToolRegistry,
    messages: unknown[],
    managedTurn: ManagedTurnGuard | undefined,
    scope: string,
  ): Promise<{ binder: ApprovalBinder; storeScope: string; messages: unknown[]; verified: VerifiedApproval[] }> {
    const binder = resolveApprovalBinder({
      secret: approvalSecret,
      maxAgeMs: approvalMaxAgeMs,
      scope,
      // The managed policy and Lancer approvals can ask for approval of a
      // tool that declares none.
      hasApprovalTools: Boolean(managedTurn)
        || Boolean(lancer?.approvals)
        || Object.values(registry).some((tool) => Boolean(tool.needsApproval)),
    });
    const storeScope = storeScopeOf(req, scope, binder);
    const checked = await enforceApprovalBindings(messages, {
      binder, store: approvalStore, scope: storeScope, localToolNames: new Set(Object.keys(registry)),
    });
    return { binder, storeScope, messages: checked.messages, verified: checked.verified };
  }

  /**
   * The tools handed to the stream handler, each one that can ask for
   * approval behind the execution gate of this request: it runs only for an
   * approval verified above (exact tool call id, tool name and input) or for
   * a live call whose `needsApproval` said no. A managed policy can ask for
   * approval of any domain tool, so with a managed turn every domain tool is
   * gated; the handler's own built-ins are not.
   */
  function gateTools<T extends Record<string, unknown>>(
    tools: T,
    verified: ReadonlyArray<VerifiedApproval>,
    managedTurn: ManagedTurnGuard | undefined,
    builtinNames: ReadonlyArray<string>,
  ): T {
    return gateApprovalTools(
      tools,
      createApprovalExecutionGate(verified),
      (name, tool) => Boolean(tool.needsApproval) || (Boolean(managedTurn) && !builtinNames.includes(name)),
    );
  }

  async function handler(req: Request): Promise<Response> {
    const refused = checkRequestHeaders(req, { allowedOrigins, crossOriginProtection });
    if (refused) return refused;
    reportDefaultsOnce();
    let turnMetrics: TurnMetricsRecorder | undefined;
    // The result handles of this turn; dropped when the turn ends.
    let turnResultStore: ResultStore | undefined;
    try {
      const body = await readJsonBody(req, maxBodyBytes);
      if (!body.ok) return body.response;
      const { messages: requestMessages, glirastesClientActions } = body.value as {
        messages?: unknown;
        glirastesClientActions?: unknown;
      };

      if (!Array.isArray(requestMessages)) {
        return new Response(
          JSON.stringify({ error: 'messages must be an array' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const attachmentRefusal = validateAttachments(requestMessages, attachments);
      if (attachmentRefusal) return attachmentRefusal;
      // A history the AI SDK could read in two ways (a tool call id in two
      // parts, a non-boolean approval answer) is refused before anything else.
      try {
        assertUnambiguousToolHistory(requestMessages);
      } catch (error) {
        if (error instanceof ApprovalHistoryError) return approvalHistoryRefusal(error);
        throw error;
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

      const memoryTurn: ChatMemoryTurn | undefined = chatMemory && !directCommand
        ? await chatMemory.begin(req, body.value)
        : undefined;
      const withMemoryTools = (registry: ToolRegistry): ToolRegistry => {
        let next = registry;
        for (const tool of memoryTurn?.tools ?? []) {
          if (!next[tool.id]) next = { ...next, [tool.id]: tool };
        }
        return next;
      };
      const prepareMemory = async (
        messages: unknown[],
        model: unknown,
        shieldSessionId: string,
      ): Promise<PreparedChatMemory | undefined> => {
        if (!memoryTurn) return undefined;
        const prepared = memoryTurn.prepare({
          messages,
          model,
          abortSignal: req.signal,
          ...(piiShield
            ? {
                anonymize: (text: string) => piiShield.outbound(text, shieldSessionId),
                restore: async (text: string) => (piiShield.inboundAsync
                  ? piiShield.inboundAsync(text, shieldSessionId)
                  : piiShield.inbound(text, shieldSessionId)),
              }
            : {}),
        });
        return piiShield && prepared.preamble
          ? { ...prepared, preamble: await piiShield.outbound(prepared.preamble, shieldSessionId) }
          : prepared;
      };

      // Build tool context
      const toolContext = buildToolContext(req, { locale, trustForwardedHeaders });
      const clientActions = readClientActions(glirastesClientActions);
      if (clientActions) toolContext.runtime = { ...toolContext.runtime, clientActions };
      const requestStart = Date.now();
      const turnId = deriveSessionId(messages);

      let managedTurn: ManagedTurnGuard | undefined;
      let managedPrincipal: Principal | undefined;
      /** The principal of this request, resolved again at every call (managed turns). */
      let resolveTurnPrincipal: (() => Promise<Principal | undefined>) | undefined;
      /** The manifest tool ids the guard would allow right now; empty when that cannot be decided. */
      let currentToolIds: () => Promise<ReadonlySet<string>> = async () => new Set();
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

        const resolvedSnapshot = await managedRuntime.resolveTurnSnapshot({
          request: req,
          turnId,
          principal: principalResult.data,
        });
        if (
          resolvedSnapshot.turnId !== turnId
          || resolvedSnapshot.principal.subjectId !== principalResult.data.subjectId
          || resolvedSnapshot.principal.tenantId !== principalResult.data.tenantId
        ) {
          return new Response(
            JSON.stringify({ error: 'Turn snapshot identity mismatch' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // The revisions stay pinned; what the turn offers and names follows
        // the principal of this request.
        const snapshot = withTurnPrincipal(resolvedSnapshot, principalResult.data);
        managedPrincipal = principalResult.data;

        const resolveCurrentPrincipal = async () => {
          const current = PrincipalSchema.safeParse(
            await managedRuntime.resolvePrincipal(req),
          );
          return current.success ? current.data : undefined;
        };
        resolveTurnPrincipal = resolveCurrentPrincipal;
        const loadCurrentRevocations = managedRuntime.loadRevocations
          ? () => managedRuntime.loadRevocations!({ request: req, snapshot })
          : undefined;
        managedTurn = createManagedTurnGuard({
          snapshot,
          resolvePrincipal: resolveCurrentPrincipal,
          loadRevocations: loadCurrentRevocations,
          onBudgetSignal: managedRuntime.onBudgetSignal,
        });
        // The same sources as the guard, asked again; fails closed.
        currentToolIds = async () => {
          try {
            return authorizedTurnToolIds({
              snapshot,
              principal: await resolveCurrentPrincipal(),
              revocations: await loadCurrentRevocations?.() ?? [],
            });
          } catch {
            return new Set();
          }
        };
      }

      turnMetrics = metrics
        ? createTurnMetricsRecorder({
            sink: metrics,
            snapshot: managedTurn?.snapshot,
            startedAtMs: requestStart,
          })
        : undefined;

      // Revocations as of the start of this request, loaded once for the tool
      // set, the discovery index and the presentation; every model step,
      // `find_tools` search and tool call loads them again.
      let turnRevocations: Promise<ReadonlyArray<SecurityRevocation>> | undefined;
      const loadTurnRevocations = () => {
        turnRevocations ??= Promise.resolve(managedTurn && managedRuntime?.loadRevocations
          ? managedRuntime.loadRevocations({ request: req, snapshot: managedTurn.snapshot })
          : []);
        return turnRevocations;
      };
      /** Registry keys are the model-safe encoding of the manifest names. */
      const manifestToolNames = (toolIds: ReadonlySet<string>) =>
        (managedTurn?.snapshot.manifestRevision.tools ?? [])
          .filter((tool) => toolIds.has(tool.toolId))
          .map((tool) => modelFacingToolName(tool.name));
      /**
       * What `offeredTools` decided at the start of the request, decided
       * again for the next model step or `find_tools` search with the
       * principal and revocations of that moment.
       */
      const currentToolNames = async (builtinNames: ReadonlyArray<string>) =>
        new Set([...builtinNames, ...manifestToolNames(await currentToolIds())]);
      /**
       * Whether a registry name belongs to what a managed turn offers: the
       * handler's own built-ins and the manifest tools this principal may
       * use, as of the start of this request. `undefined` when nothing is
       * left out (`authorizedToolsOnly: false`, unmanaged turns).
       */
      const offeredNameCheck = async (
        builtinNames: ReadonlyArray<string>,
      ): Promise<((name: string) => boolean) | undefined> => {
        if (!managedTurn || !authorizedToolsOnly) return undefined;
        const allowedNames = new Set(manifestToolNames(authorizedTurnToolIds({
          snapshot: managedTurn.snapshot,
          principal: managedPrincipal,
          revocations: await loadTurnRevocations(),
        })));
        return (name) => builtinNames.includes(name) || allowedNames.has(name);
      };
      /**
       * The tools a managed turn hands to the stream handler and the model:
       * the handler's own built-ins and the manifest tools this principal may
       * use (`authorizedTurnToolIds`, principal and revocations as of the
       * start of this request; `currentToolNames` narrows it per step).
       * Everything else in the registry would be denied by the guard and is
       * not named to the model at all.
       * `authorizedToolsOnly: false` and unmanaged turns keep every tool.
       *
       * The AI SDK drops an approved call whose tool is missing without a
       * tool result, which leaves the earlier tool call unanswered. So a
       * tool with an approval verified for this request stays in the set
       * even when the principal may no longer use it, as a stub: the
       * neutral description 'This tool is not available.' and an input
       * schema that accepts any object replace its own, so neither reaches
       * the model. The guard then ends the approved call as a tool error. Its name is in the history of this turn
       * already.
       */
      const offeredTools = async <T,>(
        aiTools: Record<string, T>,
        builtinNames: ReadonlyArray<string>,
        verified: ReadonlyArray<VerifiedApproval>,
      ): Promise<Record<string, T>> => {
        const isOffered = await offeredNameCheck(builtinNames);
        if (!isOffered) return aiTools;
        const offered: Record<string, T> = {};
        for (const [name, tool] of Object.entries(aiTools)) {
          if (isOffered(name)) {
            offered[name] = tool;
          } else if (verified.some((approval) => approval.toolName === name)) {
            offered[name] = {
              ...tool,
              description: 'This tool is not available.',
              parameters: z.object({}).passthrough(),
            };
          }
        }
        return offered;
      };
      /** Labels of the tools this principal may use in the managed turn. */
      const managedToolPresentation = async (): Promise<ToolPresentationPart | undefined> => {
        if (!managedTurn) return undefined;
        return toolPresentationOf(
          managedTurn.snapshot.manifestRevision,
          authorizedTurnToolIds({
            snapshot: managedTurn.snapshot,
            principal: managedPrincipal,
            revocations: await loadTurnRevocations(),
          }),
        ) ?? undefined;
      };

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
          ALWAYS_ON_BUILTINS.includes(name) || initialToolNames.includes(name));
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
        return createHybridToolDiscovery({
          discovery: createTurnToolDiscovery({
            snapshot: managedTurn.snapshot,
            registry,
            ...(managedPrincipal ? { principal: managedPrincipal } : {}),
            revocations: await loadTurnRevocations(),
            semantics: toolSemantics,
          }),
          initialToolNames,
          builtinToolNames,
          currentlyAuthorized: () => currentToolNames([]),
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
        ...(maxResultChars !== undefined ? { maxResultChars } : {}),
      };
      /**
       * The result handles and `read_result` of a model turn (not of a direct
       * command), sealed with the PII shield of `shieldSessionId()`. A
       * registry tool named `read_result` stays the app's tool, and the turn
       * then keeps no handles (an overview would point to a tool it cannot use).
       */
      const beginTurnResults = (registry: ToolRegistry, shieldSessionId: () => string): TurnResults | undefined => {
        if (!resultHandleLimits || registry[READ_RESULT_TOOL_NAME]) return undefined;
        const results = createTurnResults({
          limits: resultHandleLimits,
          ...(piiShield ? { seal: (value: unknown) => piiShield.anonymizeResult(value, shieldSessionId()) } : {}),
          ...(managedTurn && resolveTurnPrincipal ? { managedTurn, resolvePrincipal: resolveTurnPrincipal } : {}),
        });
        turnResultStore = results.store;
        return results;
      };
      /**
       * The registry name of the handler's own `read_result` instance (by
       * identity): its arguments are paths and ids and are never rehydrated.
       */
      const ownReadResult = (registry: ToolRegistry, results: TurnResults | undefined): string | undefined => (
        results && registry[READ_RESULT_TOOL_NAME] === results.tool ? READ_RESULT_TOOL_NAME : undefined
      );
      const withResultTool = (registry: ToolRegistry, results: TurnResults | undefined): ToolRegistry => (
        results ? { ...registry, [results.tool.id]: results.tool } : registry
      );

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
          ...(classifyToolFailure ? { classifyToolFailure } : {}),
        };
        const registry = staticTools ?? await loadTools!(endpointToolContext);
        const commandScope = await requestApprovalScope(req, managedTurn);
        const { binder: commandBinder, storeScope: commandStoreScope } = await secureApprovals(req, registry, [], managedTurn, commandScope);
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
          approvals: commandBinder,
          approvalStore,
          approvalScope: commandStoreScope,
          onError: (error) => onError?.(error, req),
        });
      }

      // ================================================================
      // Pipeline mode
      // ================================================================
      // The app's own input check runs first in both modes, without any model call.
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
          ...(classifyToolFailure ? { classifyToolFailure } : {}),
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
        const turnResults = beginTurnResults(registry, () => sessionId);
        const pipelineToolOptions: ToolToAiToolOptions = turnResults
          ? { ...toolOptions, resultStore: turnResults.store }
          : toolOptions;
        registry = withResultTool(withMemoryTools(withAlwaysOnBuiltins(registry)), turnResults);
        const handlerBuiltinNames = findHandlerBuiltins(
          registry,
          [followupTool, clarificationTool, planTool, ...(memoryTurn?.tools ?? []), turnResults?.tool ?? null],
        );
        const pipelineApprovals = await secureApprovals(req, registry, processedMessages, managedTurn, await requestApprovalScope(req, managedTurn));
        processedMessages = pipelineApprovals.messages;

        // Extract user input for pipeline
        let userText = clarificationResume?.routingText
          ?? extractLastUserText(processedMessages);
        if (piiShield) {
          userText = await piiShield.outbound(userText, sessionId);
        }

        // Build lightweight conversation history for intent classification.
        // Include the last few user/assistant text exchanges (excluding the
        // current message) so the classifier can understand follow-ups.
        const conversationHistory = extractConversationHistory(processedMessages, maxConversationHistoryPairs);

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
        let aiTools = await offeredTools(
          await toolsToAiTools(registry, endpointToolContext, pipelineToolOptions),
          handlerBuiltinNames,
          pipelineApprovals.verified,
        );
        const unscopedAiTools = aiTools;

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
          // Clarification and the plan stay callable, also for an empty
          // focused selection.
          aiTools = keepAlwaysOn(aiTools, unscopedAiTools);
        }
        // Routing for this request must not drop the tool of an approval
        // verified above (see `keepApproved`). A guardrail block keeps no
        // tools, so the approved call then ends as a tool error and is not run.
        if (!pipelineResult.blocked) {
          aiTools = keepApproved(aiTools, unscopedAiTools, pipelineApprovals.verified);
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
        const memory = await prepareMemory(processedMessages, model, sessionId);
        let recentMessages = memory?.messages ?? processedMessages.slice(-contextWindow);

        // PII Shield: anonymize message history + wrap tools
        if (piiShield) {
          recentMessages = await anonymizeMessages(recentMessages, piiShield, sessionId);
          aiTools = wrapToolsWithShield(aiTools, piiShield, sessionId, turnResults?.store, ownReadResult(registry, turnResults)) as typeof aiTools;
        }

        // Lancer Approvals: delegate approval decisions to Glirastes
        if (lancer?.approvals) {
          aiTools = wrapToolsWithLancerApprovals(aiTools, lancer.approvals, sessionId) as typeof aiTools;
        }
        aiTools = gateTools(aiTools, pipelineApprovals.verified, managedTurn, handlerBuiltinNames);

        const pipelineStreamHandler = createStreamHandler(req, (onAudit || telemetry) ? {
          sessionId,
          requestStart,
          modelId: resolvedModelId,
        } : undefined);

        return clearWhenDone(await pipelineStreamHandler({
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
        locale,
        history,
        memory,
        promptCaching,
        hideIds,
          modelTier: pipelineResult.model.modelId,
          pipelineResult,
          piiShield: piiShield ? { shield: piiShield, sessionId } : undefined,
          managedTurn,
          turnMetrics,
          modelPricing,
          toolDiscovery: discoveryController,
          toolPresentation: await managedToolPresentation(),
          ...(managedTurn && (authorizedToolsOnly || discoveryController)
            ? {
                authorizedToolNames: () => currentToolNames(discoveryController
                  ? [...handlerBuiltinNames, 'find_tools']
                  : handlerBuiltinNames),
              }
            : {}),
          handlerBuiltinToolNames: discoveryController
            ? [...handlerBuiltinNames, 'find_tools']
            : handlerBuiltinNames,
          bindApprovalRequests: (stream) => bindApprovalRequests(stream, pipelineApprovals.binder),
        }), turnResults?.store);
      }

      // ================================================================
      // Legacy mode (without pipeline)
      // ================================================================

      // Create callEndpoint for endpoint tools (needed regardless of static/dynamic)
      const callEndpoint = endpointCaller(req);
      const endpointToolContext = {
        ...toolContext,
        callEndpoint,
        ...(managedTurn
          ? { turnSnapshot: managedTurn.snapshot }
          : {}),
        ...contractRejectionReporter(turnMetrics),
        ...(classifyToolFailure ? { classifyToolFailure } : {}),
      };

      // Load tools
      let registry: ToolRegistry;
      if (staticTools) {
        registry = staticTools;
      } else {
        registry = await loadTools!(endpointToolContext);
      }
      // The shield session of the legacy path is derived below; results are sealed only once tools run.
      const turnResults = beginTurnResults(registry, () => legacySessionId);
      const legacyToolOptions: ToolToAiToolOptions = turnResults
        ? { ...toolOptions, resultStore: turnResults.store }
        : toolOptions;
      registry = withResultTool(withMemoryTools(withAlwaysOnBuiltins(registry)), turnResults);
      const handlerBuiltinNames = findHandlerBuiltins(
        registry,
        [clarificationTool, planTool, ...(memoryTurn?.tools ?? []), turnResults?.tool ?? null],
      );
      const legacyApprovals = await secureApprovals(req, registry, processedMessages, managedTurn, await requestApprovalScope(req, managedTurn));
      processedMessages = legacyApprovals.messages;
      // Routing sees what the model may see: a consumer router can hand the
      // names on to a model of its own, so a managed turn names only the
      // tools it offers (see `offeredTools`).
      const isOffered = await offeredNameCheck(handlerBuiltinNames);
      const routableRegistry: ToolRegistry = isOffered
        ? Object.fromEntries(Object.entries(registry).filter(([name]) => isOffered(name)))
        : registry;
      const allToolNames = Object.keys(routableRegistry)
        .filter((name) => !ALWAYS_ON_BUILTINS.includes(name));

      // PII Shield: anonymize for legacy mode
      const legacySessionId = piiShield ? deriveSessionId(processedMessages) : '';
      if (piiShield) {
        const lastUserText = extractLastUserText(processedMessages);
        await piiShield.outbound(lastUserText, legacySessionId);
      }

      // Intent routing
      let routing: IntentRoutingResult | undefined;
      let defaultStartToolNames: string[] | undefined;
      if (intentRouter) {
        const text = clarificationResume?.routingText
          ?? extractLastUserText(processedMessages);
        routing = await intentRouter(text, allToolNames);
      } else if (enableToolDiscovery && intentRouting !== false) {
        // Routing only picks the start set; discovery stays bounded by what
        // this principal may use and can always widen it.
        const manifest = managedTurn?.snapshot.manifestRevision;
        defaultStartToolNames = defaultIntentRouterFor({
          registry: routableRegistry,
          ...(manifest ? { manifest: { revisionId: manifest.revisionId, tools: manifest.tools } } : {}),
          semantics: toolSemantics,
          ...(typeof intentRouting === 'object' ? { options: intentRouting } : {}),
        }).route({
          text: clarificationResume?.routingText ?? extractLastUserText(processedMessages),
          previous: previousTurnScope(processedMessages),
        }).toolNames;
      }

      // Convert to AI tools
      const convertTools = async () => offeredTools(
        await toolsToAiTools(registry, endpointToolContext, legacyToolOptions),
        handlerBuiltinNames,
        legacyApprovals.verified,
      );
      let aiTools = await convertTools();

      // Scope tools by intent
      if (routing?.toolNames && routing.toolNames.length > 0) {
        const scoped: typeof aiTools = {};
        for (const name of routing.toolNames) {
          if (aiTools[name]) scoped[name] = aiTools[name];
        }
        if (Object.keys(scoped).length > 0) {
          // The router is not asked about the tool of an approval verified
          // above (it only gets the names this turn offers), and need not
          // select it for this request: it stays (see `keepApproved`).
          aiTools = keepApproved(keepAlwaysOn(scoped, aiTools), aiTools, legacyApprovals.verified);
        }
      }

      const discoveryController = await buildDiscovery(
        registry,
        routing?.toolNames?.length ? routing.toolNames : defaultStartToolNames ?? allToolNames,
        handlerBuiltinNames,
      );
      if (discoveryController) {
        // Discovery needs the full eligible server-side set; `activeTools`
        // preserves the intent router's fast initial scope.
        aiTools = await convertTools();
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
      const memory = await prepareMemory(processedMessages, model, legacySessionId);
      let recentMessages = memory?.messages ?? processedMessages.slice(-contextWindow);

      // PII Shield: anonymize message history + wrap tools (legacy mode)
      if (piiShield) {
        recentMessages = await anonymizeMessages(recentMessages, piiShield, legacySessionId);
        aiTools = wrapToolsWithShield(aiTools, piiShield, legacySessionId, turnResults?.store, ownReadResult(registry, turnResults)) as typeof aiTools;
      }

      // Lancer Approvals: delegate approval decisions to Glirastes (legacy mode)
      if (lancer?.approvals) {
        aiTools = wrapToolsWithLancerApprovals(aiTools, lancer.approvals, legacySessionId || sessionId) as typeof aiTools;
      }
      aiTools = gateTools(aiTools, legacyApprovals.verified, managedTurn, handlerBuiltinNames);

      const legacyStreamHandler = createStreamHandler(req, (onAudit || telemetry) ? {
        sessionId: legacySessionId || sessionId,
        requestStart,
      } : undefined);

      // Delegate streaming to consumer's handler
      return clearWhenDone(await legacyStreamHandler({
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
        locale,
        history,
        memory,
        promptCaching,
        hideIds,
        modelTier: routing?.modelTier,
        routing,
        piiShield: piiShield ? { shield: piiShield, sessionId: legacySessionId } : undefined,
        managedTurn,
        turnMetrics,
        modelPricing,
        toolDiscovery: discoveryController,
        toolPresentation: await managedToolPresentation(),
        ...(managedTurn && (authorizedToolsOnly || discoveryController)
          ? {
              authorizedToolNames: () => currentToolNames(discoveryController
                ? [...handlerBuiltinNames, 'find_tools']
                : handlerBuiltinNames),
            }
          : {}),
        handlerBuiltinToolNames: discoveryController
          ? [...handlerBuiltinNames, 'find_tools']
          : handlerBuiltinNames,
        bindApprovalRequests: (stream) => bindApprovalRequests(stream, legacyApprovals.binder),
      }), turnResults?.store);
    } catch (error) {
      turnResultStore?.clear();
      if (error instanceof ApprovalHistoryError) {
        turnMetrics?.finish({ status: 'error', errorCode: 'pipeline_error' });
        return approvalHistoryRefusal(error);
      }
      turnMetrics?.finish({ status: 'error', errorCode: 'pipeline_error' });
      onError?.(error, req);
      if (error instanceof ApprovalSecretMissingError) {
        return new Response(
          JSON.stringify({ error: error.code, message: error.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
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
  return `ai-${globalThis.crypto.randomUUID()}`;
}

function approvalHistoryRefusal(error: ApprovalHistoryError): Response {
  return new Response(
    JSON.stringify({ error: error.code, message: error.message }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
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

/**
 * Rehydrates tool arguments and pseudonymizes tool results. The arguments of
 * the handler's own `read_result` (`plainArgsTool`) are not rehydrated: its
 * answers are not shielded again, so a pseudonym passed as a path or id must
 * never be turned into the original there. A result the
 * turn's result store issued (an overview or a `read_result` answer) was cut
 * from the copy the store sealed once with this shield and is not shielded
 * again: detection depends on the surrounding text, so shielding excerpts
 * separately could leave a value raw in one of them, and a pseudonym that
 * looks like PII itself would be mapped again.
 */
function wrapToolsWithShield(
  aiTools: Record<string, unknown>,
  shield: PiiShield,
  sessionId: string,
  resultStore?: ResultStore,
  plainArgsTool?: string,
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
        if (name !== plainArgsTool && args && typeof args === 'object' && !Array.isArray(args)) {
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

        if (resultStore?.isIssued(result)) return result;
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
