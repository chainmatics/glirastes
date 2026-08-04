import { describe, it, expect } from 'vitest';
import type { ModuleDefinition } from '../../types.js';
import { getToolsByModule } from './helpers.js';

/**
 * Tool names are either dotted definitionIds with camelCase segments
 * (`ui.navigate`, `tasks.bulkUpdateStatus`) — the managed manifest's name
 * domain — or historical snake_case names.
 */
export const TOOL_NAME_PATTERN =
  /^[a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*$/;

/**
 * Auto-generates smoke tests from module definitions.
 *
 * Tests:
 * - Every module has at least 1 tool
 * - All tool names follow the naming convention
 * - No duplicate tool names within a module
 * - If a tool registry is provided, all module tools exist in it
 */
export function runSmokeTest(
  modules: ModuleDefinition[],
  toolRegistry?: Record<string, unknown>,
): void {
  const toolsByModule = getToolsByModule(modules);
  const moduleIds = modules.map((m) => m.id);

  describe('AI Tool Registry Smoke Tests', () => {
    describe('module completeness', () => {
      it(`has ${modules.length} intent modules`, () => {
        expect(moduleIds).toHaveLength(modules.length);
        for (const mod of modules) {
          expect(moduleIds).toContain(mod.id);
        }
      });

      it('every module has at least 1 tool', () => {
        for (const id of moduleIds) {
          expect(
            toolsByModule[id].length,
            `${id} should have tools`,
          ).toBeGreaterThan(0);
        }
      });
    });

    describe('tool naming conventions', () => {
      const allTools = Object.values(toolsByModule).flat();

      it('all tool names follow the naming convention', () => {
        for (const tool of allTools) {
          expect(
            tool,
            `Tool "${tool}" should be a definitionId or snake_case name`,
          ).toMatch(TOOL_NAME_PATTERN);
        }
      });

      it('no duplicate tool names within a module', () => {
        for (const id of moduleIds) {
          const tools = toolsByModule[id];
          const unique = new Set(tools);
          expect(unique.size, `${id} has duplicates`).toBe(tools.length);
        }
      });
    });

    if (toolRegistry) {
      describe('registry completeness', () => {
        const registryToolNames = new Set(Object.keys(toolRegistry));

        it('all module tools exist in the tool registry', () => {
          const missing: string[] = [];
          for (const id of moduleIds) {
            for (const tool of toolsByModule[id]) {
              if (!registryToolNames.has(tool)) {
                missing.push(`${id}/${tool}`);
              }
            }
          }
          expect(
            missing,
            `Missing tools in registry: ${missing.join(', ')}`,
          ).toHaveLength(0);
        });
      });
    }
  });
}
