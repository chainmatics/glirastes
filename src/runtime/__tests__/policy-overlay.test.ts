import { describe, expect, it } from 'vitest';
import type {
  ExecutionBudget,
  RuntimePolicyRevision,
  RuntimeToolPolicy,
  ToolRiskClass,
} from '../../contracts/index.js';
import {
  TOOL_POLICY_RULES_VERSION,
  resolveToolPolicy,
  type ToolPolicyEntry,
} from '../../contracts/tool-policy.js';
import {
  applyPolicyOverlay,
  policyOverlayFromRevision,
} from '../policy-overlay.js';

const READ_ID = '11111111-1111-4111-8111-111111111111';
const WRITE_ID = '22222222-2222-4222-8222-222222222222';
const DELETE_ID = '33333333-3333-4333-8333-333333333333';
const REMOVED_ID = '44444444-4444-4444-8444-444444444444';

const READ: RuntimeToolPolicy = {
  toolId: READ_ID,
  enabled: true,
  riskClass: 'safe-read',
  requiresApproval: false,
  allowedRoles: [],
};
const WRITE: RuntimeToolPolicy = {
  toolId: WRITE_ID,
  enabled: true,
  riskClass: 'write',
  requiresApproval: true,
  allowedRoles: ['member'],
};
const DELETE: RuntimeToolPolicy = {
  toolId: DELETE_ID,
  enabled: true,
  riskClass: 'delete',
  requiresApproval: true,
  allowedRoles: [],
};

const BUDGET: ExecutionBudget = {
  maxModelSteps: 8,
  maxToolCalls: 16,
  totalTimeoutMs: 60_000,
  toolTimeoutMs: 10_000,
  maxInputTokens: 100_000,
  maxOutputTokens: 8_000,
  maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 3,
  maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

describe('applyPolicyOverlay', () => {
  it('keeps local policies untouched without overlay entries', () => {
    expect(applyPolicyOverlay([READ, WRITE], []))
      .toEqual({ policies: [READ, WRITE], ignored: [] });
  });

  it('ignores overlay ids that the deployed code does not have', () => {
    expect(applyPolicyOverlay([READ], [
      { toolId: REMOVED_ID, enabled: true, requiresApproval: false },
      { toolId: REMOVED_ID, allowedRoles: ['admin'] },
    ])).toEqual({
      policies: [READ],
      ignored: [{ toolId: REMOVED_ID, reason: 'platform-tool-not-in-code' }],
    });
  });

  it('cannot enable a disabled tool, lower a risk class or relax confirmation', () => {
    const { policies } = applyPolicyOverlay([{ ...READ, enabled: false }, WRITE, DELETE], [
      { toolId: READ_ID, enabled: true },
      {
        toolId: WRITE_ID,
        requiresApproval: false,
        pin: { toolId: WRITE_ID, atRiskClass: 'write' },
      },
      { toolId: DELETE_ID, riskClass: 'safe-read', requiresApproval: false },
    ]);
    expect(policies).toEqual([{ ...READ, enabled: false }, WRITE, DELETE]);
  });

  it('applies disabling, risk raises, role narrowing and confirmation', () => {
    const { policies } = applyPolicyOverlay([READ, WRITE, DELETE], [
      { toolId: READ_ID, riskClass: 'write' },
      { toolId: WRITE_ID, allowedRoles: ['admin', 'member'] },
      { toolId: DELETE_ID, enabled: false },
    ]);
    expect(policies).toEqual([
      { ...READ, riskClass: 'write', requiresApproval: true },
      { ...WRITE, allowedRoles: ['member'] },
      { ...DELETE, enabled: false },
    ]);
  });

  it('disables a tool whose role restrictions do not overlap', () => {
    expect(applyPolicyOverlay([WRITE], [
      { toolId: WRITE_ID, allowedRoles: ['admin'] },
    ]).policies).toEqual([{ ...WRITE, enabled: false, allowedRoles: [] }]);
  });

  it.each(['Delete', 'constructor'])(
    'raises an out-of-enum overlay risk class %j to unknown and confirms it',
    (label) => {
      expect(applyPolicyOverlay([READ, { ...WRITE, requiresApproval: false }], [
        { toolId: READ_ID, riskClass: label as ToolRiskClass },
        { toolId: WRITE_ID, riskClass: label as ToolRiskClass },
      ]).policies).toEqual([
        { ...READ, riskClass: 'unknown', requiresApproval: true },
        { ...WRITE, riskClass: 'unknown', requiresApproval: true },
      ]);
    },
  );

  const parityCases: Array<[string, RuntimeToolPolicy, ToolPolicyEntry]> = [
    ['disable', READ, { enabled: false }],
    ['raise read to write', READ, { riskClass: 'write' }],
    ['raise relaxed write to delete', { ...WRITE, requiresApproval: false }, {
      riskClass: 'delete',
    }],
    ['narrow roles', WRITE, { allowedRoles: ['admin', 'member'] }],
    ['disjoint roles', WRITE, { allowedRoles: ['admin'] }],
    ['harden approval', READ, { requiresApproval: true }],
    ['relaxation attempt on write', WRITE, { requiresApproval: false }],
    ['pinned relaxation attempt on write', WRITE, {
      requiresApproval: false,
      pin: { toolId: WRITE_ID, atRiskClass: 'write' },
    }],
  ];

  it.each(parityCases)('matches resolveToolPolicy for %s', (_label, local, entry) => {
    const [overlaid] = applyPolicyOverlay(
      [local],
      [{ toolId: local.toolId, ...entry }],
    ).policies;
    const resolved = resolveToolPolicy({
      toolId: local.toolId,
      defaults: {
        operationGroup: 'update',
        riskClass: local.riskClass as Exclude<ToolRiskClass, 'unknown'>,
        requiresApproval: local.requiresApproval,
        rulesVersion: TOOL_POLICY_RULES_VERSION,
      },
      codeEnabled: local.enabled,
      local: {
        ...(local.allowedRoles.length > 0
          ? { allowedRoles: local.allowedRoles }
          : {}),
        ...(local.requiresApproval ? { requiresApproval: true } : {}),
      },
      platform: entry,
    }).effective;
    expect(overlaid).toEqual({
      toolId: local.toolId,
      enabled: resolved.enabled,
      riskClass: resolved.riskClass,
      requiresApproval: resolved.requiresApproval,
      allowedRoles: resolved.allowedRoles,
    });
  });
});

describe('policyOverlayFromRevision', () => {
  it('maps a verified policy revision to entries and keeps its identity', () => {
    const revision: RuntimePolicyRevision = {
      revisionId: '55555555-5555-4555-8555-555555555555',
      revision: 7,
      tenantId: '66666666-6666-4666-8666-666666666666',
      environmentId: '77777777-7777-4777-8777-777777777777',
      budget: BUDGET,
      toolPolicies: [WRITE],
      toolOverrides: [],
      publishedAt: '2026-10-04T00:00:00.000Z',
      signature: {
        algorithm: 'Ed25519',
        keyId: 'platform-key',
        value: 'c2lnbmF0dXJl',
      },
    };

    expect(policyOverlayFromRevision(revision)).toEqual({
      revisionId: revision.revisionId,
      revision: 7,
      budget: BUDGET,
      entries: [{
        toolId: WRITE_ID,
        enabled: true,
        requiresApproval: true,
        riskClass: 'write',
        allowedRoles: ['member'],
      }],
    });
  });
});
