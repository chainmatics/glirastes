// ---------------------------------------------------------------------------
// Lancer SDK Types
// ---------------------------------------------------------------------------

// ============================================================================
// Degradation
// ============================================================================

/**
 * Names of Glirastes services that can be called by the Lancer client.
 * Used to identify which service failed in degradation callbacks.
 */
export type LancerServiceName = 'warden' | 'primus' | 'aegis' | 'proctor' | 'config' | 'approvals';

/**
 * What to do when a Glirastes service is unavailable:
 * - 'fallback': Return the safe default value (calls onDegraded if set).
 * - 'block':    Throw a ServiceBlockedError — use for critical guardrails.
 * - 'silent':   Return the safe default value without calling onDegraded.
 */
export type DegradationAction = 'fallback' | 'block' | 'silent';

/** Context passed to the onServiceUnavailable callback. */
export interface DegradationContext {
  /** Which Glirastes service could not be reached. */
  service: LancerServiceName;
  /** The underlying error from the failed API call. */
  error: Error;
  /** Arbitrary request context (e.g. ToolContext) forwarded by the caller, if available. */
  requestContext?: Record<string, unknown>;
}

/**
 * Static per-service degradation action overrides.
 * Any service not listed falls back to the built-in default
 * ('fallback' for all services except proctor, which defaults to 'silent').
 */
export interface DegradationDefaults {
  warden?: DegradationAction;
  primus?: DegradationAction;
  aegis?: DegradationAction;
  proctor?: DegradationAction;
  config?: DegradationAction;
  approvals?: DegradationAction;
}

/**
 * Dynamic per-request degradation decision.
 * Called after static defaults are resolved; its return value takes precedence.
 * May be async (e.g. for remote policy lookups).
 */
export type OnServiceUnavailable = (
  ctx: DegradationContext,
) => DegradationAction | Promise<DegradationAction>;

/** Configuration for creating a Lancer client instance. */
export interface LancerConfig {
  apiKey: string;
  baseUrl?: string; // default: https://api.glirastes.chainmatics.io
  cache?: { ttl: number }; // default: 60000 (60s)
  retry?: { maxRetries: number }; // default: 3
  /** Called whenever any service falls back (action='fallback'). */
  onDegraded?: () => void;
  /**
   * Static per-service degradation action overrides.
   * Overrides the built-in defaults ('fallback' / 'silent') per service.
   */
  degradation?: DegradationDefaults;
  /**
   * Dynamic degradation callback. Invoked on every service failure;
   * its return value overrides both built-in and static defaults.
   */
  onServiceUnavailable?: OnServiceUnavailable;
  /** Identifies which agent is calling (e.g. "claude-code", "gpt-4o"). Sent as X-Agent-Id header. */
  agentId?: string;
  /** Broad agent category. Sent as X-Agent-Type header. */
  agentType?: 'claude' | 'openai' | 'open-source' | 'custom';
}

// -- Config -----------------------------------------------------------------

export interface PromptOverride {
  moduleId: string;
  mode: 'replace' | 'patch';
  systemPrompt: string | null;
  promptPrefix: string | null;
  promptSuffix: string | null;
  modelTierOverride: string | null;
}

export interface ConfigResult {
  modules: Record<string, unknown>;
  prompts?: PromptOverride[];
  models?: Record<string, string>;
  etag?: string;
}

// -- Classify ---------------------------------------------------------------

export interface ClassifyResult {
  moduleId: string;
  confidence: number;
  modelTier: string;
}

// -- Aegis (PII) ------------------------------------------------------------

export interface PiiEntity {
  type: string;
  value: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface AnalyzeResult {
  entities: PiiEntity[];
  anonymized: string;
  mappingToken: string | null;
  detector?: 'regex' | 'presidio';
}

export interface AnalyzeOptions {
  locales?: string[];
  mode?: 'anonymize' | 'pseudonymize';
  sessionId?: string;
}

export interface LeakageResult {
  leaked: boolean;
  entities: PiiEntity[];
  totalDetected: number;
  filteredAsKnown: number;
}

// -- Warden (safety) --------------------------------------------------------

export interface Violation {
  rule: string;
  severity: string;
  message: string;
}

export interface CheckResult {
  passed: boolean;
  violations: Violation[];
}

// -- Telemetry --------------------------------------------------------------

export interface TelemetryEvent {
  eventType: string;
  traceId?: string;
  toolId?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
  modelId?: string;
  modelTier?: string;
  /** ISO-8601 timestamp of when the event occurred on the client. Used for accurate timeline ordering. */
  timestamp?: string;
  payload?: Record<string, unknown>;
  actor?: Record<string, unknown>;
}

// -- Lancer client surface ---------------------------------------------------

export interface PrimusNamespace {
  classify(message: string, modules: { moduleId: string }[]): Promise<ClassifyResult>;
}

export interface WardenNamespace {
  check(input: string, policies: string[]): Promise<CheckResult>;
}

export interface AegisNamespace {
  analyze(text: string, options?: AnalyzeOptions): Promise<AnalyzeResult>;
  rehydrate(text: string, mappingToken: string): Promise<string>;
  checkLeakage(text: string, mappingToken: string, locales?: string[]): Promise<LeakageResult>;
}

export interface ConfigNamespace {
  fetch(modules: string[]): Promise<ConfigResult>;
  /**
   * Report the app's default model configuration to Glirastes.
   * Fire-and-forget — errors are silently ignored.
   * Called automatically by the SDK adapter on first request.
   */
  reportModels(models: Record<string, string>): Promise<void>;
}

export interface TelemetryNamespace {
  emit(event: TelemetryEvent): void;
  flush(): Promise<void>;
}

// -- Approvals ---------------------------------------------------------------

export interface ApprovalCheckResult {
  required: boolean;
  requestId?: string | null;
  status?: string;
}

export interface ApprovalDecideResult {
  ok: boolean;
}

export interface ApprovalResolveResult {
  resolved: boolean;
  requestId?: string;
}

export interface ApprovalsNamespace {
  check(req: {
    toolId: string;
    inputHash: string;
    /** Optional trace/session ID forwarded to Glirastes for approval audit correlation. */
    traceId?: string;
  }): Promise<ApprovalCheckResult>;
  decide(
    requestId: string,
    decision: { decision: 'approved' | 'denied'; decidedBy: string },
  ): Promise<ApprovalDecideResult>;
  /** Resolve a pending approval by toolId + inputHash (no requestId needed). */
  resolve(req: {
    toolId: string;
    inputHash: string;
    decision: 'approved' | 'denied';
    decidedBy: string;
  }): Promise<ApprovalResolveResult>;
  hashInput(args: Record<string, unknown>): string;
}

export interface Lancer {
  primus: PrimusNamespace;
  warden: WardenNamespace;
  aegis: AegisNamespace;
  config: ConfigNamespace;
  telemetry: TelemetryNamespace;
  /** Approval flows managed by Glirastes. Optional — only present when the Glirastes API supports approvals. */
  approvals?: ApprovalsNamespace;
  destroy(): void;
}
