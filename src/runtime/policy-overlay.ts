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
 * Reads a Platform policy revision the sync manager already verified as an
 * overlay. Values that copy the local base are harmless: composition is
 * restrict-only, so a copy resolves to the local value.
 *
 * TRANSITIONAL: the revision carries full `toolPolicies` copies, not a delta,
 * so every tool the Platform lists becomes an entry and a tool the Platform
 * copied at a stricter value than a later local change stays over-restricted
 * until the Platform republishes. The signed `RuntimePolicyRevision.toolOverrides`
 * delta field and its overlay adapter are owned by P08 (SDK lockstep) and land
 * before P11 wires `policyOverlay` into Get It Done; this mapping is then
 * replaced. A Platform relaxation ("Lockern") stays ineffective here: it needs
 * a committed local entry, so P08 must not present it as effective in managed
 * mode without one.
 */
export function policyOverlayFromRevision(
  revision: RuntimePolicyRevision,
): VerifiedPolicyOverlay {
  return {
    revisionId: revision.revisionId,
    revision: revision.revision,
    entries: revision.toolPolicies.map((policy) => ({
      toolId: policy.toolId,
      enabled: policy.enabled,
      requiresApproval: policy.requiresApproval,
      riskClass: policy.riskClass,
      allowedRoles: [...policy.allowedRoles],
    })),
    budget: revision.budget,
  };
}
