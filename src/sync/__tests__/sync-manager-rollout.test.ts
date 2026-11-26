import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RolloutBinding } from '../../contracts/rollout-binding.js';
import type { RuntimeDeploymentBundle, RuntimeRevisionEnvelope } from '../../contracts/revisions.js';
import { canonicalRuntimeJson, RuntimeRevisionVerifier } from '../signature-verifier.js';
import { MemoryRuntimeStateStore } from '../state-store.js';
import { RuntimeSyncManager } from '../sync-manager.js';

const environmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901';
const otherEnvironmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3999';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const { privateKey: foreignKey } = generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' });

function signed<T extends object>(unsigned: T, key = privateKey) {
  return {
    ...unsigned,
    signature: {
      algorithm: 'Ed25519' as const,
      keyId: 'runtime-key',
      value: sign(null, Buffer.from(canonicalRuntimeJson(unsigned)), key).toString('base64url'),
    },
  };
}

function revision(revisionType: 'agent' | 'manifest' | 'policy', idSuffix: string): RuntimeRevisionEnvelope {
  const budget = {
    maxModelSteps: 10, maxToolCalls: 8, totalTimeoutMs: 60_000, toolTimeoutMs: 10_000, maxInputTokens: 10_000,
    maxOutputTokens: 2_000, maxEstimatedCostUsd: 1, maxRepeatedFingerprint: 2, maxConsecutiveErrors: 3,
    delegation: { maxDepth: 1, maxBreadth: 2, sharedBudget: true },
  };
  const payload = revisionType === 'agent'
    ? { name: 'Agent', objective: 'Help', modelAlias: 'standard', promptBindingRef: 'local://p', toolAllowlist: [], budget }
    : revisionType === 'manifest' ? { sourceDigest: 'sha256:YWJj', tools: [] } : { budget, toolPolicies: [] };
  const unsigned = {
    schemaVersion: 1 as const, revisionId: `019fa9a9-d5f7-7ec3-a3c7-8899de1d39${idSuffix}`, revisionType, revision: 1,
    tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902', targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
    ...(revisionType === 'agent' ? { subjectId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904' } : { environmentId }),
    payload, publishedAt: '2026-11-26T09:00:00.000Z',
  };
  const contentHash = `sha256:${createHash('sha256').update(canonicalRuntimeJson(payload)).digest('base64url')}`;
  return signed({ ...unsigned, contentHash }) as RuntimeRevisionEnvelope;
}

function rolloutBinding(
  deployment: Pick<RuntimeDeploymentBundle, 'deploymentId' | 'rolloutMode' | 'targetPercentage'>,
  patch: Partial<RolloutBinding> = {},
  key = privateKey,
): RolloutBinding {
  const { signature: _signature, ...rest } = patch;
  return signed({
    kind: 'rollout-binding' as const, schemaVersion: 1 as const, deploymentId: deployment.deploymentId, environmentId,
    rolloutMode: deployment.rolloutMode, targetPercentage: deployment.targetPercentage,
    cohortSalt: 'q3Zr8Kc1VtW0xYbHnL5pJg', issuedAt: '2026-11-26T09:00:00.000Z', ...rest,
  }, key);
}

function deployment(rolloutMode: 'stable' | 'canary', idSuffix: string): RuntimeDeploymentBundle {
  return {
    deploymentId: `019fa9a9-d5f7-7ec3-a3c7-8899de1d39${idSuffix}`, environmentId, status: 'active', rolloutMode,
    targetPercentage: rolloutMode === 'stable' ? 100 : 10, pinned: false, healthStatus: 'healthy',
    agentRevision: revision('agent', '11'), manifestRevision: revision('manifest', '12'),
    policyRevision: revision('policy', '13'), updatedAt: '2026-11-26T09:01:00.000Z',
  };
}

const bound = (value: RuntimeDeploymentBundle, patch: Partial<RolloutBinding> = {}, key = privateKey) => ({
  ...value, rolloutBinding: rolloutBinding(value, patch, key),
});

async function apply(deployments: RuntimeDeploymentBundle[]) {
  const manager = new RuntimeSyncManager({
    environmentId,
    store: new MemoryRuntimeStateStore(),
    verifier: new RuntimeRevisionVerifier({ getKey: async () => jwk }),
  });
  return manager.apply({
    cursor: '2026-11-26T09:02:00.000Z', activeSnapshotComplete: true, deployments, revocations: [],
  });
}

describe('RuntimeSyncManager rollout bindings', () => {
  it('keeps verified bindings of the stable and the canary deployment', async () => {
    const stable = bound(deployment('stable', '21'));
    const canary = bound(deployment('canary', '22'));
    const result = await apply([stable, canary]);
    expect(result.rejectedDeploymentIds).toEqual([]);
    expect(result.state.stable?.rolloutBinding).toEqual(stable.rolloutBinding);
    expect(result.state.canary?.rolloutBinding).toEqual(canary.rolloutBinding);
  });

  it('flags a sync whose active set it rejected, and only that one', async () => {
    const tampered = { ...deployment('stable', '21'), policyRevision: { ...revision('policy', '13'), revision: 2 } };
    expect((await apply([tampered])).rejectedActive).toBe(true);
    expect((await apply([deployment('stable', '21')])).rejectedActive).toBe(false);
  });

  it('accepts deployments without bindings as before (old Platform)', async () => {
    const result = await apply([deployment('stable', '21'), deployment('canary', '22')]);
    expect(result.state.stable?.rolloutBinding).toBeUndefined();
    expect(result.state.canary?.deploymentId).toBe(deployment('canary', '22').deploymentId);
  });

  it.each([
    ['a forged signature', bound(deployment('canary', '22'), {}, foreignKey)],
    ['another environment', bound(deployment('canary', '22'), { environmentId: otherEnvironmentId })],
    ['another deployment', bound(deployment('canary', '22'), { deploymentId: deployment('canary', '23').deploymentId })],
    ['another share', bound(deployment('canary', '22'), { targetPercentage: 50 })],
    ['another mode', { ...deployment('canary', '22'), rolloutBinding: rolloutBinding({ ...deployment('stable', '22'), deploymentId: deployment('canary', '22').deploymentId }) }],
  ])('keeps the deployment but drops a binding with %s', async (_label, canary) => {
    const result = await apply([bound(deployment('stable', '21')), canary]);
    expect(result.rejectedDeploymentIds).toEqual([]);
    expect(result.state.canary?.deploymentId).toBe(canary.deploymentId);
    expect(result.state.canary?.rolloutBinding).toBeUndefined();
  });
});

describe('RuntimeSyncManager rollout binding replay', () => {
  function manager() {
    const rejected: string[] = [];
    const store = new MemoryRuntimeStateStore();
    const sync = new RuntimeSyncManager({
      environmentId,
      store,
      verifier: new RuntimeRevisionVerifier({ getKey: async () => jwk }),
      onRolloutBindingRejected: (code) => { rejected.push(code); },
    });
    let cursor = 0;
    const apply = (deployments: RuntimeDeploymentBundle[]) => sync.apply({
      cursor: new Date(Date.UTC(2026, 10, 26, 10, 0, cursor++)).toISOString(),
      activeSnapshotComplete: true, deployments, revocations: [],
    });
    return { apply, rejected, store };
  }
  const stable = bound(deployment('stable', '21'));
  const canaryAt = (targetPercentage: number, issuedAt: string, patch: Partial<RolloutBinding> = {}) => {
    const value = { ...deployment('canary', '22'), targetPercentage };
    return bound(value, { issuedAt, ...patch });
  };

  it('drops an older binding replayed after a newer one was accepted', async () => {
    const { apply, rejected, store } = manager();
    const ten = canaryAt(10, '2026-11-26T10:00:00.000Z');
    expect((await apply([stable, ten])).state.canary?.rolloutBinding).toEqual(ten.rolloutBinding);
    expect((await store.load())?.rolloutBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ deploymentId: ten.deploymentId, issuedAt: '2026-11-26T10:00:00.000Z' }),
    ]));

    const replayed = canaryAt(50, '2026-11-26T09:00:00.000Z');
    const result = await apply([stable, replayed]);
    expect(result.state.canary?.deploymentId).toBe(replayed.deploymentId);
    expect(result.state.canary?.rolloutBinding).toBeUndefined();
    expect(rejected).toEqual(['rollout_binding_stale']);

    const newer = canaryAt(50, '2026-11-26T11:00:00.000Z');
    expect((await apply([stable, newer])).state.canary?.rolloutBinding).toEqual(newer.rolloutBinding);
  });

  it('drops and reports a different binding with the same issuedAt, keeps an identical one', async () => {
    const { apply, rejected } = manager();
    const ten = canaryAt(10, '2026-11-26T10:00:00.000Z');
    await apply([stable, ten]);
    expect((await apply([stable, ten])).state.canary?.rolloutBinding).toEqual(ten.rolloutBinding);
    const conflicting = canaryAt(10, '2026-11-26T10:00:00.000Z', { cohortSalt: 'Xk9mR2tP7vQa4sLd1uWz0A' });
    expect((await apply([stable, conflicting])).state.canary?.rolloutBinding).toBeUndefined();
    expect(rejected).toEqual(['rollout_binding_conflict']);
  });
});
