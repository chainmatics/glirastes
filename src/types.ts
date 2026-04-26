import { z } from 'zod';

// ============================================================================
// HTTP & Transport
// ============================================================================

export type EndpointMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

// ============================================================================
// Runtime & Context
// ============================================================================

/**
 * Runtime context for tool execution (transport-level info).
 * Used so tools can forward the caller's auth (cookies, origin) to backend APIs.
 * The SDK itself does NOT handle authentication or authorization — the backend API
 * that each tool calls is responsible for checking permissions.
 */
export interface RuntimeContext {
  origin?: string;
  cookieHeader?: string;
  [key: string]: unknown;
}

/**
 * Context passed to every tool execution.
 */
export interface ToolContext {
  currentDate: Date;
  locale: string;
  runtime?: RuntimeContext;
}

// ============================================================================
// Tool (core abstraction)
// ============================================================================

/**
 * A Tool defines a single action that can be performed in the system.
 * Permission enforcement is the responsibility of the backend API that each tool calls —
 * the SDK does not perform authorization checks.
 */
export interface Tool {
  /** Unique identifier, e.g., "groups.create" */
  id: string;

  /** Human-readable description for AI to understand when to use this */
  description: string;

  /** Zod schema for input validation — shared between AI and API */
  inputSchema: z.ZodType;

  /** Optional Zod schema describing the tool's response shape */
  outputSchema?: z.ZodType;

  /** HTTP method of the underlying endpoint (e.g. GET, POST). Used by test suites to derive approval defaults. */
  method?: string;

  /**
   * Whether the tool call requires explicit user approval.
   * @deprecated Use Glirastes approval flows via `lancer.approvals` instead. Kept for backward compatibility.
   */
  needsApproval?:
    | boolean
    | ((input: unknown, context: ToolContext) => boolean | Promise<boolean>);

  /** The actual implementation */
  execute: (input: unknown, context: ToolContext) => Promise<unknown>;
}

/**
 * Helper to define a tool with full type inference at definition site.
 */
export function defineTool<TInput extends z.ZodType, TOutput>(tool: {
  id: string;
  description: string;
  inputSchema: TInput;
  outputSchema?: z.ZodType<TOutput>;
  method?: string;
  /** @deprecated Use Glirastes approval flows via `lancer.approvals` instead. Kept for backward compatibility. */
  needsApproval?:
    | boolean
    | ((
        input: z.infer<TInput>,
        context: ToolContext,
      ) => boolean | Promise<boolean>);
  execute: (input: z.infer<TInput>, context: ToolContext) => Promise<TOutput>;
}): Tool {
  return tool as Tool;
}

/**
 * Registry of all tools in the system.
 * Keys are tool names (e.g., "create_group").
 */
export type ToolRegistry = Record<string, Tool>;

// ============================================================================
// UI Action Templates & Schema
// ============================================================================

export interface UiActionTemplate {
  type: string;
  [key: string]: unknown;
}

/**
 * Creates a Zod schema for validating UI actions at runtime.
 * Consumers provide their app-specific action schemas.
 *
 * Built-in action types that every app gets:
 * - run-client-action: Dispatch to a registered action handler
 * - navigate: Navigate to a path
 * - entity actions: {entity}-{created|updated|deleted} pattern
 *
 * @param extraSchemas - Additional Zod schemas for app-specific action types
 */
