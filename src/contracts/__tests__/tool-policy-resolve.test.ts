import { describe, expect, it } from 'vitest';
import type { ToolRiskClass } from '../revisions.js';
import {
  resolveToolPolicy,
  type ResolveToolPolicyInput,
  type ToolPolicyDefaults,
  type ToolPolicyEntry,
} from '../tool-policy.js';

const TOOL_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905';
const OTHER_TOOL_ID = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906';

const READ: ToolPolicyDefaults = {
  operationGroup: 'read',
  riskClass: 'safe-read',
  requiresApproval: false,
  rulesVersion: 1,
};
const WRITE: ToolPolicyDefaults = {
  operationGroup: 'create',
  riskClass: 'write',
  requiresApproval: true,
  rulesVersion: 1,
};
const DELETE: ToolPolicyDefaults = {
  operationGroup: 'delete',
  riskClass: 'delete',
  requiresApproval: true,
  rulesVersion: 1,
};

function resolve(overrides: Partial<ResolveToolPolicyInput> = {}) {
  return resolveToolPolicy({
    toolId: TOOL_ID,
    defaults: READ,
    codeEnabled: true,
    ...overrides,
  });
}

function pin(atRiskClass: ToolRiskClass, toolId: string = TOOL_ID) {
  return { toolId, atRiskClass };
}

describe('resolveToolPolicy', () => {
  it('returns the code defaults when no layer speaks', () => {
    expect(resolve()).toEqual({
      effective: {
        enabled: true,
        requiresApproval: false,
        riskClass: 'safe-read',
        allowedRoles: [],
        origin: {
          enabled: 'code-default',
          requiresApproval: 'code-default',
          riskClass: 'code-default',
          allowedRoles: 'code-default',
          description: 'code-default',
        },
      },
      warnings: [],
      errors: [],
    });
  });

  it('lets every layer disable and nothing enable', () => {
    expect(resolve({ local: { enabled: false } }).effective)
      .toMatchObject({ enabled: false, origin: { enabled: 'local-policy' } });
    expect(resolve({ platform: { enabled: false } }).effective)
      .toMatchObject({ enabled: false, origin: { enabled: 'platform' } });
    expect(resolve({
      codeEnabled: false,
      local: { enabled: true },
      platform: { enabled: true },
    }).effective)
      .toMatchObject({ enabled: false, origin: { enabled: 'code-default' } });
  });

  it('only raises the risk class and confirms once raised into write', () => {
    expect(resolve({ local: { riskClass: 'write' } }).effective).toMatchObject({
      riskClass: 'write',
      requiresApproval: true,
      origin: { riskClass: 'local-policy', requiresApproval: 'local-policy' },
    });
    expect(resolve({ defaults: WRITE, platform: { riskClass: 'safe-read' } })
      .effective)
      .toMatchObject({ riskClass: 'write', origin: { riskClass: 'code-default' } });
    expect(resolve({ defaults: DELETE, local: { riskClass: 'financial' } })
      .effective)
      .toMatchObject({ riskClass: 'delete', origin: { riskClass: 'code-default' } });
    expect(resolve({ defaults: WRITE, platform: { riskClass: 'external' } })
      .effective).toMatchObject({
      riskClass: 'external',
      requiresApproval: true,
      origin: { riskClass: 'platform' },
    });
  });

  it('intersects role restrictions where an empty list restricts nothing', () => {
    expect(resolve({
      local: { allowedRoles: ['member', 'admin'] },
      platform: { allowedRoles: ['viewer', 'member'] },
    }).effective)
      .toMatchObject({ allowedRoles: ['member'], origin: { allowedRoles: 'platform' } });
    expect(resolve({
      local: { allowedRoles: ['admin'] },
      platform: { allowedRoles: [] },
    }).effective)
      .toMatchObject({ allowedRoles: ['admin'], origin: { allowedRoles: 'local-policy' } });
  });

  it('disables a tool whose role restrictions are disjoint instead of opening it to everyone', () => {
    expect(resolve({
      local: { allowedRoles: ['admin'] },
      platform: { allowedRoles: ['member'] },
    }).effective).toMatchObject({
      enabled: false,
      allowedRoles: [],
      origin: { enabled: 'platform', allowedRoles: 'platform' },
    });
  });

  it('prefers platform over local descriptions', () => {
    expect(resolve({
      local: { description: 'Local text.' },
      platform: { description: 'Platform text.' },
    }).effective)
      .toMatchObject({ description: 'Platform text.', origin: { description: 'platform' } });
    expect(resolve({ local: { description: 'Local text.' } }).effective)
      .toMatchObject({ description: 'Local text.', origin: { description: 'local-policy' } });
    expect(resolve().effective).not.toHaveProperty('description');
  });

  it('lets any layer require confirmation and keeps tier 3 confirmed', () => {
    expect(resolve({ local: { requiresApproval: true } }).effective).toMatchObject({
      requiresApproval: true,
      origin: { requiresApproval: 'local-policy' },
    });
    expect(resolve({ defaults: DELETE }).effective).toMatchObject({
      requiresApproval: true,
      origin: { requiresApproval: 'code-default' },
    });
    expect(resolve({ defaults: { ...DELETE, requiresApproval: false } }).effective)
      .toMatchObject({ requiresApproval: true, origin: { requiresApproval: 'code-default' } });
    expect(resolve({ defaults: WRITE, platform: { requiresApproval: false } })
      .effective.requiresApproval).toBe(true);
  });
});

