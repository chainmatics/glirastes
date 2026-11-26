import { z } from 'zod';

/** Value of the `controlVersion` sync query a runner sends to receive `control`. */
export const ENVIRONMENT_CONTROL_SYNC_VERSION = 1;
/** Value of `capabilities.environmentControl` a runner reports at registration. */
export const ENVIRONMENT_CONTROL_CAPABILITY = 1;
export const ENVIRONMENT_CONTROL_SCHEMA_VERSION = 1;

const uuid = z.uuid();
// Same shape as RevisionSignatureSchema; revisions.ts imports this module.
const signature = z.object({
  algorithm: z.literal('Ed25519'),
  keyId: z.string().trim().min(1).max(200),
  value: z.string().trim().min(8).max(1_024),
}).strict();

/** Upper bounds that can only lower the local `ExecutionBudget`, field by field. */
export const EnvironmentControlBudgetCeilingSchema = z.object({
  maxModelSteps: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  totalTimeoutMs: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxEstimatedCostUsd: z.number().finite().nonnegative().optional(),
}).strict().refine(
  (ceiling) => Object.values(ceiling).some((value) => value !== undefined),
  { message: 'A budget ceiling names at least one field' },
);

export const EnvironmentControlRateLimitSchema = z.object({
  maxTurnsPerMinutePerPrincipal: z.number().int().min(1).max(600),
}).strict();

export const EnvironmentControlReasonCodeSchema = z.string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/);

/**
 * The signed, per-environment control object (kill switch, budget ceiling,
 * rate limit). The signature covers `canonicalRuntimeJson` of the object
 * without `signature`; `sequence` is strictly monotonic per environment.
 */
export const EnvironmentControlSchema = z.object({
  schemaVersion: z.literal(ENVIRONMENT_CONTROL_SCHEMA_VERSION),
  tenantId: uuid,
  targetAppId: uuid,
  environmentId: uuid,
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  assistant: z.enum(['enabled', 'halted']),
  budgetCeiling: EnvironmentControlBudgetCeilingSchema.optional(),
  rateLimit: EnvironmentControlRateLimitSchema.optional(),
  reasonCode: EnvironmentControlReasonCodeSchema,
  issuedAt: z.iso.datetime({ offset: true }),
  signature,
}).strict();

/**
 * Set locally when a delivered control fails its schema or signature: the
 * runner halts until a valid control with a higher sequence arrives.
 */
export const LocalEnvironmentControlHaltSchema = z.object({
  kind: z.literal('local'),
  assistant: z.literal('halted'),
  reasonCode: z.literal('control_unverifiable'),
  /** The sequence a replacement must exceed: the last accepted one, or 0. */
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  detectedAt: z.iso.datetime({ offset: true }),
}).strict();

export type EnvironmentControl = z.infer<typeof EnvironmentControlSchema>;
export type EnvironmentControlBudgetCeiling = z.infer<typeof EnvironmentControlBudgetCeilingSchema>;
export type EnvironmentControlRateLimit = z.infer<typeof EnvironmentControlRateLimitSchema>;
export type LocalEnvironmentControlHalt = z.infer<typeof LocalEnvironmentControlHaltSchema>;
/** What a runner enforces: the accepted control, or a local fail-closed halt. */
export type EffectiveEnvironmentControl = EnvironmentControl | LocalEnvironmentControlHalt;
