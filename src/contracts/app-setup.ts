import { z } from 'zod';
import { findForbiddenPlatformContentPath } from './content-boundary.js';
import { ToolRiskClassSchema } from './revisions.js';

const uuid = z.uuid();
const identifier = z.string().trim().min(1).max(200);
const digest = z.string().regex(
  /^sha256:(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9+/]{43}=)$/,
);
const timestamp = z.iso.datetime({ offset: true });

export const AppSetupStatusSchema = z.enum([
  'discovering',
  'assessing',
  'waiting_for_interview',
  'review',
  'ready',
  'published',
  'failed',
]);

export const AppSetupAssessmentModeSchema = z.enum([
  'autonomous',
  'interview',
]);

export const AppSetupOperationGroupSchema = z.enum([
  'read',
  'create',
  'update',
  'delete',
  'ui',
  'needs_attention',
]);

export const AppSetupToolCandidateSchema = z.object({
  toolId: uuid,
  sourceFingerprint: digest,
  name: identifier,
  /**
   * Short prose so a reviewer can judge an operation before overriding its
   * risk class or approval requirement. Bounded because a description is
   * never a place to carry source, schemas, or secrets.
   */
  description: z.string().trim().min(1).max(1_000).optional(),
  /** Deterministic provider-safe name exposed to the model. */
  modelName: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200).optional(),
  /** Primary intent module plus optional additional module memberships. */
  module: identifier.optional(),
  sharedWith: z.array(identifier).max(50).optional(),
  /** Short operational guidance; never prompts, source, or business data. */
  usageHints: z.array(z.string().trim().min(1).max(500)).min(1).max(20)
    .optional(),
  executionKind: z.enum(['endpoint', 'ui']),
  /**
   * Technical metadata that describes the operation without being prose, so
   * the description can stay about purpose and a reviewer can still see the
   * facts. Optional because a UI entry has no route and an endpoint has no
   * action binding.
   */
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  path: z.string().startsWith('/').max(2_048).optional(),
  authBindingRef: identifier.optional(),
  actionBindingRef: identifier.optional(),
  /**
   * Roles the assessment proposes may call this. Empty means undecided, not
   * "everyone": the local endpoint remains the final authorization boundary
   * either way.
   */
  allowedRoles: z.array(identifier).max(50).optional(),
  operationGroup: AppSetupOperationGroupSchema,
  riskClass: ToolRiskClassSchema,
  enabled: z.boolean(),
  requiresApproval: z.boolean(),
  inputSchemaDigest: digest,
  outputSchemaDigest: digest,
}).strict();

const AppSetupPlannerMetadataSchema = z.object({
  plannerId: uuid,
  modelBindingRef: identifier,
  promptBindingRef: identifier,
  budgetProfileRef: identifier,
  toolIds: z.array(uuid),
}).strict();

const AppSetupPromptMetadataSchema = z.object({
  bundleDigest: digest,
  artifactRef: z.string().trim().min(1).max(2_048),
  plannerDigest: digest,
  appBehaviorDigest: digest,
  responseStyleDigest: digest,
  capabilityFragmentDigests: z.record(identifier, digest).default({}),
}).strict();

const AppSetupWarningSchema = z.object({
  code: identifier,
  subjectRef: identifier.optional(),
}).strict();

export const AppSetupArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: uuid,
  runId: uuid,
  appId: uuid,
  discoveryDigest: digest,
  assessmentMode: AppSetupAssessmentModeSchema,
  status: z.enum(['review', 'ready']),
  tools: z.array(AppSetupToolCandidateSchema),
  planner: AppSetupPlannerMetadataSchema,
  prompts: AppSetupPromptMetadataSchema,
  warnings: z.array(AppSetupWarningSchema).default([]),
  generatedAt: timestamp,
}).strict().superRefine((artifact, context) => {
  const toolIds = new Set(artifact.tools.map((tool) => tool.toolId));
  for (const [index, toolId] of artifact.planner.toolIds.entries()) {
    if (!toolIds.has(toolId)) {
      context.addIssue({
        code: 'custom',
        message: 'Planner tool reference is not present in the setup artifact',
        path: ['planner', 'toolIds', index],
      });
    }
  }

  const forbiddenPath = findForbiddenPlatformContentPath(artifact);
  if (forbiddenPath) {
    context.addIssue({
      code: 'custom',
      message: 'App setup artifact contains prohibited content',
      path: forbiddenPath,
    });
  }
});

export type AppSetupStatus = z.infer<typeof AppSetupStatusSchema>;
export type AppSetupAssessmentMode = z.infer<
  typeof AppSetupAssessmentModeSchema
>;
export type AppSetupOperationGroup = z.infer<
  typeof AppSetupOperationGroupSchema
>;
export type AppSetupToolCandidate = z.infer<
  typeof AppSetupToolCandidateSchema
>;
export type AppSetupArtifact = z.infer<typeof AppSetupArtifactSchema>;

/**
 * Strong gate used by CLI validate/setup and standalone consumers. The base
 * schema keeps historical artifacts readable; any newly generated artifact
 * must pass this complete semantic parity check before it can be used.
 */
export function assertAppSetupSemanticParity(
  value: unknown,
  servedToolNames: ReadonlyArray<string>,
): AppSetupArtifact {
  const artifact = AppSetupArtifactSchema.parse(value);
  const served = new Set(servedToolNames);
  const artifactNames = new Set(artifact.tools.map((tool) => tool.name));
  if (
    served.size !== artifactNames.size
    || [...served].some((name) => !artifactNames.has(name))
  ) {
    throw new Error('App setup semantic parity does not match the served registry');
  }

  const modelNames = new Map<string, string>();
  for (const tool of artifact.tools.filter((candidate) => candidate.enabled)) {
    if (
      !tool.modelName
      || !tool.module
      || !tool.sharedWith
      || !tool.usageHints
    ) {
      throw new Error(`Tool ${tool.name} has incomplete curated semantics`);
    }
    const expectedModelName = tool.name.replace(/\./g, '_');
    if (tool.modelName !== expectedModelName) {
      throw new Error(`Tool ${tool.name} has a non-deterministic model-facing tool name`);
    }
    const owner = modelNames.get(tool.modelName);
    if (owner && owner !== tool.name) {
      throw new Error(
        `Tools ${owner} and ${tool.name} collide on model-facing tool name ${tool.modelName}`,
      );
    }
    if (tool.sharedWith.includes(tool.module)) {
      throw new Error(`Tool ${tool.name} repeats its primary module in sharedWith`);
    }
    modelNames.set(tool.modelName, tool.name);
  }
  return artifact;
}