describe('resolveToolPolicy relaxation bounds', () => {
  it('relaxes tiers 0 and 1 freely', () => {
    expect(resolve({
      defaults: { ...READ, riskClass: 'read-sensitive', requiresApproval: true },
      local: { requiresApproval: false },
    })).toMatchObject({
      effective: {
        requiresApproval: false,
        origin: { requiresApproval: 'local-policy' },
      },
      warnings: [],
      errors: [],
    });
  });

  it('relaxes write only through a reviewed entry pinned at write', () => {
    expect(resolve({
      defaults: WRITE,
      local: { requiresApproval: false, reason: 'reviewed', pin: pin('write') },
    })).toMatchObject({
      effective: {
        requiresApproval: false,
        origin: { requiresApproval: 'local-policy' },
      },
      warnings: [],
      errors: [],
    });
    expect(resolve({
      defaults: WRITE,
      platform: { requiresApproval: false, pin: pin('write') },
    }).effective).toMatchObject({
      requiresApproval: false,
      origin: { requiresApproval: 'platform' },
    });
  });

  it('lets a hardening win over a valid relaxation', () => {
    expect(resolve({
      defaults: WRITE,
      local: { requiresApproval: true },
      platform: { requiresApproval: false, pin: pin('write') },
    }).effective).toMatchObject({
      requiresApproval: true,
      origin: { requiresApproval: 'local-policy' },
    });
  });

  it.each([
    ['write without a pin', WRITE, {}, 'relaxation-requires-reviewed-pin'],
    ['delete without a pin', DELETE, {}, 'tier-3-always-requires-approval'],
    ['delete pinned at delete', DELETE, { pin: pin('delete') },
      'tier-3-always-requires-approval'],
  ] as const)('rejects relaxing %s with E-POLICY-002', (
    _label,
    defaults,
    extra,
    reason,
  ) => {
    const result = resolve({
      defaults,
      local: { requiresApproval: false, ...extra },
    });
    expect(result.effective.requiresApproval).toBe(true);
    expect(result.errors).toEqual([
      { code: 'E-POLICY-002', field: 'local.requiresApproval', reason },
    ]);
  });

  it('lets a pinned relaxation lapse with a warning when the risk rises', () => {
    expect(resolve({
      defaults: DELETE,
      local: { requiresApproval: false, pin: pin('write') },
    })).toMatchObject({
      effective: { requiresApproval: true },
      warnings: [
        { code: 'override-lapsed-risk-raised', field: 'local.requiresApproval' },
      ],
      errors: [],
    });
    expect(resolve({
      defaults: WRITE,
      local: { requiresApproval: false, pin: pin('safe-read') },
    })).toMatchObject({
      effective: { requiresApproval: true },
      warnings: [
        { code: 'override-lapsed-risk-raised', field: 'local.requiresApproval' },
      ],
      errors: [],
    });
  });

  it('never revives a relaxation for a reappeared tool but keeps its hardenings', () => {
    expect(resolve({
      defaults: WRITE,
      local: {
        requiresApproval: false,
        allowedRoles: ['admin'],
        pin: pin('write', OTHER_TOOL_ID),
      },
    })).toEqual({
      effective: {
        enabled: true,
        requiresApproval: true,
        riskClass: 'write',
        allowedRoles: ['admin'],
        origin: {
          enabled: 'code-default',
          requiresApproval: 'code-default',
          riskClass: 'code-default',
          allowedRoles: 'local-policy',
          description: 'code-default',
        },
      },
      warnings: [{ code: 'policy-entry-orphaned', field: 'local.pin.toolId' }],
      errors: [],
    });
  });
});

