import { z } from 'zod';
import { findForbiddenContentPath } from './content-boundary.js';

export const TechnicalRuntimeEventSchema = z.object({
  eventId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  eventType: z.string().trim().min(1).max(100),
  tenantId: z.uuid(),
  targetAppId: z.uuid(),
  environmentId: z.uuid(),
  agentRevisionId: z.uuid().optional(),
  policyRevisionId: z.uuid().optional(),
  manifestRevisionId: z.uuid().optional(),
  runId: z.string().trim().min(1).max(200),
  status: z.string().trim().min(1).max(100),
  durationMs: z.number().int().nonnegative().optional(),
  errorClass: z.string().trim().min(1).max(200).optional(),
  budget: z.object({
    modelSteps: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().finite().nonnegative().optional(),
  }).strict().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((event, context) => {
  const path = findForbiddenContentPath(event.metadata, ['metadata']);
  if (path) {
    context.addIssue({
      code: 'custom',
      message: 'Technical runtime events must not contain business content or credentials',
      path,
    });
  }
});

export type TechnicalRuntimeEvent = z.infer<typeof TechnicalRuntimeEventSchema>;
