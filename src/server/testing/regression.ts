import { describe, it } from 'vitest';
import type { PipelineComponents } from './helpers.js';
import { simulatePipeline } from './helpers.js';
import type { RegressionTestCase, RegressionContext } from './types.js';

/**
 * Runs user-defined regression tests with access to pipeline simulation
 * and tool registry for custom assertions.
 */
export function runRegressionTest(
  components: PipelineComponents,
  toolRegistry: Record<string, unknown>,
  cases: RegressionTestCase[],
): void {
  if (cases.length === 0) return;

  const ctx: RegressionContext = {
    simulatePipeline: (input, intent) => simulatePipeline(components, input, intent),
    tools: toolRegistry,
    modules: components.modules,
  };

  describe('AI Regression Tests', () => {
    for (const testCase of cases) {
      const ref = testCase.reference ? `[${testCase.reference}] ` : '';
      const label = `${ref}${testCase.name}`;

      it(label, async () => {
        await testCase.verify(ctx);
      });
    }
  });
}