describe('resolveToolPolicy ratchet and entry validation', () => {
  it('holds a code-caused risk decrease until it is accepted', () => {
    expect(resolve({ previousEffectiveRiskClass: 'write' })).toMatchObject({
      effective: {
        riskClass: 'write',
        requiresApproval: true,
        origin: { riskClass: 'code-default' },
      },
      warnings: [{ code: 'risk-lower-available', field: 'riskClass' }],
    });
    expect(resolve({
      previousEffectiveRiskClass: 'write',
      acceptedRisk: { riskClass: 'safe-read', toolId: TOOL_ID },
    })).toMatchObject({
      effective: { riskClass: 'safe-read', requiresApproval: false },
      warnings: [],
    });
  });

  it.each([
    ['another tool id', { riskClass: 'safe-read', toolId: OTHER_TOOL_ID }],
    ['another risk class', { riskClass: 'read-sensitive', toolId: TOOL_ID }],
  ] as const)('ignores an acceptance for %s', (_label, acceptedRisk) => {
    expect(resolve({ previousEffectiveRiskClass: 'write', acceptedRisk }))
      .toMatchObject({
        effective: { riskClass: 'write' },
        warnings: [{ code: 'risk-lower-available', field: 'riskClass' }],
      });
  });

  it('takes risk increases over automatically and counts layer raises', () => {
    expect(resolve({ defaults: DELETE, previousEffectiveRiskClass: 'write' }))
      .toMatchObject({ effective: { riskClass: 'delete' }, warnings: [] });
    expect(resolve({
      local: { riskClass: 'write' },
      previousEffectiveRiskClass: 'write',
    })).toMatchObject({
      effective: { riskClass: 'write', origin: { riskClass: 'local-policy' } },
      warnings: [],
    });
  });

  it('fails a malformed entry closed with E-POLICY-001', () => {
    expect(resolve({
      defaults: WRITE,
      platform: { riskClass: 'critical' } as unknown as ToolPolicyEntry,
    })).toMatchObject({
      effective: {
        enabled: false,
        riskClass: 'write',
        requiresApproval: true,
        origin: { enabled: 'platform' },
      },
      errors: [
        { code: 'E-POLICY-001', field: 'platform.riskClass', reason: 'invalid-entry' },
      ],
    });
    expect(resolve({
      local: { enabled: true, toolId: TOOL_ID } as unknown as ToolPolicyEntry,
    }).errors).toEqual([
      { code: 'E-POLICY-001', field: 'local', reason: 'invalid-entry' },
    ]);
  });
});
