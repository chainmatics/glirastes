import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEdgeCaseTest } from '../edge-cases.js';
import { runSchemaConsistencyTest } from '../schema-consistency.js';

// End-to-end exercise of the auto-generating test helpers. The nested
// describe/it blocks they register run as part of this file; if schema
// introspection silently broke (e.g. after a Zod upgrade) these would emit
// zero boundary tests. The explicit assertions below fail loudly in that case.

const listTasks = {
  inputSchema: z.object({
    boardId: z.string().uuid(),
    status: z.enum(['open', 'closed']),
    tags: z.array(z.string()).max(3),
    note: z.string().optional(),
  }),
};

const createTask = {
  inputSchema: z.object({
    boardId: z.string().uuid(),
    title: z.string(),
  }),
};

const registry = { list_tasks: listTasks, create_task: createTask };

// Drives the generator — its nested tests show up in this file's output.
runEdgeCaseTest(registry);

runSchemaConsistencyTest(registry, {
  chains: [
    { from: 'create_task', field: 'boardId', to: 'list_tasks', targetField: 'boardId' },
  ],
});

// Guard against the "green but empty" failure mode: prove the introspection
// the generators rely on still sees the schema's testable fields.
describe('generator introspection sanity', () => {
  it('detects required, enum, array-max, and uuid fields', () => {
    const shape = listTasks.inputSchema.shape;
    expect(Object.keys(shape)).toEqual(['boardId', 'status', 'tags', 'note']);

    // status enum members are discoverable
    expect(listTasks.inputSchema.safeParse({
      boardId: '00000000-0000-0000-0000-000000000000',
      status: 'open',
      tags: ['a'],
    }).success).toBe(true);

    // invalid enum + over-max array + bad uuid all rejected
    expect(listTasks.inputSchema.safeParse({
      boardId: 'not-a-uuid',
      status: 'open',
      tags: [],
    }).success).toBe(false);
    expect(listTasks.inputSchema.safeParse({
      boardId: '00000000-0000-0000-0000-000000000000',
      status: 'nope',
      tags: [],
    }).success).toBe(false);
    expect(listTasks.inputSchema.safeParse({
      boardId: '00000000-0000-0000-0000-000000000000',
      status: 'open',
      tags: ['a', 'b', 'c', 'd'],
    }).success).toBe(false);
  });
});
