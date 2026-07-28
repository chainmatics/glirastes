import type {
  AgentRevision,
  ManifestRevision,
  Principal,
  RuntimePolicyRevision,
  ToolRiskClass,
} from '../contracts/index.js';

export type ToolAuthorizationResult =
  | {
      allowed: true;
      requiresApproval: boolean;
      riskClass: ToolRiskClass;
    }
  | {
      allowed: false;
      reason:
        | 'missing_principal'
        | 'tenant_mismatch'
        | 'agent_tool_denied'
        | 'manifest_tool_unavailable'
        | 'policy_tool_denied'
        | 'principal_role_denied';
    };

export function authorizeToolCall(options: {
  principal: Principal | undefined;
  agentRevision: AgentRevision;
  manifestRevision: ManifestRevision;
  policyRevision: RuntimePolicyRevision;
  toolId: string;
}): ToolAuthorizationResult {
  const {
    principal,
    agentRevision,
    manifestRevision,
    policyRevision,
    toolId,
  } = options;

  if (!principal) return { allowed: false, reason: 'missing_principal' };
  if (
    principal.tenantId !== agentRevision.tenantId
    || principal.tenantId !== manifestRevision.tenantId
    || principal.tenantId !== policyRevision.tenantId
  ) {
    return { allowed: false, reason: 'tenant_mismatch' };
  }
  if (!agentRevision.toolAllowlist.includes(toolId)) {
    return { allowed: false, reason: 'agent_tool_denied' };
  }

  const manifestTool = manifestRevision.tools.find((tool) => tool.toolId === toolId);
  if (!manifestTool || !manifestTool.enabled || manifestTool.tombstone) {
    return { allowed: false, reason: 'manifest_tool_unavailable' };
  }

  const policy = policyRevision.toolPolicies.find((tool) => tool.toolId === toolId);
  if (!policy || !policy.enabled) {
    return { allowed: false, reason: 'policy_tool_denied' };
  }
  if (
    policy.allowedRoles.length > 0
    && !policy.allowedRoles.some((role) => principal.roles.includes(role))
  ) {
    return { allowed: false, reason: 'principal_role_denied' };
  }

  return {
    allowed: true,
    requiresApproval: policy.requiresApproval,
    riskClass: policy.riskClass,
  };
}
