import { toolsToAiTools, createFollowupTool } from '../../core/index.js';
import type { ToolToAiToolOptions } from '../../core/index.js';
import type { ToolRegistry, ConversationMessage, PiiShield, PromptOverride } from '../../../types.js';
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
 * `maxSteps` is configured. Lowered from 24 → 8 in 0.3.0: 24 was generous
 * enough that a runaway tool loop could burn meaningful token cost before
 * the cap kicked in. Override per request via `createAiChatHandler({
 * safetyMaxSteps })` if you legitimately need more headroom.
 */
export const DEFAULT_SAFETY_MAX_STEPS = 8;

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

export function resolveStepLimit(options: {
  moduleMaxSteps?: number | null;
  configuredMaxSteps?: number | null;
  safetyMaxSteps?: number;
}): { maxSteps: number; stepLimitSource: StepLimitSource } {
  const moduleMaxSteps = asPositiveInt(options.moduleMaxSteps);
  if (moduleMaxSteps) {
    return { maxSteps: moduleMaxSteps, stepLimitSource: 'module' };
  }

  const configuredMaxSteps = asPositiveInt(options.configuredMaxSteps);
  if (configuredMaxSteps) {
    return { maxSteps: configuredMaxSteps, stepLimitSource: 'explicit' };
  }

  return {
    maxSteps: asPositiveInt(options.safetyMaxSteps) ?? DEFAULT_SAFETY_MAX_STEPS,
    stepLimitSource: 'safety',
  };
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
): Promise<Response> {
  const vercelTools = wrapToolsForVercelAi(ctx.tools);
  const modelMessages = await prepareModelMessages(
    ctx.messages as UIMessage[],
    { maxContextMessages: ctx.maxContextMessages },
  );

  let wasTruncated = false;
  let stoppedByLoop = false;

  // Stop condition: step count OR consecutive identical tool calls (loop detection).
  const LOOP_REPEAT_THRESHOLD = 3;
  const shouldStop = (event: {
    steps: Array<{ toolCalls: Array<{ toolName: string }> }>;
  }) => {
    if (event.steps.length >= ctx.maxSteps) return true;

    if (event.steps.length >= LOOP_REPEAT_THRESHOLD) {
      const recent = event.steps.slice(-LOOP_REPEAT_THRESHOLD);
      const signatures = recent.map((s) =>
        s.toolCalls
          .map((c) => c.toolName)
          .sort()
          .join(','),
      );
      if (
        signatures[0].length > 0 &&
        signatures.every((sig) => sig === signatures[0])
      ) {
        stoppedByLoop = true;
        return true;
      }
    }
    return false;
  };

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      let totalSteps = 0;
      let finalStateWritten = false;

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
        maxOutputTokens: ctx.maxOutputTokens,
        temperature: ctx.temperature,
        stopWhen: shouldStop,
        onStepFinish: (event) => {
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
          wasTruncated =
            event.finishReason === 'tool-calls' &&
            (event.steps.length >= ctx.maxSteps || stoppedByLoop);
          totalSteps = Math.max(totalSteps, event.steps.length);

          const isSafetyStop = wasTruncated && ctx.stepLimitSource === 'safety' && !stoppedByLoop;
          const status: PipelineStreamState['status'] =
            stoppedByLoop
              ? 'safety-stop'
              : isSafetyStop
                ? 'safety-stop'
                : event.finishReason === 'error'
                  ? 'error'
                  : 'completed';

          if (!finalStateWritten) {
            writePipelineState(
              createPipelineState({
                status,
                totalSteps,
                finishReason: event.finishReason,
                maxSteps: ctx.maxSteps,
                stepLimitSource: ctx.stepLimitSource,
                message: stoppedByLoop
                  ? 'Stopped: repeated tool call loop detected.'
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

      writer.merge(result.toUIMessageStream());
      try {
        await result.response;
      } catch (error) {
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
        throw error;
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
    pipeline,
    followups,

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
  } = config;

  // Report model defaults to Glirastes (fire-and-forget, once)
  let defaultsReported = false;
  function reportDefaultsOnce() {
    if (defaultsReported || !lancer || !modelDefaults) return;
    defaultsReported = true;
    lancer.config.reportModels(modelDefaults).catch(() => {});
  }

  // Build stream handler factory — per-request to allow session.ended audit
  function createStreamHandler(auditContext?: {
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
      : (ctx: StreamHandlerContext) => defaultStreamHandler(ctx, wrappedOnFinish);
  }

  if (!staticTools && !loadTools) {
    throw new Error(
      'createAiChatHandler: either tools or loadTools must be provided',
    );
  }

  async function handler(req: Request): Promise<Response> {
    reportDefaultsOnce();
    try {
      const { messages } = await req.json();

      if (!Array.isArray(messages)) {
        return new Response(
          JSON.stringify({ error: 'messages must be an array' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Build tool context
      const toolContext = buildToolContext(req, { locale });
      const requestStart = Date.now();

      // Derive session ID — stable per conversation turn (groups approval flows)
      const sessionId = (onAudit || piiShield || telemetry) ? deriveSessionId(messages) : '';

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
      // Pipeline mode
      // ================================================================
      if (pipeline) {

        // Create callEndpoint for endpoint tools (needed regardless of static/dynamic)
        const callEndpoint = createInternalApiCallerFromRequest(req);
        const endpointToolContext = { ...toolContext, callEndpoint };

        // Get tools (static or dynamic)
        let registry: ToolRegistry;
        if (staticTools) {
          registry = staticTools;
        } else {
          registry = await loadTools!(endpointToolContext);
        }

        // Add followup tool if configured
        if (followups) {
          const followupTool = createFollowupTool(followups);
          if (followupTool) {
            registry = { ...registry, [followupTool.id]: followupTool };
          }
        }

        // Extract user input for pipeline
        let userText = extractLastUserText(messages);
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

        // Convert all tools to AI tools
        let aiTools = await toolsToAiTools(registry, endpointToolContext, toolOptions);

        // Scope tools to pipeline selection
        if (pipelineResult.blocked) {
          // Guardrails blocked — no tools allowed
          aiTools = {};
        } else if (pipelineResult.tools.length > 0) {
          const scoped: typeof aiTools = {};
          for (const name of pipelineResult.tools) {
            if (aiTools[name]) scoped[name] = aiTools[name];
          }
          if (Object.keys(scoped).length > 0) aiTools = scoped;
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

        const pipelineStreamHandler = createStreamHandler((onAudit || telemetry) ? {
          sessionId,
          requestStart,
          modelId: resolvedModelId,
        } : undefined);

        return pipelineStreamHandler({
          tools: aiTools as Record<string, unknown>,
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
      const callEndpoint = createInternalApiCallerFromRequest(req);
      const endpointToolContext = { ...toolContext, callEndpoint };

      // Load tools
      let registry: ToolRegistry;
      if (staticTools) {
        registry = staticTools;
      } else {
        registry = await loadTools!(endpointToolContext);
      }
      const allToolNames = Object.keys(registry);

      // PII Shield: anonymize for legacy mode
      const legacySessionId = piiShield ? deriveSessionId(processedMessages) : '';
      if (piiShield) {
        const lastUserText = extractLastUserText(processedMessages);
        await piiShield.outbound(lastUserText, legacySessionId);
      }

      // Intent routing
      let routing: IntentRoutingResult | undefined;
      if (intentRouter) {
        const text = extractLastUserText(processedMessages);
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
        if (Object.keys(scoped).length > 0) aiTools = scoped;
      }

      // Resolve model + system prompt (legacy mode — no pipeline fallback)
      if (!modelConfig) {
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
            })
          : systemPromptConfig;

      const stepLimit = resolveStepLimit({
        configuredMaxSteps: routing?.maxSteps ?? configuredMaxSteps,
        safetyMaxSteps,
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

      const legacyStreamHandler = createStreamHandler((onAudit || telemetry) ? {
        sessionId: legacySessionId || sessionId,
        requestStart,
      } : undefined);

      // Delegate streaming to consumer's handler
      return legacyStreamHandler({
        tools: aiTools as Record<string, unknown>,
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
      });
    } catch (error) {
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

    // Only anonymize user messages
    if (record.role !== 'user') {
      result.push(msg);
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
