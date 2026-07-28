import { z } from 'zod';
import { ExecutionBudgetSchema } from './runtime.js';

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
