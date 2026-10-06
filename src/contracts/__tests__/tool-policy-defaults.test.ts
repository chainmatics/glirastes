import { describe, expect, it } from 'vitest';
import {
  TOOL_POLICY_RULES_VERSION,
  declaredEffectRiskClass,
  deriveToolPolicyDefaults,
  type DeclaredEffect,
  type ToolPolicyDefaults,
  type ToolPolicyDefaultsInput,
} from '../tool-policy.js';

type Expected = Pick<
  ToolPolicyDefaults,
  'operationGroup' | 'riskClass' | 'requiresApproval'
>;

const READ: Expected = {
  operationGroup: 'read', riskClass: 'safe-read', requiresApproval: false,
};
const CREATE: Expected = {
  operationGroup: 'create', riskClass: 'write', requiresApproval: true,
};
const UPDATE: Expected = {
  operationGroup: 'update', riskClass: 'write', requiresApproval: true,
};
const DELETE: Expected = {
  operationGroup: 'delete', riskClass: 'delete', requiresApproval: true,
};
const UI: Expected = {
  operationGroup: 'ui', riskClass: 'safe-read', requiresApproval: false,
};

function endpoint(
  method: string | undefined,
  path: string,
  definitionId: string,
  extra: Partial<ToolPolicyDefaultsInput> = {},
): ToolPolicyDefaultsInput {
  return {
    executionKind: 'endpoint',
    ...(method === undefined ? {} : { method }),
    path,
    definitionId,
    ...extra,
  };
}

function ui(
  definitionId: string,
  extra: Partial<ToolPolicyDefaultsInput> = {},
): ToolPolicyDefaultsInput {
  return { executionKind: 'ui', definitionId, ...extra };
}

const TABLE: Array<[string, ToolPolicyDefaultsInput, Expected]> = [
  ['UI action', ui('ui.navigate'), UI],
  ['GET', endpoint('GET', '/api/tasks', 'tasks.list'), READ],
  ['HEAD', endpoint('HEAD', '/api/tasks', 'tasks.head'), READ],
  ['lowercase get', endpoint('get', '/api/tasks', 'tasks.list'), READ],
  ['POST', endpoint('POST', '/api/tasks', 'tasks.create'), CREATE],
  ['PUT', endpoint('PUT', '/api/tasks/[id]', 'tasks.replace'), UPDATE],
  ['PATCH', endpoint('PATCH', '/api/tasks/[id]', 'tasks.update'), UPDATE],
  ['DELETE', endpoint('DELETE', '/api/tasks/[id]', 'tasks.delete'), DELETE],
  ['missing method', endpoint(undefined, '/api/tasks/sync', 'tasks.sync'), UPDATE],
  ['unknown method', endpoint('OPTIONS', '/api/tasks', 'tasks.options'), UPDATE],
];

