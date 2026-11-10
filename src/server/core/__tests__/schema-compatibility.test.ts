import { describe, expect, it } from 'vitest';
import { z as z3 } from 'zod-v3';
import {
  createUiActionSchema,
  defineEndpointTool,
} from '../../../types.js';
import { endpointToolsToRegistry } from '../index.js';

describe('host schema compatibility', () => {
  it('accepts Zod 3 endpoint schemas without converting them', () => {
    const definition = defineEndpointTool({
      id: 'tasks.list',
      toolName: 'list_tasks',
      description: 'List tasks.',
      method: 'GET',
      path: '/api/tasks',
      inputSchema: z3.object({ limit: z3.number().optional() }),
      outputSchema: z3.object({ id: z3.string() }),
    });

    const registry = endpointToolsToRegistry([definition]);

    expect(registry.list_tasks?.inputSchema.safeParse({ limit: 10 }).success)
      .toBe(true);
    expect(registry.list_tasks?.description)
      .toContain('Returns: { id: string }');
  });

  it('composes built-in actions with host-provided Zod 3 actions', () => {
    const schema = createUiActionSchema([
      z3.object({
        type: z3.literal('set-filter'),
        value: z3.string(),
      }).strict(),
    ]);

    expect(schema.safeParse({
      type: 'set-filter',
      value: 'open',
    }).success).toBe(true);
    expect(schema.safeParse({
      type: 'navigate',
      path: '/tasks',
    }).success).toBe(true);
    expect(schema.safeParse({
      type: 'set-filter',
      value: 42,
    }).success).toBe(false);
  });
});
