import type {
  AgentRevision,
  ExecutionBudget,
  ManifestRevision,
  Principal,
  PromptPin,
  RuntimePolicyRevision,
  SecurityRevocation,
} from '../contracts/index.js';
import { applyPolicyOverlay } from './policy-overlay.js';

export interface TurnSnapshot {
  readonly turnId: string;
  readonly startedAt: string;
  readonly principal: Principal;
  readonly agentRevision: AgentRevision;
  readonly manifestRevision: ManifestRevision;
  /**
   * The pinned policy revision. Its `toolPolicies` are the effective ones:
   * the signed values composed with the revision's own signed `toolOverrides`
   * deltas (restrictions, plus the D16 relaxations the local code report
   * allows), so every consumer of the snapshot obeys Platform decisions,
   * whichever path built it.
   */
  readonly policyRevision: RuntimePolicyRevision;
  readonly budget: ExecutionBudget;
  /**
   * Prompt revision the turn started with. Prompt bundles hot-swap
   * independently of the runtime bundle, so a running turn stays on this pin.
   */
  readonly promptPin?: PromptPin;
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

/**
 * Applies the signed `toolOverrides` deltas of a Platform policy revision to
 * its reported `toolPolicies` (`applyPolicyOverlay`). A revision composed by
 * the local runtime source carries no deltas and stays as it is; one a
 * consumer takes straight from a Platform deployment no longer runs a tool
 * the Platform disabled, and switches a confirmation off only for tools the
 * local code report names in `relaxableToolIds` (D16). Applying the same
 * deltas twice changes nothing.
 */
function withPlatformDecisions(
  policyRevision: RuntimePolicyRevision,
  relaxableToolIds: ReadonlySet<string> | undefined,
): RuntimePolicyRevision {
  const deltas = policyRevision.toolOverrides ?? [];
  if (deltas.length === 0) return policyRevision;
  return {
    ...policyRevision,
    toolPolicies: applyPolicyOverlay(
      policyRevision.toolPolicies,
      deltas,
      relaxableToolIds ? { relaxableToolIds } : {},
    ).policies,
  };
}

export function createTurnSnapshot(options: {
  turnId: string;
  agentRevision: AgentRevision;
  manifestRevision: ManifestRevision;
  policyRevision: RuntimePolicyRevision;
  principal: Principal;
  localLimits: ExecutionBudget;
  promptPin?: PromptPin;
  startedAt?: string;
  /**
   * D16: the tools whose confirmation a signed Platform decision may switch
   * off, `relaxableToolIds(setupArtifact)` of the running code. Without it a
   * snapshot built straight from a Platform deployment relaxes nothing.
   */
  relaxableToolIds?: ReadonlySet<string>;
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
    policyRevision: clone(withPlatformDecisions(policyRevision, options.relaxableToolIds)),
    budget: minBudget(options.localLimits, agentRevision.budget, policyRevision.budget),
    ...(options.promptPin ? { promptPin: clone(options.promptPin) } : {}),
  };

  return deepFreeze(snapshot);
}

/**
 * Resuming a turn must never silently change its prompt revision. A turn that
 * pinned a prompt bundle can only resume on the identical revision and digest.
 */
export function assertPromptPinForResume(
  snapshot: TurnSnapshot,
  pin: PromptPin | undefined,
): void {
  const pinned = snapshot.promptPin;
  if (!pinned) return;
  if (!pin) {
    throw new Error('Cannot resume a turn without its pinned prompt revision');
  }
  if (pin.revisionId !== pinned.revisionId || pin.revision !== pinned.revision) {
    throw new Error(
      'Resumed prompt revision does not match the pinned prompt revision',
    );
  }
  if (pin.bundleDigest !== pinned.bundleDigest) {
    throw new Error('Resumed prompt bundle digest does not match the pinned digest');
  }
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
