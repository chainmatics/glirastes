import { describe, expect, it } from 'vitest';
import type {
  AgentRevision,
  ExecutionBudget,
  ManifestRevision,
  Principal,
  RuntimePolicyRevision,
  SecurityRevocation,
} from '../../contracts/index.js';
import {
  assertPromptPinForResume,
  createTurnSnapshot,
  isToolRevoked,
} from '../turn-snapshot.js';

const signature = {
  algorithm: 'Ed25519' as const,
  keyId: 'key-1',
  value: 'c2lnbmF0dXJl',
};

const localLimits: ExecutionBudget = {
  maxModelSteps: 20,
  maxToolCalls: 10,
  totalTimeoutMs: 120_000,
  toolTimeoutMs: 20_000,
  maxInputTokens: 50_000,
  maxOutputTokens: 10_000,
  maxEstimatedCostUsd: 5,
  maxRepeatedFingerprint: 3,
  maxConsecutiveErrors: 3,
  delegation: { maxDepth: 3, maxBreadth: 4, sharedBudget: false },
};

const agentRevision: AgentRevision = {
  revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a01',
  revision: 2,
  agentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a02',
  tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a03',
  name: 'Assistant',
  objective: 'Complete task-management outcomes.',
  modelAlias: 'standard',
  promptBindingRef: 'prompt-v2',
  toolAllowlist: ['019fa9a9-d5f7-7ec3-a3c7-8899de1d3a04'],
  budget: { ...localLimits, maxToolCalls: 8 },
  publishedAt: '2026-07-28T20:00:00.000Z',
  signature,
};

const manifestRevision: ManifestRevision = {
  revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a05',
  revision: 4,
  tenantId: agentRevision.tenantId,
  targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a06',
  environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a07',
  sourceDigest: 'sha256:manifest',
  tools: [{
    toolId: agentRevision.toolAllowlist[0]!,
    sourceFingerprint: 'sha256:tool',
    executionKind: 'endpoint',
    name: 'list_tasks',
    description: 'List visible tasks.',
    riskClass: 'safe-read',
    enabled: true,
    tombstone: false,
    method: 'GET',
    path: '/api/tasks',
    inputSchemaDigest: 'sha256:input',
    outputSchemaDigest: 'sha256:output',
    authBindingRef: 'task-session',
  }],
  publishedAt: '2026-07-28T20:00:00.000Z',
  signature,
};

const policyRevision: RuntimePolicyRevision = {
  revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a08',
  revision: 7,
  tenantId: agentRevision.tenantId,
  environmentId: manifestRevision.environmentId,
  budget: { ...localLimits, maxToolCalls: 6, maxModelSteps: 12 },
  toolPolicies: [{
    toolId: agentRevision.toolAllowlist[0]!,
    enabled: true,
    riskClass: 'safe-read',
    requiresApproval: false,
    allowedRoles: ['admin'],
  }],
  publishedAt: '2026-07-28T20:00:00.000Z',
  signature,
};

const principal: Principal = {
  subjectId: 'user-1',
  tenantId: agentRevision.tenantId,
  roles: ['admin'],
  attributes: {},
};

describe('createTurnSnapshot', () => {
  it('pins one revision set and applies only stricter limits', () => {
    const mutablePolicy = structuredClone(policyRevision);
    const snapshot = createTurnSnapshot({
      turnId: 'turn-1',
      agentRevision,
      manifestRevision,
      policyRevision: mutablePolicy,
      principal,
      localLimits,
      startedAt: '2026-07-28T20:01:00.000Z',
    });

    mutablePolicy.revision = 8;
    mutablePolicy.budget.maxToolCalls = 1;

    expect(snapshot.policyRevision.revision).toBe(7);
    expect(snapshot.budget.maxToolCalls).toBe(6);
    expect(snapshot.budget.maxModelSteps).toBe(12);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('fails closed when tenant or environment revisions do not align', () => {
    expect(() => createTurnSnapshot({
      turnId: 'turn-1',
      agentRevision,
      manifestRevision,
      policyRevision: { ...policyRevision, environmentId: crypto.randomUUID() },
      principal,
      localLimits,
    })).toThrow(/environment/i);
  });

  it('pins the prompt revision identity and digest for the whole turn', () => {
    const promptPin = {
      revisionId: '019fb003-0000-7000-8000-000000000004',
      revision: 3,
      bundleDigest: `sha256:${'A'.repeat(43)}`,
    };
    const snapshot = createTurnSnapshot({
      turnId: 'turn-1',
      agentRevision,
      manifestRevision,
      policyRevision,
      principal,
      localLimits,
      promptPin,
    });

    expect(snapshot.promptPin).toEqual(promptPin);
    expect(Object.isFrozen(snapshot.promptPin)).toBe(true);
    expect(snapshot.manifestRevision.revisionId)
      .toBe(manifestRevision.revisionId);
  });
});

describe('assertPromptPinForResume', () => {
  const promptPin = {
    revisionId: '019fb003-0000-7000-8000-000000000004',
    revision: 3,
    bundleDigest: `sha256:${'A'.repeat(43)}`,
  };
  const snapshot = () => createTurnSnapshot({
    turnId: 'turn-1',
    agentRevision,
    manifestRevision,
    policyRevision,
    principal,
    localLimits,
    promptPin,
  });

  it('resumes a turn on its original prompt revision', () => {
    expect(() => assertPromptPinForResume(snapshot(), promptPin)).not.toThrow();
  });

  it('rejects a conflicting binding instead of silently swapping it', () => {
    expect(() => assertPromptPinForResume(snapshot(), {
      ...promptPin,
      revisionId: '019fb003-0000-7000-8000-000000000005',
      revision: 4,
    })).toThrow(/prompt revision/i);
    expect(() => assertPromptPinForResume(snapshot(), {
      ...promptPin,
      bundleDigest: `sha256:${'B'.repeat(43)}`,
    })).toThrow(/digest/i);
  });

  it('rejects resuming a pinned turn without any prompt binding', () => {
    expect(() => assertPromptPinForResume(snapshot(), undefined))
      .toThrow(/prompt revision/i);
  });

  it('accepts a turn that never pinned a prompt bundle', () => {
    const unpinned = createTurnSnapshot({
      turnId: 'turn-2',
      agentRevision,
      manifestRevision,
      policyRevision,
      principal,
      localLimits,
    });

    expect(() => assertPromptPinForResume(unpinned, undefined)).not.toThrow();
    expect(() => assertPromptPinForResume(unpinned, promptPin)).not.toThrow();
  });
});

describe('isToolRevoked', () => {
  it('applies a security revocation before the next tool call', () => {
    const snapshot = createTurnSnapshot({
      turnId: 'turn-1',
      agentRevision,
      manifestRevision,
      policyRevision,
      principal,
      localLimits,
    });
    const revocation: SecurityRevocation = {
      revocationId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3a09',
      environmentId: manifestRevision.environmentId,
      effectiveAt: '2026-07-28T20:02:00.000Z',
      reasonCode: 'security-disable',
      toolIds: [agentRevision.toolAllowlist[0]!],
      agentRevisionIds: [],
      policyRevisionIds: [],
      signature,
    };

    expect(isToolRevoked(
      snapshot,
      agentRevision.toolAllowlist[0]!,
      [revocation],
      new Date('2026-07-28T20:02:01.000Z'),
    )).toBe(true);
  });
});

export {
  agentRevision,
  localLimits,
  manifestRevision,
  policyRevision,
  principal,
};
