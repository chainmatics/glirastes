import type {
  ModuleDefinition,
  GuardrailsConfig,
  IntentClassification,
} from '../../types.js';
/** Duck-typed Zod schema interface to avoid direct zod dependency */
interface ZodLikeSchema {
  safeParse(input: unknown): { success: boolean; error?: { issues: unknown[] } };
}

// ============================================================================
// Test Suite Configuration
// ============================================================================

export interface TestSuiteConfig {
  /** Module definitions (same as used in the app's pipeline) */
  modules: ModuleDefinition[];

  /** Tool registry — Record<toolName, toolDefinition> */
  tools?: Record<string, unknown>;

  /** Pipeline configuration matching the app */
  pipeline?: {
    guardrails?: GuardrailsConfig;
    confidenceThresholds?: {
      high?: number;
      medium?: number;
    };
  };

  /** Locale hint for test descriptions (default: 'en') */
  locale?: string;
}

// ============================================================================
// Routing Test Cases
// ============================================================================

export interface RoutingTestCase {
  /** Natural-language input */
  input: string;
  /** Expected module ID (e.g., 'task_query') */
  expectModule: string;
  /** Tools that MUST be present in the result */
  expectTools?: string[];
  /** Tools that MUST NOT be present */
  excludeTools?: string[];
  /** Override confidence (default: 0.95) */
  confidence?: number;
}

// ============================================================================
// Guardrails Test Overrides
// ============================================================================

export interface GuardrailsTestOptions {
  /** Extra injection patterns to test (appended to defaults) */
  extraInjectionInputs?: string[];
  /** Extra valid inputs to test */
  extraValidInputs?: string[];
}

// ============================================================================
// Pipeline Simulation Result
// ============================================================================

export interface SimulatedPipelineResult {
  blocked: boolean;
  tools: string[];
  module: string | null;
  intent: IntentClassification;
  strategy?: 'single' | 'expanded' | 'all';
}

// ============================================================================
// Test Suite API
// ============================================================================

export interface AiTestSuite {
  /** Auto-generated smoke tests: module completeness, tool naming, no duplicates */
  smokeTest(): void;

  /** Deterministic routing tests with provided test cases */
  routingTest(cases: RoutingTestCase[]): void;

  /** Auto-generated guardrails tests: injection, length, sanitization */
  guardrailsTest(options?: GuardrailsTestOptions): void;

  /** Auto-generated approval flag tests: mutations need approval, queries don't */
  approvalTest(): void;

  /** Low-level pipeline simulation for custom assertions */
  simulatePipeline(input: string, intent: IntentClassification): SimulatedPipelineResult;

  /** Tool combination & workflow chain tests */
  combinationTest(cases?: CombinationTestCase[], options?: CombinationTestOptions): void;

  /** Auto-generated edge case tests from Zod schemas + custom business-logic cases */
  edgeCaseTest(options?: EdgeCaseTestOptions): void;

  /** Verify tool output→input type compatibility across workflow chains */
  schemaConsistencyTest(options: SchemaConsistencyOptions): void;

  /** User-defined regression tests with pipeline simulation context */
  regressionTest(cases: RegressionTestCase[]): void;
}

// ============================================================================
// Combination Test Cases
// ============================================================================

export interface CombinationTestCase {
  /** Human-readable workflow name */
  name: string;
  /** The module this workflow targets */
  intent: string;
  /** All tools that must be available simultaneously */
  requiredToolChain: string[];
  /** Confidence level (default: 0.95 for single-module, 0.75 for expanded) */
  confidence?: number;
  /** Optional HTTP-level execution chain (requires toolExecutor) */
  execution?: ExecutionStep[];
  /** Assertions on the execution result */
  expect?: { finalToolResult?: unknown; allToolsSucceeded?: boolean };
}

export interface ExecutionStep {
  tool: string;
  input: Record<string, unknown>;
  mockResponse: unknown;
}

export interface CombinationTestOptions {
  /** Mock tool executor for HTTP-level execution tests */
  toolExecutor?: MockToolExecutor;
}

// ============================================================================
// Edge Case Tests
// ============================================================================

export interface EdgeCaseTestOptions {
  /** Skip these tools (e.g. synthetic tools like suggest_followups) */
  skipTools?: string[];
  /** Custom business-logic edge cases per tool */
  customCases?: Record<string, CustomEdgeCase[]>;
}

export interface CustomEdgeCase {
  label: string;
  input: Record<string, unknown>;
  expectError: boolean;
  errorMessage?: string;
}

// ============================================================================
// Schema Consistency Tests
// ============================================================================

export interface SchemaConsistencyChain {
  /** Source tool name */
  from: string;
  /** Output field path (e.g. 'id', 'tasks[].id') */
  field: string;
  /** Target tool name */
  to: string;
  /** Input field (e.g. 'assigneeId', 'taskIds') */
  targetField: string;
}

export interface SchemaConsistencyOptions {
  chains: SchemaConsistencyChain[];
}

// ============================================================================
// Regression Tests
// ============================================================================

export interface RegressionTestCase {
  /** Regression name */
  name: string;
  /** Bug reference (e.g. 'LIN-123', 'commit abc1234') */
  reference?: string;
  /** Description of the original bug */
  description: string;
  /** Test function — receives context with pipeline simulation + tool access */
  verify: (ctx: RegressionContext) => void | Promise<void>;
}

export interface RegressionContext {
  /** Simulate pipeline routing */
  simulatePipeline: AiTestSuite['simulatePipeline'];
  /** Tool registry for schema access */
  tools: Record<string, unknown>;
  /** Module definitions */
  modules: ModuleDefinition[];
}

// ============================================================================
// Mock Tool Executor
// ============================================================================

export interface MockToolExecutor {
  execute(
    toolName: string,
    input: Record<string, unknown>,
    mockResponse: unknown,
  ): { success: boolean; validationError?: string; response: unknown };
}

// ============================================================================
// Tool Definition for Tests (extended shape)
// ============================================================================

export interface ToolDefinitionForTest {
  toolName?: string;
  inputSchema?: ZodLikeSchema;
  needsApproval?: boolean;
  method?: string;
  module?: string;
  [key: string]: unknown;
}
