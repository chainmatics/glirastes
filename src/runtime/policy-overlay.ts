import type {
  ExecutionBudget,
  RuntimePolicyRevision,
  RuntimeToolPolicy,
} from '../contracts/index.js';
import {
  confirmationFloor,
  intersectAllowedRoles,
  mostRestrictiveRiskClass,
  riskTier,
  type ToolPolicyEntry,
} from '../contracts/tool-policy.js';

/** One Platform delta for one tool the deployed code owns. */
export type PolicyOverlayEntry = { toolId: string } & ToolPolicyEntry;

export interface PolicyOverlayIgnoredEntry {
  toolId: string;
  reason: 'platform-tool-not-in-code';
}

export interface PolicyOverlayResult {
  policies: RuntimeToolPolicy[];
  ignored: PolicyOverlayIgnoredEntry[];
}

/**
 * A Platform policy overlay whose signature the sync layer already verified.
 * The runtime reads the last accepted value; it never fetches one per turn.
 */
export interface VerifiedPolicyOverlay {
  /** Platform policy revision id; revocations of it keep matching. */
  revisionId: string;
  revision: number;
  entries: PolicyOverlayEntry[];
  /** Optional Platform budget; it can only tighten the local limits. */
  budget?: ExecutionBudget;
}

/**
 * Composes the local effective policies with a verified Platform overlay,
 * restrict-only (spec 4.9, resolveToolPolicy semantics): disable, raise the
 * risk class, narrow roles, require confirmation. `enabled: true`, a lower
 * risk class and `requiresApproval: false` are no-ops, pinned or not. Overlay
 * ids without a local policy are ignored and reported.
 */
export function applyPolicyOverlay(
  local: RuntimeToolPolicy[],
  overlay: PolicyOverlayEntry[],
): PolicyOverlayResult {
  const localIds = new Set(local.map((policy) => policy.toolId));
  const entriesByToolId = new Map<string, ToolPolicyEntry[]>();
  const ignored = new Set<string>();
  for (const { toolId, ...entry } of overlay) {
    if (!localIds.has(toolId)) {
      ignored.add(toolId);
      continue;
    }
    entriesByToolId.set(toolId, [...(entriesByToolId.get(toolId) ?? []), entry]);
  }
  return {
    policies: local.map((policy) =>
      (entriesByToolId.get(policy.toolId) ?? []).reduce(restrictPolicy, policy)),
    ignored: [...ignored].sort().map((toolId) => ({
      toolId,
      reason: 'platform-tool-not-in-code' as const,
    })),
  };
}

function restrictPolicy(
  policy: RuntimeToolPolicy,
  entry: ToolPolicyEntry,
): RuntimeToolPolicy {
  const riskClass = mostRestrictiveRiskClass(policy.riskClass, entry.riskClass);
  const roles = intersectAllowedRoles(policy.allowedRoles, entry.allowedRoles);
  const raisedIntoConfirmation = riskTier(riskClass) >= 2
    && riskTier(riskClass) > riskTier(policy.riskClass);
  return {
    toolId: policy.toolId,
    // Disjoint role restrictions mean nobody, never everyone.
    enabled: policy.enabled && entry.enabled !== false && !roles.disjoint,
    riskClass,
    requiresApproval: confirmationFloor(
      riskClass,
      policy.requiresApproval
        || entry.requiresApproval === true
        || raisedIntoConfirmation,
    ),
    allowedRoles: roles.roles,
  };
}

/**
 * Platform descriptions for tools the deployed code has (spec 4.5: Platform >
 * local > code for prose). The last delta for a tool wins, like the policy
 * layers; deltas for tools the code does not have are ignored.
 */
export function overlayDescriptions(
  localToolIds: ReadonlySet<string>,
  overlay: ReadonlyArray<PolicyOverlayEntry>,
): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const entry of overlay) {
    if (entry.description !== undefined && localToolIds.has(entry.toolId)) {
      descriptions.set(entry.toolId, entry.description);
    }
  }
  return descriptions;
}

/**
 * Reads a Platform policy revision the sync manager already verified as an
 * overlay. The entries are the signed `toolOverrides` deltas (P08b shared
 * contract item 2), never the reported `toolPolicies`: those repeat what the
 * code reported and would freeze an old local value. Composition stays
 * restrict-only, so a Platform relaxation remains a no-op without a committed
 * local entry, and the revision id keeps Platform revocations matching.
 */
export function policyOverlayFromRevision(
  revision: RuntimePolicyRevision,
): VerifiedPolicyOverlay {
  return {
    revisionId: revision.revisionId,
    revision: revision.revision,
    entries: revision.toolOverrides.map((delta) => ({ ...delta })),
    budget: revision.budget,
  };
}
