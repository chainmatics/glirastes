// Server core (includes native telemetry forwarding via TelemetrySink interface)
export * from './core/index.js';

// AI pipeline (multi-stage: guardrails → classify → route → model select)
export * from './pipeline.js';

// Lancer (platform client) — createLancer, ServiceBlockedError, types
export * from './lancer/index.js';

// PII shield
export { createPiiShield } from './pii-shield/index.js';
export { createAegisDetector } from './pii-shield/index.js';
export type { AegisLike } from './pii-shield/index.js';
