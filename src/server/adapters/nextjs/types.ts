import type { z } from 'zod';
import type {
  ToolContext,
  ToolRegistry,
  EndpointMethod,
  UiActionTemplate,
  UiPattern,
  ModelTier,
  AuditEmitter,
  AiPipeline,
  FollowupsConfig,
  PipelineResult,
  PiiShield,
  TelemetrySink,
  PromptOverride,
} from '../../../types.js';
import type { Lancer } from '../../lancer/index.js';
import type { InternalApiCaller } from '../../core/index.js';

// ============================================================================
// withAiTool - Route Wrapper Types
// ============================================================================

export interface WithAiToolOptions<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  toolName: string;
  id?: string;
  module?: string;
  sharedWith?: string[];
  description: string;
  method?: EndpointMethod;
  path?: string;
  inputSchema: TInput;
  needsApproval?: boolean;
  uiActionOnSuccess?: UiActionTemplate;
  uiPattern?: UiPattern;
}

export type AiToolRouteHandler = ((
  req: Request,
  context?: { params: Promise<Record<string, string>> },
) => Response | Promise<Response>) & {
  __aiToolMeta?: WithAiToolOptions;
};

// ============================================================================
// createAiChatHandler Types
// ============================================================================

export type LoadTools = (
  context: ToolContext & { callEndpoint: InternalApiCaller },
) => ToolRegistry | Promise<ToolRegistry>;

export interface GuardrailResult {
  ok: boolean;
  reason?: string;
  sanitizedMessages?: unknown[];
}

export type GuardrailHook = (
  messages: unknown[],
) => GuardrailResult | Promise<GuardrailResult>;

export interface IntentRoutingResult {
  toolNames?: string[];
  systemPromptAddition?: string;
  maxSteps?: number;
  contextWindow?: number;
  modelTier?: ModelTier;
  metadata?: Record<string, unknown>;
}

export type IntentRouter = (
  latestUserText: string,
  allToolNames: string[],
) => IntentRoutingResult | Promise<IntentRoutingResult>;

export type StepLimitSource = 'explicit' | 'module' | 'safety';

export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface PipelineStepReport {
  stepNumber: number;
  finishReason: string;
  toolCalls: string[];
  toolResults: number;
  requiresApproval: boolean;
  pendingApprovals: number;
  summary: string;
  usage: StepUsage;
  createdAt: string;
}

export type PipelineStreamStatus =
  | 'running'
  | 'completed'
  | 'safety-stop'
  | 'aborted'
  | 'error';

export interface PipelineStreamState {
  status: PipelineStreamStatus;
  totalSteps: number;
  finishReason?: string;
  maxSteps: number;
  stepLimitSource: StepLimitSource;
  updatedAt: string;
  message?: string;
}

export interface AiChatHandlerConfig {
  /**
   * Static tools (ToolRegistry). Used when pipeline mode is active.
   * Alternative to loadTools — when both are provided, `tools` takes precedence.
   */
  tools?: ToolRegistry;

  /**
   * Dynamic tool loader. Used in legacy mode (without pipeline).
   * When `tools` is provided, loadTools is ignored.
   */
  loadTools?: LoadTools;

  /**
   * AI Pipeline (Pro feature via glirastes/server).
   * When provided, replaces guardrails + intentRouter with the pipeline's
   * process() method. The pipeline handles intent classification, tool
   * selection, guardrails, and model selection.
   */
  pipeline?: AiPipeline;

  /**
   * Followups configuration. Pro feature — requires pipeline from glirastes/server.
   * Only used with pipeline mode.
   */
  followups?: FollowupsConfig;

  /**
   * Model or model-resolver. Optional when pipeline `ModelSelectorConfig`
   * entries include an `instance` field — the adapter falls back to
   * `pipelineResult.model.instance` automatically.
   */
  model?:
    | unknown
    | ((context: {
        routing?: IntentRoutingResult;
        pipelineResult?: PipelineResult;
      }) => unknown);
  systemPrompt:
    | string
    | ((context: {
        routing?: IntentRoutingResult;
        pipelineResult?: PipelineResult;
        currentDate: Date;
      }) => string);
  locale?: string;
  uiActionSchema?: z.ZodTypeAny;
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Explicit hard cap for reasoning steps.
   *
   * When omitted or null, `safetyMaxSteps` is used as a soft safety cap.
   */
  maxSteps?: number | null;
  /**
   * Safety cap used when no explicit/module maxSteps is defined.
   *
   * Defaults to 24 and is intended as a guard against runaway loops,
   * while users can still stop manually at any time.
   */
  safetyMaxSteps?: number;
  /**
   * Emit per-step reports as `data-step-report` stream parts.
   * Enabled by default.
   */
  emitStepReports?: boolean;
  maxContextMessages?: number;
  /**
   * Number of recent user/assistant text pairs to include as conversation
   * history for intent classification. Helps the classifier understand
   * follow-up messages. Defaults to 4.
   */
  maxConversationHistoryPairs?: number;

