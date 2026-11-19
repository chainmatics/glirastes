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
import type { ApprovalSubjectLimits } from './approval-subject-lookup.js';
import type { DefaultIntentRoutingOptions } from './default-intent-routing.js';
import type { HistoryOptions, ModelInputBreakdown } from './prepare-model-messages.js';
import type { ChatMemoryConfig } from './chat-memory.js';
import type { BudgetStopTexts } from './budget-stop-notice.js';
import type { StreamErrorTexts } from './stream-error-text.js';
import type { ChatServerLocales } from './chat-texts.js';
import type { UiActionOutcomesOption } from './ui-outcomes.js';
import type { UiToolResultShapeOption } from '../../core/index.js';
import type { ToolTextsMap } from '../../../runtime/tool-texts.js';
import type { ClarificationConfig, InternalApiCaller, PlanningConfig, ResultHandleLimits, ToolFailureClassifier } from '../../core/index.js';
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
   * continuations must return the same pinned revisions for the same turnId.
   * The handler uses the snapshot with the principal it resolved for the
   * request, so tool discovery, tool labels and the system prompt context
   * follow the roles and revocations as of the start of the request; the
   * tools offered per model step and `find_tools` follow the current ones.
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

/** What one model step receives (`AiChatHandlerConfig.onModelInput`). Carries content: local diagnostics only. */
export interface ModelInputEvent {
  /** The model step of the turn, from 0. */
  stepNumber: number;
  /** The messages of this step as the model gets them (with `promptCaching`, the system prompt is the first). */
  messages: unknown[];
  /** The system prompt, when it travels apart from the messages (`promptCaching: false`). */
  system?: string;
  /** What the history of the turn became; the same for every step of a turn. */
  breakdown: ModelInputBreakdown;
  /** Estimated tokens of `messages` and `system` (4 characters per token; tool definitions not counted). */
  estimatedTokens: number;
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

/** Where a failure passed to `AiChatHandlerConfig.onError` happened. */
export interface AiChatErrorInfo {
  /** One tool call failed inside a running turn; the turn may go on. */
  source: 'tool-call';
  /**
   * `denied`: the managed turn guard refused the call and the turn ends (a
   * `ToolExecutionDeniedError`, e.g. `budget_exhausted`). `invalid-input`:
   * the model's arguments do not match the tool's input schema; the error is
   * a `ToolInputValidationError` with field paths and expectations, never the
   * arguments. `failed`: anything else (a timeout, a thrown error).
   */
  kind: 'denied' | 'invalid-input' | 'failed';
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
   * With managedRuntime (default `true`): the model and the stream handler
   * get only the handler's built-ins and the manifest tools the principal
   * may use, by the decision of the tool-call guard (`authorizeTurnTool`)
   * on the pinned revisions: decided at the start of the request, and
   * again before every model step with a freshly resolved principal and
   * freshly loaded revocations. Name, description and input schema of any
   * other tool never reach the model. A legacy `intentRouter` and the
   * built-in start-set routing get the same names. `false` hands over
   * every registry tool, as before this option existed; the guard still
   * denies their calls. No effect without managedRuntime.
   *
   * NOT filtered, because it is server-side app data: `routing` and
   * `pipelineResult` (`model` and `systemPrompt` callbacks,
   * `onPipelineResult`, a custom `streamHandler`; they carry the tool names
   * of the app's own `pipeline` modules and router result), `turnSnapshot`
   * with the whole pinned manifest (`systemPrompt` callback, the endpoint
   * tool context of `loadTools` and of every tool's `execute`) and
   * `managedTurn.snapshot` (custom `streamHandler`). An app that forwards
   * any of it to a model names tools the principal may not use.
   */
  authorizedToolsOnly?: boolean;

  /**
   * Built-in start-set routing for `toolDiscovery` without `intentRouter`
   * (default on): modules derived from the tool metadata, the request
   * classified locally (German and English), the previous turn's tools kept
   * for follow-ups. A turn starts with a small set plus `find_tools` and
   * never with more than the principal may use. `false` starts every turn
   * with all eligible tools; an object tunes the start set.
   */
  intentRouting?: boolean | DefaultIntentRoutingOptions;

  /**
   * Search-only synonyms and example sentences keyed by model-facing tool
   * name (for example `toolSearchSemantics` of the generated module). They
   * rank `find_tools` and the default start set and never make a tool
   * eligible or reach the model. Replaces the map `chatTurn()` hands on;
   * it is not merged with it (to add your own, pass
   * `mergeToolSearchSemantics(turn.toolSemantics, own)` from `glirastes/runtime`).
   */
  toolSemantics?: ToolSearchSemanticsMap;

  /**
   * Labels per language keyed by model-facing tool name (`toolTexts` of the
   * generated module, written when tools.json names `languages`; `chatTurn()`
   * hands it on). With it, the `data-tool-presentation` part of a managed
   * turn words each tool in the turn's language (`requestLocale`, else an
   * explicitly set `locale`, else the language the chat UI sent, see
   * `clientLanguage`, else the manifest's locale as before): the
   * manifest presentation where it is in that language, else these labels
   * (the language, another region of it, English, the first one). Local
   * data; never sent to the Platform.
   */
  toolTexts?: ToolTextsMap;

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
  /**
   * Locale of the texts the handler writes itself, e.g. the budget stop
   * notice (German for `de*`, else English; default `en-US`). Not derived
   * from the chat or the model's answers: set it for a non-English chat.
   */
  locale?: string;
  /**
   * The language of one request, e.g. from a header the app's chat
   * transport sends (`x-app-language`), a cookie or the user's profile; a
   * BCP-47 tag (`pl-PL`). Opt-in: without it every turn uses `locale`.
   * It sets the turn's language for the handler's own texts (with
   * `locales`) and the tool labels (with `toolTexts`). Must not read the
   * body; a value that is no language tag, or a throw, falls back to `locale`.
   */
  requestLocale?: (request: Request) => string | undefined | Promise<string | undefined>;
  /**
   * The language the chat UI sends with each request (the React/Vercel
   * transport and `<glirastes-chat>`: the `Content-Language` header, one
   * BCP-47 tag; anything else is ignored). Default true: without
   * `requestLocale` and without an explicit `locale` it is the turn's
   * language (handler texts with `locales`, tool labels with `toolTexts`).
   * Order: `requestLocale` > `locale` > this > the manifest's locale.
   * `false` ignores it (the turn language of before).
   */
  clientLanguage?: boolean;
  /**
   * The handler's own texts per BCP-47 language tag, to add a language
   * (`pl`) or change single texts of one: the keys of `budgetStopTexts` plus
   * `silentTurn` (the answer of a turn that produced nothing). Partial tables
   * fall back per key: the language, another region of it, the built-in
   * German or English texts, English. `budgetStopTexts` stays language-free
   * and wins for every language. An unknown key, an empty text or a key
   * that is no language tag throws.
   */
  locales?: ChatServerLocales;
  /**
   * Texts of the closing notice the built-in stream handler appends when it
   * stops a turn at a limit (step cap or runtime budget) without a final
   * answer of the model. Keys: `closing` and `closingWithoutAnswer` (with `{reason}`), and per reason
   * (`maxSteps`, `maxModelSteps`, `maxToolCalls`, `totalTimeoutMs`,
   * `maxInputTokens`, `maxOutputTokens`, `maxEstimatedCostUsd`,
   * `maxRepeatedFingerprint`, `maxConsecutiveErrors`) a text with `{limit}`.
   * Given keys replace the defaults of `locale` (German for `de*`, else
   * English); an unknown key or an empty text throws.
   */
  budgetStopTexts?: Partial<BudgetStopTexts>;
  /**
   * The fixed texts the chat shows for a failed turn or tool call: `generic`
   * (any failure the SDK does not name itself; default `AI request failed`,
   * German `KI-Anfrage fehlgeschlagen`) and `invalidToolInput` (a tool call
   * with arguments that do not match the schema). Given keys replace the
   * defaults of the turn language (German for `de*`, else English); an
   * unknown key or an empty text throws. The 500 JSON body before streaming
   * stays English.
   */
  streamErrorTexts?: Partial<StreamErrorTexts>;
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
   * How earlier turns reach the model (default on): the current turn
   * complete, the previous turn with compacted tool results (long strings
   * cut, arrays to their first `maxItems` entries plus a count; the largest
   * array's further entries reduced to their identity fields such as `id`
   * and `name` under a `_history` marker unless `keepIdentity: false`),
   * older turns as text only, at most `maxTurns` (6) within `maxTokens`
   * (4000, estimated). `false` keeps the flat slice-and-prune of earlier versions.
   * Defaults since 0.18.0: `toolTurnCounting: 'tool-turns'` counts only
   * turns with tool calls against `toolTurns` (`'all-turns'` is the way
   * back); `seenObjects` (on, `false` is the way back) adds a memo of
   * declared records whose results left the history, nothing for an app
   * without declarations (see `HistoryOptions`).
   */
  history?: HistoryOptions | false;
  /**
   * Prompt caching hints (default `true`): the system prompt and the newest
   * message carry cache breakpoints for providers that need explicit ones
   * (`@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider`), and tools are sent
   * active first in a stable order. Providers that cache a stable prefix
   * automatically ignore the breakpoints. `false` sends `system` as before.
   */
  promptCaching?: boolean;
  /**
   * Keeps technical ids out of answers (default `true`): the system prompt
   * forbids them, and the built-in stream handler replaces an id the model
   * writes anyway with the label its tool result gave it (a `*Identifier` or
   * `key` field, else `title`, `name`, `displayName`, `label`) or removes it.
   * A custom `streamHandler` gets `hideIds` in its context and can pass
   * `createHideIdsTransform()` to `streamText` as `experimental_transform`.
   */
  hideIds?: boolean;
  /**
   * Outcome protocol of UI actions, for requests whose client reports
   * outcomes (`glirastesUiOutcomes: 1` in the body; the bundled React
   * provider and `<glirastes-chat>` send it). `'confirm'` (default): a UI
   * tool result that hands a `glirastes.*` action to the browser carries
   * `awaitsOutcome: true`, the request ends after that step, the browser
   * writes `outcome` into the result and sends the history again, and the
   * model answers with a fixed text per outcome (one more request, at most
   * three per turn). `'report-only'`: `awaitsOutcome: false`, the model
   * answers in the same request and reads the outcome in the next turn.
   * `'off'`: no marker. A function decides per tool name. A client without
   * the flag, and a custom `streamHandler`, always get no marker.
   */
  uiActionOutcomes?: UiActionOutcomesOption;
  /**
   * Shape of a UI tool result that hands a `uiAction` to the browser.
   * `'auto'` (default), per request: a client that sends
   * `glirastesUiOutcomes: 1` (glirastes 0.18 and later) gets
   * `{ handedOff: true, message, uiAction }` without `success`, because the
   * server does not know whether the app carried it out; every other
   * request gets `{ success: true, message, uiAction }` exactly as 0.17.3
   * sent it, since a 0.17 browser runs an action only with `success: true`.
   * `'handoff'` and `'legacy'` force one of the two for every request (also
   * direct commands and a custom `streamHandler`, which follow the flag
   * under `'auto'` as well).
   */
  uiToolResultShape?: UiToolResultShapeOption;
  /**
   * Number of recent user/assistant text pairs to include as conversation
   * history for intent classification. Helps the classifier understand
   * follow-up messages. Defaults to 4.
   */
  maxConversationHistoryPairs?: number;

  /**
   * Chat memory. `chat` (default on) replaces the fixed message window: the
   * conversation stays verbatim until it reaches the auto-compact threshold,
   * then `model` folds the older turns into a short summary that travels in
   * the chat as a `data-memory-summary` part. `user` and `shared` give the
   * model `memory_remember` / `memory_forget` for short notes that later
   * chats of the user, or all users of a workspace, get. Notes and summary
   * reach the model as background ahead of the messages, never as
   * instructions. With `memory.chat` on, `maxContextMessages` and
   * `history.maxTurns` no longer drop earlier turns.
   */
  memory?: ChatMemoryConfig;

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
  /**
   * Server-side diagnostics for a failure the chat only sees as a fixed text.
   * Without `info` (as before): the request or the whole turn failed (the
   * chat gets `AI request failed`, or a 500 before streaming). With
   * `info.source === 'tool-call'`: one tool call failed inside a running turn
   * and the chat got a fixed text in a `tool-output-error` /
   * `tool-input-error`; `info.kind` tells a guard denial, invalid input and
   * any other failure apart. Not reported: a recoverable denial and a call of
   * a tool the model was not offered (the model gets them back). Called once
   * per failure; a throw from it during streaming does not break the stream.
   * A denial of the managed turn guard is a `ToolExecutionDeniedError`
   * (`glirastes/runtime`) with `reason` and, for the budget, `budget`.
   */
  onError?: (error: unknown, req: Request, info?: AiChatErrorInfo) => void;
  onToolError?: (toolId: string, error: unknown) => void;
  /**
   * Classifies a failed backend call of an endpoint tool (non-2xx response)
   * as `'error'` (the default) or `'expected'`, e.g. a 403 for a user
   * without the role or an app error code in the body. Receives the
   * endpoint tool's `toolName`, the HTTP status and the FULL parsed response
   * body. Synchronous; a throw or any other return value counts as
   * `'error'`. Not called for thrown errors (timeout, network, response
   * size) or for calls the endpoint caller refused locally.
   *
   * An expected failure still counts as a tool call, but neither increments
   * nor resets the `maxConsecutiveErrors` budget of `managedRuntime`, and is
   * not a tool error in `metrics` (`toolErrorCount`, per-tool `errors`). It
   * is counted locally only, in `onFinish`'s `expectedToolFailureCount`;
   * nothing about it is sent to the Platform. A direct command is classified
   * too but never calls `onFinish`, so its expected failure is not counted. Without `managedRuntime` there
   * is no consecutive-error budget, so it only affects metrics. Without this
   * option every failure counts as an error, as before.
   */
  classifyToolFailure?: ToolFailureClassifier;
  /**
   * Upper bound of a serialized successful tool result, in characters, for
   * every tool of the handler (model turns and direct commands): an integer
   * from 1,000 to 200,000, default 16,000. A larger result is cut (the
   * largest array first, then long fields) and carries a `_truncated` marker
   * with a hint for the model. A tool's own `maxResultChars` (OpenAPI
   * `x-glirastes-max-result-chars`) wins. An invalid value throws when the
   * handler is created.
   */
  maxResultChars?: number;
  /**
   * Turn-scoped result handles (on by default). A successful record result
   * of a model turn that exceeds its limit (`maxResultChars`) is kept in
   * full for the running turn, after the PII shield when `piiShield` is set,
   * and the model gets an overview instead: every entry of the largest
   * array with its small fields, the largest fields left out (named in
   * `_result.omitted`), plus a `_result` handle. The built-in tool
   * `read_result` reads omitted fields or further entries from it without
   * calling the backend again. The handle lives only in this request: an
   * approval continuation or a later turn answers `result_expired`.
   * Direct commands never get handles.
   *
   * `true` (default): 8 handles per turn, 2 MiB per result, 16 MiB per
   * turn; an object sets `maxResults`, `maxResultBytes`, `maxTotalBytes`
   * (positive integers). A result beyond them is cut as with `false`, which
   * turns the feature off: every large result is cut (`_truncated`). An
   * invalid value throws when the handler is created.
   */
  resultHandles?: boolean | ResultHandleLimits;
  /**
   * Called after pipeline classification and tool scoping, before streaming.
   * Use this to log which intent, module, model, and tools were selected.
   */
  onPipelineResult?: (result: PipelineResult) => void;
  onStepReport?: (report: PipelineStepReport) => void;
  /**
   * Debug hook, opt-in: called by the built-in stream handler before every
   * model step with the exact messages that step sends to the model and a
   * breakdown of the history (which earlier turns kept their tool results,
   * which went as text or were left out, the seen-objects memo, a token
   * estimate). It CARRIES CONTENT: prompts, user text, tool results, ids and
   * names, after the PII shield. It runs in this process only: nothing of it
   * is sent to the browser, the stream or the Platform, and no request can
   * turn it on. Keep it out of production logs, or redact first. A throw
   * from it is ignored. Not called by a custom `streamHandler`, which can
   * pass `onBreakdown` to `prepareModelMessages` itself.
   */
  onModelInput?: (event: ModelInputEvent) => void;
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
    /**
     * Tool calls of the turn that ended in a failure `classifyToolFailure`
     * classified as expected. Local only; never sent to the Platform.
     */
    expectedToolFailureCount: number;
    /**
     * Set when this request continued a turn instead of starting one:
     * answered approvals (`'approval'`) or reported UI outcomes
     * (`'ui-outcome'`). `onFinish` fires once per request, so count turns
     * by the requests without it.
     */
    continuation?: 'approval' | 'ui-outcome';
    /** Set when the request ended to wait for the outcome of a UI action; a continuation follows. */
    awaitingUiOutcome?: true;
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
   * Local limits of the server lookups behind approval cards
   * (docs/approval-subjects.md): `maxLookupsPerTurn` (32),
   * `maxSubjectsPerCall` (4, a preview included), `lookupTimeoutMs` (3000,
   * at most the managed tool timeout), `maxLookupTimePerTurnMs` (10 000).
   * They apply only to tools with a declaration (`entityLookup` on a read
   * tool, `inputEntities` or `approvalSubject` on the write tool); lookups
   * never count against the signed `maxToolCalls`, which means calls made
   * by the model. `false` turns the lookups off: every card then names
   * records from the chat history, as without a declaration. A custom
   * `streamHandler` gets no lookups either.
   */
  approvalSubjects?: Partial<ApprovalSubjectLimits> | false;

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
   * Largest request body in bytes. Default 1,000,000, or 50,000,000 when
   * `attachments.enabled` is set. A larger body is answered with 413 before
   * it is parsed; the limit counts the bytes read, not only the declared
   * `Content-Length`.
   */
  maxBodyBytes?: number;

  /**
   * File and image attachments in user messages; off by default, and a file
   * part is then refused with 400. Attachments bypass the PII shield, so
   * with `piiShield` set the handler refuses to start unless
   * `allowWithPiiShield` is true.
   */
  attachments?: ChatAttachmentsConfig;

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

/** Attachment options of `createAiChatHandler`. */
export interface ChatAttachmentsConfig {
  enabled: boolean;
  /** Files per message. Default 10. */
  maxFiles?: number;
  /** Decoded bytes per file. Default 20,000,000. */
  maxFileBytes?: number;
  /**
   * Accepted media types. Default PNG, JPEG, WebP, GIF and PDF; for these
   * the leading bytes must match the declared type.
   */
  mediaTypes?: ReadonlyArray<string>;
  /** Also accept http(s) URLs instead of data URLs. The model provider fetches them. Default false. */
  allowRemoteUrls?: boolean;
  /** Required next to `piiShield`: images and PDFs reach the model unredacted. */
  allowWithPiiShield?: boolean;
}