const ESCALATIONS: Array<[string, ToolPolicyDefaultsInput, Expected]> = [
  ['destructive path segment',
    endpoint('POST', '/api/tasks/bulk/delete', 'tasks.bulk'), DELETE],
  ['hyphenated permanent-delete',
    endpoint('POST', '/api/tasks/bulk/permanent-delete', 'tasks.bulkPermanent'),
    DELETE],
  ['empty-trash pair',
    endpoint('POST', '/api/trash/empty-trash', 'trash.empty'), DELETE],
  ['camelCase definitionId',
    endpoint('PATCH', '/api/users/[id]', 'users.hardDelete'), DELETE],
  ['camelCase bulk delete',
    endpoint('POST', '/api/tasks/bulk', 'tasks.bulkDelete'), DELETE],
  ['revoke',
    endpoint('POST', '/api/keys/[keyId]/revoke', 'apiKeys.revoke'), DELETE],
  ['declared financial',
    endpoint('POST', '/api/invoices/[id]/pay', 'invoices.pay', {
      declaredEffect: 'financial',
    }),
    { operationGroup: 'create', riskClass: 'financial', requiresApproval: true }],
  ['declared destructive',
    endpoint('POST', '/api/tasks/[id]/close', 'tasks.close', {
      declaredEffect: 'destructive',
    }),
    DELETE],
  ['declared external on GET',
    endpoint('GET', '/api/calendar/sync', 'calendar.sync', {
      declaredEffect: 'external',
    }),
    { operationGroup: 'read', riskClass: 'external', requiresApproval: true }],
  ['external-call evidence',
    endpoint('GET', '/api/export', 'exports.download', {
      evidence: { externalCall: true },
    }),
    { operationGroup: 'read', riskClass: 'external', requiresApproval: true }],
  ['UI mutation evidence',
    ui('tasks.quickAdd', { evidence: { uiMutation: true } }),
    { operationGroup: 'ui', riskClass: 'write', requiresApproval: true }],
  ['UI mutation with destructive id',
    ui('tasks.deleteSelected', { evidence: { uiMutation: true } }),
    { operationGroup: 'ui', riskClass: 'delete', requiresApproval: true }],
  ['UI external evidence',
    ui('maps.openExternal', { evidence: { externalCall: true } }),
    { operationGroup: 'ui', riskClass: 'external', requiresApproval: true }],
];

const NEVER_LOWER: Array<[string, ToolPolicyDefaultsInput, Expected]> = [
  ['declared read on POST',
    endpoint('POST', '/api/search', 'search.run', { declaredEffect: 'read' }),
    CREATE],
  ['declared write on DELETE',
    endpoint('DELETE', '/api/tasks/[id]', 'tasks.delete', {
      declaredEffect: 'write',
    }),
    DELETE],
];

// Review focus: tokens match whole words only, never on reads, and UI ids
// only escalate with evidence that the handler mutates.
const TOKEN_BOUNDARIES: Array<[string, ToolPolicyDefaultsInput, Expected]> = [
  ['GET of deleted items',
    endpoint('GET', '/api/tasks/deleted', 'tasks.listDeleted'), READ],
  ['restore of deleted items',
    endpoint('POST', '/api/tasks/deleted/restore', 'tasks.restoreDeleted'),
    CREATE],
  ['archive is not a token',
    endpoint('PATCH', '/api/tasks/[taskId]/archive', 'tasks.archive'), UPDATE],
  ['reminders are not remove',
    endpoint('POST', '/api/reminders', 'reminders.create'), CREATE],
  ['UI id without mutation evidence', ui('ui.trash.emptyTrash'), UI],
];

const ALL = [...TABLE, ...ESCALATIONS, ...NEVER_LOWER, ...TOKEN_BOUNDARIES];

describe('deriveToolPolicyDefaults', () => {
  it.each(ALL)('%s', (_label, input, expected) => {
    expect(deriveToolPolicyDefaults(input)).toEqual({
      ...expected,
      rulesVersion: TOOL_POLICY_RULES_VERSION,
    });
  });

  it('never emits the unassessed risk class', () => {
    for (const [, input] of ALL) {
      expect(deriveToolPolicyDefaults(input).riskClass).not.toBe('unknown');
    }
  });
});

describe('declaredEffectRiskClass', () => {
  const EFFECTS: ReadonlyArray<[DeclaredEffect, ToolPolicyDefaults['riskClass']]> = [
    ['read', 'safe-read'],
    ['write', 'write'],
    ['destructive', 'delete'],
    ['external', 'external'],
    ['financial', 'financial'],
  ];

  it.each(EFFECTS)('maps %s to %s', (effect, riskClass) => {
    expect(declaredEffectRiskClass(effect)).toBe(riskClass);
  });

  it.each(EFFECTS)(
    'is the class deriveToolPolicyDefaults raises a read to for %s',
    (effect) => {
      expect(deriveToolPolicyDefaults(
        endpoint('GET', '/api/things', 'things.list', { declaredEffect: effect }),
      ).riskClass).toBe(declaredEffectRiskClass(effect));
    },
  );
});