  /**
   * @deprecated Use `pipeline` instead. Ignored when `pipeline` is set.
   */
  guardrails?: GuardrailHook;

  /**
   * @deprecated Use `pipeline` instead. Ignored when `pipeline` is set.
   */
  intentRouter?: IntentRouter;

  /**
   * PII Shield instance for anonymization/pseudonymization.
   * When provided, user messages are anonymized before reaching the LLM,
   * tool-call arguments are re-hydrated, and responses are de-anonymized.
   */
  piiShield?: PiiShield;

  wrapHandler?: <T>(callback: () => T | Promise<T>, req: Request) => Promise<T>;
  onError?: (error: unknown, req: Request) => void;
  onToolError?: (toolId: string, error: unknown) => void;
  /**
   * Called after pipeline classification and tool scoping, before streaming.
   * Use this to log which intent, module, model, and tools were selected.
   */
  onPipelineResult?: (result: PipelineResult) => void;
  onStepReport?: (report: PipelineStepReport) => void;
  onFinish?: (event: {
    totalSteps: number;
    finishReason: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    wasTruncated: boolean;
    maxSteps: number;
    stepLimitSource: StepLimitSource;
  }) => void;

  /**
   * Unified audit event callback.
   * Receives all audit events from all SDK packages (server-core, server-pro,
   * lancer) as well as adapter-level session events.
   * Forward to your SIEM, logging backend, or compliance store.
   */
  onAudit?: AuditEmitter;

  /**
   * Remote telemetry sink for forwarding audit events to Glirastes.
   *
   * Pass `lancer.telemetry` to enable monitoring on the Glirastes dashboard
   * — works with both Free and Pro API keys. When combined with `pipeline`,
   * Pro-tier telemetry is handled by server-pro; this field additionally
   * forwards adapter-level session events.
   *
   * ```typescript
   * const lancer = createLancer({ apiKey: process.env.GLIRASTES_API_KEY! });
   * createAiChatHandler({ telemetry: lancer.telemetry, ... });
   * ```
   */
  telemetry?: TelemetrySink;

  /**
   * Lancer client for runtime prompt and model overrides (Pro feature).
   *
   * When provided, the adapter fetches prompt overrides from Glirastes
   * via `lancer.config.fetch(['prompts', 'models'])` and merges them with the
   * local system prompt and model selection based on the classified module.
   *
   * For model overrides to work, also provide `modelInstanceFactory`.
   *
   * ```typescript
   * const lancer = createLancer({ apiKey: process.env.GLIRASTES_API_KEY! });
   * createAiChatHandler({ lancer, pipeline, ... });
   * ```
   */
  lancer?: Lancer;

  /**
   * Default model IDs per tier as configured in the consumer app.
   * Reported to Glirastes on first request so the dashboard can display them.
   *
   * ```typescript
   * createAiChatHandler({
   *   modelDefaults: { fast: 'openai/gpt-4o-mini', standard: 'openai/gpt-4o', powerful: 'openai/gpt-4o' },
   *   ...
   * });
   * ```
   */
  modelDefaults?: Record<string, string>;

  /**
   * Factory that turns a modelId string (e.g. "anthropic/claude-sonnet-4")
   * into a ready-to-use LanguageModel instance.
   *
   * Required for Glirastes model overrides to take effect at runtime.
   * When a model override is configured on the Glirastes dashboard,
   * this factory creates the replacement model instance.
   *
   * ```typescript
   * const openrouter = createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey });
   * createAiChatHandler({ modelInstanceFactory: (id) => openrouter(id), ... });
   * ```
   */
  modelInstanceFactory?: (modelId: string) => unknown;
}

// Re-export for consumer convenience
export type { PromptOverride };

// Re-export pipeline types for consumer convenience
export type { AiPipeline, FollowupsConfig, PipelineResult };

// ============================================================================
// Server Action Helper Types
// ============================================================================

export interface ExecuteToolOptions {
  toolName: string;
  input: unknown;
  tools: ToolRegistry;
  locale?: string;
  uiActionSchema?: z.ZodTypeAny;
}

export interface ExecuteToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  uiAction?: Record<string, unknown>;
}
