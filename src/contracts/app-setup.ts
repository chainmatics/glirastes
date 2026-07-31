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
  executionKind: z.enum(['endpoint', 'ui']),
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
