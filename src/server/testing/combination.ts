import { describe, it, expect } from 'vitest';
import type { PipelineComponents } from './helpers.js';
import { simulatePipeline } from './helpers.js';
import type {
  CombinationTestCase,
  CombinationTestOptions,
} from './types.js';

export function runCombinationTest(
  components: PipelineComponents,
  cases?: CombinationTestCase[],
  options?: CombinationTestOptions,
): void {
  const { modules } = components;

  describe('AI Tool Combinations', () => {
    // ── Auto-generated: shared tool availability ──────────────────────
    const modulesWithSharedTools = modules.filter(
      (mod) => mod.sharedTools && mod.sharedTools.length > 0,
    );

    if (modulesWithSharedTools.length > 0) {
      describe('shared tool availability', () => {
        for (const mod of modulesWithSharedTools) {
          for (const sharedTool of mod.sharedTools!) {
            it(`${sharedTool} available in ${mod.id} (shared tool)`, () => {
              const result = simulatePipeline(components, `test ${mod.id}`, {
                intent: mod.id,
                confidence: 0.95,
              });
              expect(
                result.tools,
                `${sharedTool} should be in ${mod.id} tool set`,
              ).toContain(sharedTool);
            });
          }
        }
      });
    }

    // ── Auto-generated: core tools present at high confidence ────────
    describe('core tool availability', () => {
      for (const mod of modules) {
        it(`${mod.id} includes all declared core tools at high confidence`, () => {
          const result = simulatePipeline(components, `test ${mod.id}`, {
            intent: mod.id,
            confidence: 0.95,
          });

          for (const tool of mod.tools) {
            expect(
              result.tools,
              `Core tool "${tool}" should be in ${mod.id}`,
            ).toContain(tool);
          }
        });
      }
    });

    // ── User-defined workflow chains ─────────────────────────────────
    if (cases && cases.length > 0) {
      describe('workflow chains', () => {
        for (const testCase of cases) {
          const confidence = testCase.confidence ?? 0.95;

          it(`${testCase.name}: all tools available`, () => {
            const result = simulatePipeline(components, testCase.name, {
              intent: testCase.intent,
              confidence,
            });

            expect(result.blocked).toBe(false);

            for (const tool of testCase.requiredToolChain) {
              expect(
                result.tools,
                `Workflow "${testCase.name}" requires "${tool}" in ${testCase.intent}`,
              ).toContain(tool);
            }
          });
        }
      });

      // ── HTTP execution chains (optional) ─────────────────────────
      const executor = options?.toolExecutor;
      const casesWithExecution = cases.filter((c) => c.execution && c.execution.length > 0);

      if (executor && casesWithExecution.length > 0) {
        describe('HTTP execution chains', () => {
          for (const testCase of casesWithExecution) {
            it(`${testCase.name}: mock execution succeeds`, () => {
              const results: Array<{ tool: string; success: boolean }> = [];

              for (const step of testCase.execution!) {
                const result = executor.execute(step.tool, step.input, step.mockResponse);
                results.push({ tool: step.tool, success: result.success });

                if (result.validationError) {
                  expect.fail(
                    `Tool "${step.tool}" input validation failed: ${result.validationError}`,
                  );
                }
              }

              if (testCase.expect?.allToolsSucceeded) {
                for (const r of results) {
                  expect(r.success, `${r.tool} should succeed`).toBe(true);
                }
              }
            });
          }
        });
      }
    }
  });
}
