import {
  AgentRevisionSchema,
  ManifestRevisionSchema,
  RuntimePolicyRevisionSchema,
  type AgentRevision,
  type ManifestRevision,
  type RuntimeDeploymentBundle,
  type RuntimePolicyRevision,
  type RuntimeRevisionEnvelope,
} from '../contracts/revisions.js';

export interface MaterializedDeploymentRevisions {
  agentRevision: AgentRevision;
  manifestRevision: ManifestRevision;
  policyRevision: RuntimePolicyRevision;
}

export function materializeDeploymentRevisions(
  deployment: RuntimeDeploymentBundle,
): MaterializedDeploymentRevisions {
  return {
    agentRevision: AgentRevisionSchema.parse({
      revisionId: deployment.agentRevision.revisionId,
      revision: deployment.agentRevision.revision,
      agentId: deployment.agentRevision.subjectId,
      tenantId: deployment.agentRevision.tenantId,
      ...payloadObject(deployment.agentRevision),
      publishedAt: deployment.agentRevision.publishedAt,
      signature: deployment.agentRevision.signature,
    }),
    manifestRevision: ManifestRevisionSchema.parse({
      revisionId: deployment.manifestRevision.revisionId,
      revision: deployment.manifestRevision.revision,
      tenantId: deployment.manifestRevision.tenantId,
      targetAppId: deployment.manifestRevision.targetAppId,
      environmentId: deployment.manifestRevision.environmentId,
      ...payloadObject(deployment.manifestRevision),
      publishedAt: deployment.manifestRevision.publishedAt,
      signature: deployment.manifestRevision.signature,
    }),
    policyRevision: RuntimePolicyRevisionSchema.parse({
      revisionId: deployment.policyRevision.revisionId,
      revision: deployment.policyRevision.revision,
      tenantId: deployment.policyRevision.tenantId,
      environmentId: deployment.policyRevision.environmentId,
      ...payloadObject(deployment.policyRevision),
      publishedAt: deployment.policyRevision.publishedAt,
      signature: deployment.policyRevision.signature,
    }),
  };
}

function payloadObject(
  revision: RuntimeRevisionEnvelope,
): Record<string, unknown> {
  if (
    !revision.payload
    || typeof revision.payload !== 'object'
    || Array.isArray(revision.payload)
  ) {
    throw new Error(
      `${revision.revisionType} revision payload must be an object`,
    );
  }
  return revision.payload as Record<string, unknown>;
}