export function createUiActionSchema(
  extraSchemas: z.ZodTypeAny[] = [],
) {
  const runClientActionSchema = z
    .object({
      type: z.literal('run-client-action'),
      actionId: z.string().min(1),
      payload: z.record(z.unknown()).optional(),
    })
    .strict();

  const navigateSchema = z
    .object({
      type: z.literal('navigate'),
      path: z.string().min(1),
    })
    .strict();

  // Generic entity action: {entity}-{created|updated|deleted}
  const entityActionSchema = z
    .object({
      type: z.string().regex(/^[a-z]+-(?:created|updated|deleted)$/),
    })
    .passthrough()
    .refine(
      (data) => {
        const entity = data.type.split('-')[0];
        const idKey = `${entity}Id`;
        const id = data[idKey];
        return (
          typeof id === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            id,
          )
        );
      },
      { message: 'Entity action must include valid {entity}Id (UUID)' },
    );

  return z.union([
    runClientActionSchema,
    navigateSchema,
    ...extraSchemas,
    entityActionSchema, // Fallback — must be last
  ] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

// ============================================================================
// UI Patterns
// ============================================================================

export type UiPatternType =
  | 'filter-and-navigate'
  | 'open-detail'
  | 'open-dialog'
  | 'refresh'
  | 'toast';

export interface FilterAndNavigatePattern {
  type: 'filter-and-navigate';
  /** Target page identifier (app-specific, e.g., 'tasks', 'dashboard') */
  target: string;
  /** Maps response/input fields to filter keys. Array-wrapped: status, priority, assignee. String: rest. */
  filterMapping?: Record<string, string>;
  /** Fields whose values should be auto-wrapped in arrays */
  arrayFields?: string[];
  /** Only emit uiAction if this response field is truthy */
  condition?: string;
}

export interface OpenDetailPattern {
  type: 'open-detail';
  /** Entity type — used to derive actionId (e.g., 'task' → 'task-details.open') */
  entity: string;
  /** Response field containing the entity ID */
  idField: string;
}

export interface OpenDialogPattern {
  type: 'open-dialog';
  /** Dialog actionId suffix (e.g., 'create-task' → 'task-create-dialog.open') */
  dialog: string;
  /** Response field containing entity ID (for edit/delete) */
  idField?: string;
}

export interface RefreshPattern {
  type: 'refresh';
  /** What to refresh (e.g., 'tasks', 'dashboard', 'current') */
  target: string;
}

export interface ToastPattern {
  type: 'toast';
  /** Response field reference (starting with $) or static message */
  message: string;
  /** Toast variant */
  variant?: 'default' | 'success' | 'error' | 'warning';
}

export type UiPattern =
  | FilterAndNavigatePattern
  | OpenDetailPattern
  | OpenDialogPattern
  | RefreshPattern
  | ToastPattern;

// ============================================================================
// Endpoint Tool Definition
// ============================================================================

export interface AiEndpointToolDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  id: string;
  toolName: string;
  /** Which intent module this tool belongs to */
  module?: string;
  /** Additional modules where this tool should also be available */
  sharedWith?: string[];
  description: string;
  method: EndpointMethod;
  path: string;
  inputSchema: TInput;
  /**
   * Optional Zod schema describing the API response shape.
   * When provided, a compact description is auto-appended to the tool description.
   */
  outputSchema?: TOutput;
  /** @deprecated Use Glirastes approval flows via `lancer.approvals` instead. Kept for backward compatibility. */
  needsApproval?: boolean;
  /**
   * Static uiAction template with $variable placeholders.
   * Use for simple cases where action is always the same.
   * Pass an array for compound actions (e.g., toast + refresh).
   */
  uiActionOnSuccess?: UiActionTemplate | UiActionTemplate[];
  /**
   * Dynamic uiAction pattern. Evaluated at runtime based on input + response.
   * Takes precedence over uiActionOnSuccess if both are defined.
   * Pass an array for compound actions (e.g., toast + refresh).
   */
  uiPattern?: UiPattern | UiPattern[];
}

export function defineEndpointTool<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
>(
  definition: AiEndpointToolDefinition<TInput, TOutput>,
): AiEndpointToolDefinition<TInput, TOutput> {
  return definition;
}

// ============================================================================
// UI Tool Definition
// ============================================================================

