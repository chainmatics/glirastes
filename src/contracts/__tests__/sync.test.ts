import { describe, expect, it } from 'vitest';
import {
  RuntimeRevisionEnvelopeSchema,
  RuntimeSyncBundleSchema,
} from '../revisions.js';

const signature = {
  algorithm: 'Ed25519' as const,
  keyId: 'runtime-key',
  value: 'signed-value',
};
const common = {
  schemaVersion: 1 as const,
  revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901',
  revision: 1,
  tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
  targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
  contentHash: 'sha256:YWJj',
  publishedAt: '2026-07-28T20:00:00.000Z',
  signature,
};

describe('runtime sync contracts', () => {
  it('accepts content-free signed generic revision envelopes', () => {
    expect(RuntimeRevisionEnvelopeSchema.parse({
      ...common,
      revisionType: 'agent',
      subjectId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
      payload: {
        name: 'Order agent',
        objective: 'Help users manage orders',
        modelAlias: 'standard',
        promptBindingRef: 'local://prompts/order-agent',
      },
    })).toBeDefined();
  });

  it('rejects raw content inside a synced payload', () => {
    expect(() => RuntimeRevisionEnvelopeSchema.parse({
      ...common,
      revisionType: 'agent',
      subjectId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
      payload: { prompt: 'private prompt' },
    })).toThrow();
  });

  it('models stable and canary deployments plus revocations in one cursor bundle', () => {
    const agentRevision = {
      ...common,
      revisionType: 'agent' as const,
      subjectId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
      payload: { modelAlias: 'standard' },
    };
    const manifestRevision = {
      ...common,
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905',
      revisionType: 'manifest' as const,
      environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906',
      payload: { sourceDigest: 'sha256:YWJj', tools: [] },
    };
    const policyRevision = {
      ...common,
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3907',
      revisionType: 'policy' as const,
      environmentId: manifestRevision.environmentId,
      payload: { toolPolicies: [] },
    };
    expect(RuntimeSyncBundleSchema.parse({
      cursor: '2026-07-28T20:01:00.000Z',
      activeSnapshotComplete: true,
      deployments: [{
        deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3908',
        environmentId: manifestRevision.environmentId,
        status: 'active',
        rolloutMode: 'canary',
        targetPercentage: 10,
        pinned: false,
        healthStatus: 'healthy',
        agentRevision,
        manifestRevision,
        policyRevision,
        updatedAt: '2026-07-28T20:01:00.000Z',
      }],
      revocations: [],
    })).toBeDefined();
  });
});
