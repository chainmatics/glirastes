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
import type { PrivacyPolicyBlock, PrivacyRuntimeStatus } from '../../contracts/privacy-policy.js';
import { PrivacyRuntimeStatusSchema } from '../../contracts/privacy-policy.js';
import { findForbiddenPlatformContentPath } from '../../contracts/content-boundary.js';
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

function activeDeployment(
  privateKey: KeyObject,
  privacy?: PrivacyPolicyBlock,
  ids: { deploymentId?: string; policyRevisionId?: string; revision?: number } = {},
): RuntimeDeploymentBundle {
  return {
    deploymentId: ids.deploymentId ?? '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
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
      revision: ids.revision ?? 1,
      revisionId: ids.policyRevisionId ?? '019fa9a9-d5f7-7ec3-a3c7-8899de1d3908',
      revisionType: 'policy',
      environmentId,
      payload: { budget, toolPolicies: [], ...(privacy ? { privacy } : {}) },
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

const PROTECTED: PrivacyPolicyBlock = {
  schemaVersion: 1,
  profile: 'protected-text/v1',
  screenshots: { mode: 'blocked' },
  providers: { allowed: [{ entryId: 'main', bindingDigest: `sha256:${'A'.repeat(43)}` }], defaultEntryId: 'main', userChoice: false },
  mapping: { idleTtlSeconds: 3600, absoluteTtlSeconds: 86400 },
  speech: { localOnly: true, maxDurationSeconds: 60 },
};

function privacySync(options: { privacyStatus?: (revisions: unknown) => PrivacyRuntimeStatus } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const fetchImpl = vi.fn().mockImplementation(async (url: string) => (
    url.includes('jwks')
      ? new Response(JSON.stringify({
          keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'runtime-key', alg: 'EdDSA', use: 'sig' }],
        }), { status: 200 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 })
  ));
  const sync = createManagedRuntimeSync({
    baseUrl: 'https://control.example',
    apiKey: 'runtime-secret',
    appId: common.targetAppId,
    environmentId,
    runnerKey: 'runner-a',
    version: '1.0.0',
    fetchImpl,
    push: false,
    validateDeployment: vi.fn(),
    ...(options.privacyStatus ? { privacyStatus: options.privacyStatus as never } : {}),
  });
  const heartbeats = () => fetchImpl.mock.calls
    .filter(([url]) => String(url).includes('/heartbeat'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as {
      health: string; lastAppliedDeploymentId?: string; validatedDeploymentId?: string;
      technicalMetadata: { validationStage?: string; activationStage?: string; privacy: PrivacyRuntimeStatus };
    });
  let minute = 2;
  const apply = (deployments: RuntimeDeploymentBundle[]) => sync.manager.apply({
    cursor: `2026-07-29T00:${String(minute++).padStart(2, '0')}:00.000Z`,
    activeSnapshotComplete: true,
    deployments,
    revocations: [],
  });
  return { privateKey, sync, heartbeats, apply };
}

const enforced = (revisions: unknown): PrivacyRuntimeStatus => ({
  schemaVersion: 1,
  state: 'enforced',
  policyRevisionId: (revisions as { policyRevision: { revisionId: string } }).policyRevision.revisionId,
  publishedPolicyDigest: `sha256:${'C'.repeat(43)}`,
  effectivePolicyDigest: `sha256:${'D'.repeat(43)}`,
  localRestrictions: ['local_ttl_shorter'],
  reasons: [],
});

describe('privacy in the runner heartbeat (K3)', () => {
  it('reports off for a deployment without a privacy block', async () => {
    const { privateKey, heartbeats, apply } = privacySync();
    await apply([activeDeployment(privateKey)]);
    const [beat] = heartbeats();
    expect(beat).toMatchObject({ health: 'healthy', technicalMetadata: { privacy: { state: 'off', reasons: [] } } });
    expect(PrivacyRuntimeStatusSchema.safeParse(beat!.technicalMetadata.privacy).success).toBe(true);
  });

  it('a protected block on a runner without privacy is reported refused and not activated', async () => {
    const { privateKey, sync, heartbeats, apply } = privacySync();
    const result = await apply([activeDeployment(privateKey, PROTECTED)]);
    expect(result.rejectedDeploymentIds).toEqual(['019fa9a9-d5f7-7ec3-a3c7-8899de1d3904']);
    expect(result.state.stable).toBeNull();
    const [beat] = heartbeats();
    expect(beat).toMatchObject({
      health: 'unhealthy',
      validatedDeploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
      technicalMetadata: { validationStage: 'privacy_refused', privacy: { state: 'refused', reasons: ['store_missing'] } },
    });
    expect(heartbeats().some((b) => b.lastAppliedDeploymentId)).toBe(false);
    expect(await sync.store.load()).toMatchObject({
      stable: null, privacyRefusedDeploymentIds: ['019fa9a9-d5f7-7ec3-a3c7-8899de1d3904'],
    });
    expect(result.privacyRefusedDeploymentIds).toEqual(['019fa9a9-d5f7-7ec3-a3c7-8899de1d3904']);
  });

  it('keeps the refusal while offered; a withdrawal leaves the raised floor, not the unprotected revision', async () => {
    const { privateKey, sync, apply } = privacySync();
    await apply([activeDeployment(privateKey, PROTECTED)]);
    await apply([activeDeployment(privateKey, PROTECTED)]);
    expect((await sync.store.load())?.privacyRefusedDeploymentIds).toEqual(['019fa9a9-d5f7-7ec3-a3c7-8899de1d3904']);
    const result = await apply([activeDeployment(privateKey, undefined, {
      deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3924', policyRevisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3928',
    })]);
    expect(result.state.privacyRefusedDeploymentIds).toEqual([]);
    expect(result.privacyDowngradeDeploymentIds).toEqual(['019fa9a9-d5f7-7ec3-a3c7-8899de1d3924']);
    expect(result.state.stable).toBeNull();
    expect(result.state.privacyFloor).toMatchObject({ profile: 'protected-text/v1', deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904' });
  });

  it('carries the enforced status of the runtime, content-free', async () => {
    const { privateKey, heartbeats, apply } = privacySync({ privacyStatus: enforced });
    await apply([activeDeployment(privateKey, PROTECTED)]);
    const [beat] = heartbeats();
    expect(beat).toMatchObject({ health: 'healthy', technicalMetadata: { privacy: { state: 'enforced' } } });
    expect(findForbiddenPlatformContentPath(beat)).toBeNull();
    expect(JSON.stringify(beat)).not.toMatch(/runtime-secret|bindingDigest|main/);
  });

  it('reports a rejected downgrade as degraded and keeps the protected deployment', async () => {
    const { privateKey, heartbeats, apply } = privacySync({ privacyStatus: enforced });
    await apply([activeDeployment(privateKey, PROTECTED, { revision: 5 })]);
    const result = await apply([activeDeployment(privateKey, undefined, {
      deploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3914', policyRevisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3918', revision: 6,
    })]);
    expect(result.privacyDowngradeDeploymentIds).toEqual(['019fa9a9-d5f7-7ec3-a3c7-8899de1d3914']);
    expect(result.state.stable?.deploymentId).toBe('019fa9a9-d5f7-7ec3-a3c7-8899de1d3904');
    expect(heartbeats().at(-1)).toMatchObject({
      health: 'degraded',
      validatedDeploymentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3914',
      technicalMetadata: { validationStage: 'privacy_policy_downgrade', privacy: { state: 'downgrade-rejected', reasons: ['policy_downgrade'] } },
    });
  });
});
