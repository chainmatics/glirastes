import {
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ExecutionLease,
  ToolRiskClass,
} from '../../contracts/revisions.js';
import {
  OfflineExecutionLeaseAuthorizer,
} from '../offline-execution-lease.js';
import { canonicalRuntimeJson } from '../../sync/signature-verifier.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'runtime-key';
const ids = {
  leaseId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3980',
  tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3981',
  targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3982',
  environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3983',
  runnerId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3984',
  deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3985',
  agentRevisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3986',
};
const budget = {
  maxModelSteps: 4,
  maxToolCalls: 3,
  totalTimeoutMs: 30_000,
  toolTimeoutMs: 5_000,
  maxInputTokens: 2_000,
  maxOutputTokens: 500,
  maxEstimatedCostUsd: 0.1,
  maxRepeatedFingerprint: 2,
  maxConsecutiveErrors: 2,
  delegation: { maxDepth: 0, maxBreadth: 0, sharedBudget: true },
};
const keys = {
  getKey: async (requestedKeyId: string) => (
    requestedKeyId === keyId
      ? publicKey.export({ format: 'jwk' })
      : null
  ),
};

function signedLease(
  overrides: Partial<Omit<ExecutionLease, 'signature'>> = {},
): ExecutionLease {
  const unsigned = {
    schemaVersion: 1 as const,
    ...ids,
    triggerId: 'scheduled-safe-read',
    allowedRiskClasses: ['safe-read'] as ToolRiskClass[],
    budget,
    issuedAt: '2026-07-29T15:00:00.000Z',
    expiresAt: '2026-07-29T15:05:00.000Z',
    ...overrides,
  };
  return {
    ...unsigned,
    signature: {
      algorithm: 'Ed25519',
      keyId,
      value: sign(
        null,
        Buffer.from(canonicalRuntimeJson(unsigned)),
        privateKey,
      ).toString('base64url'),
    },
  };
}

function request(
  lease: ExecutionLease,
  overrides: Partial<{
    riskClass: ToolRiskClass;
    requiresApproval: boolean;
    at: Date;
    triggerId: string;
  }> = {},
) {
  return {
    lease,
    scope: {
      tenantId: ids.tenantId,
      targetAppId: ids.targetAppId,
      environmentId: ids.environmentId,
      runnerId: ids.runnerId,
      deploymentId: ids.deploymentId,
      agentRevisionId: ids.agentRevisionId,
      triggerId: overrides.triggerId ?? 'scheduled-safe-read',
    },
    riskClass: overrides.riskClass ?? 'safe-read' as ToolRiskClass,
    requiresApproval: overrides.requiresApproval ?? false,
    at: overrides.at ?? new Date('2026-07-29T15:02:00.000Z'),
  };
}

describe('OfflineExecutionLeaseAuthorizer', () => {
  it('accepts a signed, scoped, unexpired safe-read lease', async () => {
    const authorizer = new OfflineExecutionLeaseAuthorizer(keys);
    await expect(authorizer.authorize(request(signedLease()))).resolves.toEqual({
      leaseId: ids.leaseId,
      budget,
    });
  });

  it('rejects tampering and every scope mismatch', async () => {
    const authorizer = new OfflineExecutionLeaseAuthorizer(keys);
    const valid = signedLease();
    await expect(authorizer.authorize(request({
      ...valid,
      targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3999',
    }))).rejects.toThrow(/signature/i);
    await expect(authorizer.authorize(request(valid, {
      triggerId: 'different-trigger',
    }))).rejects.toThrow(/scope/i);
  });

  it('fails closed before issuance, at expiry, for writes, and for approvals', async () => {
    const authorizer = new OfflineExecutionLeaseAuthorizer(keys);
    const lease = signedLease();
    await expect(authorizer.authorize(request(lease, {
      at: new Date('2026-07-29T14:59:59.999Z'),
    }))).rejects.toThrow(/not active/i);
    await expect(authorizer.authorize(request(lease, {
      at: new Date(lease.expiresAt),
    }))).rejects.toThrow(/expired/i);
    await expect(authorizer.authorize(request(lease, {
      riskClass: 'write',
    }))).rejects.toThrow(/safe-read/i);
    await expect(authorizer.authorize(request(lease, {
      requiresApproval: true,
    }))).rejects.toThrow(/approval/i);
  });
});
