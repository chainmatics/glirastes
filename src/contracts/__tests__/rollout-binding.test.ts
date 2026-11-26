import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalRuntimeJson, RuntimeRevisionVerifier } from '../../sync/signature-verifier.js';
import { rolloutCohortBucket } from '../../sync/deployment-selector.js';
import {
  CANARY_SELECTION_CAPABILITY,
  CANARY_SELECTION_SYNC_VERSION,
  ROLLOUT_BINDING_SCHEMA_VERSION,
  RolloutBindingSchema,
  RuntimeDeploymentBundleSchema,
} from '../index.js';

interface RolloutBindingVectors {
  contract: 'RolloutBinding';
  schemaVersion: 1;
  negotiation: {
    syncQuery: { canaryVersion: string };
    registrationCapability: { canarySelection: number };
  };
  signing: {
    testKey: {
      keyId: string;
      publicJwk: Record<string, string>;
      privateJwkTestOnly: Record<string, string>;
    };
  };
  bucket: Array<{ cohortSalt: string; subjectId: string; bucket: number }>;
  valid: Array<{ name: string; canonical: string; binding: Record<string, unknown> }>;
  invalid: Array<{ name: string; failure: 'schema' | 'signature'; binding: Record<string, unknown> }>;
}

/**
 * The Platform keeps a byte-identical copy (T15) and pins the same digest.
 * Changing a vector means a new digest on both sides, never a one-sided edit.
 */
const VECTORS_SHA256 = '921559f57d91b084820bc67f6c4eb08ee1a73c9b8e2d8e5d3bfcd9df422cfe06';
const raw = readFileSync(new URL('../__vectors__/rollout-binding.v1.json', import.meta.url));
const vectors = JSON.parse(raw.toString('utf8')) as RolloutBindingVectors;
const { testKey } = vectors.signing;
const verifier = new RuntimeRevisionVerifier({
  getKey: async (keyId) => (keyId === testKey.keyId ? testKey.publicJwk : null),
});

describe('RolloutBinding v1 golden vectors', () => {
  it('pins the vectors the Platform copies', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
    expect(vectors.schemaVersion).toBe(ROLLOUT_BINDING_SCHEMA_VERSION);
    expect(vectors.negotiation.syncQuery.canaryVersion).toBe(String(CANARY_SELECTION_SYNC_VERSION));
    expect(vectors.negotiation.registrationCapability).toEqual({
      canarySelection: CANARY_SELECTION_CAPABILITY,
    });
  });

  it.each(vectors.bucket.map((entry) => [entry.cohortSalt, entry.subjectId, entry.bucket] as const))(
    'buckets salt %s and subject %s into %i',
    (cohortSalt, subjectId, bucket) => {
      expect(rolloutCohortBucket(cohortSalt, subjectId)).toBe(bucket);
    },
  );

  it('distributes the same subjects differently under another salt', () => {
    const subjects = Array.from({ length: 200 }, (_, index) => `user-${index}`);
    const [first, second] = [vectors.bucket[0]!.cohortSalt, vectors.bucket.at(-1)!.cohortSalt];
    expect(first).not.toBe(second);
    const moved = subjects.filter((subject) => rolloutCohortBucket(first, subject) !== rolloutCohortBucket(second, subject));
    expect(moved.length).toBeGreaterThan(150);
  });

  for (const vector of vectors.valid) {
    it(`${vector.name} parses, matches its canonical form and verifies`, async () => {
      const binding = RolloutBindingSchema.parse(vector.binding);
      const { signature, ...unsigned } = binding;
      expect(canonicalRuntimeJson(unsigned)).toBe(vector.canonical);
      await expect(verifier.verifyRolloutBinding(binding)).resolves.toBeUndefined();
      const privateKey = createPrivateKey({ key: testKey.privateJwkTestOnly, format: 'jwk' });
      expect(sign(null, Buffer.from(vector.canonical), privateKey).toString('base64url')).toBe(signature.value);
    });
  }

  for (const vector of vectors.invalid.filter((entry) => entry.failure === 'schema')) {
    it(`${vector.name} fails the schema`, () => {
      expect(RolloutBindingSchema.safeParse(vector.binding).success).toBe(false);
    });
  }

  for (const vector of vectors.invalid.filter((entry) => entry.failure === 'signature')) {
    it(`${vector.name} parses but fails verification`, async () => {
      const binding = RolloutBindingSchema.parse(vector.binding);
      await expect(verifier.verifyRolloutBinding(binding)).rejects.toThrow();
    });
  }
});

describe('RuntimeDeploymentBundleSchema rolloutBinding field', () => {
  const canary = vectors.valid.find((vector) => vector.binding.rolloutMode === 'canary')!.binding;
  const revision = (revisionType: string) => ({
    schemaVersion: 1, revisionId: '019fbd00-0000-7000-8000-0000000000f1', revisionType, revision: 1,
    tenantId: '019fbd00-0000-7000-8000-0000000000f2', targetAppId: '019fbd00-0000-7000-8000-0000000000f3',
    ...(revisionType === 'agent' ? { subjectId: '019fbd00-0000-7000-8000-0000000000f4' } : { environmentId: canary.environmentId }),
    payload: {}, contentHash: 'sha256:abc', publishedAt: '2026-11-26T09:00:00.000Z',
    signature: { algorithm: 'Ed25519', keyId: 'k', value: 'signature-value' },
  });
  const deployment = {
    deploymentId: canary.deploymentId, environmentId: canary.environmentId, status: 'active',
    rolloutMode: 'canary', targetPercentage: canary.targetPercentage, pinned: false, healthStatus: 'healthy',
    agentRevision: revision('agent'), manifestRevision: revision('manifest'), policyRevision: revision('policy'),
    updatedAt: '2026-11-26T09:00:00.000Z',
  };

  it('stays valid without the negotiated field', () => {
    expect(RuntimeDeploymentBundleSchema.safeParse(deployment).success).toBe(true);
  });

  it('accepts a binding when negotiated and rejects a malformed one', () => {
    expect(RuntimeDeploymentBundleSchema.parse({ ...deployment, rolloutBinding: canary }).rolloutBinding)
      .toEqual(canary);
    expect(RuntimeDeploymentBundleSchema.safeParse({
      ...deployment, rolloutBinding: vectors.invalid.find((vector) => vector.failure === 'schema')!.binding,
    }).success).toBe(false);
  });
});
