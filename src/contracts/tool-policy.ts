import { z } from 'zod';
import { FoundationDiagnosticError } from '../diagnostics/index.js';
import { findSensitiveStringPath } from './content-boundary.js';
import { ToolRiskClassSchema, type ToolRiskClass } from './revisions.js';

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

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const stableKey = z.string().min(1).max(512);

export const ToolPolicyPinSchema = z.object({
  toolId: z.uuid(),
  atRiskClass: ToolRiskClassSchema,
}).strict();

/** One policy layer entry: the same shape for local files and Platform deltas. */
export const ToolPolicyEntrySchema = z.object({
  enabled: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  riskClass: ToolRiskClassSchema.optional(),
  allowedRoles: z.array(boundedText(200)).max(100).optional(),
  description: boundedText(4_000).optional(),
  reason: boundedText(500).optional(),
  pin: ToolPolicyPinSchema.optional(),
}).strict();

export interface ToolPolicyEntry {
  enabled?: boolean;
  requiresApproval?: boolean;
  riskClass?: ToolRiskClass;
  allowedRoles?: string[];
  description?: string;
  reason?: string;
  pin?: { toolId: string; atRiskClass: ToolRiskClass };
}

/**
 * `.glirastes/tool-policy.json`. Written by the developer or the CLI only,
 * never by an agent; `tools refresh` never rewrites it.
 */
export const ToolPolicyFileSchema = z.object({
  schemaVersion: z.literal(1),
  tools: z.record(stableKey, ToolPolicyEntrySchema).default({}),
  exclude: z.array(z.object({
    match: boundedText(2_048),
    reason: boundedText(500),
  }).strict()).max(500).default([]),
  acceptedRisk: z.record(stableKey, z.object({
    riskClass: ToolRiskClassSchema,
    toolId: z.uuid(),
  }).strict()).default({}),
}).strict().superRefine((file, context) => {
  // Values only: stable keys such as "POST /api/auth/token" are not content.
  const sensitivePath = findSensitiveStringPath(file);
  if (sensitivePath) {
    context.addIssue({
      code: 'custom',
      message: 'Tool policy contains secret-like content',
      path: sensitivePath,
    });
  }
});

export type ToolPolicyFile = z.infer<typeof ToolPolicyFileSchema>;

export function parseToolPolicyFile(value: unknown): ToolPolicyFile {
  const parsed = ToolPolicyFileSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // The issue path names the field; the offending value is never echoed.
  const identifier = parsed.error.issues[0]?.path.map(String).join('.') ?? '';
  throw new FoundationDiagnosticError({
    code: 'E-POLICY-001',
    operation: 'tools.policy',
    message: 'The tool policy file is invalid.',
    remediation: 'repair-tool-policy-file',
    path: '.glirastes/tool-policy.json',
    ...(identifier ? { identifier } : {}),
  });
}

export type PolicyOrigin = 'code-default' | 'local-policy' | 'platform';

export interface EffectiveToolPolicy {
  enabled: boolean;
  requiresApproval: boolean;
  riskClass: ToolRiskClass;
  allowedRoles: string[];
  description?: string;
  origin: {
    enabled: PolicyOrigin;
    requiresApproval: PolicyOrigin;
    riskClass: PolicyOrigin;
    allowedRoles: PolicyOrigin;
    description: PolicyOrigin;
  };
}

export type ToolPolicyWarningCode =
  | 'override-lapsed-risk-raised'
  | 'risk-lower-available'
  | 'policy-entry-orphaned';

export interface ResolveToolPolicyInput {
  toolId: string;
  defaults: ToolPolicyDefaults;
  /** False for needs_attention, excluded or missing tools; nothing re-enables them. */
  codeEnabled: boolean;
  local?: ToolPolicyEntry;
  platform?: ToolPolicyEntry;
  acceptedRisk?: { riskClass: ToolRiskClass; toolId: string };
  /** The riskClass this toolId resolved to in the previous committed refresh. */
  previousEffectiveRiskClass?: ToolRiskClass;
}

