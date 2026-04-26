import { describe, it, expect } from 'vitest';
import type { PipelineComponents } from './helpers.js';
import { simulatePipeline } from './helpers.js';
import type { RoutingTestCase } from './types.js';

/**
 * Runs deterministic routing tests with provided test cases.
 *
 * Each case simulates the pipeline with a given input and a fixed
 * intent classification (no LLM needed). Asserts:
 * - Correct module is selected
 * - Expected tools are present
 * - Excluded tools are absent
 */
export function runRoutingTest(
  components: PipelineComponents,
  cases: RoutingTestCase[],
): void {
  describe('AI Pipeline Routing (deterministic)', () => {
    for (const testCase of cases) {
      const confidence = testCase.confidence ?? 0.95;
      const label = `"${testCase.input}" → ${testCase.expectModule}`;

      it(label, () => {
        const result = simulatePipeline(components, testCase.input, {
          intent: testCase.expectModule,
          confidence,
        });

        expect(result.blocked).toBe(false);
        expect(result.module).toBe(testCase.expectModule);

        if (testCase.expectTools) {
          for (const tool of testCase.expectTools) {
            expect(
              result.tools,
              `Expected tool "${tool}" in result`,
            ).toContain(tool);
          }
        }

        if (testCase.excludeTools) {
          for (const tool of testCase.excludeTools) {
            expect(
              result.tools,
              `Tool "${tool}" should not be in result`,
            ).not.toContain(tool);
          }
        }
      });
    }

    // Auto-generated edge cases
    describe('edge cases', () => {
      it('ambiguous intent gives all tools', () => {
        const result = simulatePipeline(
          components,
          'Hallo wie geht es dir',
          { intent: 'ambiguous', confidence: 0.30 },
        );
        expect(result.module).toBeNull();
        expect(result.tools.length).toBeGreaterThan(0);
      });

      it('low confidence returns all tools (fallback safety)', () => {
        const firstModule = components.modules[0];
        if (!firstModule) return;

        const result = simulatePipeline(
          components,
          'vague request',
          { intent: firstModule.id, confidence: 0.30 },
        );
        expect(result.module).toBeNull();
        expect(result.strategy).toBe('all');
      });

      it('suggest_followups is always included in non-blocked results', () => {
        const firstModule = components.modules[0];
        if (!firstModule) return;

        const result = simulatePipeline(
          components,
          'test input',
          { intent: firstModule.id, confidence: 0.95 },
        );
        expect(result.tools).toContain('suggest_followups');
      });
    });
  });
}
