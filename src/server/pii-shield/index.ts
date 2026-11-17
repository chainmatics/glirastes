// Factory
export { createPiiShield } from './create-pii-shield.js';
export {
  createRegexPiiDetector,
  type RegexPiiDetectorConfig,
} from './regex-detector.js';

// Aegis (Pro) detector adapter
export { createAegisDetector } from './aegis-detector.js';
export type { AegisLike } from './aegis-detector.js';

// Re-export types from contracts for convenience
export type {
  PiiCategory,
  PiiEntity,
  PiiDetector,
  PiiShield,
  PiiShieldConfig,
  PiiAuditEntry,
  ComplianceSummary,
  MappingEntry,
} from '../../types.js';

// Protected-text profile (protected-text/v1): fail closed, scoped persistent mapping
export {
  PrivacyError,
  isPrivacyError,
  toSafeError,
  detectStrict,
  detectOrThrow,
  REMOTE_DETECTOR,
  type PrivacyErrorCode,
  type SafeErrorSummary,
  type DetectionResult,
  type StrictDetectorOptions,
} from './detection-result.js';
export {
  assertPrivacyScope,
  createMemoryPrivacyMappingStore,
  parsePrivacyKeyring,
  scopeKeyOf,
  type PrivacyScope,
  type MappingEntry as PrivacyMappingEntry,
  type MappingSnapshot,
  type MappingLifetime,
  type PrivacyKeyring,
  type PrivacyMappingStore,
} from './mapping-store.js';
export {
  createPostgresPrivacyMappingStore,
  POSTGRES_PRIVACY_MAPPING_SCHEMA_SQL,
  type PostgresPrivacyMappingStoreOptions,
} from './postgres-mapping-store.js';
export {
  createStrictPiiShield,
  PROTECTED_TEXT_PROFILE,
  type StrictPiiShield,
  type StrictPiiShieldConfig,
  type PrivacySession,
  type PrivacyAuditEvent,
} from './strict-shield.js';
export { extractIdentitiesFromJson, type KnownIdentity } from './known-identities.js';
export {
  createPrivacyBoundary,
  isPrivacyWrappedModel,
  DEFAULT_PROVIDER_OPTIONS_ALLOWLIST,
  type PrivacyBoundary,
  type PrivacyBoundaryOptions,
  type ModelCapabilities,
  type ProviderOptionsAllowlist,
} from './model-boundary.js';
export {
  projectUiMessageStream,
  privacyStatusData,
  privacyStreamErrorText,
  type PrivacyStatusData,
} from './display-projection.js';
export { wrapToolsForPrivacy, type PrivacyToolOptions, type ToolReceiptStore } from './tool-boundary.js';
export {
  resolveAttachmentPolicy,
  attachmentDecision,
  screenshotStatusText,
  BLOCKED_ATTACHMENTS,
  SCREENSHOT_MODES,
  DEFAULT_ALLOWED_IMAGE_TYPES,
  type ScreenshotMode,
  type AttachmentPolicyInput,
  type AttachmentPolicySnapshot,
} from './attachment-policy.js';
export {
  openChatPrivacyTurn,
  privacyRefusal,
  privacySafeError,
  latestUserMessage,
  type ChatPrivacyConfig,
  type ChatPrivacyTurn,
} from './chat-privacy.js';
export {
  protectedStreamText,
  protectedGenerateText,
  protectedGenerateObject,
  type ModelCallProtection,
} from './model-calls.js';
