// ============================================================================
// glirastes/server/testing
//
// Test framework for AI pipeline behavior — guardrails, routing,
// tool registry smoke tests, and approval flag validation.
// No LLM calls needed.
// ============================================================================

// Main API
export { createAiTestSuite } from './create-test-suite.js';

// Types
export type {
  TestSuiteConfig,
  RoutingTestCase,
  GuardrailsTestOptions,
  SimulatedPipelineResult,
  AiTestSuite,
  CombinationTestCase,
  CombinationTestOptions,
  ExecutionStep,
  EdgeCaseTestOptions,
  CustomEdgeCase,
  SchemaConsistencyChain,
  SchemaConsistencyOptions,
  RegressionTestCase,
  RegressionContext,
  MockToolExecutor,
  ToolDefinitionForTest,
} from './types.js';

// Low-level building blocks (for advanced usage)
export { runSmokeTest } from './smoke.js';
export { runRoutingTest } from './routing.js';
export { runGuardrailsTest } from './guardrails.js';
export { runApprovalTest } from './approvals.js';
export { runCombinationTest } from './combination.js';
export { runEdgeCaseTest } from './edge-cases.js';
export { runSchemaConsistencyTest } from './schema-consistency.js';
export { runRegressionTest } from './regression.js';
export { createMockToolExecutor } from './mock-executor.js';
export {
  buildPipelineComponents,
  simulatePipeline,
  collectAllModuleTools,
  getToolsByModule,
} from './helpers.js';
