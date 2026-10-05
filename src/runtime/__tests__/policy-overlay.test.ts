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
  overlayDescriptions,
  policyOverlayFromRevision,
  relaxableToolIds,
  type PolicyOverlayEntry,
} from '../policy-overlay.js';

const READ_ID = '11111111-1111-4111-8111-111111111111';
const WRITE_ID = '22222222-2222-4222-8222-222222222222';
const DELETE_ID = '33333333-3333-4333-8333-333333333333';
const REMOVED_ID = '44444444-4444-4444-8444-444444444444';
const FINANCIAL_ID = '88888888-8888-4888-8888-888888888888';
const EXTERNAL_ID = '99999999-9999-4999-8999-999999999999';
const UNKNOWN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
      .toEqual({ policies: [READ, WRITE], ignored: [], relaxations: [] });
  });

  it('ignores overlay ids that the deployed code does not have', () => {
    expect(applyPolicyOverlay([READ], [
      { toolId: REMOVED_ID, enabled: true, requiresApproval: false },
      { toolId: REMOVED_ID, allowedRoles: ['admin'] },
    ])).toEqual({
      policies: [READ],
      ignored: [{ toolId: REMOVED_ID, reason: 'platform-tool-not-in-code' }],
      relaxations: [],
    });
  });

  // D16 flipped this case on purpose: a pinned relaxation of a write tool is
  // no longer a no-op as such; it stays one here only because the caller did
  // not name the tool relaxable (no local code report, fail closed).
  it('cannot enable a disabled tool or lower a risk class, and relaxes nothing it may not', () => {
    const result = applyPolicyOverlay([{ ...READ, enabled: false }, WRITE, DELETE], [
      { toolId: READ_ID, enabled: true },
      {
        toolId: WRITE_ID,
        requiresApproval: false,
        pin: { toolId: WRITE_ID, atRiskClass: 'write' },
      },
      { toolId: DELETE_ID, riskClass: 'safe-read', requiresApproval: false },
    ]);
    expect(result.policies).toEqual([{ ...READ, enabled: false }, WRITE, DELETE]);
    expect(result.relaxations).toEqual([
      { toolId: WRITE_ID, outcome: 'locked-locally' },
      { toolId: DELETE_ID, outcome: 'tier-3-always-requires-approval' },
    ]);
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
    ['pinned relaxation on write', WRITE, {
      requiresApproval: false,
      pin: { toolId: WRITE_ID, atRiskClass: 'write' },
    }],
    ['relaxation pinned below the class', WRITE, {
      requiresApproval: false,
      pin: { toolId: WRITE_ID, atRiskClass: 'safe-read' },
    }],
    ['relaxation with a raise to delete', WRITE, {
      riskClass: 'delete',
      requiresApproval: false,
      pin: { toolId: WRITE_ID, atRiskClass: 'write' },
    }],
    ['relaxation pinned at delete', DELETE, {
      requiresApproval: false,
      pin: { toolId: DELETE_ID, atRiskClass: 'delete' },
    }],
    ['relaxation pinned for another tool', WRITE, {
      requiresApproval: false,
      pin: { toolId: READ_ID, atRiskClass: 'write' },
    }],
  ];

  // The composition form of the D16 vectors: the local policy is the reported
  // default, and a tool the code report does not name relaxable carries its
  // confirmation as an explicit local hardening.
  it.each(parityCases.flatMap(([label, local, entry]) => [
    [label, 'relaxable', local, entry] as const,
    [label, 'locked', local, entry] as const,
  ]))('matches resolveToolPolicy for %s (%s)', (_label, lock, local, entry) => {
    const relaxable = lock === 'relaxable';
    const [overlaid] = applyPolicyOverlay(
      [local],
      [{ toolId: local.toolId, ...entry }],
      { relaxableToolIds: new Set(relaxable ? [local.toolId] : []) },
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
        ...(local.requiresApproval && !relaxable ? { requiresApproval: true } : {}),
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

describe('applyPolicyOverlay with Platform relaxations (D16)', () => {
  const FINANCIAL: RuntimeToolPolicy = { ...DELETE, toolId: FINANCIAL_ID, riskClass: 'financial' };
  const EXTERNAL: RuntimeToolPolicy = { ...DELETE, toolId: EXTERNAL_ID, riskClass: 'external' };
  const UNKNOWN: RuntimeToolPolicy = { ...DELETE, toolId: UNKNOWN_ID, riskClass: 'unknown' };
  const pinned = (toolId: string, atRiskClass: ToolRiskClass): PolicyOverlayEntry => ({
    toolId,
    requiresApproval: false,
    pin: { toolId, atRiskClass },
  });
  const everyTool = new Set([READ_ID, WRITE_ID, DELETE_ID, FINANCIAL_ID, EXTERNAL_ID, UNKNOWN_ID]);

  // Refusals first: each case would have to stay a no-op even for a caller
  // that names every tool relaxable.
  it('never relaxes tier 3 or an unassessed class, pinned or not', () => {
    const local = [DELETE, FINANCIAL, EXTERNAL, UNKNOWN];
    const result = applyPolicyOverlay(local, [
      pinned(DELETE_ID, 'delete'),
      pinned(FINANCIAL_ID, 'write'),
      { toolId: EXTERNAL_ID, requiresApproval: false },
      pinned(UNKNOWN_ID, 'write'),
    ], { relaxableToolIds: everyTool });
    expect(result.policies).toEqual(local);
    expect(result.relaxations).toEqual([
      { toolId: DELETE_ID, outcome: 'tier-3-always-requires-approval' },
      { toolId: FINANCIAL_ID, outcome: 'override-lapsed-risk-raised' },
      { toolId: EXTERNAL_ID, outcome: 'tier-3-always-requires-approval' },
      { toolId: UNKNOWN_ID, outcome: 'override-lapsed-risk-raised' },
    ]);
  });

  it('lets a relaxation lapse once the risk rises above its pin', () => {
    const raisedByTheCode = applyPolicyOverlay([DELETE], [pinned(DELETE_ID, 'write')], {
      relaxableToolIds: everyTool,
    });
    expect(raisedByTheCode.policies).toEqual([DELETE]);
    const raisedTogether = applyPolicyOverlay([WRITE], [
      { ...pinned(WRITE_ID, 'write'), riskClass: 'delete' },
    ], { relaxableToolIds: everyTool });
    expect(raisedTogether.policies).toEqual([{ ...WRITE, riskClass: 'delete', requiresApproval: true }]);
    const pinnedBelow = applyPolicyOverlay([WRITE], [pinned(WRITE_ID, 'read-sensitive')], {
      relaxableToolIds: everyTool,
    });
    expect(pinnedBelow.policies).toEqual([WRITE]);
    expect([raisedByTheCode, raisedTogether, pinnedBelow].map((result) => result.relaxations[0]?.outcome))
      .toEqual(['override-lapsed-risk-raised', 'override-lapsed-risk-raised', 'override-lapsed-risk-raised']);
  });

  it('never relaxes over a local lock or without the local report', () => {
    const lockedInPolicyFile = applyPolicyOverlay([WRITE], [pinned(WRITE_ID, 'write')], {
      relaxableToolIds: new Set([READ_ID]),
    });
    const withoutReport = applyPolicyOverlay([WRITE], [pinned(WRITE_ID, 'write')]);
    for (const result of [lockedInPolicyFile, withoutReport]) {
      expect(result.policies).toEqual([WRITE]);
      expect(result.relaxations).toEqual([{ toolId: WRITE_ID, outcome: 'locked-locally' }]);
    }
  });

  it('needs a reviewed pin for this very tool', () => {
    const result = applyPolicyOverlay([WRITE, { ...WRITE, toolId: READ_ID }], [
      { toolId: WRITE_ID, requiresApproval: false },
      { toolId: READ_ID, requiresApproval: false, pin: { toolId: WRITE_ID, atRiskClass: 'write' } },
    ], { relaxableToolIds: everyTool });
    expect(result.policies).toEqual([WRITE, { ...WRITE, toolId: READ_ID }]);
    expect(result.relaxations).toEqual([
      { toolId: WRITE_ID, outcome: 'relaxation-requires-reviewed-pin' },
      { toolId: READ_ID, outcome: 'pin-for-other-tool' },
    ]);
  });

  it('refuses a relaxation next to another decision for the same tool', () => {
    const result = applyPolicyOverlay([WRITE], [
      { toolId: WRITE_ID, requiresApproval: true },
      pinned(WRITE_ID, 'write'),
    ], { relaxableToolIds: everyTool });
    expect(result.policies).toEqual([WRITE]);
    expect(result.relaxations).toEqual([{ toolId: WRITE_ID, outcome: 'duplicate-decisions' }]);
  });

  it('takes a relaxation only from a signed decision, never from a reported copy', () => {
    const overlay = policyOverlayFromRevision({
      revisionId: '55555555-5555-4555-8555-555555555555',
      revision: 8,
      tenantId: '66666666-6666-4666-8666-666666666666',
      environmentId: '77777777-7777-4777-8777-777777777777',
      budget: BUDGET,
      toolPolicies: [{ ...WRITE, requiresApproval: false }],
      toolOverrides: [],
      publishedAt: '2026-10-05T00:00:00.000Z',
      signature: { algorithm: 'Ed25519', keyId: 'platform-key', value: 'c2lnbmF0dXJl' },
    });
    expect(applyPolicyOverlay([WRITE], overlay.entries, { relaxableToolIds: everyTool }))
      .toEqual({ policies: [WRITE], ignored: [], relaxations: [] });
  });

  // Acceptance after the refusals.
  it('switches off a code-default confirmation pinned at its class, up to tier 2', () => {
    const readSensitive = { ...WRITE, toolId: READ_ID, riskClass: 'read-sensitive' as const };
    const result = applyPolicyOverlay([WRITE, readSensitive], [
      pinned(WRITE_ID, 'write'),
      pinned(READ_ID, 'read-sensitive'),
    ], { relaxableToolIds: everyTool });
    expect(result.policies).toEqual([
      { ...WRITE, requiresApproval: false },
      { ...readSensitive, requiresApproval: false },
    ]);
    expect(result.relaxations).toEqual([
      { toolId: WRITE_ID, outcome: 'applied' },
      { toolId: READ_ID, outcome: 'applied' },
    ]);
  });

  it('keeps every restriction of the relaxing decision and stays idempotent', () => {
    const entries = [{ ...pinned(WRITE_ID, 'write'), allowedRoles: ['admin'] }];
    const once = applyPolicyOverlay([{ ...WRITE, allowedRoles: [] }], entries, {
      relaxableToolIds: everyTool,
    });
    expect(once.policies).toEqual([{ ...WRITE, allowedRoles: ['admin'], requiresApproval: false }]);
    expect(applyPolicyOverlay(once.policies, entries, { relaxableToolIds: everyTool }).policies)
      .toEqual(once.policies);
  });
});

describe('relaxableToolIds', () => {
  const tool = (toolId: string, extra: Record<string, unknown>) => ({
    toolId,
    sourceFingerprint: `sha256:${'F'.repeat(43)}`,
    name: `tool.${toolId.slice(0, 4)}`,
    executionKind: 'endpoint',
    method: 'POST',
    path: '/api/tasks',
    operationGroup: 'create',
    riskClass: 'write',
    enabled: true,
    requiresApproval: true,
    inputSchemaDigest: `sha256:${'I'.repeat(43)}`,
    outputSchemaDigest: `sha256:${'O'.repeat(43)}`,
    ...extra,
  });
  const artifact = (tools: unknown[]) => ({
    schemaVersion: 1,
    artifactId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    appId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    discoveryDigest: `sha256:${'A'.repeat(43)}`,
    assessmentMode: 'autonomous',
    status: 'ready',
    tools,
    planner: {
      plannerId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      modelBindingRef: 'default',
      promptBindingRef: 'prompt:fixture',
      budgetProfileRef: 'default',
      toolIds: [],
    },
    prompts: {
      bundleDigest: `sha256:${'B'.repeat(43)}`,
      artifactRef: 'local://fixture/prompts',
      plannerDigest: `sha256:${'C'.repeat(43)}`,
      appBehaviorDigest: `sha256:${'D'.repeat(43)}`,
      responseStyleDigest: `sha256:${'E'.repeat(43)}`,
      capabilityFragmentDigests: {},
    },
    warnings: [],
    generatedAt: '2026-10-05T08:00:00.000Z',
  });

  it('names only code-default confirmations up to tier 2 from the code report', () => {
    expect(relaxableToolIds(artifact([
      tool(WRITE_ID, { provenance: { policyOrigin: { requiresApproval: 'code-default' } } }),
      tool(READ_ID, { provenance: { policyOrigin: { requiresApproval: 'local-policy' } } }),
      tool(DELETE_ID, {
        method: 'DELETE', operationGroup: 'delete', riskClass: 'delete',
        provenance: { policyOrigin: { requiresApproval: 'code-default' } },
      }),
      tool(REMOVED_ID, {}),
    ]))).toEqual(new Set([WRITE_ID]));
  });

  it('refuses an artifact that fails the contract', () => {
    expect(() => relaxableToolIds({ tools: [] })).toThrow(/schemaVersion/);
  });
});

describe('policyOverlayFromRevision', () => {
  const revision: RuntimePolicyRevision = {
    revisionId: '55555555-5555-4555-8555-555555555555',
    revision: 7,
    tenantId: '66666666-6666-4666-8666-666666666666',
    environmentId: '77777777-7777-4777-8777-777777777777',
    budget: BUDGET,
    toolPolicies: [WRITE, READ],
    toolOverrides: [],
    publishedAt: '2026-10-04T00:00:00.000Z',
    signature: {
      algorithm: 'Ed25519',
      keyId: 'platform-key',
      value: 'c2lnbmF0dXJl',
    },
  };

  it('reads the signed decision deltas, never the reported toolPolicies copies', () => {
    const toolOverrides = [
      { toolId: WRITE_ID, enabled: false, description: 'Archives a task.' },
      { toolId: REMOVED_ID, riskClass: 'delete' as const },
    ];
    expect(policyOverlayFromRevision({ ...revision, toolOverrides })).toEqual({
      revisionId: revision.revisionId,
      revision: 7,
      budget: BUDGET,
      entries: toolOverrides,
    });
  });

  it('leaves the local policy untouched when the Platform decided nothing', () => {
    const overlay = policyOverlayFromRevision(revision);
    expect(overlay.entries).toEqual([]);
    // A later local relaxation is no longer frozen by a copied Platform value.
    const relaxedLocally = { ...WRITE, allowedRoles: [] };
    expect(applyPolicyOverlay([relaxedLocally], overlay.entries).policies).toEqual([relaxedLocally]);
  });
});

describe('overlayDescriptions', () => {
  it('takes a Platform description only for tools the code has', () => {
    expect(overlayDescriptions(new Set([READ_ID, WRITE_ID]), [
      { toolId: WRITE_ID, description: 'Archives a task.' },
      { toolId: READ_ID, enabled: false },
      { toolId: REMOVED_ID, description: 'Never shown.' },
    ])).toEqual(new Map([[WRITE_ID, 'Archives a task.']]));
  });

  it('lets the last delta for a tool win, like the policy layers', () => {
    expect(overlayDescriptions(new Set([WRITE_ID]), [
      { toolId: WRITE_ID, description: 'First.' },
      { toolId: WRITE_ID, description: 'Second.' },
    ]).get(WRITE_ID)).toBe('Second.');
  });
});
