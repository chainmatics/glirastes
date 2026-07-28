import { z } from 'zod';
import { ExecutionBudgetSchema } from './runtime.js';
import { findForbiddenContentPath } from './content-boundary.js';

const uuid = z.uuid();
const identifier = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^sha256:[A-Za-z0-9+/=_-]+$/);
const publishedAt = z.iso.datetime({ offset: true });

export const RevisionSignatureSchema = z.object({
  algorithm: z.literal('Ed25519'),
  keyId: identifier,
  value: z.string().trim().min(8).max(1_024),
}).strict();

export const LocalBindingReferenceSchema = z.object({
  bindingId: identifier,
  kind: z.enum(['model', 'tool', 'prompt', 'store']),
  providerAlias: identifier.optional(),
}).strict();

export const ToolRiskClassSchema = z.enum([
  'safe-read',
  'read-sensitive',
  'write',
  'delete',
  'financial',
  'external',
  'unknown',
]);

export const ManifestToolSchema = z.object({
  toolId: uuid,
  sourceFingerprint: digest,
  name: identifier,
  description: z.string().trim().min(1).max(4_000),
  riskClass: ToolRiskClassSchema,
  enabled: z.boolean(),
  tombstone: z.boolean(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').max(2_048),
  inputSchemaDigest: digest,
  outputSchemaDigest: digest,
  authBindingRef: identifier,
}).strict().superRefine((tool, context) => {
  if (tool.tombstone && tool.enabled) {
    context.addIssue({
      code: 'custom',
      message: 'A tombstoned tool cannot remain enabled',
      path: ['enabled'],
    });
  }
});

export const ManifestRevisionSchema = z.object({
  revisionId: uuid,
  revision: z.number().int().positive(),
  tenantId: uuid,
  targetAppId: uuid,
  environmentId: uuid,
  sourceDigest: digest,
  tools: z.array(ManifestToolSchema),
  publishedAt,
  signature: RevisionSignatureSchema,
}).strict();

export const AgentRevisionSchema = z.object({
  revisionId: uuid,
  revision: z.number().int().positive(),
  agentId: uuid,
  tenantId: uuid,
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(4_000),
  modelAlias: identifier,
  promptBindingRef: identifier,
  toolAllowlist: z.array(uuid),
  budget: ExecutionBudgetSchema,
  publishedAt,
  signature: RevisionSignatureSchema,
}).strict();

export const RuntimeToolPolicySchema = z.object({
  toolId: uuid,
  enabled: z.boolean(),
  riskClass: ToolRiskClassSchema,
  requiresApproval: z.boolean(),
  allowedRoles: z.array(identifier).max(100),
}).strict();

export const RuntimePolicyRevisionSchema = z.object({
  revisionId: uuid,
  revision: z.number().int().positive(),
  tenantId: uuid,
  environmentId: uuid,
  budget: ExecutionBudgetSchema,
  toolPolicies: z.array(RuntimeToolPolicySchema),
  publishedAt,
  signature: RevisionSignatureSchema,
}).strict();

export const SecurityRevocationSchema = z.object({
  revocationId: uuid,
  environmentId: uuid,
  effectiveAt: publishedAt,
  reasonCode: identifier,
  toolIds: z.array(uuid).default([]),
  agentRevisionIds: z.array(uuid).default([]),
  policyRevisionIds: z.array(uuid).default([]),
  signature: RevisionSignatureSchema,
}).strict();

export const ExecutionLeaseSchema = z.object({
  leaseId: uuid,
  environmentId: uuid,
  agentRevisionId: uuid,
  triggerId: identifier,
  allowedRiskClasses: z.array(ToolRiskClassSchema),
  budget: ExecutionBudgetSchema,
  issuedAt: publishedAt,
  expiresAt: publishedAt,
  signature: RevisionSignatureSchema,
}).strict().superRefine((lease, context) => {
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.issuedAt)) {
    context.addIssue({
      code: 'custom',
      message: 'Execution lease must expire after it is issued',
      path: ['expiresAt'],
    });
  }
});

