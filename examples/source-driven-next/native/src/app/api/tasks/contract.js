import { z } from 'zod';

export const inputSchema = z.object({ status: z.enum(['open', 'done']).optional() }).strict();
export const outputSchema = z.object({
  tasks: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(['open', 'done']) })),
}).describe('List your tasks, optionally filtered by status.');
