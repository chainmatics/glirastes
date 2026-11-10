import { describe, expect, it } from 'vitest';
import {
  RuntimeDeploymentBundleSchema,
  RuntimeRevisionEnvelopeSchema,
} from '../revisions.js';

const environmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901';
const signature = {
  algorithm: 'Ed25519' as const,
  keyId: 'runtime-key',
  value: 'signed-value',
};
const budget = {
  maxToolCalls: 24,
  maxModelSteps: 12,
  toolTimeoutMs: 15_000,
  totalTimeoutMs: 60_000,
  maxInputTokens: 50_000,
  maxOutputTokens: 20_000,
  maxEstimatedCostUsd: 5,
  maxConsecutiveErrors: 3,
  maxRepeatedFingerprint: 3,
  delegation: { maxDepth: 2, maxBreadth: 4, sharedBudget: true },
};

function revision(
  revisionType: 'agent' | 'manifest' | 'policy' | 'config',
  idSuffix: string,
) {
  return {
    schemaVersion: 1,
    revisionId: `019fa9a9-d5f7-7ec3-a3c7-8899de1d39${idSuffix}`,
    revisionType,
    revision: 1,
    tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
    targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
    ...(revisionType === 'agent'
      ? { subjectId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904' }
      : {}),
    ...(['manifest', 'policy'].includes(revisionType)
      ? { environmentId }
      : {}),
    contentHash: 'sha256:YWJj',
    payload: revisionType === 'agent'
      ? {
          name: 'Order agent',
          objective: 'Help with orders',
          modelAlias: 'standard',
          promptBindingRef: 'local://prompts/order-agent',
          toolAllowlist: [],
          budget,
        }
      : revisionType === 'manifest'
        ? { sourceDigest: 'sha256:YWJj', tools: [] }
        : revisionType === 'policy'
          ? { budget, toolPolicies: [] }
          : {
              schemaVersion: 1,
              setupArtifactDigest: 'sha256:YWJj',
              runtimeDigest: 'sha256:cnQ',
              promptDigest: 'sha256:cHQ',
              promptRevisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3941',
              plannerRevisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3942',
              tools: [],
            },
    publishedAt: '2026-07-28T20:00:00.000Z',
    signature,
  };
}

const promptBinding = {
  schemaVersion: 1,
  appId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
  revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3941',
  revision: 1,
  bundleDigest: 'sha256:cHQ',
  artifactRef: 'local://get-it-done/prompt-bundle',
  activatedAt: '2026-07-28T20:00:00.000Z',
  signature,
};

function boundDeployment() {
  return {
    deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3930',
    environmentId,
    status: 'pending',
    rolloutMode: 'stable',
    targetPercentage: 100,
    pinned: false,
    healthStatus: 'unknown',
    agentRevision: revision('agent', '11'),
    manifestRevision: revision('manifest', '12'),
    policyRevision: revision('policy', '13'),
    configRevision: revision('config', '14'),
    runtimeDigest: 'sha256:cnQ',
    promptDigest: 'sha256:cHQ',
    promptBinding,
    updatedAt: '2026-07-28T20:01:00.000Z',
  };
}

describe('deployment artifact bindings on the wire', () => {
  it('accepts a deployment that carries its runtime and prompt bindings', () => {
    // The Platform serves these four fields for every deployment created since
    // artifact binding landed. A contract that rejects them silently strands
    // every new deployment client-side — which is exactly what happened.
    const parsed = RuntimeDeploymentBundleSchema.safeParse(boundDeployment());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('still accepts the transitional shape without bindings', () => {
    const {
      configRevision: _config,
      runtimeDigest: _runtime,
      promptDigest: _prompt,
      promptBinding: _binding,
      ...withoutBindings
    } = boundDeployment();
    expect(RuntimeDeploymentBundleSchema.safeParse(withoutBindings).success)
      .toBe(true);
  });

  it('rejects a deployment carrying only part of its binding', () => {
    // The server emits all four or none; a partial set means something was
    // stripped or tampered with, and must not pass as either shape.
    for (const missing of [
      'configRevision',
      'runtimeDigest',
      'promptDigest',
      'promptBinding',
    ] as const) {
      const candidate: Record<string, unknown> = boundDeployment();
      delete candidate[missing];
      const parsed = RuntimeDeploymentBundleSchema.safeParse(candidate);
      expect(parsed.success, `without ${missing}`).toBe(false);
    }
  });

  it('requires the config envelope to actually be a config revision', () => {
    const candidate = {
      ...boundDeployment(),
      configRevision: revision('manifest', '12'),
    };
    expect(RuntimeDeploymentBundleSchema.safeParse(candidate).success)
      .toBe(false);
  });

  it('accepts a config envelope without environment or subject scope', () => {
    // Config revisions are app-scoped: unlike manifest/policy they carry no
    // environmentId, unlike tool/agent no subjectId.
    const parsed = RuntimeRevisionEnvelopeSchema.safeParse(revision('config', '14'));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
