import {
  AgentRevisionSchema,
  ManifestRevisionSchema,
  PlannerRevisionPayloadSchema,
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
  const policyRevision = RuntimePolicyRevisionSchema.parse({
    revisionId: deployment.policyRevision.revisionId,
    revision: deployment.policyRevision.revision,
    tenantId: deployment.policyRevision.tenantId,
    environmentId: deployment.policyRevision.environmentId,
    ...payloadObject(deployment.policyRevision),
    publishedAt: deployment.policyRevision.publishedAt,
    signature: deployment.policyRevision.signature,
  });
  return {
    agentRevision: AgentRevisionSchema.parse({
      revisionId: deployment.agentRevision.revisionId,
      revision: deployment.agentRevision.revision,
      agentId: deployment.agentRevision.subjectId,
      tenantId: deployment.agentRevision.tenantId,
      ...agentFields(payloadObject(deployment.agentRevision), policyRevision),
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
    policyRevision,
  };
}

/**
 * A v1 agent payload already carries every field the runtime contract needs.
 * A v2 planner payload references a budget profile instead of a concrete
 * budget, so its normalized form takes the budget the policy revision of the
 * same deployment pins; any other shape falls through to the strict agent
 * contract and fails closed there.
 */
function agentFields(
  payload: Record<string, unknown>,
  policyRevision: RuntimePolicyRevision,
): Record<string, unknown> {
  if (!('budgetProfileRef' in payload)) return payload;
  const planner = PlannerRevisionPayloadSchema.parse(payload);
  return {
    name: planner.plannerId,
    objective: `Planner ${planner.plannerId} (${planner.budgetProfileRef})`,
    modelAlias: planner.modelBindingRef,
    promptBindingRef: planner.promptBindingRef,
    toolAllowlist: planner.toolAllowlist,
    budget: policyRevision.budget,
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
