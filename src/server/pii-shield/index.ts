// Factory
export { createPiiShield } from './create-pii-shield.js';

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
