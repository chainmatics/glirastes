import { describe, expect, it } from 'vitest';
import type { ToolRiskClass } from '../revisions.js';
import {
  resolveToolPolicy,
  type ResolveToolPolicyInput,
  type ToolPolicyDefaults,
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

// Keeps the helpers referenced until Task 5 appends its block.
void pin;
void OTHER_TOOL_ID;
