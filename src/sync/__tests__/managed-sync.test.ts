import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeDeploymentBundle,
  RuntimeRevisionEnvelope,
} from '../../contracts/revisions.js';
import { canonicalRuntimeJson } from '../signature-verifier.js';
import { createManagedRuntimeSync } from '../managed-sync.js';

const environmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901';
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
const common = {
  schemaVersion: 1 as const,
  revision: 1,
  tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
  targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
  publishedAt: '2026-07-29T00:00:00.000Z',
};

function revision(
  privateKey: KeyObject,
  input: Omit<RuntimeRevisionEnvelope, 'contentHash' | 'signature'>,
): RuntimeRevisionEnvelope {
  const contentHash = `sha256:${createHash('sha256')
    .update(canonicalRuntimeJson(input.payload))
    .digest('base64url')}`;
  const unsigned = { ...input, contentHash };
  return {
    ...unsigned,
    signature: {
      algorithm: 'Ed25519',
      keyId: 'runtime-key',
      value: sign(
        null,
        Buffer.from(canonicalRuntimeJson(unsigned)),
        privateKey,
      ).toString('base64url'),
    },
  };
}

function activeDeployment(privateKey: KeyObject): RuntimeDeploymentBundle {
  return {
    deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
    environmentId,
    status: 'active',
    rolloutMode: 'stable',
    targetPercentage: 100,
    pinned: false,
    healthStatus: 'healthy',
    agentRevision: revision(privateKey, {
      ...common,
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905',
      revisionType: 'agent',
      subjectId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3906',
      payload: {
        name: 'Task agent',
        objective: 'Manage tasks',
        modelAlias: 'standard',
        promptBindingRef: 'local://prompts/task-agent',
        toolAllowlist: [],
        budget,
      },
    }),
    manifestRevision: revision(privateKey, {
      ...common,
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3907',
      revisionType: 'manifest',
      environmentId,
      payload: { sourceDigest: 'sha256:YWJj', tools: [] },
    }),
    policyRevision: revision(privateKey, {
      ...common,
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3908',
      revisionType: 'policy',
      environmentId,
      payload: { budget, toolPolicies: [] },
    }),
    updatedAt: '2026-07-29T00:01:00.000Z',
  };
}

describe('createManagedRuntimeSync', () => {
  it('reports an activated deployment as locally applied', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => (
      url.includes('jwks')
        ? new Response(JSON.stringify({
            keys: [{
              ...publicKey.export({ format: 'jwk' }),
              kid: 'runtime-key',
              alg: 'EdDSA',
              use: 'sig',
            }],
          }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 })
    ));
    const { manager } = createManagedRuntimeSync({
      baseUrl: 'https://control.example',
      apiKey: 'runtime-secret',
      appId: common.targetAppId,
      environmentId,
      runnerKey: 'get-it-done-production',
      version: '1.0.0',
      fetchImpl,
      push: false,
      validateDeployment: vi.fn(),
    });

    await manager.apply({
      cursor: '2026-07-29T00:02:00.000Z',
      activeSnapshotComplete: true,
      deployments: [activeDeployment(privateKey)],
      revocations: [],
    });

    const heartbeat = fetchImpl.mock.calls.find(([url]) =>
      String(url).includes('/heartbeat'));
    expect(heartbeat).toBeDefined();
    expect(JSON.parse(String(heartbeat?.[1]?.body))).toEqual(
      expect.objectContaining({
        runnerKey: 'get-it-done-production',
        health: 'healthy',
        lastAppliedDeploymentId:
          '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
      }),
    );
  });
});
