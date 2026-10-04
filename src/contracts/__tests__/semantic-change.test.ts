import { describe, expect, it } from 'vitest';
import { FoundationDiagnosticError } from '../../diagnostics/index.js';
import type { ToolRiskClass } from '../revisions.js';
import { classifyToolSemanticChange } from '../semantic-change.js';

const base = {
  toolId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905',
  enabled: true,
  requiresApproval: false,
  riskClass: 'safe-read' as const,
  allowedRoles: [] as string[],
  description: 'List visible tasks.',
  modelName: 'tasks_list',
  module: 'task_query',
  sharedWith: ['dashboard'],
  usageHints: ['Use for visible task lists.'],
  presentation: {
    locale: 'de-DE',
    singular: 'Aufgabenliste',
    plural: 'Aufgabenlisten',
    approval: 'Aufgabenliste anzeigen',
  },
};

describe('classifyToolSemanticChange', () => {
  it.each([
    ['enabled', { enabled: false }],
    ['requiresApproval', { requiresApproval: true }],
    ['riskClass', { riskClass: 'read-sensitive' as const }],
    ['allowedRoles', { allowedRoles: ['admin'] }],
  ])('classifies %s hardening independently', (field, update) => {
    expect(classifyToolSemanticChange(base, { ...base, ...update })).toEqual({
      toolId: base.toolId,
      classification: 'hardening',
      fields: [field],
      requiresConfirmation: false,
    });
  });

  it.each([
    ['description', { description: 'List tasks visible to the caller.' }],
    ['modelName', { modelName: 'visible_tasks' }],
    ['module', { module: 'reporting' }],
    ['sharedWith', { sharedWith: ['reporting'] }],
    ['usageHints', { usageHints: ['Use for reporting.'] }],
    ['presentation', {
      presentation: { ...base.presentation, approval: 'Aufgaben anzeigen' },
    }],
  ])('classifies a %s-only change as neutral', (field, update) => {
    expect(classifyToolSemanticChange(base, { ...base, ...update })).toEqual({
      toolId: base.toolId,
      classification: 'neutral',
      fields: [field],
      requiresConfirmation: false,
    });
  });

  it.each([
    ['enabled', { enabled: true }, { ...base, enabled: false }],
    [
      'requiresApproval',
      { requiresApproval: false },
      { ...base, requiresApproval: true },
    ],
    [
      'riskClass',
      { riskClass: 'safe-read' as const },
      { ...base, riskClass: 'read-sensitive' as const },
    ],
    [
      'allowedRoles',
      { allowedRoles: [] },
      { ...base, allowedRoles: ['admin'] },
    ],
  ])('classifies %s loosening independently', (field, update, before) => {
    expect(classifyToolSemanticChange(before, { ...base, ...update })).toEqual({
      toolId: base.toolId,
      classification: 'loosening',
      fields: [field],
      requiresConfirmation: true,
    });
  });

  it('returns a deterministic unchanged result', () => {
    expect(classifyToolSemanticChange(base, structuredClone(base))).toEqual({
      toolId: base.toolId,
      classification: 'unchanged',
      fields: [],
      requiresConfirmation: false,
    });
  });

  it.each([
    ['safe-read', 'unknown', 'hardening', false],
    ['unknown', 'write', 'loosening', true],
    ['delete', 'external', 'neutral', false],
    ['unknown', 'delete', 'neutral', false],
  ] as const)('classifies risk %s -> %s as %s', (
    beforeRisk,
    afterRisk,
    classification,
    requiresConfirmation,
  ) => {
    expect(classifyToolSemanticChange(
      { ...base, riskClass: beforeRisk },
      { ...base, riskClass: afterRisk },
    )).toEqual({
      toolId: base.toolId,
      classification,
      fields: ['riskClass'],
      requiresConfirmation,
    });
  });

  it('still fails closed for incomparable role sets', () => {
    expect(() => classifyToolSemanticChange(
      { ...base, allowedRoles: ['admin'] },
      { ...base, allowedRoles: ['editor'] },
    )).toThrowError(expect.objectContaining<Partial<FoundationDiagnosticError>>({
      code: 'E-SEMANTICS-003',
      operation: 'setup.semantic-change',
    }));
  });

  it.each([
    ['write', 'Delete'],
    ['Delete', 'write'],
    ['Delete', 'Remove'],
    ['delete', 'constructor'],
  ])('fails closed for the out-of-enum risk change %s -> %s', (beforeRisk, afterRisk) => {
    expect(() => classifyToolSemanticChange(
      { ...base, riskClass: beforeRisk as ToolRiskClass },
      { ...base, riskClass: afterRisk as ToolRiskClass },
    )).toThrowError(expect.objectContaining<Partial<FoundationDiagnosticError>>({
      code: 'E-SEMANTICS-003',
      operation: 'setup.semantic-change',
      identifier: base.toolId,
    }));
  });

  it('lets loosening dominate simultaneous neutral and hardening changes', () => {
    const before = { ...base, requiresApproval: true };
    const after = {
      ...base,
      enabled: false,
      description: 'Changed description.',
    };
    expect(classifyToolSemanticChange(before, after)).toEqual({
      toolId: base.toolId,
      classification: 'loosening',
      fields: ['enabled', 'requiresApproval', 'description'],
      requiresConfirmation: true,
    });
  });
});
