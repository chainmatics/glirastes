import { describe, it, expect } from 'vitest';

interface ToolWithApproval {
  needsApproval?: boolean;
  method?: string;
  [key: string]: unknown;
}

/**
 * Auto-generates approval flag tests from a tool registry.
 *
 * Convention:
 * - Tools with method POST/PATCH/PUT/DELETE should resolve to needsApproval: true
 *   (this is the default in server-node when needsApproval is omitted)
 * - Tools with method GET (or no method, i.e. UI tools) should have needsApproval: false/undefined
 *
 * This test verifies that mutation tools have not been explicitly set to needsApproval: false.
 */
export function runApprovalTest(
  toolRegistry: Record<string, unknown>,
): void {
  const tools = Object.entries(toolRegistry) as Array<[string, ToolWithApproval]>;

  if (tools.length === 0) {
    return;
  }

  const mutationMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

  describe('AI Tool Approval Flags', () => {
    const mutationTools = tools.filter(
      ([, def]) => def.method && mutationMethods.has(def.method.toUpperCase()),
    );
    const queryTools = tools.filter(
      ([, def]) => !def.method || def.method.toUpperCase() === 'GET',
    );

    if (mutationTools.length > 0) {
      describe('mutation tools require approval', () => {
        it.each(mutationTools.map(([name, def]) => [name, def.method]))(
          '%s (%s) has needsApproval: true',
          (name) => {
            const tool = toolRegistry[name as string] as ToolWithApproval;
            expect(
              tool.needsApproval,
              `${name} is a mutation tool and should require approval`,
            ).toBe(true);
          },
        );
      });
    }

    if (queryTools.length > 0) {
      describe('query/UI tools do not require approval', () => {
        it.each(queryTools.map(([name]) => [name]))(
          '%s does not require approval',
          (name) => {
            const tool = toolRegistry[name as string] as ToolWithApproval;
            expect(
              tool.needsApproval,
              `${name} is a query tool and should not require approval`,
            ).toBeFalsy();
          },
        );
      });
    }
  });
}
