// Server core (includes native telemetry forwarding via TelemetrySink interface)
export * from './core/index.js';

// AI pipeline (multi-stage: guardrails → classify → route → model select)
export * from './pipeline.js';
export {
  createLocalAiPipeline,
  type LocalAiPipelineConfig,
} from './local-pipeline.js';

// PII shield
export {
  createPiiShield,
  createRegexPiiDetector,
} from './pii-shield/index.js';

// Protected-text privacy profile (protected-text/v1). Explicit list: the
// legacy remote detector (Aegis) stays out of the package.
export {
  createStrictPiiShield,
  PROTECTED_TEXT_PROFILE,
  type StrictPiiShield,
  type StrictPiiShieldConfig,
  type PrivacySession,
  createPostgresPrivacyMappingStore,
  createMemoryPrivacyMappingStore,
  POSTGRES_PRIVACY_MAPPING_SCHEMA_SQL,
  parsePrivacyKeyring,
  type PrivacyKeyring,
  type PrivacyScope,
  type PrivacyMappingStore,
  createPrivacyBoundary,
  DEFAULT_PROVIDER_OPTIONS_ALLOWLIST,
  type PrivacyBoundary,
  type ModelCapabilities,
  type ProviderOptionsAllowlist,
  wrapToolsForPrivacy,
  type ToolReceiptStore,
  projectUiMessageStream,
  resolveAttachmentPolicy,
  type ScreenshotMode,
  type AttachmentPolicyInput,
  PrivacyError,
  isPrivacyError,
  toSafeError,
  type PrivacyErrorCode,
  extractIdentitiesFromJson,
  type KnownIdentity,
  privacySafeError,
  type ChatPrivacyConfig,
  protectedStreamText,
  protectedGenerateText,
  protectedGenerateObject,
  type ModelCallProtection,
  createProviderRegistry,
  openRouterAdapter,
  anthropicAdapter,
  openAiCompatibleAdapter,
  withOpenRouterRouting,
  STRICT_OPENROUTER_ROUTING,
  type ProviderAdapter,
  type ProviderEntry,
  type ProviderOption,
  type ProviderRegistry,
  type ProviderRegistryConfig,
  type ResolvedProvider,
  type ProviderModelInput,
  type OpenRouterRoutingPolicy,
  type CreateOpenAIProvider,
  type CreateAnthropicProvider,
} from './pii-shield/index.js';
