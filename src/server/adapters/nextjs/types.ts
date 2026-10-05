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
  SchemaLike,
} from '../../../types.js';
import type { Lancer } from '../../lancer/index.js';
import type { ClarificationConfig, InternalApiCaller } from '../../core/index.js';
import type {
  Principal,
  SecurityRevocation,
} from '../../../contracts/index.js';
import type {
  ManagedTurnBudgetSignal,
  RuntimeMetricsSink,
  RuntimePriceTable,
  ToolSearchSemanticsMap,
  TurnSnapshot,
} from '../../../runtime/index.js';

// ============================================================================
// withAiTool - Route Wrapper Types
// ============================================================================

export interface WithAiToolOptions<TInput extends SchemaLike = SchemaLike> {
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
  context: ToolContext & {
    callEndpoint: InternalApiCaller;
    /** Immutable signed revision set pinned before dynamic tools are loaded. */
    turnSnapshot?: TurnSnapshot;
  },
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

export type StepLimitSource =
  | 'explicit'
  | 'module'
  | 'safety'
  | 'runtime-budget';

export interface ResolveTurnSnapshotContext {
  request: Request;
  turnId: string;
  principal: Principal;
}

export interface ManagedLocalRuntimeConfig {
  /**
   * Resolve identity exclusively from a verified server-side session.
   * Returning undefined fails closed before model or tool processing.
   */
  resolvePrincipal: (
    request: Request,
  ) => Principal | undefined | Promise<Principal | undefined>;

  /**
   * Return the immutable snapshot pinned for this turn. Approval
   * continuations must return the same snapshot for the same turnId.
   */
  resolveTurnSnapshot: (
    context: ResolveTurnSnapshotContext,
  ) => TurnSnapshot | Promise<TurnSnapshot>;

  /** Load current signed security revocations before every tool call. */
  loadRevocations?: (
    context: {
      request: Request;
      snapshot: TurnSnapshot;
    },
  ) => ReadonlyArray<SecurityRevocation> | Promise<ReadonlyArray<SecurityRevocation>>;

  /** Receives content-free local budget state transitions. */
  onBudgetSignal?: (
    signal: ManagedTurnBudgetSignal,
  ) => void | Promise<void>;
}

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
   * Managed-local runtime boundary. When configured, the handler verifies a
   * server principal, pins one turn snapshot, and guards every tool locally.
   */
  managedRuntime?: ManagedLocalRuntimeConfig;

  /**
   * Enable local `find_tools` recovery. With managedRuntime (managed or
   * standalone source) discovery is pinned to the turn snapshot and its
   * authorization; without it the per-request registry is the deployed,
   * app-authorized tool set. false preserves static scoping.
   */
  toolDiscovery?: boolean;

  /**
   * Search-only synonyms keyed by model-facing tool name (for example from
   * generated tool semantics). They improve `find_tools` ranking and never
   * make a tool eligible or reach the model.
   */
  toolSemantics?: ToolSearchSemanticsMap;

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
   * Built-in structured clarification (`ask_clarification`). The model asks
   * one targeted question inside its normal step (no extra planner call);
   * the turn ends after the question, and the UI's answer resumes the
   * original request. Omit to keep the tool unavailable.
   */
  clarification?: ClarificationConfig;

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
        /**
         * Revision set pinned for this turn. It lets a consumer assemble the
         * prompt against exactly the revisions the turn started with.
         */
        turnSnapshot?: TurnSnapshot;
      }) => string);
  locale?: string;
  uiActionSchema?: SchemaLike;
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
   * Legacy remote telemetry sink (Lancer, `/v1/proctor/events`).
   *
   * Not available with `managedRuntime`: the Foundation control plane does
   * not serve the Proctor endpoint and these audit payloads are not
   * content-free, so `createAiChatHandler` refuses the combination. Use
   * `metrics` there. Without `managedRuntime` the legacy behaviour is
   * unchanged:
   *
   * ```typescript
   * const lancer = createLancer({ apiKey: process.env.GLIRASTES_API_KEY! });
   * createAiChatHandler({ telemetry: lancer.telemetry, ... });
   * ```
   */
  telemetry?: TelemetrySink;

  /**
   * Content-free turn metrics (TechnicalRuntimeEvent v2) for the Glirastes
   * Platform, e.g. `createRuntimeMetricsSinkFromEnv()` from
   * `glirastes/runtime`. One event per turn (tokens, cost with provenance,
   * latency, outcome, tool ids); never prompts, messages, arguments, results
   * or secrets. Recording is synchronous and cheap, delivery happens later
   * off the turn, and a failing sink never blocks or fails a turn.
   */
  metrics?: RuntimeMetricsSink;

  /**
   * Prices for models whose provider reports no cost (`source:
   * 'price-table'`). A provider-reported cost (OpenRouter `usage.cost`)
   * always wins; without either a turn's cost stays unknown (`null`), never
   * 0. A known cost also counts against the turn's `maxEstimatedCostUsd`.
   */
  modelPricing?: RuntimePriceTable;

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
export type { ClarificationConfig };

// ============================================================================
// Server Action Helper Types
// ============================================================================

export interface ExecuteToolOptions {
  toolName: string;
  input: unknown;
  tools: ToolRegistry;
  locale?: string;
  uiActionSchema?: SchemaLike;
}

export interface ExecuteToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  uiAction?: Record<string, unknown>;
}