export interface AiUiToolDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  id: string;
  toolName: string;
  /** Which intent module this tool belongs to */
  module?: string;
  /** Additional modules where this tool should also be available */
  sharedWith?: string[];
  description: string;
  inputSchema: TInput;
  /**
   * Optional Zod schema describing the tool's response shape.
   * When provided, a compact description is auto-appended to the tool description.
   */
  outputSchema?: TOutput;
  /** @deprecated Use Glirastes approval flows via `lancer.approvals` instead. Kept for backward compatibility. */
  needsApproval?: boolean;
  successMessage?: string;
  /**
   * Static uiAction template with $variable placeholders.
   * Pass an array for compound actions (e.g., toast + refresh).
   */
  uiAction?: UiActionTemplate | UiActionTemplate[];
  /**
   * Dynamic uiAction pattern. Takes precedence over uiAction if both defined.
   * Pass an array for compound actions (e.g., toast + refresh).
   */
  uiPattern?: UiPattern | UiPattern[];
}

export function defineUiTool<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
>(
  definition: AiUiToolDefinition<TInput, TOutput>,
): AiUiToolDefinition<TInput, TOutput> {
  return definition;
}

// ============================================================================
// Module System
// ============================================================================

/**
 * Model tier for selecting appropriate model based on task complexity.
 * - fast: Quick responses, simple lookups
 * - standard: Balanced performance
 * - powerful: Complex reasoning, planning
 */
export type ModelTier = 'fast' | 'standard' | 'powerful';

export interface ModuleExecutionConfig {
  maxSteps: number;
  contextWindow: number;
  modelTier: ModelTier;
}

/**
 * Sensible baseline execution parameters.
 * Modules spread these defaults and override only what differs.
 */
export const EXECUTION_DEFAULTS: ModuleExecutionConfig = {
  maxSteps: 4,
  contextWindow: 12,
  modelTier: 'standard',
};

export interface ModuleClassificationConfig {
  hint: string;
  examples: string[];
}

export interface ModuleMeta {
  classification: ModuleClassificationConfig;
  /** Partial — missing fields fall back to EXECUTION_DEFAULTS at build time. */
  execution?: Partial<ModuleExecutionConfig>;
  systemPrompt?: string;
}

export interface IntentModule {
  type: string;
  toolNames: string[];
  systemPromptAddition?: string;
  /** Resolved execution fields (merged with EXECUTION_DEFAULTS). */
  maxSteps?: number;
  contextWindow?: number;
  modelTier?: ModelTier;
  meta: ModuleMeta;
}

// ============================================================================
// OpenAPI Extension (for code generation from OpenAPI specs)
// ============================================================================

export interface OpenApiAiExtension {
  enabled?: boolean;
  toolName?: string;
  description?: string;
  module?: string;
  sharedWith?: string[];
  /** @deprecated Use Glirastes approval flows via `lancer.approvals` instead. Kept for backward compatibility. */
  needsApproval?: boolean;
  uiActionOnSuccess?: Record<string, unknown> | Record<string, unknown>[];
  uiPattern?: UiPattern | UiPattern[];
}

export interface OpenApiOperationLike {
  operationId?: string;
  summary?: string;
  description?: string;
  'x-ai'?: OpenApiAiExtension;
}

// ============================================================================
// Action ID Registry (for codegen output)
// ============================================================================

export interface ActionIdEntry {
  tools: Array<{ toolName: string; sourceFile: string }>;
  payloadKeys: readonly string[];
}

export type ActionIdRegistry = Record<string, ActionIdEntry>;

// ============================================================================
// Agent Skill Definition (for Claude Code / Codex / autonomous agents)
// ============================================================================

/**
 * Authentication strategy for agent skill access.
 * Describes how an autonomous agent authenticates against the platform API.
 */
export type AgentAuthStrategy =
  | { type: 'bearer'; tokenEnvVar: string; description?: string }
  | { type: 'api-key'; headerName: string; keyEnvVar: string; description?: string }
  | { type: 'oauth2'; tokenUrl: string; clientIdEnvVar: string; clientSecretEnvVar: string; scopes?: string[]; description?: string }
  | { type: 'cookie'; description?: string };

