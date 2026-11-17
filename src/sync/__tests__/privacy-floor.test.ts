import { describe, expect, it, vi } from 'vitest';
import type { RuntimeDeploymentBundle, RuntimeRevisionEnvelope, SecurityRevocation } from '../../contracts/revisions.js';
import type { PrivacyPolicyBlock } from '../../contracts/privacy-policy.js';
import { PrivacyRefusedError, RuntimeSyncManager } from '../sync-manager.js';
import { MemoryRuntimeStateStore, type RuntimeSyncState } from '../state-store.js';

const environmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901';
const signature = { algorithm: 'Ed25519' as const, keyId: 'runtime-key', value: 'signed-value' };
const budget = {
  maxModelSteps: 10, maxToolCalls: 8, totalTimeoutMs: 60_000, toolTimeoutMs: 10_000,
  maxInputTokens: 10_000, maxOutputTokens: 2_000, maxEstimatedCostUsd: 1,
  maxRepeatedFingerprint: 2, maxConsecutiveErrors: 3,
  delegation: { maxDepth: 1, maxBreadth: 2, sharedBudget: true },
};
const DIGEST = `sha256:${'A'.repeat(43)}`;
const PROTECTED: PrivacyPolicyBlock = {
  schemaVersion: 1,
  profile: 'protected-text/v1',
  screenshots: { mode: 'blocked' },
  providers: { allowed: [{ entryId: 'main', bindingDigest: DIGEST }], defaultEntryId: 'main', userChoice: false },
  mapping: { idleTtlSeconds: 3600, absoluteTtlSeconds: 86400 },
  speech: { localOnly: true, maxDurationSeconds: 60 },
};
const OFF: PrivacyPolicyBlock = { schemaVersion: 1, profile: 'off' };

const id = (suffix: number) => `019fa9a9-d5f7-7ec3-a3c7-8899de1d${String(suffix).padStart(4, '0')}`;

function envelope(type: 'agent' | 'manifest' | 'policy', revisionId: string, revision: number, payload: unknown): RuntimeRevisionEnvelope {
  return {
    schemaVersion: 1,
    revisionId,
    revisionType: type,
    revision,
    tenantId: id(2),
    targetAppId: id(3),
    ...(type === 'agent' ? { subjectId: id(4) } : { environmentId }),
    contentHash: 'sha256:YWJj',
    payload,
    publishedAt: '2026-11-17T10:00:00.000Z',
    signature,
  };
}

/** An active stable deployment whose policy revision has number `revision` and the given privacy block. */
function deployment(n: number, revision: number, privacy: PrivacyPolicyBlock | undefined, status: 'active' | 'pending' = 'active'): RuntimeDeploymentBundle {
  return {
    deploymentId: id(100 + n),
    environmentId,
    status,
    rolloutMode: 'stable',
    targetPercentage: 100,
    pinned: false,
    healthStatus: 'healthy',
    agentRevision: envelope('agent', id(11), 1, {
      name: 'Agent', objective: 'Help', modelAlias: 'standard', promptBindingRef: 'local://p', toolAllowlist: [], budget,
    }),
    manifestRevision: envelope('manifest', id(12), 1, { sourceDigest: 'sha256:YWJj', tools: [] }),
    policyRevision: envelope('policy', id(200 + n), revision, { budget, toolPolicies: [], ...(privacy ? { privacy } : {}) }),
    updatedAt: `2026-11-17T10:${String(n).padStart(2, '0')}:00.000Z`,
  };
}

const verifier = () => ({
  verifyRevocation: vi.fn().mockResolvedValue(undefined),
  verifyRevision: vi.fn().mockResolvedValue(undefined),
  verifyPromptBinding: vi.fn().mockResolvedValue(undefined),
});

function manager(store = new MemoryRuntimeStateStore(), extra: Partial<ConstructorParameters<typeof RuntimeSyncManager>[0]> = {}) {
  return new RuntimeSyncManager({ environmentId, store, verifier: verifier() as never, ...extra });
}

