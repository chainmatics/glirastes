import type {
  AgentRevision,
  ExecutionBudget,
  ManifestRevision,
  Principal,
  RuntimePolicyRevision,
  SecurityRevocation,
} from '../contracts/index.js';

export interface TurnSnapshot {
  readonly turnId: string;
  readonly startedAt: string;
  readonly principal: Principal;
  readonly agentRevision: AgentRevision;
  readonly manifestRevision: ManifestRevision;
  readonly policyRevision: RuntimePolicyRevision;
  readonly budget: ExecutionBudget;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function minBudget(
  local: ExecutionBudget,
  agent: ExecutionBudget,
  policy: ExecutionBudget,
): ExecutionBudget {
  return {
    maxModelSteps: Math.min(local.maxModelSteps, agent.maxModelSteps, policy.maxModelSteps),
    maxToolCalls: Math.min(local.maxToolCalls, agent.maxToolCalls, policy.maxToolCalls),
    totalTimeoutMs: Math.min(local.totalTimeoutMs, agent.totalTimeoutMs, policy.totalTimeoutMs),
    toolTimeoutMs: Math.min(local.toolTimeoutMs, agent.toolTimeoutMs, policy.toolTimeoutMs),
    maxInputTokens: Math.min(local.maxInputTokens, agent.maxInputTokens, policy.maxInputTokens),
    maxOutputTokens: Math.min(local.maxOutputTokens, agent.maxOutputTokens, policy.maxOutputTokens),
    maxEstimatedCostUsd: Math.min(
      local.maxEstimatedCostUsd,
      agent.maxEstimatedCostUsd,
      policy.maxEstimatedCostUsd,
    ),
    maxRepeatedFingerprint: Math.min(
      local.maxRepeatedFingerprint,
      agent.maxRepeatedFingerprint,
      policy.maxRepeatedFingerprint,
    ),
    maxConsecutiveErrors: Math.min(
      local.maxConsecutiveErrors,
      agent.maxConsecutiveErrors,
      policy.maxConsecutiveErrors,
    ),
    delegation: {
      maxDepth: Math.min(
        local.delegation.maxDepth,
        agent.delegation.maxDepth,
        policy.delegation.maxDepth,
      ),
      maxBreadth: Math.min(
        local.delegation.maxBreadth,
        agent.delegation.maxBreadth,
        policy.delegation.maxBreadth,
      ),
      sharedBudget: local.delegation.sharedBudget
        || agent.delegation.sharedBudget
        || policy.delegation.sharedBudget,
    },
  };
}

export function createTurnSnapshot(options: {
  turnId: string;
  agentRevision: AgentRevision;
  manifestRevision: ManifestRevision;
  policyRevision: RuntimePolicyRevision;
  principal: Principal;
  localLimits: ExecutionBudget;
  startedAt?: string;
}): TurnSnapshot {
  const {
    agentRevision,
    manifestRevision,
    policyRevision,
    principal,
  } = options;

  const tenantIds = new Set([
    agentRevision.tenantId,
    manifestRevision.tenantId,
    policyRevision.tenantId,
    principal.tenantId,
  ]);
  if (tenantIds.size !== 1) {
    throw new Error('Cannot create turn snapshot across tenant boundaries');
  }
  if (manifestRevision.environmentId !== policyRevision.environmentId) {
    throw new Error('Cannot create turn snapshot with mismatched environments');
  }

  const snapshot: TurnSnapshot = {
    turnId: options.turnId,
    startedAt: options.startedAt ?? new Date().toISOString(),
    principal: clone(principal),
    agentRevision: clone(agentRevision),
    manifestRevision: clone(manifestRevision),
    policyRevision: clone(policyRevision),
    budget: minBudget(options.localLimits, agentRevision.budget, policyRevision.budget),
  };

  return deepFreeze(snapshot);
}

export function isToolRevoked(
  snapshot: TurnSnapshot,
  toolId: string,
  revocations: ReadonlyArray<SecurityRevocation>,
  at = new Date(),
): boolean {
  const timestamp = at.getTime();
  return revocations.some((revocation) => {
    if (revocation.environmentId !== snapshot.manifestRevision.environmentId) return false;
    if (Date.parse(revocation.effectiveAt) > timestamp) return false;
    return revocation.toolIds.includes(toolId)
      || revocation.agentRevisionIds.includes(snapshot.agentRevision.revisionId)
      || revocation.policyRevisionIds.includes(snapshot.policyRevision.revisionId);
  });
}