/**
 * A single tool exposed in an agent skill file.
 * Contains everything an LLM agent needs to call the tool via HTTP.
 */
export interface AgentSkillTool {
  name: string;
  description: string;
  method: EndpointMethod;
  path: string;
  /** JSON Schema representation of inputSchema (Zod → JSON Schema) */
  parameters: Record<string, unknown>;
  /** JSON Schema representation of outputSchema, if available */
  response?: Record<string, unknown>;
  /**
   * Whether the tool requires explicit user confirmation before execution.
   * @deprecated Use Glirastes approval flows via `lancer.approvals` instead. Kept for backward compatibility.
   */
  needsApproval?: boolean;
}

/**
 * Configuration for generating agent skill files.
 */
export interface AgentSkillConfig {
  /** Human-readable name of the platform/app (e.g., "My Task Manager") */
  appName: string;
  /** Base URL of the API (e.g., "https://api.example.com") */
  baseUrl: string;
  /** How the agent authenticates */
  auth: AgentAuthStrategy;
  /** Optional version string */
  version?: string;
  /** Optional description of the platform */
  description?: string;
}

// ============================================================================
// Audit Event Bus
// ============================================================================

/**
 * All audit event types emitted across the SDK.
 * Each package emits a subset of these via an optional `onAudit` callback.
 */
export type AuditEventType =
  // Session lifecycle
  | 'session.started'
  | 'session.ended'
  // Guardrails (lancer/warden)
  | 'guardrail.passed'
  | 'guardrail.blocked'
  // Intent classification (lancer/primus)
  | 'intent.classified'
  // Routing (server-core)
  | 'routing.resolved'
  // PII (lancer/aegis)
  | 'pii.detected'
  | 'pii.anonymized'
  | 'pii.rehydrated'
  | 'pii.leakage'
  // Tool execution (server-core)
  | 'tool.executed'
  | 'tool.failed'
  // Approval workflow (server-core / adapter)
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.denied';

/**
 * A single audit event emitted by any SDK package.
 *
 * Consumers receive these via the `onAudit` callback and can forward them
 * to any SIEM, logging backend, or compliance store.
 */
export interface AuditEvent {
  /** Event type */
  type: AuditEventType;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Session identifier */
  sessionId: string;
  /** Source package that emitted this event */
  source: 'server-core' | 'server-pro' | 'lancer' | 'adapter';
  /** Event-specific payload (varies by event type) */
  details: Record<string, unknown>;
}

/**
 * Callback type for receiving audit events.
 * Passed as `onAudit` option to each package.
 */
export type AuditEmitter = (event: AuditEvent) => void;

/**
 * Lightweight telemetry sink for forwarding SDK events to a remote backend.
 *
 * Compatible with `lancer.telemetry` — pass it directly:
 * ```typescript
 * const lancer = createLancer({ apiKey: '...' });
 * createAiChatHandler({ telemetry: lancer.telemetry, ... });
 * ```
 *
 * Free-tier users get monitoring/analytics on Glirastes without Pro features.
 */
export interface TelemetrySink {
  /** Buffer an event for async delivery. Fire-and-forget — must never throw. */
  emit(event: {
    eventType: string;
    traceId?: string;
    toolId?: string;
    tokensIn?: number;
    tokensOut?: number;
    latencyMs?: number;
    modelId?: string;
    modelTier?: string;
    /** ISO-8601 timestamp of when the event occurred on the client. */
    timestamp?: string;
    payload?: Record<string, unknown>;
    actor?: Record<string, unknown>;
  }): void;
  /** Flush buffered events. Called on session end / process shutdown. */
  flush(): Promise<void>;
}

// ============================================================================
// Conversation & Classification (from ai-router)
// ============================================================================

