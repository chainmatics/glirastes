import { describe, expect, it, vi } from 'vitest';
import type {
  RuntimeDeploymentBundle,
  RuntimeRevisionEnvelope,
  SecurityRevocation,
} from '../../contracts/revisions.js';
import { RuntimeSyncManager } from '../sync-manager.js';
import {
  MemoryRuntimeStateStore,
  type RuntimeSyncState,
} from '../state-store.js';

const environmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901';
const signature = {
  algorithm: 'Ed25519' as const,
  keyId: 'runtime-key',
  value: 'signed-value',
};
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

function revision(
  revisionType: 'agent' | 'manifest' | 'policy',
  idSuffix: string,
): RuntimeRevisionEnvelope {
  return {
    schemaVersion: 1,
    revisionId: `019fa9a9-d5f7-7ec3-a3c7-8899de1d39${idSuffix}`,
    revisionType,
    revision: 1,
    tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
    targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
    ...(revisionType === 'agent'
      ? { subjectId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904' }
      : { environmentId }),
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
        : { budget, toolPolicies: [] },
    publishedAt: '2026-07-28T20:00:00.000Z',
    signature,
  };
}

function deployment(
  rolloutMode: 'stable' | 'canary',
  idSuffix: string,
  status: 'pending' | 'active' = 'active',
): RuntimeDeploymentBundle {
  return {
    deploymentId: `019fa9a9-d5f7-7ec3-a3c7-8899de1d39${idSuffix}`,
    environmentId,
    status,
    rolloutMode,
    targetPercentage: rolloutMode === 'stable' ? 100 : 10,
    pinned: false,
    healthStatus: status === 'active' ? 'healthy' : 'unknown',
    agentRevision: revision('agent', '11'),
    manifestRevision: revision('manifest', '12'),
    policyRevision: revision('policy', '13'),
    updatedAt: '2026-07-28T20:01:00.000Z',
  };
}

/** A pending deployment as the Platform serves it since artifact binding. */
function boundDeployment(idSuffix: string): RuntimeDeploymentBundle {
  return {
    ...deployment('stable', idSuffix, 'pending'),
    configRevision: {
      ...revision('agent', '14'),
      revisionType: 'config',
      subjectId: undefined,
      payload: {
        schemaVersion: 1,
        setupArtifactDigest: 'sha256:YWJj',
        runtimeDigest: 'sha256:cnQ',
        promptDigest: 'sha256:cHQ',
        promptRevisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3941',
        plannerRevisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3942',
        tools: [],
      },
    },
    runtimeDigest: 'sha256:cnQ',
    promptDigest: 'sha256:cHQ',
    promptBinding: {
      schemaVersion: 1,
      appId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
      revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3941',
      revision: 1,
      bundleDigest: 'sha256:cHQ',
      artifactRef: 'local://app/prompt-bundle',
      activatedAt: '2026-07-28T20:00:00.000Z',
      signature,
    },
  };
}

function initialState(stable: RuntimeDeploymentBundle): RuntimeSyncState {
  return {
    cursor: '2026-07-28T20:00:00.000Z',
    stable,
    canary: null,
    pending: [],
    revocations: [],
    updatedAt: '2026-07-28T20:00:00.000Z',
  };
}

describe('RuntimeSyncManager', () => {
  it('persists verified revocations before evaluating deployment candidates', async () => {
    const store = new MemoryRuntimeStateStore();
    const save = vi.spyOn(store, 'saveAtomic');
    const verifier = {
      verifyRevocation: vi.fn().mockResolvedValue(undefined),
      verifyRevision: vi.fn().mockRejectedValue(new Error('invalid signature')),
    };
    const revocation: SecurityRevocation = {
      revocationId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3920',
      environmentId,
      effectiveAt: '2026-07-28T20:01:00.000Z',
      reasonCode: 'deployment-security-revocation',
      toolIds: ['019fa9a9-d5f7-7ec3-a3c7-8899de1d3921'],
      agentRevisionIds: [],
      policyRevisionIds: [],
      signature,
    };
    const manager = new RuntimeSyncManager({
      environmentId,
      store,
      verifier: verifier as never,
    });

    const result = await manager.apply({
      cursor: '2026-07-28T20:02:00.000Z',
      activeSnapshotComplete: true,
      deployments: [deployment('stable', '30')],
      revocations: [revocation],
    });

    expect(save.mock.calls[0][0].revocations).toEqual([revocation]);
    expect(result.rejectedDeploymentIds).toEqual([
      '019fa9a9-d5f7-7ec3-a3c7-8899de1d3930',
    ]);
  });

  it('accepts a deployment carrying artifact bindings and verifies both', async () => {
    const store = new MemoryRuntimeStateStore();
    const verifier = {
      verifyRevocation: vi.fn().mockResolvedValue(undefined),
      verifyRevision: vi.fn().mockResolvedValue(undefined),
      verifyPromptBinding: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new RuntimeSyncManager({
      environmentId,
      store,
      verifier: verifier as never,
    });

    const bound = boundDeployment('31');
    const result = await manager.apply({
      cursor: '2026-07-28T20:02:00.000Z',
      activeSnapshotComplete: true,
      deployments: [bound],
      revocations: [],
    });

    expect(result.rejectedDeploymentIds).toEqual([]);
    // Config envelope and prompt binding are signed material like the other
    // three revisions; accepting them unverified would smuggle unsigned
    // desired state into the fail-closed path.
    expect(verifier.verifyRevision).toHaveBeenCalledWith(bound.configRevision);
    expect(verifier.verifyPromptBinding)
      .toHaveBeenCalledWith(bound.promptBinding);
    const state = await store.load();
    expect(state?.pending.map((entry) => entry.deploymentId))
      .toEqual([bound.deploymentId]);
  });

  it('rejects a bound deployment whose prompt binding fails verification', async () => {
    const store = new MemoryRuntimeStateStore();
    const manager = new RuntimeSyncManager({
      environmentId,
      store,
      verifier: {
        verifyRevocation: vi.fn().mockResolvedValue(undefined),
        verifyRevision: vi.fn().mockResolvedValue(undefined),
        verifyPromptBinding: vi.fn()
          .mockRejectedValue(new Error('bad binding signature')),
      } as never,
    });

    const bound = boundDeployment('32');
    const result = await manager.apply({
      cursor: '2026-07-28T20:02:00.000Z',
      activeSnapshotComplete: true,
      deployments: [bound],
      revocations: [],
    });

    expect(result.rejectedDeploymentIds).toEqual([bound.deploymentId]);
    expect((await store.load())?.pending ?? []).toEqual([]);
  });

  it('atomically keeps stable and canary active while separating pending candidates', async () => {
    const store = new MemoryRuntimeStateStore();
    const manager = new RuntimeSyncManager({
      environmentId,
      store,
      verifier: {
        verifyRevocation: vi.fn().mockResolvedValue(undefined),
        verifyRevision: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    await manager.apply({
      cursor: '2026-07-28T20:02:00.000Z',
      activeSnapshotComplete: true,
      deployments: [
        deployment('stable', '30'),
        deployment('canary', '31'),
        deployment('canary', '32', 'pending'),
      ],
      revocations: [],
    });
    const state = await store.load();
    expect(state?.stable?.deploymentId).toMatch(/30$/);
    expect(state?.canary?.deploymentId).toMatch(/31$/);
    expect(state?.pending.map((item) => item.deploymentId)).toEqual([
      expect.stringMatching(/32$/),
    ]);
  });

  it('removes an activated deployment from pending even when another pending candidate is rejected', async () => {
    const store = new MemoryRuntimeStateStore();
    const candidate = deployment('stable', '33', 'pending');
    await store.saveAtomic({
      ...initialState(deployment('stable', '30')),
      pending: [candidate],
    });
    const manager = new RuntimeSyncManager({
      environmentId,
      store,
      verifier: {
        verifyRevocation: vi.fn().mockResolvedValue(undefined),
        verifyRevision: vi.fn().mockResolvedValue(undefined),
      } as never,
    });

    await manager.apply({
      cursor: '2026-07-28T20:03:00.000Z',
      activeSnapshotComplete: true,
      deployments: [
        { ...candidate, status: 'active', healthStatus: 'healthy' },
        {
          deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3934',
          environmentId,
          status: 'pending',
        },
      ],
      revocations: [],
    });

    expect((await store.load())?.pending).toEqual([]);
  });

  it('retains last-known-good when an active snapshot cannot be verified', async () => {
    const store = new MemoryRuntimeStateStore();
    const stable = deployment('stable', '40');
    await store.saveAtomic(initialState(stable));
    const manager = new RuntimeSyncManager({
      environmentId,
      store,
      verifier: {
        verifyRevocation: vi.fn().mockResolvedValue(undefined),
        verifyRevision: vi.fn().mockRejectedValue(new Error('invalid')),
      } as never,
    });
    await manager.apply({
      cursor: '2026-07-28T20:02:00.000Z',
      activeSnapshotComplete: true,
      deployments: [deployment('stable', '41')],
      revocations: [],
    });
    expect((await store.load())?.stable?.deploymentId).toBe(stable.deploymentId);
  });
});
