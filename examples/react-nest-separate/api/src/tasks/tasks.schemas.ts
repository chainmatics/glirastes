import { z } from 'zod';

export const listTasksQuery = z.object({ status: z.enum(['open', 'done']).optional() }).strict();
export const taskOutput = z.object({ id: z.string(), title: z.string(), status: z.enum(['open', 'done']) });
export const listTasksOutput = z.object({ tasks: z.array(taskOutput) })
  .describe('List your tasks, optionally only open or done ones.');
export const createTaskInput = z.object({ title: z.string().min(1) }).strict();

export type ListTasksQuery = z.infer<typeof listTasksQuery>;
export type CreateTaskInput = z.infer<typeof createTaskInput>;
export type Task = z.infer<typeof taskOutput>;
