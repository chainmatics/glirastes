import { describe, expect, it } from 'vitest';
import type {
  AgentRevision,
  ExecutionBudget,
  ManifestRevision,
  ManifestTool,
  Principal,
  RuntimePolicyRevision,
  RuntimeToolPolicy,
  ToolOverrideDelta,
} from '../../contracts/index.js';
import { authorizeToolCall } from '../authorization.js';
import { createTurnSnapshot, type TurnSnapshot } from '../turn-snapshot.js';

// Self-contained on purpose: turn-snapshot.test.ts is a fixture module that
// nine other test files import, so cases added there run ten times.
const id = (suffix: string) => `019fb004-0000-7000-8000-${suffix.padStart(12, '0')}`;
const TENANT_ID = id('a1');
const ENVIRONMENT_ID = id('a2');
const WRITE_ID = id('1');
const LOCKED_ID = id('2');
const DELETE_ID = id('3');
const UNPINNED_ID = id('4');
const FOREIGN_PIN_ID = id('5');
const TOOL_IDS = [WRITE_ID, LOCKED_ID, DELETE_ID, UNPINNED_ID, FOREIGN_PIN_ID];

const signature = { algorithm: 'Ed25519' as const, keyId: 'platform-key', value: 'c2lnbmF0dXJl' };
const budget: ExecutionBudget = {
  maxModelSteps: 8,
  maxToolCalls: 8,
  totalTimeoutMs: 60_000,
  toolTimeoutMs: 10_000,
  maxInputTokens: 40_000,
  maxOutputTokens: 8_000,
  maxEstimatedCostUsd: 2,
  maxRepeatedFingerprint: 3,
  maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 1, sharedBudget: true },
};

const riskOf = (toolId: string) => (toolId === DELETE_ID ? 'delete' as const : 'write' as const);

const agentRevision: AgentRevision = {
  revisionId: id('b1'),
  revision: 3,
  agentId: id('b2'),
  tenantId: TENANT_ID,
  name: 'Assistant',
  objective: 'Complete task-management outcomes.',
  modelAlias: 'standard',
  promptBindingRef: 'prompt-v3',
  toolAllowlist: TOOL_IDS,
  budget,
  publishedAt: '2026-10-05T08:00:00.000Z',
  signature,
};

const manifestRevision: ManifestRevision = {
  revisionId: id('b3'),
  revision: 5,
  tenantId: TENANT_ID,
  targetAppId: id('b4'),
  environmentId: ENVIRONMENT_ID,
  sourceDigest: 'sha256:manifest',
  tools: TOOL_IDS.map((toolId, index): ManifestTool => ({
    toolId,
    sourceFingerprint: 'sha256:tool',
    executionKind: 'endpoint',
    name: `tasks.tool${index}`,
    description: 'Changes a task.',
    riskClass: riskOf(toolId),
    enabled: true,
    tombstone: false,
    method: toolId === DELETE_ID ? 'DELETE' : 'PATCH',
    path: `/api/tasks/${index}`,
    inputSchemaDigest: 'sha256:input',
    outputSchemaDigest: 'sha256:output',
    authBindingRef: 'session',
  })),
  publishedAt: '2026-10-05T08:00:00.000Z',
  signature,
};

const reported: RuntimeToolPolicy[] = TOOL_IDS.map((toolId) => ({
  toolId,
  enabled: true,
  riskClass: riskOf(toolId),
  requiresApproval: true,
  allowedRoles: [],
}));

const relax = (toolId: string, pinToolId = toolId): ToolOverrideDelta => ({
  toolId,
  requiresApproval: false,
  pin: { toolId: pinToolId, atRiskClass: 'write' },
});

const policyRevision = (toolOverrides: ToolOverrideDelta[]): RuntimePolicyRevision => ({
  revisionId: id('b5'),
  revision: 9,
  tenantId: TENANT_ID,
  environmentId: ENVIRONMENT_ID,
  budget,
  toolPolicies: reported,
  toolOverrides,
  publishedAt: '2026-10-05T08:00:00.000Z',
  signature,
});

const principal: Principal = { subjectId: 'user-1', tenantId: TENANT_ID, roles: ['member'], attributes: {} };

function snapshotFrom(
  toolOverrides: ToolOverrideDelta[],
  relaxableToolIds?: ReadonlySet<string>,
): TurnSnapshot {
  return createTurnSnapshot({
    turnId: 'turn-d16',
    agentRevision,
    manifestRevision,
    policyRevision: policyRevision(toolOverrides),
    principal,
    localLimits: budget,
    ...(relaxableToolIds ? { relaxableToolIds } : {}),
  });
}

function asksFirst(snapshot: TurnSnapshot, toolId: string): boolean {
  const authorization = authorizeToolCall({ ...snapshot, principal, toolId });
  if (!authorization.allowed) throw new Error(authorization.reason);
  return authorization.requiresApproval;
}

describe('createTurnSnapshot with a Platform relaxation (D16)', () => {
  // Every tool but LOCKED_ID is named relaxable, so only the rule can refuse.
  const relaxable = new Set([WRITE_ID, DELETE_ID, UNPINNED_ID, FOREIGN_PIN_ID]);

  it('keeps every confirmation without the local code report (fail closed)', () => {
    const snapshot = snapshotFrom([relax(WRITE_ID)]);
    expect(snapshot.policyRevision.toolPolicies).toEqual(reported);
    expect(asksFirst(snapshot, WRITE_ID)).toBe(true);
  });

  it('never relaxes a local lock, tier 3, an unpinned or a foreign-pinned decision', () => {
    const snapshot = snapshotFrom([
      relax(LOCKED_ID),
      relax(DELETE_ID),
      { toolId: UNPINNED_ID, requiresApproval: false },
      relax(FOREIGN_PIN_ID, WRITE_ID),
    ], relaxable);
    expect(snapshot.policyRevision.toolPolicies).toEqual(reported);
    for (const toolId of [LOCKED_ID, DELETE_ID, UNPINNED_ID, FOREIGN_PIN_ID]) {
      expect(asksFirst(snapshot, toolId)).toBe(true);
    }
  });

  it('runs a code-default write tool without asking once the relaxation is signed', () => {
    const snapshot = snapshotFrom([relax(WRITE_ID)], relaxable);
    expect(snapshot.policyRevision.toolPolicies[0]).toEqual({ ...reported[0], requiresApproval: false });
    expect(snapshot.policyRevision.toolOverrides).toEqual([relax(WRITE_ID)]);
    expect(asksFirst(snapshot, WRITE_ID)).toBe(false);
    expect(asksFirst(snapshot, LOCKED_ID)).toBe(true);
    expect(Object.isFrozen(snapshot.policyRevision.toolPolicies[0])).toBe(true);
  });

  it('keeps a revision without decisions exactly as signed', () => {
    expect(snapshotFrom([], relaxable).policyRevision).toEqual(policyRevision([]));
  });
});