/**
 * A lightweight message representation passed to the intent classifier
 * so it can consider conversation history when classifying follow-up messages.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface IntentClassification {
  intent: string;
  confidence: number;
}

// ============================================================================
// Module Definition (from ai-router)
// ============================================================================

export interface ModuleDefinition {
  id: string;
  name: string;
  description: string;
  tools: string[];
  sharedTools?: string[];
  executionDefaults?: {
    maxSteps?: number;
    contextWindow?: number;
    modelTier?: ModelTier;
  };
  classification?: {
    hint: string;
    examples: string[];
  };
  systemPrompt?: string;
}

// ============================================================================
// Prompt Override (runtime prompt customization via Glirastes)
// ============================================================================

export interface PromptOverride {
  moduleId: string;
  mode: 'replace' | 'patch';
  /** Full replacement prompt (replace mode) */
  systemPrompt: string | null;
  /** Prepended before generated prompt (patch mode) */
  promptPrefix: string | null;
  /** Appended after generated prompt (patch mode) */
  promptSuffix: string | null;
  /** Override the module's model tier */
  modelTierOverride: string | null;
}

/**
 * Apply a prompt override to a base system prompt.
 * - replace mode: returns the override's systemPrompt (or base if null)
 * - patch mode: prepends prefix and/or appends suffix to base
 */
export function applyPromptOverride(
  base: string,
  override: PromptOverride,
): string {
  if (override.mode === 'replace' && override.systemPrompt) {
    return override.systemPrompt;
  }
  if (override.mode === 'patch') {
    const prefix = override.promptPrefix ?? '';
    const suffix = override.promptSuffix ?? '';
    return `${prefix}${prefix ? '\n\n' : ''}${base}${suffix ? '\n\n' : ''}${suffix}`;
  }
  return base;
}

// ============================================================================
// Router (from ai-router)
// ============================================================================

export interface AiRouterConfig {
  modules: ModuleDefinition[];
  expansionStrategy?: 'minimal' | 'shared' | 'full';
  relatedModules?: Record<string, string[]>;
  confidenceThresholds?: {
    high?: number;
    medium?: number;
  };
}

export interface SelectedTools {
  tools: string[];
  module: ModuleDefinition | null;
  strategy: 'single' | 'expanded' | 'all';
}

export interface AiRouter {
  route(intent: IntentClassification, allToolNames: string[]): SelectedTools;
}

// ============================================================================
// Model Selection (from ai-router)
// ============================================================================

export interface ModelConfig {
  modelId: string;
  /** Ready-to-use LanguageModel instance. When provided, the adapter
   *  uses this directly instead of requiring a separate model callback. */
  instance?: unknown;
  [key: string]: unknown;
}

export interface ModelSelectorConfig {
  fast: ModelConfig;
  standard: ModelConfig;
  premium: ModelConfig;
}

export interface ModelSelector {
  select(intent: IntentClassification, context?: ToolContext): ModelConfig;
}

// ============================================================================
// Guardrails (from ai-router)
// ============================================================================

export interface Validator {
  name: string;
  validate(input: string): ValidationResult;
}

export interface GuardrailsConfig {
  maxInputLength?: number;
  enableInjectionDetection?: boolean;
  customValidators?: Validator[];
  injectionPatterns?: RegExp[];
}

export interface ValidationResult {
  valid: boolean;
  blocked: boolean;
  reason?: string;
  sanitized: string;
}

export interface Guardrails {
  validate(input: string): ValidationResult;
  /** Async validation with Lancer delegation (falls back to local validate) */
  validateAsync?(input: string): Promise<ValidationResult>;
  sanitize(input: string): string;
}

// ============================================================================
// Followups (from ai-router)
// ============================================================================

export interface FollowupLocale {
  description: string;
  suggestionHint: string;
  examples?: {
    good: string[];
    bad: string[];
  };
}

export interface FollowupsConfig {
  enabled?: boolean;
  count?: number;
  locale?: FollowupLocale;
}

// ============================================================================
// Fast Path (from ai-router)
// ============================================================================

