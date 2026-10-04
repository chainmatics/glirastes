import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createToolResultRendererRegistry,
  defineToolResultRenderer,
} from '../registry.js';

const V1 = defineToolResultRenderer({
  definitionId: 'tasks.listTasks',
  schemaVersion: 1,
  outputSchema: z.object({ success: z.literal(true), data: z.array(z.string()) }),
  component: () => null,
});

const V2 = defineToolResultRenderer({
  definitionId: 'tasks.listTasks',
  schemaVersion: 2,
  outputSchema: z.object({
    success: z.literal(true),
    data: z.array(z.object({ id: z.string(), title: z.string() })),
  }),
  component: () => null,
});

describe('createToolResultRendererRegistry', () => {
  const registry = createToolResultRendererRegistry([V1, V2]);

  it('matches the model-facing and the definition name', () => {
    const output = { success: true, data: [{ id: '1', title: 'Bericht' }] };
    expect(registry.resolve('tasks_listTasks', output)?.renderer).toBe(V2);
    expect(registry.resolve('tasks.listTasks', output)?.renderer).toBe(V2);
    expect(registry.size).toBe(2);
  });

  it('falls back to an older version for an old stored message', () => {
    expect(registry.resolve('tasks_listTasks', { success: true, data: ['Bericht'] }))
      .toEqual({ renderer: V1, output: { success: true, data: ['Bericht'] } });
  });

  it('returns nothing for unknown tools, failed results or throwing schemas', () => {
    expect(registry.resolve('tasks_createTask', { success: true })).toBeUndefined();
    expect(registry.resolve('tasks_listTasks', { success: false, error: 'x' })).toBeUndefined();
    const throwing = createToolResultRendererRegistry([{
      ...V1,
      outputSchema: { safeParse: () => { throw new Error('boom'); } },
    }]);
    expect(throwing.resolve('tasks_listTasks', {})).toBeUndefined();
  });

  it('rejects duplicate versions and invalid metadata', () => {
    expect(() => createToolResultRendererRegistry([V1, V1])).toThrow(/Duplicate/);
    expect(() => createToolResultRendererRegistry([{ ...V1, schemaVersion: 0 }])).toThrow(/schemaVersion/);
    expect(() => createToolResultRendererRegistry([{ ...V1, definitionId: 'a b' }])).toThrow(/definitionId/);
  });
});
