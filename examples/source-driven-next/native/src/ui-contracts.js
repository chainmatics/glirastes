import { z } from 'zod';

/** Payload of the tasks.highlight client action. */
export const highlightTask = z.object({ title: z.string().min(1) }).strict();