export interface ResolveToolPolicyResult {
  effective: EffectiveToolPolicy;
  warnings: Array<{ code: ToolPolicyWarningCode; field?: string }>;
  errors: Array<{
    code: 'E-POLICY-001' | 'E-POLICY-002';
    field: string;
    reason: string;
  }>;
}

type PolicyWarning = ResolveToolPolicyResult['warnings'][number];
type PolicyError = ResolveToolPolicyResult['errors'][number];

interface PolicyLayer {
  name: 'local' | 'platform';
  origin: Exclude<PolicyOrigin, 'code-default'>;
  entry: ToolPolicyEntry;
}

interface CollectedLayers {
  layers: PolicyLayer[];
  invalidOrigin?: PolicyOrigin;
}

interface ResolvedField<T> {
  value: T;
  origin: PolicyOrigin;
}

/**
 * Pure policy resolution shared with the Platform port via golden vectors.
 * Code defaults are the base; local and Platform entries restrict, except a
 * reviewed, pinned relaxation of confirmation up to tier 2. Across all layers
 * the most restrictive protection value wins.
 */
export function resolveToolPolicy(
  input: ResolveToolPolicyInput,
): ResolveToolPolicyResult {
  const warnings: PolicyWarning[] = [];
  const errors: PolicyError[] = [];
  const { layers, invalidOrigin } = collectPolicyLayers(input, warnings, errors);
  const risk = resolveRiskClass(input, layers, warnings);
  const roles = resolveAllowedRoles(layers);
  const enabled = resolveEnabled(
    input.codeEnabled,
    layers,
    roles.disjointOrigin,
    invalidOrigin,
  );
  const approval = resolveApproval(input, layers, risk, warnings, errors);
  const description = resolveDescription(layers);
  return {
    effective: {
      enabled: enabled.value,
      requiresApproval: approval.value,
      riskClass: risk.value,
      allowedRoles: roles.value,
      ...(description.value === undefined
        ? {}
        : { description: description.value }),
      origin: {
        enabled: enabled.origin,
        requiresApproval: approval.origin,
        riskClass: risk.origin,
        allowedRoles: roles.origin,
        description: description.origin,
      },
    },
    warnings,
    errors,
  };
}

function collectPolicyLayers(
  input: ResolveToolPolicyInput,
  warnings: PolicyWarning[],
  _errors: PolicyError[],
): CollectedLayers {
  const layers: PolicyLayer[] = [];
  if (input.local) {
    layers.push({ name: 'local', origin: 'local-policy', entry: input.local });
  }
  if (input.platform) {
    layers.push({ name: 'platform', origin: 'platform', entry: input.platform });
  }
  for (const layer of layers) {
    // A pin from an earlier incarnation: relaxations lapse, hardenings stay.
    if (layer.entry.pin && layer.entry.pin.toolId !== input.toolId) {
      warnings.push({
        code: 'policy-entry-orphaned',
        field: `${layer.name}.pin.toolId`,
      });
    }
  }
  return { layers };
}

function resolveRiskClass(
  input: ResolveToolPolicyInput,
  layers: ReadonlyArray<PolicyLayer>,
  _warnings: PolicyWarning[],
): ResolvedField<ToolRiskClass> {
  let value: ToolRiskClass = input.defaults.riskClass;
  let origin: PolicyOrigin = 'code-default';
  for (const layer of layers) {
    const raised = mostRestrictiveRiskClass(value, layer.entry.riskClass);
    if (raised !== value) {
      value = raised;
      origin = layer.origin;
    }
  }
  return { value, origin };
}

function sameRoles(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return left.length === right.length
    && left.every((role, index) => role === right[index]);
}

function resolveAllowedRoles(
  layers: ReadonlyArray<PolicyLayer>,
): ResolvedField<string[]> & { disjointOrigin?: PolicyOrigin } {
  let value: string[] = [];
  let origin: PolicyOrigin = 'code-default';
  for (const layer of layers) {
    const restriction = layer.entry.allowedRoles;
    if (!restriction || restriction.length === 0) continue;
    const next = intersectAllowedRoles(value, restriction);
    if (next.disjoint) {
      // [] would read as "everyone"; a disjoint restriction means nobody.
      return { value: [], origin: layer.origin, disjointOrigin: layer.origin };
    }
    if (!sameRoles(next.roles, value)) {
      value = next.roles;
      origin = layer.origin;
    }
  }
  return { value, origin };
}

