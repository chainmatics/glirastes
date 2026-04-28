import { z } from 'zod';
import { defineEndpointTool } from 'glirastes';

export const listTasks = defineEndpointTool({
  id: 'tasks.list',
  toolName: 'list_tasks',
  description: 'List tasks with an optional status filter.',
  method: 'GET',
  path: '/api/tasks',
  inputSchema: z.object({
    status: z.enum(['open', 'done']).optional(),
  }),
});
