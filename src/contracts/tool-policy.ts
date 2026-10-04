import type { ToolRiskClass } from './revisions.js';

/**
 * Version of the default table and the policy bounds below. The golden
 * vectors in `__vectors__/tool-policy.v1.json` pin it; the Platform port
 * must produce byte-identical results for the same version.
 */
export const TOOL_POLICY_RULES_VERSION = 1 as const;

export type RiskTier = 0 | 1 | 2 | 3;

const RISK_TIERS: Readonly<Record<ToolRiskClass, RiskTier>> = {
  'safe-read': 0,
  'read-sensitive': 1,
  write: 2,
  delete: 3,
  financial: 3,
  external: 3,
  // An unassessed risk class is treated like the highest tier.
  unknown: 3,
};

export function riskTier(riskClass: ToolRiskClass): RiskTier {
  return RISK_TIERS[riskClass];
}

/**
 * The runtime confirmation floor: tier 3 always asks before it runs,
 * whatever any policy layer says.
 */
export function confirmationFloor(
  riskClass: ToolRiskClass,
  requiresApproval: boolean,
): boolean {
  return requiresApproval || riskTier(riskClass) >= 3;
}

/**
 * Raise-only combination. A candidate replaces the current class only from a
 * strictly higher tier; a same-tier relabel or a lower class never applies.
 */
export function mostRestrictiveRiskClass(
  current: ToolRiskClass,
  candidate: ToolRiskClass | undefined,
): ToolRiskClass {
  if (candidate === undefined) return current;
  return riskTier(candidate) > riskTier(current) ? candidate : current;
}

export interface AllowedRolesIntersection {
  /** Sorted, de-duplicated roles; empty means "no additional restriction". */
  roles: string[];
  /** Both sides restrict and nothing is left: nobody may call the tool. */
  disjoint: boolean;
}

export function intersectAllowedRoles(
  current: ReadonlyArray<string>,
  restriction: ReadonlyArray<string> | undefined,
): AllowedRolesIntersection {
  const left = normalizedRoles(current);
  const right = normalizedRoles(restriction ?? []);
  if (left.length === 0) return { roles: right, disjoint: false };
  if (right.length === 0) return { roles: left, disjoint: false };
  const roles = left.filter((role) => right.includes(role));
  return { roles, disjoint: roles.length === 0 };
}

function normalizedRoles(roles: ReadonlyArray<string>): string[] {
  return [...new Set(roles)].sort();
}

export type DeclaredEffect =
  | 'read'
  | 'write'
  | 'destructive'
  | 'external'
  | 'financial';

export interface ToolPolicyDefaultsInput {
  executionKind: 'endpoint' | 'ui';
  method?: string;
  path?: string;
  definitionId: string;
  declaredEffect?: DeclaredEffect;
  evidence?: { externalCall?: boolean; uiMutation?: boolean };
}

export interface ToolPolicyDefaults {
  operationGroup: 'read' | 'create' | 'update' | 'delete' | 'ui';
  riskClass: Exclude<ToolRiskClass, 'unknown'>;
  requiresApproval: boolean;
  rulesVersion: typeof TOOL_POLICY_RULES_VERSION;
}

type AssessedRiskClass = Exclude<ToolRiskClass, 'unknown'>;
type PolicyDefaultsCore = Omit<ToolPolicyDefaults, 'rulesVersion'>;

const METHOD_DEFAULTS = new Map<string, PolicyDefaultsCore>([
  ['GET', { operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false }],
  ['HEAD', { operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false }],
  ['POST', { operationGroup: 'create', riskClass: 'write', requiresApproval: true }],
  ['PUT', { operationGroup: 'update', riskClass: 'write', requiresApproval: true }],
  ['PATCH', { operationGroup: 'update', riskClass: 'write', requiresApproval: true }],
  ['DELETE', { operationGroup: 'delete', riskClass: 'delete', requiresApproval: true }],
]);

const UNKNOWN_METHOD_DEFAULTS: PolicyDefaultsCore = {
  operationGroup: 'update',
  riskClass: 'write',
  requiresApproval: true,
};

const UI_DEFAULTS: PolicyDefaultsCore = {
  operationGroup: 'ui',
  riskClass: 'safe-read',
  requiresApproval: false,
};

const DESTRUCTIVE_WORDS = new Set([
  'delete',
  'remove',
  'destroy',
  'purge',
  'erase',
  'wipe',
  'permanent',
  'revoke',
]);

/** Multi-word tokens; `hard-delete` is already covered by `delete`. */
const DESTRUCTIVE_WORD_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['empty', 'trash'],
];

const DECLARED_EFFECT_RISK: Readonly<Record<DeclaredEffect, AssessedRiskClass>> = {
  read: 'safe-read',
  write: 'write',
  destructive: 'delete',
  external: 'external',
  financial: 'financial',
};

function segmentWords(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** Whole-word match per path or definitionId segment (camelCase aware). */
function hasDestructiveToken(
  ...sources: ReadonlyArray<string | undefined>
): boolean {
  for (const source of sources) {
    for (const segment of (source ?? '').split(/[/.]/)) {
      const words = segmentWords(segment);
      if (words.some((word) => DESTRUCTIVE_WORDS.has(word))) return true;
      for (let index = 0; index + 1 < words.length; index += 1) {
        if (DESTRUCTIVE_WORD_PAIRS.some(([first, second]) =>
          words[index] === first && words[index + 1] === second)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Raise-only step on the assessed class set. It delegates to
 * `mostRestrictiveRiskClass` so the raise rule lives in one place; both inputs
 * are assessed, so the result is always one of them and never `unknown`.
 */
function raiseAssessed(
  current: AssessedRiskClass,
  candidate: AssessedRiskClass,
): AssessedRiskClass {
  return mostRestrictiveRiskClass(current, candidate) === candidate
    ? candidate
    : current;
}

/**
 * Deterministic stage-1 defaults (spec 4.5). Escalations only ever raise;
 * `unknown` is never produced. Roles are not part of the defaults: the
 * endpoint's own authorization applies.
 */
export function deriveToolPolicyDefaults(
  input: ToolPolicyDefaultsInput,
): ToolPolicyDefaults {
  const isUi = input.executionKind === 'ui';
  const method = input.method?.toUpperCase();
  const base = isUi
    ? UI_DEFAULTS
    : METHOD_DEFAULTS.get(method ?? '') ?? UNKNOWN_METHOD_DEFAULTS;
  let operationGroup = base.operationGroup;
  let riskClass = base.riskClass;

  const readOnlyMethod = !isUi && (method === 'GET' || method === 'HEAD');
  const tokensApply = isUi
    ? input.evidence?.uiMutation === true
    : !readOnlyMethod;
  if (tokensApply && hasDestructiveToken(input.path, input.definitionId)) {
    riskClass = raiseAssessed(riskClass, 'delete');
    if (!isUi) operationGroup = 'delete';
  }
  if (input.declaredEffect !== undefined) {
    riskClass = raiseAssessed(
      riskClass,
      DECLARED_EFFECT_RISK[input.declaredEffect],
    );
    if (input.declaredEffect === 'destructive' && !isUi) {
      operationGroup = 'delete';
    }
  }
  if (input.evidence?.externalCall) {
    riskClass = raiseAssessed(riskClass, 'external');
  }
  if (isUi && input.evidence?.uiMutation) {
    riskClass = raiseAssessed(riskClass, 'write');
  }

  return {
    operationGroup,
    riskClass,
    requiresApproval: base.requiresApproval || riskTier(riskClass) >= 2,
    rulesVersion: TOOL_POLICY_RULES_VERSION,
  };
}
