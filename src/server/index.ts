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
