import { z } from 'zod';
import { findForbiddenContentPath } from './content-boundary.js';

const identifier = z.string().trim().min(1).max(200);
const uuid = z.uuid();

export const RuntimeEnvironmentNameSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);

export const RuntimeEnvironmentSchema = z.object({
  id: uuid,
  tenantId: uuid,
  targetAppId: uuid,
  name: RuntimeEnvironmentNameSchema,
  status: z.enum(['disconnected', 'connecting', 'connected', 'degraded', 'disabled']),
}).strict();

export const PrincipalSchema = z.object({
  subjectId: identifier,
  tenantId: identifier,
  roles: z.array(identifier).max(100),
  attributes: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((principal, context) => {
  const path = findForbiddenContentPath(principal.attributes, ['attributes']);
  if (path) {
    context.addIssue({
      code: 'custom',
      message: 'Principal attributes must not contain raw credentials',
      path,
    });
  }
});

export const DelegationBudgetSchema = z.object({
  maxDepth: z.number().int().min(0).max(32),
  maxBreadth: z.number().int().min(0).max(128),
  sharedBudget: z.boolean(),
}).strict();

export const ExecutionBudgetSchema = z.object({
  maxModelSteps: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  totalTimeoutMs: z.number().int().positive(),
  toolTimeoutMs: z.number().int().positive(),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxEstimatedCostUsd: z.number().finite().nonnegative(),
  maxRepeatedFingerprint: z.number().int().positive(),
  maxConsecutiveErrors: z.number().int().positive(),
  delegation: DelegationBudgetSchema,
}).strict().superRefine((budget, context) => {
  if (budget.toolTimeoutMs > budget.totalTimeoutMs) {
    context.addIssue({
      code: 'custom',
      message: 'Tool timeout cannot exceed total timeout',
      path: ['toolTimeoutMs'],
    });
  }
});

export type RuntimeEnvironment = z.infer<typeof RuntimeEnvironmentSchema>;
export type Principal = z.infer<typeof PrincipalSchema>;
export type DelegationBudget = z.infer<typeof DelegationBudgetSchema>;
export type ExecutionBudget = z.infer<typeof ExecutionBudgetSchema>;