let minute = 0;
const bundle = (deployments: RuntimeDeploymentBundle[], revocations: SecurityRevocation[] = []) => ({
  cursor: `2026-11-17T11:${String(minute++ % 60).padStart(2, '0')}:00.000Z`,
  activeSnapshotComplete: true as const,
  deployments,
  revocations,
});

describe('privacy floor (K2)', () => {
  it('records a protected floor with the accepted state in the same write', async () => {
    const store = new MemoryRuntimeStateStore();
    const save = vi.spyOn(store, 'saveAtomic');
    await manager(store).apply(bundle([deployment(1, 5, PROTECTED)]));
    const last = save.mock.calls.at(-1)![0] as RuntimeSyncState;
    expect(last.stable?.deploymentId).toBe(id(101));
    expect(last.privacyFloor).toEqual({ profile: 'protected-text/v1', policyRevision: 5, deploymentId: id(101), revisionId: id(201) });
  });

  it('refuses a later revision without a privacy block and keeps the protected one', async () => {
    const store = new MemoryRuntimeStateStore();
    const onPrivacyDowngrade = vi.fn();
    const sync = manager(store, { onPrivacyDowngrade });
    await sync.apply(bundle([deployment(1, 5, PROTECTED)]));
    const result = await sync.apply(bundle([deployment(2, 6, undefined)]));
    expect(result.privacyDowngradeDeploymentIds).toEqual([id(102)]);
    expect(result.rejectedDeploymentIds).toEqual([id(102)]);
    expect(result.state.stable?.deploymentId).toBe(id(101));
    expect(onPrivacyDowngrade).toHaveBeenCalledWith([id(102)]);
  });

  it('accepts an explicitly signed, newer off and lowers the floor', async () => {
    const sync = manager();
    await sync.apply(bundle([deployment(1, 5, PROTECTED)]));
    const result = await sync.apply(bundle([deployment(2, 6, OFF)]));
    expect(result.privacyDowngradeDeploymentIds).toEqual([]);
    expect(result.state.stable?.deploymentId).toBe(id(102));
    expect(result.state.privacyFloor).toMatchObject({ profile: 'off', policyRevision: 6 });
    // Below an off floor a revision without a block is fine again.
    const after = await sync.apply(bundle([deployment(3, 7, undefined)]));
    expect(after.state.stable?.deploymentId).toBe(id(103));
  });

  it('refuses a replayed older off after protection was enabled again', async () => {
    const sync = manager();
    await sync.apply(bundle([deployment(1, 5, OFF)]));
    await sync.apply(bundle([deployment(2, 9, PROTECTED)]));
    const replay = await sync.apply(bundle([deployment(1, 5, OFF)]));
    expect(replay.privacyDowngradeDeploymentIds).toEqual([id(101)]);
    expect(replay.state.stable?.deploymentId).toBe(id(102));
    expect(replay.state.privacyFloor).toMatchObject({ profile: 'protected-text/v1', policyRevision: 9 });
  });

  it('refuses an off at the same revision number as the floor', async () => {
    const sync = manager();
    await sync.apply(bundle([deployment(1, 5, PROTECTED)]));
    const result = await sync.apply(bundle([deployment(2, 5, OFF)]));
    expect(result.privacyDowngradeDeploymentIds).toEqual([id(102)]);
  });

  it('refuses a newer off whose policy revision is revoked', async () => {
    const sync = manager();
    await sync.apply(bundle([deployment(1, 5, PROTECTED)]));
    const revocation: SecurityRevocation = {
      revocationId: id(300),
      environmentId,
      effectiveAt: '2026-11-17T10:00:00.000Z',
      reasonCode: 'privacy-off-revoked',
      toolIds: [],
      agentRevisionIds: [],
      policyRevisionIds: [id(202)],
      signature,
    };
    const result = await sync.apply(bundle([deployment(2, 6, OFF)], [revocation]));
    expect(result.privacyDowngradeDeploymentIds).toEqual([id(102)]);
    expect(result.state.stable?.deploymentId).toBe(id(101));
  });

  it('keeps the highest protected revision as the floor on a rollback to an older protected revision', async () => {
    const sync = manager();
    await sync.apply(bundle([deployment(1, 8, PROTECTED)]));
    const rollback = await sync.apply(bundle([deployment(2, 4, PROTECTED)]));
    expect(rollback.state.stable?.deploymentId).toBe(id(102));
    expect(rollback.state.privacyFloor).toMatchObject({ profile: 'protected-text/v1', policyRevision: 8 });
    // An off newer than the rolled-back revision but older than the floor is still a downgrade.
    const off = await sync.apply(bundle([deployment(3, 6, OFF)]));
    expect(off.privacyDowngradeDeploymentIds).toEqual([id(103)]);
  });

  it('keeps the high-water mark when protection returns by a rollback to an older revision after an off (H1)', async () => {
    const sync = manager();
    await sync.apply(bundle([deployment(1, 5, PROTECTED)]));
    await sync.apply(bundle([deployment(2, 10, OFF)]));
    const rollback = await sync.apply(bundle([deployment(3, 5, PROTECTED)]));
    expect(rollback.state.stable?.deploymentId).toBe(id(103));
    expect(rollback.state.privacyFloor).toMatchObject({ profile: 'protected-text/v1', policyRevision: 10 });
    // The off signed before protection returned is a replay now.
    const replay = await sync.apply(bundle([deployment(2, 10, OFF)]));
    expect(replay.privacyDowngradeDeploymentIds).toEqual([id(102)]);
    expect(replay.state.stable?.deploymentId).toBe(id(103));
    expect(replay.state.privacyFloor).toMatchObject({ profile: 'protected-text/v1', policyRevision: 10 });
    // Only an off signed after everything accepted before lowers it.
    const off = await sync.apply(bundle([deployment(4, 11, OFF)]));
    expect(off.state.stable?.deploymentId).toBe(id(104));
    expect(off.state.privacyFloor).toMatchObject({ profile: 'off', policyRevision: 11 });
  });

  it('refuses the replayed off after a restart on the persisted high-water mark (H1)', async () => {
    const store = new MemoryRuntimeStateStore();
    const before = manager(store);
    await before.apply(bundle([deployment(1, 5, PROTECTED)]));
    await before.apply(bundle([deployment(2, 10, OFF)]));
    await before.apply(bundle([deployment(3, 5, PROTECTED)]));
    const after = manager(store);
    const replay = await after.apply(bundle([deployment(2, 10, OFF)]));
    expect(replay.privacyDowngradeDeploymentIds).toEqual([id(102)]);
    expect(replay.state.stable?.deploymentId).toBe(id(103));
  });

  it('refuses a pending downgrade too, without touching the active state', async () => {
    const sync = manager();
    await sync.apply(bundle([deployment(1, 5, PROTECTED)]));
    const result = await sync.apply(bundle([deployment(1, 5, PROTECTED), deployment(2, 6, undefined, 'pending')]));
    expect(result.privacyDowngradeDeploymentIds).toEqual([id(102)]);
    expect(result.state.pending).toEqual([]);
    expect(result.state.stable?.deploymentId).toBe(id(101));
  });

  it('a failed write changes neither the accepted state nor the floor', async () => {
    const store = new MemoryRuntimeStateStore();
    const sync = manager(store);
    await sync.apply(bundle([deployment(1, 5, PROTECTED)]));
    vi.spyOn(store, 'saveAtomic').mockRejectedValueOnce(new Error('disk full'));
    await expect(sync.apply(bundle([deployment(2, 6, OFF)]))).rejects.toThrow('disk full');
    const state = await store.load();
    expect(state?.stable?.deploymentId).toBe(id(101));
    expect(state?.privacyFloor).toMatchObject({ profile: 'protected-text/v1', policyRevision: 5 });
  });

  it('serializes overlapping applies, so a concurrent update cannot drop the floor', async () => {
    const store = new MemoryRuntimeStateStore();
    let releaseFirstLoad!: () => void;
    const firstLoadGate = new Promise<void>((resolve) => { releaseFirstLoad = resolve; });
    const load = store.load.bind(store);
    let calls = 0;
    vi.spyOn(store, 'load').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await firstLoadGate;
      return load();
    });
    const sync = manager(store);
    const first = sync.apply(bundle([deployment(1, 5, PROTECTED)]));
    const second = sync.apply(bundle([deployment(2, 6, undefined)]));
    releaseFirstLoad();
    await first;
    const result = await second;
    // The second apply saw the floor of the first and refused the downgrade.
    expect(result.privacyDowngradeDeploymentIds).toEqual([id(102)]);
    expect((await store.load())?.privacyFloor).toMatchObject({ profile: 'protected-text/v1' });
  });

  it('reads a state file written before privacy policies existed', async () => {
    const store = new MemoryRuntimeStateStore();
    await store.saveAtomic({ cursor: null, stable: null, canary: null, pending: [], revocations: [], updatedAt: '2026-11-17T10:00:00.000Z' });
    const result = await manager(store).apply(bundle([deployment(1, 5, undefined)]));
    expect(result.state.stable?.deploymentId).toBe(id(101));
    expect(result.state.privacyFloor ?? null).toBeNull();
  });
});

