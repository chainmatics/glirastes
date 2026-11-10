import { describe, expect, it } from 'vitest';
import {
  ExecutionBudgetSchema,
  PrincipalSchema,
  RuntimeEnvironmentSchema,
} from '../runtime.js';
import { ExecutionLeaseSchema } from '../revisions.js';

const budget = {
  maxModelSteps: 12,
  maxToolCalls: 8,
  totalTimeoutMs: 120_000,
  toolTimeoutMs: 15_000,
  maxInputTokens: 40_000,
  maxOutputTokens: 8_000,
  maxEstimatedCostUsd: 2,
  maxRepeatedFingerprint: 3,
  maxConsecutiveErrors: 3,
  delegation: {
    maxDepth: 2,
    maxBreadth: 3,
    sharedBudget: true,
  },
};

describe('PrincipalSchema', () => {
  it('accepts a verified server-side principal shape', () => {
    const result = PrincipalSchema.parse({
      subjectId: 'user-42',
      tenantId: 'tenant-7',
      roles: ['admin'],
      attributes: { department: 'operations' },
    });

    expect(result.subjectId).toBe('user-42');
  });

  it.each([
    { subjectId: '', tenantId: 'tenant-7', roles: [] },
    { subjectId: 'user-42', tenantId: '', roles: [] },
    {
      subjectId: 'user-42',
      tenantId: 'tenant-7',
      roles: [],
      attributes: { accessToken: 'raw-token' },
    },
  ])('rejects invalid or credential-bearing principals', (principal) => {
    expect(PrincipalSchema.safeParse(principal).success).toBe(false);
  });
});

describe('ExecutionBudgetSchema', () => {
  it('accepts all required execution dimensions', () => {
    expect(ExecutionBudgetSchema.parse(budget)).toEqual(budget);
  });

  it.each([
    { ...budget, maxToolCalls: 0 },
    { ...budget, toolTimeoutMs: budget.totalTimeoutMs + 1 },
    { ...budget, maxEstimatedCostUsd: -1 },
    { ...budget, delegation: { ...budget.delegation, maxDepth: -1 } },
  ])('rejects unsafe or internally inconsistent limits', (candidate) => {
    expect(ExecutionBudgetSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('ExecutionLeaseSchema', () => {
  const lease = {
    schemaVersion: 1,
    leaseId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3980',
    tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3981',
    targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3982',
    environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3983',
    runnerId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3984',
    deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3985',
    agentRevisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3986',
    triggerId: 'scheduled-safe-read',
    allowedRiskClasses: ['safe-read'],
    budget,
    issuedAt: '2026-07-29T15:00:00.000Z',
    expiresAt: '2026-07-29T15:05:00.000Z',
    signature: {
      algorithm: 'Ed25519',
      keyId: 'runtime-signing-2026-01',
      value: 'c2lnbmF0dXJl',
    },
  };

  it('requires the complete offline execution scope', () => {
    expect(ExecutionLeaseSchema.safeParse(lease).success).toBe(true);
    for (const field of [
      'tenantId',
      'targetAppId',
      'runnerId',
      'deploymentId',
    ] as const) {
      const candidate = structuredClone(lease);
      delete candidate[field];
      expect(ExecutionLeaseSchema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe('RuntimeEnvironmentSchema', () => {
  it.each(['development', 'staging', 'production', 'customer-sandbox'])(
    'accepts the environment name %s',
    (name) => {
      expect(RuntimeEnvironmentSchema.safeParse({
        id: '019fa9a9-d5f7-7ec3-a3c7-8899de1d39bb',
        tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d39bc',
        targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d39bd',
        name,
        status: 'connected',
      }).success).toBe(true);
    },
  );

  it('rejects an unbounded environment label', () => {
    expect(RuntimeEnvironmentSchema.safeParse({
      id: '019fa9a9-d5f7-7ec3-a3c7-8899de1d39bb',
      tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d39bc',
      targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d39bd',
      name: 'x'.repeat(65),
      status: 'connected',
    }).success).toBe(false);
  });
});
