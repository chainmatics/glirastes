import {
  AppSetupArtifactSchema,
  type ExecutionBudget,
  type RuntimePolicyRevision,
  type RuntimeToolPolicy,
  type ToolRiskClass,
} from '../contracts/index.js';
import {
  confirmationFloor,
  confirmationRelaxationOutcome,
  intersectAllowedRoles,
  mostRestrictiveRiskClass,
  platformMayRelaxConfirmation,
  riskTier,
  type ConfirmationRelaxationOutcome,
  type ToolPolicyEntry,
} from '../contracts/tool-policy.js';

/** One Platform delta for one tool the deployed code owns. */
export type PolicyOverlayEntry = { toolId: string } & ToolPolicyEntry;

export interface PolicyOverlayIgnoredEntry {
  toolId: string;
  reason: 'platform-tool-not-in-code';
}

/**
 * What became of a Platform relaxation of confirmation for a tool that asks
 * before it runs. `locked-locally`: the local code report does not open this
 * confirmation to the Platform (tool-policy.json decided it, the report names
 * no origin, the local class is tier 3, or the caller passed no report).
 * `duplicate-decisions`: the overlay holds more than one decision for the
 * tool, which a signed revision never does. The rest come from the shared
 * rule `confirmationRelaxationOutcome`.
 */
export type PolicyOverlayRelaxationOutcome =
  | 'applied'
  | 'locked-locally'
  | 'duplicate-decisions'
  | Exclude<ConfirmationRelaxationOutcome, 'applies'>;

/** Content-free: a tool id and a code, never a value. */
export interface PolicyOverlayRelaxation {
  toolId: string;
  outcome: PolicyOverlayRelaxationOutcome;
}

export interface PolicyOverlayResult {
  policies: RuntimeToolPolicy[];
  ignored: PolicyOverlayIgnoredEntry[];
  /** One entry per asking tool a Platform decision tried to relax, in local order. */
  relaxations: PolicyOverlayRelaxation[];
}

export interface PolicyOverlayOptions {
  /**
   * Tools whose confirmation a signed Platform decision may switch off:
   * `relaxableToolIds(setupArtifact)` of the running code. Every other tool
   * keeps its local confirmation; without this set nothing relaxes.
   */
  relaxableToolIds?: ReadonlySet<string>;
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
 * Composes the local effective policies with a verified Platform overlay
 * (spec 4.9, resolveToolPolicy semantics). The overlay restricts: disable,
 * raise the risk class, narrow roles, require confirmation; `enabled: true`
 * and a lower risk class are no-ops. Its one relaxation is D16 (spec 4.5 as
 * amended 2026-10-05): a signed `requiresApproval: false` switches a tool's
 * confirmation off where `confirmationRelaxationOutcome` applies at the
 * effective risk class (pinned to this tool, at most tier 2, lapsing once
 * the risk rises above the pin; tier 3 and `unknown` never) and only for
 * tools in `relaxableToolIds`, so a local lock in tool-policy.json always
 * wins. Overlay ids without a local policy are ignored and reported.
 */
export function applyPolicyOverlay(
  local: RuntimeToolPolicy[],
  overlay: PolicyOverlayEntry[],
  options: PolicyOverlayOptions = {},
): PolicyOverlayResult {
  const relaxable = options.relaxableToolIds ?? new Set<string>();
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
  const relaxations: PolicyOverlayRelaxation[] = [];
  const policies = local.map((policy) => {
    const entries = entriesByToolId.get(policy.toolId) ?? [];
    const restricted = entries.reduce(restrictPolicy, policy);
    if (
      !restricted.requiresApproval
      || !entries.some((entry) => entry.requiresApproval === false)
    ) {
      return restricted;
    }
    const outcome = relaxationOutcome(
      policy.toolId,
      entries,
      restricted.riskClass,
      relaxable,
    );
    relaxations.push({ toolId: policy.toolId, outcome });
    return outcome === 'applied'
      ? { ...restricted, requiresApproval: false }
      : restricted;
  });
  return {
    policies,
    ignored: [...ignored].sort().map((toolId) => ({
      toolId,
      reason: 'platform-tool-not-in-code' as const,
    })),
    relaxations,
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

/** D16 for one asking tool, checked after every restriction of its decision. */
function relaxationOutcome(
  toolId: string,
  entries: ReadonlyArray<ToolPolicyEntry>,
  riskClass: ToolRiskClass,
  relaxable: ReadonlySet<string>,
): PolicyOverlayRelaxationOutcome {
  if (entries.length !== 1) return 'duplicate-decisions';
  const outcome = confirmationRelaxationOutcome(toolId, entries[0]!.pin, riskClass);
  if (outcome !== 'applies') return outcome;
  return relaxable.has(toolId) ? 'applied' : 'locked-locally';
}

/**
 * The tools of the running code whose confirmation a signed Platform decision
 * may switch off (D16): those the committed setup artifact (the code report)
 * attributes to the code default, up to tier 2 (`platformMayRelaxConfirmation`).
 * An explicit `requiresApproval: true` or a risk raise in tool-policy.json and
 * an artifact without provenance are local locks.
 */
export function relaxableToolIds(setupArtifact: unknown): Set<string> {
  const artifact = AppSetupArtifactSchema.parse(setupArtifact);
  return new Set(artifact.tools
    .filter((tool) => platformMayRelaxConfirmation(
      tool.riskClass,
      tool.provenance?.policyOrigin?.requiresApproval,
    ))
    .map((tool) => tool.toolId));
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
 * code reported and would freeze an old local value, and a relaxation there
 * is no decision. The revision id keeps Platform revocations matching.
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
