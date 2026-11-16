import type {
  AgentRevision,
  ManifestRevision,
  Principal,
  RuntimePolicyRevision,
  SecurityRevocation,
  ToolRiskClass,
} from '../contracts/index.js';
import { confirmationFloor } from '../contracts/tool-policy.js';
import { isToolRevoked, type TurnSnapshot } from './turn-snapshot.js';

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
    // Tier 3 always confirms, whatever the pinned policy says.
    requiresApproval: confirmationFloor(policy.riskClass, policy.requiresApproval),
    riskClass: policy.riskClass,
  };
}

export type TurnToolAuthorizationResult =
  | ToolAuthorizationResult
  | { allowed: false; reason: 'revoked' };

/**
 * The decision for one tool of a pinned turn: `authorizeToolCall` against the
 * pinned agent, manifest and policy revisions for the given principal, then
 * the current revocations. The execution guard, tool discovery and the tool
 * presentation all use it, so what a turn offers or names never differs from
 * what it would run.
 */
export function authorizeTurnTool(options: {
  snapshot: TurnSnapshot;
  principal: Principal | undefined;
  toolId: string;
  revocations?: ReadonlyArray<SecurityRevocation>;
  at?: Date;
}): TurnToolAuthorizationResult {
  const { snapshot } = options;
  const authorization = authorizeToolCall({
    principal: options.principal,
    agentRevision: snapshot.agentRevision,
    manifestRevision: snapshot.manifestRevision,
    policyRevision: snapshot.policyRevision,
    toolId: options.toolId,
  });
  if (!authorization.allowed) return authorization;
  if (isToolRevoked(snapshot, options.toolId, options.revocations ?? [], options.at)) {
    return { allowed: false, reason: 'revoked' };
  }
  return authorization;
}

/** The manifest tool ids of a pinned turn that `authorizeTurnTool` allows. */
export function authorizedTurnToolIds(options: {
  snapshot: TurnSnapshot;
  principal: Principal | undefined;
  revocations?: ReadonlyArray<SecurityRevocation>;
  at?: Date;
}): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const tool of options.snapshot.manifestRevision.tools) {
    if (authorizeTurnTool({ ...options, toolId: tool.toolId }).allowed) allowed.add(tool.toolId);
  }
  return allowed;
}
