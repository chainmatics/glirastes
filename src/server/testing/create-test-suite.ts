import type {
  IntentClassification,
} from '../../types.js';
import type {
  TestSuiteConfig,
  RoutingTestCase,
  GuardrailsTestOptions,
  AiTestSuite,
  SimulatedPipelineResult,
  CombinationTestCase,
  CombinationTestOptions,
  EdgeCaseTestOptions,
  SchemaConsistencyOptions,
  RegressionTestCase,
} from './types.js';
import {
  buildPipelineComponents,
  simulatePipeline as runSimulation,
} from './helpers.js';
import { runSmokeTest } from './smoke.js';
import { runRoutingTest } from './routing.js';
import { runGuardrailsTest } from './guardrails.js';
import { runApprovalTest } from './approvals.js';
import { runCombinationTest } from './combination.js';
import { runEdgeCaseTest } from './edge-cases.js';
import { runSchemaConsistencyTest } from './schema-consistency.js';
import { runRegressionTest } from './regression.js';

/**
 * Create an AI test suite for testing pipeline behavior without LLM calls.
 *
 * Each method registers `describe`/`it` blocks via Vitest globals.
 * Call the methods at the top level of your test file (outside `describe`).
 *
 * @example
 * ```ts
 * import { createAiTestSuite } from './index.js';
 * import { modules } from '@/lib/ai/module-definitions';
 *
 * const suite = createAiTestSuite({
 *   modules,
 *   pipeline: {
 *     guardrails: { enableInjectionDetection: true, maxInputLength: 4000 },
 *     confidenceThresholds: { high: 0.85, medium: 0.65 },
 *   },
 * });
 *
 * suite.smokeTest();
 * suite.guardrailsTest();
 *
 * suite.routingTest([
 *   { input: 'show my tasks', expectModule: 'task_query', expectTools: ['list_tasks'] },
 * ]);
 * ```
 */
export function createAiTestSuite(config: TestSuiteConfig): AiTestSuite {
  const {
    modules,
    tools: toolRegistry,
    pipeline,
  } = config;

  const components = buildPipelineComponents(
    modules,
    pipeline?.guardrails,
    pipeline?.confidenceThresholds,
  );

  return {
    smokeTest(): void {
      runSmokeTest(modules, toolRegistry);
    },

    routingTest(cases: RoutingTestCase[]): void {
      runRoutingTest(components, cases);
    },

    guardrailsTest(options?: GuardrailsTestOptions): void {
      runGuardrailsTest(pipeline?.guardrails, options);
    },

    approvalTest(): void {
      if (!toolRegistry) {
        throw new Error(
          'approvalTest() requires a tool registry. Pass `tools` to createAiTestSuite().',
        );
      }
      runApprovalTest(toolRegistry);
    },

    simulatePipeline(
      input: string,
      intent: IntentClassification,
    ): SimulatedPipelineResult {
      return runSimulation(components, input, intent);
    },

    combinationTest(cases?: CombinationTestCase[], options?: CombinationTestOptions): void {
      runCombinationTest(components, cases, options);
    },

    edgeCaseTest(options?: EdgeCaseTestOptions): void {
      if (!toolRegistry) {
        throw new Error(
          'edgeCaseTest() requires a tool registry. Pass `tools` to createAiTestSuite().',
        );
      }
      runEdgeCaseTest(toolRegistry, options);
    },

    schemaConsistencyTest(options: SchemaConsistencyOptions): void {
      if (!toolRegistry) {
        throw new Error(
          'schemaConsistencyTest() requires a tool registry. Pass `tools` to createAiTestSuite().',
        );
      }
      runSchemaConsistencyTest(toolRegistry, options);
    },

    regressionTest(cases: RegressionTestCase[]): void {
      runRegressionTest(components, toolRegistry ?? {}, cases);
    },
  };
}
