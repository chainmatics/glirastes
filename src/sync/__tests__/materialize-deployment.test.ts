import { describe, expect, it } from 'vitest';
import type { RuntimeDeploymentBundle } from '../../contracts/revisions.js';
import { materializeDeploymentRevisions } from '../materialize-deployment.js';

const budget = {
  maxModelSteps: 10,
  maxToolCalls: 8,
  totalTimeoutMs: 60_000,
  toolTimeoutMs: 10_000,
  maxInputTokens: 10_000,
  maxOutputTokens: 2_000,
  maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 2,
  maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 2, sharedBudget: true },
};
const signature = {
  algorithm: 'Ed25519' as const,
  keyId: 'runtime-key',
  value: 'signed-value',
};
const common = {
  schemaVersion: 1 as const,
  revision: 1,
  tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901',
  targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
  contentHash: 'sha256:YWJj',
  publishedAt: '2026-07-28T20:00:00.000Z',
  signature,
};

function deployment(): RuntimeDeploymentBundle {
  const environmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903';
  return {
    deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
    environmentId,
    status: 'active',
    rolloutMode: 'stable',
    targetPercentage: 100,
    pinned: false,
    healthStatus: 'healthy',
    agentRevision: {
      ...common,
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905',
      revisionType: 'agent',
      subjectId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906',
      payload: {
        name: 'Order agent',
        objective: 'Help with orders',
        modelAlias: 'standard',
        promptBindingRef: 'local://prompts/order-agent',
        toolAllowlist: [],
        budget,
      },
    },
    manifestRevision: {
      ...common,
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3907',
      revisionType: 'manifest',
      environmentId,
      payload: { sourceDigest: 'sha256:YWJj', tools: [] },
    },
    policyRevision: {
      ...common,
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3908',
      revisionType: 'policy',
      environmentId,
      payload: { budget, toolPolicies: [] },
    },
    updatedAt: '2026-07-28T20:01:00.000Z',
  };
}

describe('materializeDeploymentRevisions', () => {
  it('turns generic signed envelopes into typed local runtime revisions', () => {
    const materialized = materializeDeploymentRevisions(deployment());
    expect(materialized.agentRevision.agentId).toBe(
      '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906',
    );
    expect(materialized.manifestRevision.environmentId).toBe(
      '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
    );
    expect(materialized.policyRevision.budget.maxToolCalls).toBe(8);
  });

  it('fails closed when a published payload is structurally incomplete', () => {
    const invalid = deployment();
    invalid.agentRevision.payload = { modelAlias: 'standard' };
    expect(() => materializeDeploymentRevisions(invalid)).toThrow();
  });

  it('materializes a v2 planner payload with the policy budget', () => {
    const bundle = deployment();
    bundle.agentRevision.payload = {
      schemaVersion: 1,
      plannerId: 'foundation',
      modelBindingRef: 'balanced',
      promptBindingRef: 'prompt:get-it-done',
      budgetProfileRef: 'foundation-default',
      toolAllowlist: ['019fa9a9-d5f7-7ec3-a3c7-8899de1d3999'],
    };

    const materialized = materializeDeploymentRevisions(bundle);

    expect(materialized.agentRevision.agentId).toBe(
      '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906',
    );
    expect(materialized.agentRevision.modelAlias).toBe('balanced');
    expect(materialized.agentRevision.promptBindingRef).toBe(
      'prompt:get-it-done',
    );
    expect(materialized.agentRevision.toolAllowlist).toEqual([
      '019fa9a9-d5f7-7ec3-a3c7-8899de1d3999',
    ]);
    // A planner revision references a budget profile; the concrete budget is
    // pinned by the policy revision of the same deployment.
    expect(materialized.agentRevision.budget).toEqual(budget);
  });

  it('fails closed on a planner payload without a tool allowlist', () => {
    const bundle = deployment();
    bundle.agentRevision.payload = {
      schemaVersion: 1,
      plannerId: 'foundation',
      modelBindingRef: 'balanced',
      promptBindingRef: 'prompt:get-it-done',
      budgetProfileRef: 'foundation-default',
    };
    expect(() => materializeDeploymentRevisions(bundle)).toThrow();
  });

  it('fails closed on a planner payload with unknown fields', () => {
    const bundle = deployment();
    bundle.agentRevision.payload = {
      schemaVersion: 1,
      plannerId: 'foundation',
      modelBindingRef: 'balanced',
      promptBindingRef: 'prompt:get-it-done',
      budgetProfileRef: 'foundation-default',
      toolAllowlist: [],
      systemPrompt: 'injected',
    };
    expect(() => materializeDeploymentRevisions(bundle)).toThrow();
  });
});
