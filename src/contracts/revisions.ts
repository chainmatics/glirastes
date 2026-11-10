import { z } from 'zod';
import { ExecutionBudgetSchema } from './runtime.js';
import { findForbiddenContentPath } from './content-boundary.js';
import { ToolOverrideDeltaSchema, ToolRiskClassSchema } from './tool-policy-entry.js';

export { ToolRiskClassSchema } from './tool-policy-entry.js';

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

/**
 * Curated, locale-specific labels for operator-facing surfaces. These values
 * describe the operation; they never replace policy or execution checks.
 */
export const ToolPresentationSchema = z.object({
  locale: z.string().trim().min(2).max(35)
    .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/),
  singular: z.string().trim().min(1).max(200),
  plural: z.string().trim().min(1).max(200),
  approval: z.string().trim().min(1).max(500),
}).strict();

const ManifestToolBaseSchema = z.object({
  toolId: uuid,
  sourceFingerprint: digest,
  name: identifier,
  description: z.string().trim().min(1).max(4_000),
  modelName: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200).optional(),
  module: identifier.optional(),
  sharedWith: z.array(identifier).max(50).optional(),
  usageHints: z.array(z.string().trim().min(1).max(500)).min(1).max(20)
    .optional(),
  presentation: ToolPresentationSchema.optional(),
  riskClass: ToolRiskClassSchema,
  enabled: z.boolean(),
  tombstone: z.boolean(),
  inputSchemaDigest: digest,
  outputSchemaDigest: digest,
});

const ManifestEndpointToolSchema = ManifestToolBaseSchema.extend({
  executionKind: z.literal('endpoint'),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/').max(2_048),
  authBindingRef: identifier,
}).strict();

const ManifestUiToolSchema = ManifestToolBaseSchema.extend({
  executionKind: z.literal('ui'),
  actionBindingRef: identifier,
}).strict();

export const ManifestToolSchema = z.discriminatedUnion('executionKind', [
  ManifestEndpointToolSchema,
  ManifestUiToolSchema,
]).superRefine((tool, context) => {
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

/**
 * The v2 app-scoped planner payload the Platform publishes from a setup run.
 * It references a budget profile instead of carrying a concrete budget; the
 * concrete budget is pinned by the policy revision of the same deployment.
 */
export const PlannerRevisionPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  plannerId: identifier,
  modelBindingRef: identifier,
  promptBindingRef: identifier,
  budgetProfileRef: identifier,
  toolAllowlist: z.array(uuid),
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
  /**
   * Signed Platform decisions as deltas (P08b shared contract item 2): only
   * fields an operator decided, one entry per tool. Absent on revisions
   * without decisions, which therefore keep their bytes.
   */
  toolOverrides: z.array(ToolOverrideDeltaSchema).max(5_000).default([])
    .superRefine((deltas, context) => {
      const seen = new Set<string>();
      deltas.forEach((delta, index) => {
        if (seen.has(delta.toolId)) {
          context.addIssue({
            code: 'custom',
            message: 'A tool has more than one Platform decision',
            path: [index, 'toolId'],
          });
        }
        seen.add(delta.toolId);
      });
    }),
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
  schemaVersion: z.literal(1),
  leaseId: uuid,
  tenantId: uuid,
  targetAppId: uuid,
  environmentId: uuid,
  runnerId: uuid,
  deploymentId: uuid,
  agentRevisionId: uuid,
  triggerId: identifier,
  allowedRiskClasses: z.array(ToolRiskClassSchema).min(1),
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
  revisionType: z.enum(['tool', 'manifest', 'agent', 'policy', 'config']),
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

/**
 * Signed desired-state pin for one prompt bundle. The Platform signs the
 * binding; the bundle contents stay in the customer-controlled registry and are
 * proven by the content digest. Defined here (not in prompt-bundle.ts) because
 * the deployment bundle below carries it and prompt-bundle already imports from
 * this module.
 */
export const SignedPromptBindingSchema = z.object({
  schemaVersion: z.literal(1),
  appId: uuid,
  revisionId: uuid,
  revision: z.number().int().positive(),
  bundleDigest: digest,
  artifactRef: z.string().trim().min(1).max(2_048),
  activatedAt: publishedAt,
  signature: RevisionSignatureSchema,
}).strict();

const DEPLOYMENT_BINDING_FIELDS = [
  'configRevision',
  'runtimeDigest',
  'promptDigest',
  'promptBinding',
] as const;

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
  // Artifact bindings: present on every deployment created since the Platform
  // binds runtime and prompt artifacts; absent on the transitional shape.
  configRevision: RuntimeRevisionEnvelopeSchema.refine(
    (revision) => revision.revisionType === 'config',
    'Expected config revision',
  ).optional(),
  runtimeDigest: digest.optional(),
  promptDigest: digest.optional(),
  promptBinding: SignedPromptBindingSchema.optional(),
  updatedAt: publishedAt,
}).strict().superRefine((deployment, context) => {
  // The server emits all four binding fields or none. A partial set means
  // something was stripped or tampered with and must not pass as either shape.
  const bindingsPresent = DEPLOYMENT_BINDING_FIELDS
    .filter((field) => deployment[field] !== undefined);
  if (
    bindingsPresent.length > 0
    && bindingsPresent.length < DEPLOYMENT_BINDING_FIELDS.length
  ) {
    for (const field of DEPLOYMENT_BINDING_FIELDS) {
      if (deployment[field] === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Deployment artifact bindings are all-or-nothing',
          path: [field],
        });
      }
    }
  }
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
export type SignedPromptBinding = z.infer<typeof SignedPromptBindingSchema>;
export type LocalBindingReference = z.infer<typeof LocalBindingReferenceSchema>;
export type ToolRiskClass = z.infer<typeof ToolRiskClassSchema>;
export type ToolPresentation = z.infer<typeof ToolPresentationSchema>;
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