function resolveEnabled(
  codeEnabled: boolean,
  layers: ReadonlyArray<PolicyLayer>,
  disjointOrigin: PolicyOrigin | undefined,
  invalidOrigin: PolicyOrigin | undefined,
): ResolvedField<boolean> {
  if (!codeEnabled) return { value: false, origin: 'code-default' };
  if (invalidOrigin) return { value: false, origin: invalidOrigin };
  const disabledBy = layers.find((layer) => layer.entry.enabled === false);
  if (disabledBy) return { value: false, origin: disabledBy.origin };
  if (disjointOrigin) return { value: false, origin: disjointOrigin };
  return { value: true, origin: 'code-default' };
}

function resolveApproval(
  input: ResolveToolPolicyInput,
  layers: ReadonlyArray<PolicyLayer>,
  risk: ResolvedField<ToolRiskClass>,
  warnings: PolicyWarning[],
  errors: PolicyError[],
): ResolvedField<boolean> {
  const tier = riskTier(risk.value);
  const raisedIntoConfirmation = tier >= 2
    && tier > riskTier(input.defaults.riskClass);
  const baseline = input.defaults.requiresApproval || raisedIntoConfirmation;
  const baselineOrigin: PolicyOrigin =
    !input.defaults.requiresApproval && raisedIntoConfirmation
      ? risk.origin
      : 'code-default';
  let hardenedBy: PolicyLayer | undefined;
  let relaxedBy: PolicyLayer | undefined;
  for (const layer of layers) {
    if (layer.entry.requiresApproval === true) {
      hardenedBy ??= layer;
    } else if (
      layer.entry.requiresApproval === false
      && relaxationAllowed(input.toolId, layer, tier, warnings, errors)
    ) {
      relaxedBy = layer;
    }
  }
  let result: ResolvedField<boolean>;
  if (hardenedBy) {
    result = {
      value: true,
      origin: baseline && !relaxedBy ? baselineOrigin : hardenedBy.origin,
    };
  } else if (relaxedBy) {
    result = { value: false, origin: relaxedBy.origin };
  } else {
    result = { value: baseline, origin: baselineOrigin };
  }
  // Tier 3 always confirms, whatever any layer says.
  return !result.value && tier >= 3
    ? { value: true, origin: 'code-default' }
    : result;
}

function relaxationAllowed(
  toolId: string,
  layer: PolicyLayer,
  tier: RiskTier,
  warnings: PolicyWarning[],
  errors: PolicyError[],
): boolean {
  const pin = layer.entry.pin;
  const field = `${layer.name}.requiresApproval`;
  if (pin && pin.toolId !== toolId) return false;
  if (tier <= 1) return true;
  if (!pin) {
    errors.push({
      code: 'E-POLICY-002',
      field,
      reason: tier >= 3
        ? 'tier-3-always-requires-approval'
        : 'relaxation-requires-reviewed-pin',
    });
    return false;
  }
  const pinnedTier = riskTier(pin.atRiskClass);
  if (pinnedTier >= 3) {
    errors.push({
      code: 'E-POLICY-002',
      field,
      reason: 'tier-3-always-requires-approval',
    });
    return false;
  }
  if (tier > pinnedTier) {
    warnings.push({ code: 'override-lapsed-risk-raised', field });
    return false;
  }
  return true;
}

function resolveDescription(
  layers: ReadonlyArray<PolicyLayer>,
): ResolvedField<string | undefined> {
  let result: ResolvedField<string | undefined> = {
    value: undefined,
    origin: 'code-default',
  };
  for (const layer of layers) {
    if (layer.entry.description !== undefined) {
      result = { value: layer.entry.description, origin: layer.origin };
    }
  }
  return result;
}