export interface LearnedPattern {
  pattern: string;
  intent: string;
  confidence: number;
  hitCount: number;
  lastSeen: number;
  promotedAt?: number;
}

export interface FastPathConfig {
  maxPatterns?: number;
  confidenceThreshold?: number;
  promotionThreshold?: number;
  minConfidence?: number;
  patternTtlMs?: number;
  enableLearning?: boolean;
  initialPatterns?: LearnedPattern[];
}

export interface FastPathStorage {
  load(): Promise<LearnedPattern[]>;
  save(patterns: LearnedPattern[]): Promise<void>;
}

export interface AdaptiveFastPathInstance {
  match(input: string): IntentClassification | null;
  learn(input: string, intent: IntentClassification): void;
  getPatterns(): LearnedPattern[];
  getPromotedPatterns(): LearnedPattern[];
  importPatterns(patterns: LearnedPattern[]): void;
  getStats(): FastPathStats;
  clear(): void;
  loadFromStorage(): Promise<void>;
  saveToStorage(): Promise<void>;
}

export interface FastPathStats {
  totalPatterns: number;
  promotedPatterns: number;
  avgHitCount: number;
  oldestPattern: number;
}

// ============================================================================
// Intent Classifier (from ai-router)
// ============================================================================

export interface IntentClassifierConfig {
  /** Module definitions to classify against */
  modules: ModuleDefinition[];
  /** Model used for classification */
  model?: unknown;
  /** Classification timeout in ms (default: 2000) */
  timeoutMs?: number;
  /** Minimum confidence threshold (default: 0.5) */
  confidenceThreshold?: number;
  /** Minimum token count in input to attempt classification (default: 2) */
  minTokens?: number;
  /** BCP-47 locale for language-aware stemming (e.g. "de", "en-US", "fr") */
  locale?: string;
}

export interface IntentClassifier {
  classify(
    input: string,
    context?: ToolContext,
    conversationHistory?: ConversationMessage[],
  ): Promise<IntentClassification>;
}

// ============================================================================
// Pipeline (from ai-router)
// ============================================================================

export interface AiPipelineConfig {
  modules: ModuleDefinition[];
  guardrails?: GuardrailsConfig;
  modelSelector?: ModelSelectorConfig;
  /**
   * Flat tier→modelId map as a simpler alternative to `modelSelector`.
   * Keys are tier names (fast, standard, powerful).
   * Requires `modelInstanceFactory` to turn IDs into LanguageModel instances.
   */
  models?: Record<string, string>;
  /**
   * Factory that turns a modelId string into a ready-to-use LanguageModel instance.
   * Required when using the flat `models` map.
   */
  modelInstanceFactory?: (modelId: string) => unknown;
  classifier?: IntentClassifierConfig;
  fastPath?: FastPathConfig;
  fastPathStorage?: FastPathStorage;
  followups?: FollowupsConfig;
  relatedModules?: Record<string, string[]>;
  confidenceThresholds?: {
    high?: number;
    medium?: number;
  };
  /** Audit event emitter for compliance logging */
  onAudit?: AuditEmitter;
}

export interface PipelineResult {
  model: ModelConfig;
  tools: string[];
  sanitizedInput: string;
  intent: IntentClassification;
  module: ModuleDefinition | null;
  followupsEnabled: boolean;
  /** True when guardrails blocked the input (warden check failed or service unavailable with block policy). */
  blocked?: boolean;
}

export interface AiPipeline {
  process(
    input: string,
    context: ToolContext,
    conversationHistory?: ConversationMessage[],
  ): Promise<PipelineResult>;
}

// ============================================================================
// Evals (from ai-router)
// ============================================================================

export interface EvalCase {
  id: string;
  input: string;
  expectedTools: string[];
  expectedIntent?: string;
  expectedModule?: string;
  requiresApproval?: boolean;
  assertResult?: (result: unknown) => boolean;
}

