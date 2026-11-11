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
import type { ApprovalStore } from './approval-binding.js';
import type { ClarificationConfig, InternalApiCaller, PlanningConfig } from '../../core/index.js';
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
   * Built-in task list (`update_plan`). The model records a short plan only
   * for requests with several distinct actions and updates its statuses as
   * it works; the chat UI shows the latest call as a checklist. The turn
   * continues after each call. Omit to keep the tool unavailable.
   */
  planning?: PlanningConfig;

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
   * The app's own input check. Runs before the pipeline or the intent router,
   * also with `pipeline` set; a refusal answers 400 without any model call.
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
   * Platform, e.g. `metrics` from `createGlirastes(...).chatTurn()` in
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
   * Direct chat commands (`/` commands and entity actions of the chat UI,
   * default `true`): a user message that is exactly one command marker runs
   * its tool without a model call, through the same registry, guard,
   * confirmation, audit, PII shield and metrics as a model turn. Routing,
   * guardrails and the model are skipped. `false` sends such a message to
   * the model like any other text.
   */
  directCommands?: boolean;

  /**
   * The caller endpoint tools of one chat request use. When absent, calls go
   * to the origin of the chat request's URL and carry only its cookie
   * (`createInternalApiCallerFromRequest`); `Host` and `x-forwarded-host` are
   * not read unless `trustForwardedHeaders` is set. An API on its own origin,
   * an app that cannot reach itself under its request URL, or one that
   * authenticates by `Authorization` header, passes
   * `(request) => createHttpEndpointCaller({ baseUrl, request })`.
   */
  endpointCaller?: (request: Request) => InternalApiCaller;

  /**
   * Let the default endpoint caller and `runtime.origin` take the origin from
   * `x-forwarded-host` / `x-forwarded-proto` (their last value, which the
   * proxy nearest to the app set). Default `false`.
   *
   * Set it only when every request reaches the app through a proxy that sets
   * or appends these headers. Anyone who can reach the app directly can put
   * any host there, including internal addresses, and endpoint tools then
   * send the user's cookie to it. A fixed `endpointCaller` with
   * `createHttpEndpointCaller({ baseUrl })` is safer. The cross-origin check
   * does not depend on this option.
   */
  trustForwardedHeaders?: boolean;

  /**
   * Secret that binds every approval the handler asks for to the tool call it
   * was asked for (HMAC-SHA-256 over tool call id, tool name, input, issue
   * time, expiry and the principal's scope). The browser sends the whole chat history back with the user's
   * answer, and the AI SDK runs the approved call from that history; without
   * the binding, a forged or replayed history would run any tool with any
   * input. At least 16 characters, the same on every instance that can serve
   * the second request of an approval. Falls back to the
   * `GLIRASTES_APPROVAL_SECRET` environment variable.
   *
   * Without a secret, a handler whose tools can ask for approval derives a
   * random per-process secret outside production and logs one warning; with
   * `NODE_ENV=production` it refuses requests with HTTP 500
   * (`approval_secret_missing`) instead. Approvals issued before an upgrade,
   * by another secret or by another process are refused, not run.
   */
  approvalSecret?: string;

  /**
   * How long an approval stays valid after the handler asked for it, in
   * milliseconds. Default 15 minutes. The expiry is signed into the approval
   * id; an answer after it, or after the issue time plus this handler's own
   * `approvalMaxAgeMs` if that is earlier, is refused with `approval_expired`.
   * Must be a whole number above 0 and at most 24 hours; anything else makes
   * `createAiChatHandler` throw a `RangeError`.
   */
  approvalMaxAgeMs?: number;

  /**
   * Single-use store for approvals. `consume(approvalId, expiresAtMs,
   * { scope })` must atomically record the id and return `false` when it was
   * recorded before; it receives the canonical id of a verified approval and
   * a quota scope. Single use is by id alone, across all scopes: an id
   * consumed under one scope must be refused under every other. The scope
   * only says whose quota the entry counts against: the managed principal's
   * scope, else the `approvalScope` value (both also signed into the id),
   * else a per-caller key `caller:<hmac>` derived from the request's
   * `Authorization` header, or its `Cookie` header without one (HMAC-SHA-256
   * under the approval secret; the raw credentials are never passed or kept),
   * else `''` for a request without credentials. Entries may be dropped after
   * `expiresAtMs`. A throw refuses the approval
   * (`approval_store_unavailable`). Only approvals the AI SDK can run in this
   * request are consumed.
   *
   * Default: a bounded store in this process's memory, shared by every
   * handler of the process (20,000 live approvals, at most 200 of them per
   * scope; when either is full, further approvals are refused, not run). An
   * entry, and the count of its scope, exists only for a genuine approval
   * that was consumed. It makes a single instance replay-safe.
   * Several instances that share `GLIRASTES_APPROVAL_SECRET` need a shared
   * store (e.g. Redis `SET key 1 NX PXAT expiresAtMs`): with the default, an
   * approved history replayed to another instance runs there once more,
   * within `approvalMaxAgeMs`.
   */
  approvalStore?: ApprovalStore;

  /**
   * Who an approval is for when the handler runs without a managed runtime
   * (with one, the managed principal's tenant and subject are used), e.g.
   * `(req) => session(req).userId`. The value is signed into every approval
   * id, so an approval issued to one user does not verify for another, and
   * it is the scope of the approval store's per-scope quota.
   *
   * Without it and without a managed runtime, approvals are not bound to a
   * user, and the store's quota is kept per caller, keyed by a hash of the
   * request's `Authorization` or `Cookie` header (requests without either
   * share one quota). That key is not signed into the approval id, because a
   * cookie may change between the approval request and its answer. Set this
   * option when the app identifies users another way, or to also bind each
   * approval to its user.
   */
  approvalScope?: (request: Request) => string | Promise<string>;

  /**
   * Origins, besides the request's own, whose pages may post to the handler
   * from a browser, e.g. `['https://admin.example.com']`. The request's own
   * origin is taken from `x-forwarded-host` / `x-forwarded-proto` (the first
   * value of each) when a proxy sets them. A browser request from a listed
   * origin passes also when the browser marks it `Sec-Fetch-Site:
   * same-site` or `cross-site`; `Origin: null` is never accepted.
   */
  allowedOrigins?: ReadonlyArray<string>;

  /**
   * Browser cross-origin protection, on by default. A page on another site
   * can make a browser post to the chat route with the user's cookie, so the
   * handler refuses (403) a request with `Sec-Fetch-Site` other than
   * `same-origin` / `none` unless its `Origin` is in `allowedOrigins`, or,
   * without that header, with an `Origin` that is neither its own nor in
   * `allowedOrigins`, and always `Origin: null`. Requests with neither header
   * (server to server) pass.
   *
   * `false` turns this off, and only an app whose chat route does not
   * authenticate by cookie may do so (a bearer token the page adds itself,
   * which a cross-origin page does not have). With cookie authentication it
   * re-opens cross-site request forgery: any page the user visits could send
   * chat turns, and run tools, as the user. The JSON content type check stays.
   */
  crossOriginProtection?: boolean;

  /**
   * Largest request body in bytes. Default 1,000,000. A larger body is
   * answered with 413 before it is parsed; the limit counts the bytes read,
   * not only the declared `Content-Length`.
   */
  maxBodyBytes?: number;

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
export type { ClarificationConfig, PlanningConfig };

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
