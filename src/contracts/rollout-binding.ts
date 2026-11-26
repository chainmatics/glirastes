import { z } from 'zod';

/** Value of the `canaryVersion` sync query a runner sends to receive `rolloutBinding`. */
export const CANARY_SELECTION_SYNC_VERSION = 1;
/** Value of `capabilities.canarySelection` a runner reports at registration. */
export const CANARY_SELECTION_CAPABILITY = 1;
export const ROLLOUT_BINDING_SCHEMA_VERSION = 1;

// Same shape as RevisionSignatureSchema; revisions.ts imports this module.
const signature = z.object({
  algorithm: z.literal('Ed25519'),
  keyId: z.string().trim().min(1).max(200),
  value: z.string().trim().min(8).max(1_024),
}).strict();

/**
 * The signed rollout of one deployment: mode, share and the cohort salt the
 * runner buckets subjects with. The signature covers `canonicalRuntimeJson`
 * of the object without `signature`. Without a valid binding a runner never
 * selects a canary.
 */
export const RolloutBindingSchema = z.object({
  kind: z.literal('rollout-binding'),
  schemaVersion: z.literal(ROLLOUT_BINDING_SCHEMA_VERSION),
  deploymentId: z.uuid(),
  environmentId: z.uuid(),
  rolloutMode: z.enum(['stable', 'canary']),
  targetPercentage: z.number().int().min(1).max(100),
  cohortSalt: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  issuedAt: z.iso.datetime({ offset: true }),
  signature,
}).strict().superRefine((binding, context) => {
  if (binding.rolloutMode === 'stable' ? binding.targetPercentage !== 100 : binding.targetPercentage >= 100) {
    context.addIssue({
      code: 'custom',
      message: 'A stable rollout targets 100 percent, a canary less',
      path: ['targetPercentage'],
    });
  }
});

export type RolloutBinding = z.infer<typeof RolloutBindingSchema>;