export const RuntimeRevisionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  revisionId: uuid,
  revisionType: z.enum(['tool', 'manifest', 'agent', 'policy']),
  revision: z.number().int().positive(),
  tenantId: uuid,
  targetAppId: uuid,
  environmentId: uuid.optional(),
  subjectId: uuid.optional(),
  contentHash: digest,
  payload: z.unknown(),
  publishedAt,
  signature: RevisionSignatureSchema,
}).strict().superRefine((revisionEnvelope, context) => {
  if (
    ['manifest', 'policy'].includes(revisionEnvelope.revisionType)
    && !revisionEnvelope.environmentId
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Environment-scoped revisions require environmentId',
      path: ['environmentId'],
    });
  }
  if (
    ['tool', 'agent'].includes(revisionEnvelope.revisionType)
    && !revisionEnvelope.subjectId
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Subject-scoped revisions require subjectId',
      path: ['subjectId'],
    });
  }
  const forbiddenPath = findForbiddenContentPath(
    revisionEnvelope.payload,
    ['payload'],
  );
  if (forbiddenPath) {
    context.addIssue({
      code: 'custom',
      message: 'Runtime revision payload contains raw content or credentials',
      path: forbiddenPath,
    });
  }
});

export const RuntimeDeploymentBundleSchema = z.object({
  deploymentId: uuid,
  environmentId: uuid,
  status: z.enum(['pending', 'active']),
  rolloutMode: z.enum(['stable', 'canary']),
  targetPercentage: z.number().int().min(1).max(100),
  pinned: z.boolean(),
  healthStatus: z.enum(['unknown', 'healthy', 'degraded', 'unhealthy']),
  agentRevision: RuntimeRevisionEnvelopeSchema.refine(
    (revision) => revision.revisionType === 'agent',
    'Expected agent revision',
  ),
  manifestRevision: RuntimeRevisionEnvelopeSchema.refine(
    (revision) => revision.revisionType === 'manifest',
    'Expected manifest revision',
  ),
  policyRevision: RuntimeRevisionEnvelopeSchema.refine(
    (revision) => revision.revisionType === 'policy',
    'Expected policy revision',
  ),
  updatedAt: publishedAt,
}).strict().superRefine((deployment, context) => {
  if (
    deployment.rolloutMode === 'stable'
    && deployment.targetPercentage !== 100
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Stable rollout must target 100 percent',
      path: ['targetPercentage'],
    });
  }
  if (
    deployment.rolloutMode === 'canary'
    && deployment.targetPercentage >= 100
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Canary rollout must target less than 100 percent',
      path: ['targetPercentage'],
    });
  }
});

export const RuntimeSyncBundleSchema = z.object({
  cursor: publishedAt,
  activeSnapshotComplete: z.literal(true),
  deployments: z.array(RuntimeDeploymentBundleSchema),
  revocations: z.array(SecurityRevocationSchema),
}).strict();

export type RevisionSignature = z.infer<typeof RevisionSignatureSchema>;
export type LocalBindingReference = z.infer<typeof LocalBindingReferenceSchema>;
export type ToolRiskClass = z.infer<typeof ToolRiskClassSchema>;
export type ManifestTool = z.infer<typeof ManifestToolSchema>;
export type ManifestRevision = z.infer<typeof ManifestRevisionSchema>;
export type AgentRevision = z.infer<typeof AgentRevisionSchema>;
export type RuntimeToolPolicy = z.infer<typeof RuntimeToolPolicySchema>;
export type RuntimePolicyRevision = z.infer<typeof RuntimePolicyRevisionSchema>;
export type SecurityRevocation = z.infer<typeof SecurityRevocationSchema>;
export type ExecutionLease = z.infer<typeof ExecutionLeaseSchema>;
export type RuntimeRevisionEnvelope = z.infer<typeof RuntimeRevisionEnvelopeSchema>;
export type RuntimeDeploymentBundle = z.infer<typeof RuntimeDeploymentBundleSchema>;
export type RuntimeSyncBundle = z.infer<typeof RuntimeSyncBundleSchema>;