export interface SmokeResult {
  passed: boolean;
  summary: string;
  details: Array<{
    caseId: string;
    passed: boolean;
    reason?: string;
  }>;
}

export interface RoutingResult {
  passed: boolean;
  summary: string;
  details: Array<{
    caseId: string;
    passed: boolean;
    actualIntent?: string;
    actualModule?: string;
    reason?: string;
  }>;
}

export interface E2EResult {
  passed: boolean;
  summary: string;
  details: Array<{
    caseId: string;
    passed: boolean;
    toolsCalled?: string[];
    reason?: string;
  }>;
}

export interface EvalSuiteConfig {
  tools: Record<string, unknown>;
  pipeline?: AiPipeline;
  cases: EvalCase[];
}

export interface EvalSuite {
  runSmoke(): Promise<SmokeResult>;
  runRouting(): Promise<RoutingResult>;
  runE2E(): Promise<E2EResult>;
}

// ============================================================================
// PII Types (from pii-shield)
// ============================================================================

export type PiiCategory =
  | 'person'
  | 'email'
  | 'phone'
  | 'iban'
  | 'credit_card'
  | 'cvv'
  | 'card_expiry'
  | 'address'
  | 'date_of_birth'
  | 'tax_id'
  | 'ssn'
  | 'ip_address'
  | 'url'
  | 'custom';

export interface PiiEntity {
  type: PiiCategory | string;
  start: number;
  end: number;
  score: number;
  text: string;
}

export interface MappingEntry {
  original: string;
  pseudonym: string;
  type: PiiCategory | string;
  variants: {
    forward: Map<string, string>;
    reverse: Map<string, string>;
  };
  firstSeen: number;
  source: 'user-input' | 'tool-result';
}

export interface PiiAuditEntry {
  sessionId: string;
  timestamp: string;
  direction: 'outbound' | 'inbound' | 'rehydrate-args' | 'anonymize-result';
  leakage?: boolean;
  detections: {
    type: PiiCategory | string;
    detector: string;
    confidence: number;
    position: { start: number; end: number };
    length: number;
  }[];
  totalDetected: number;
  totalAnonymized: number;
  mode: 'anonymize' | 'pseudonymize';
  locale: string;
}

export interface ComplianceSummary {
  sessionId: string;
  duration: string;
  totalMessages: number;
  totalToolCalls: number;
  piiStats: {
    totalDetected: number;
    byType: Record<string, number>;
    byDetector: Record<string, number>;
    byDirection: Record<string, number>;
  };
  mode: 'anonymize' | 'pseudonymize';
  leakageDetected: number;
  verdict: 'COMPLIANT' | 'LEAKAGE_DETECTED';
}

export interface PiiDetector {
  detect(text: string, locales?: string[]): PiiEntity[] | Promise<PiiEntity[]>;
}

export interface PiiShieldConfig {
  locale: string;
  detector: PiiDetector;
  leakageDetection?: boolean;
  onAudit?: (entry: PiiAuditEntry) => void;
}

export interface PiiShield {
  /** Anonymize user message before LLM sees it */
  outbound(text: string, sessionId: string): Promise<string>;
  /** Sync de-anonymize */
  inbound(text: string, sessionId: string): string;
  /** Async de-anonymize */
  inboundAsync?(text: string, sessionId: string): Promise<string>;
  /** Sync re-hydrate tool-call arguments */
  rehydrateArgs(args: Record<string, unknown>, sessionId: string): Record<string, unknown>;
  /** Async rehydrate */
  rehydrateArgsAsync?(args: Record<string, unknown>, sessionId: string): Promise<Record<string, unknown>>;
  /** Anonymize tool-result before LLM sees it */
  anonymizeResult(result: unknown, sessionId: string): Promise<unknown>;
  /** Get compliance summary for a session */
  getComplianceSummary(sessionId: string): ComplianceSummary;
  /** Clear session mapping */
  clearSession(sessionId: string): void;
}