/**
 * A runner that cannot enforce a protected block (no store, keyring or
 * approved binding): the managed sync's validator throws `PrivacyRefusedError`.
 */
const refusesProtected = vi.fn(async (_deployment: RuntimeDeploymentBundle, revisions: { policyRevision: { privacy?: PrivacyPolicyBlock } }) => {
  if (revisions.policyRevision.privacy?.profile === 'protected-text/v1') throw new PrivacyRefusedError();
});

const revocationOf = (policyRevisionId: string): SecurityRevocation => ({
  revocationId: id(301),
  environmentId,
  effectiveAt: '2026-11-17T10:00:00.000Z',
  reasonCode: 'privacy-revoked',
  toolIds: [],
  agentRevisionIds: [],
  policyRevisionIds: [policyRevisionId],
  signature,
});

describe('privacy refusal is no silent way out (K2/K3)', () => {
  const PROTECTED_FLOOR_6 = { profile: 'protected-text/v1', policyRevision: 6, deploymentId: id(102), revisionId: id(202) };

  it('a verified protected revision this runner cannot enforce raises the persistent floor', async () => {
    const store = new MemoryRuntimeStateStore();
    const sync = manager(store, { validateDeployment: refusesProtected as never });
    await sync.apply(bundle([deployment(1, 5, undefined)]));
    const result = await sync.apply(bundle([deployment(2, 6, PROTECTED)]));
    expect(result.privacyRefusedDeploymentIds).toEqual([id(102)]);
    // The old unprotected deployment stays the accepted state, but the
    // floor now names the protected requirement: the runtime gate blocks.
    expect(result.state.stable?.deploymentId).toBe(id(101));
    expect((await store.load())?.privacyFloor).toEqual(PROTECTED_FLOOR_6);
  });

  it('a withdrawn refused deployment does not lead back to the old unprotected revision', async () => {
    const sync = manager(new MemoryRuntimeStateStore(), { validateDeployment: refusesProtected as never });
    await sync.apply(bundle([deployment(1, 5, undefined)]));
    await sync.apply(bundle([deployment(2, 6, PROTECTED)]));
    const withdrawn = await sync.apply(bundle([deployment(1, 5, undefined)]));
    expect(withdrawn.privacyRefusedDeploymentIds).toEqual([]);
    expect(withdrawn.privacyDowngradeDeploymentIds).toEqual([id(101)]);
    expect(withdrawn.state.privacyFloor).toEqual(PROTECTED_FLOOR_6);
    // A newer revision without a block is a downgrade as well.
    const newer = await sync.apply(bundle([deployment(3, 7, undefined)]));
    expect(newer.privacyDowngradeDeploymentIds).toEqual([id(103)]);
    expect(newer.state.privacyFloor).toEqual(PROTECTED_FLOOR_6);
  });

  it('a revocation of the refused revision does not lower the floor either', async () => {
    const sync = manager(new MemoryRuntimeStateStore(), { validateDeployment: refusesProtected as never });
    await sync.apply(bundle([deployment(1, 5, undefined)]));
    await sync.apply(bundle([deployment(2, 6, PROTECTED)]));
    const revoked = await sync.apply(bundle([deployment(1, 5, undefined)], [revocationOf(id(202))]));
    expect(revoked.privacyDowngradeDeploymentIds).toEqual([id(101)]);
    expect(revoked.state.privacyFloor).toEqual(PROTECTED_FLOOR_6);
  });

  it('survives a restart: a new manager on the same state keeps the floor', async () => {
    const store = new MemoryRuntimeStateStore();
    const before = manager(store, { validateDeployment: refusesProtected as never });
    await before.apply(bundle([deployment(1, 5, undefined)]));
    await before.apply(bundle([deployment(2, 6, PROTECTED)]));
    const after = manager(store, { validateDeployment: refusesProtected as never });
    const result = await after.apply(bundle([deployment(1, 5, undefined)]));
    expect(result.privacyDowngradeDeploymentIds).toEqual([id(101)]);
    expect(result.state.privacyFloor).toEqual(PROTECTED_FLOOR_6);
  });

  it('a candidate with an invalid signature neither refuses nor raises the floor', async () => {
    const forged = verifier();
    forged.verifyRevision.mockImplementation(async (revision: RuntimeRevisionEnvelope) => {
      if (revision.revisionId === id(202)) throw new Error('signature invalid');
    });
    const sync = new RuntimeSyncManager({
      environmentId, store: new MemoryRuntimeStateStore(), verifier: forged as never, validateDeployment: refusesProtected as never,
    });
    await sync.apply(bundle([deployment(1, 5, undefined)]));
    const result = await sync.apply(bundle([deployment(2, 6, PROTECTED)]));
    expect(result.rejectedDeploymentIds).toEqual([id(102)]);
    expect(result.privacyRefusedDeploymentIds).toEqual([]);
    expect(result.state.privacyFloor ?? null).toBeNull();
    // Without the forged candidate the runner carries on as before.
    const next = await sync.apply(bundle([deployment(1, 5, undefined)]));
    expect(next.state.stable?.deploymentId).toBe(id(101));
    expect(next.rejectedDeploymentIds).toEqual([]);
  });

  it('a candidate for another environment neither refuses nor raises the floor', async () => {
    const sync = manager(new MemoryRuntimeStateStore(), { validateDeployment: refusesProtected as never });
    const foreign = { ...deployment(2, 6, PROTECTED), environmentId: id(9) };
    const result = await sync.apply(bundle([deployment(1, 5, undefined), foreign]));
    expect(result.privacyRefusedDeploymentIds).toEqual([]);
    expect(result.state.privacyFloor ?? null).toBeNull();
  });

  it('a replayed older protected revision does not move a higher floor', async () => {
    const sync = manager(new MemoryRuntimeStateStore(), { validateDeployment: refusesProtected as never });
    await sync.apply(bundle([deployment(2, 6, PROTECTED)]));
    const replay = await sync.apply(bundle([deployment(3, 4, PROTECTED)]));
    expect(replay.privacyRefusedDeploymentIds).toEqual([id(103)]);
    expect(replay.state.privacyFloor).toEqual(PROTECTED_FLOOR_6);
  });

  it('a verified pending protected revision this runner cannot enforce raises the floor too', async () => {
    const sync = manager(new MemoryRuntimeStateStore(), { validateDeployment: refusesProtected as never });
    await sync.apply(bundle([deployment(1, 5, undefined)]));
    const result = await sync.apply(bundle([deployment(1, 5, undefined), deployment(2, 6, PROTECTED, 'pending')]));
    expect(result.privacyRefusedDeploymentIds).toEqual([id(102)]);
    expect(result.state.stable?.deploymentId).toBe(id(101));
    expect(result.state.privacyFloor).toEqual(PROTECTED_FLOOR_6);
  });

  it('only a newer, explicitly signed off lifts the floor', async () => {
    const sync = manager(new MemoryRuntimeStateStore(), { validateDeployment: refusesProtected as never });
    await sync.apply(bundle([deployment(1, 5, undefined)]));
    await sync.apply(bundle([deployment(2, 6, PROTECTED)]));
    const olderOff = await sync.apply(bundle([deployment(3, 5, OFF)]));
    expect(olderOff.privacyDowngradeDeploymentIds).toEqual([id(103)]);
    const off = await sync.apply(bundle([deployment(4, 7, OFF)]));
    expect(off.state.stable?.deploymentId).toBe(id(104));
    expect(off.state.privacyFloor).toMatchObject({ profile: 'off', policyRevision: 7 });
  });

  it('a refused older protected revision after an off raises the floor to the high-water mark (H1)', async () => {
    const sync = manager(new MemoryRuntimeStateStore(), { validateDeployment: refusesProtected as never });
    await sync.apply(bundle([deployment(1, 10, OFF)]));
    const refused = await sync.apply(bundle([deployment(2, 5, PROTECTED)]));
    expect(refused.privacyRefusedDeploymentIds).toEqual([id(102)]);
    expect(refused.state.privacyFloor).toMatchObject({ profile: 'protected-text/v1', policyRevision: 10 });
    const replay = await sync.apply(bundle([deployment(1, 10, OFF)]));
    expect(replay.privacyDowngradeDeploymentIds).toEqual([id(101)]);
  });

  it('a verified protected revision rejected by local validation raises the floor too (M3)', async () => {
    const validateDeployment = vi.fn(async (_deployment: RuntimeDeploymentBundle, revisions: { policyRevision: { privacy?: PrivacyPolicyBlock } }) => {
      if (revisions.policyRevision.privacy?.profile === 'protected-text/v1') throw new Error('Unavailable manifest tool');
    });
    const sync = manager(new MemoryRuntimeStateStore(), { validateDeployment: validateDeployment as never });
    await sync.apply(bundle([deployment(1, 5, undefined)]));
    const rejected = await sync.apply(bundle([deployment(2, 6, PROTECTED)]));
    expect(rejected.rejectedDeploymentIds).toEqual([id(102)]);
    expect(rejected.privacyRefusedDeploymentIds).toEqual([]);
    expect(rejected.state.privacyFloor).toEqual(PROTECTED_FLOOR_6);
    // Withdrawn: the unprotected revision is a downgrade now.
    const withdrawn = await sync.apply(bundle([deployment(1, 5, undefined)]));
    expect(withdrawn.privacyDowngradeDeploymentIds).toEqual([id(101)]);
  });

  it('a protected revision rejected for a bad signature or another scope never raises the floor (M3)', async () => {
    const failing = verifier();
    failing.verifyRevision.mockRejectedValue(new Error('bad signature'));
    const unsigned = manager(new MemoryRuntimeStateStore(), { verifier: failing as never });
    const forged = await unsigned.apply(bundle([deployment(2, 6, PROTECTED)]));
    expect(forged.rejectedDeploymentIds).toEqual([id(102)]);
    expect(forged.state.privacyFloor ?? null).toBeNull();

    const foreign = manager();
    const other = { ...deployment(3, 7, PROTECTED), environmentId: id(999) };
    const result = await foreign.apply(bundle([other]));
    expect(result.rejectedDeploymentIds).toEqual([id(103)]);
    expect(result.state.privacyFloor ?? null).toBeNull();
  });

  it('a newer protected revision this runner can enforce lifts the refusal and keeps the floor protected', async () => {
    let canEnforce = false;
    const validateDeployment = vi.fn(async (_deployment: RuntimeDeploymentBundle, revisions: { policyRevision: { privacy?: PrivacyPolicyBlock } }) => {
      if (!canEnforce && revisions.policyRevision.privacy?.profile === 'protected-text/v1') throw new PrivacyRefusedError();
    });
    const sync = manager(new MemoryRuntimeStateStore(), { validateDeployment: validateDeployment as never });
    await sync.apply(bundle([deployment(1, 5, undefined)]));
    await sync.apply(bundle([deployment(2, 6, PROTECTED)]));
    canEnforce = true;
    const result = await sync.apply(bundle([deployment(3, 7, PROTECTED)]));
    expect(result.privacyRefusedDeploymentIds).toEqual([]);
    expect(result.state.stable?.deploymentId).toBe(id(103));
    expect(result.state.privacyFloor).toMatchObject({ profile: 'protected-text/v1', policyRevision: 7 });
  });
});
