import type { ToolPresentation, ToolRiskClass } from './revisions.js';
import { FoundationDiagnosticError } from '../diagnostics/index.js';
import { riskTier } from './tool-policy.js';

export type SemanticChangeClassification =
  | 'unchanged'
  | 'hardening'
  | 'neutral'
  | 'loosening';

export interface ToolSemanticState {
  toolId: string;
  enabled: boolean;
  requiresApproval: boolean;
  riskClass: ToolRiskClass;
  allowedRoles?: ReadonlyArray<string>;
  description?: string;
  modelName?: string;
  module?: string;
  sharedWith?: ReadonlyArray<string>;
  usageHints?: ReadonlyArray<string>;
  presentation?: ToolPresentation;
}

export interface SemanticChange {
  toolId: string;
  classification: SemanticChangeClassification;
  fields: string[];
  requiresConfirmation: boolean;
}

function incomparable(toolId: string): never {
  throw new FoundationDiagnosticError({
    code: 'E-SEMANTICS-003',
    operation: 'setup.semantic-change',
    message: 'A semantic change cannot be classified safely.',
    remediation: 'review-semantic-change',
    identifier: toolId,
  });
}

function compareRisk(
  before: ToolRiskClass,
  after: ToolRiskClass,
): SemanticChangeClassification {
  if (before === after) return 'unchanged';
  const beforeTier = riskTier(before);
  const afterTier = riskTier(after);
  // Equal-tier relabels (the unassessed 'unknown' counts as tier 3) change
  // no protection, so they never need confirmation.
  if (beforeTier === afterTier) return 'neutral';
  return afterTier > beforeTier ? 'hardening' : 'loosening';
}

function normalizedSet(values: ReadonlyArray<string> | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

function compareRoles(
  beforeValue: ReadonlyArray<string> | undefined,
  afterValue: ReadonlyArray<string> | undefined,
  toolId: string,
): SemanticChangeClassification {
  const before = normalizedSet(beforeValue);
  const after = normalizedSet(afterValue);
  if (before.length === after.length && before.every((role, i) => role === after[i])) {
    return 'unchanged';
  }
  // An empty role list means no additional role restriction at authorization.
  if (before.length === 0) return 'hardening';
  if (after.length === 0) return 'loosening';
  const afterNarrowsBefore = after.every((role) => before.includes(role));
  const afterWidensBefore = before.every((role) => after.includes(role));
  if (afterNarrowsBefore) return 'hardening';
  if (afterWidensBefore) return 'loosening';
  return incomparable(toolId);
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Compares only the explicit curated and authorization-bearing semantic
 * fields. Loosening dominates a mixed change so confirmation can never be
 * hidden by simultaneous hardening or copy changes.
 */
export function classifyToolSemanticChange(
  before: ToolSemanticState,
  after: ToolSemanticState,
): SemanticChange {
  if (before.toolId !== after.toolId) return incomparable(after.toolId);

  const changes: Array<{
    field: string;
    classification: Exclude<SemanticChangeClassification, 'unchanged'>;
  }> = [];
  const add = (
    field: string,
    classification: SemanticChangeClassification,
  ) => {
    if (classification !== 'unchanged') changes.push({ field, classification });
  };

  if (before.enabled !== after.enabled) {
    add('enabled', after.enabled ? 'loosening' : 'hardening');
  }
  if (before.requiresApproval !== after.requiresApproval) {
    add(
      'requiresApproval',
      after.requiresApproval ? 'hardening' : 'loosening',
    );
  }
  add('riskClass', compareRisk(before.riskClass, after.riskClass));
  add(
    'allowedRoles',
    compareRoles(before.allowedRoles, after.allowedRoles, after.toolId),
  );

  const neutralFields = [
    'description',
    'modelName',
    'module',
    'sharedWith',
    'usageHints',
    'presentation',
  ] as const;
  for (const field of neutralFields) {
    if (!equalValue(before[field], after[field])) add(field, 'neutral');
  }

  const classification: SemanticChangeClassification = changes.some(
    (change) => change.classification === 'loosening',
  )
    ? 'loosening'
    : changes.some((change) => change.classification === 'hardening')
    ? 'hardening'
    : changes.length > 0
    ? 'neutral'
    : 'unchanged';

  return {
    toolId: after.toolId,
    classification,
    fields: changes.map((change) => change.field),
    requiresConfirmation: classification === 'loosening',
  };
}
