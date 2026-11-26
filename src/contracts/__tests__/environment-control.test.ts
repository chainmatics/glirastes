import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalRuntimeJson, RuntimeRevisionVerifier } from '../../sync/signature-verifier.js';
import {
  ENVIRONMENT_CONTROL_CAPABILITY,
  ENVIRONMENT_CONTROL_SCHEMA_VERSION,
  ENVIRONMENT_CONTROL_SYNC_VERSION,
  EnvironmentControlSchema,
  RuntimeSyncBundleSchema,
} from '../index.js';

interface ControlVectors {
  contract: 'EnvironmentControl';
  schemaVersion: 1;
  negotiation: {
    syncQuery: { controlVersion: string };
    registrationCapability: { environmentControl: number };
  };
  signing: {
    testKey: {
      keyId: string;
      publicJwk: Record<string, string>;
      privateJwkTestOnly: Record<string, string>;
    };
  };
  valid: Array<{ name: string; canonical: string; control: Record<string, unknown> }>;
  invalid: Array<{ name: string; failure: 'schema' | 'signature'; control: Record<string, unknown> }>;
}

/**
 * The Platform keeps a byte-identical copy (T5) and pins the same digest.
 * Changing a vector means a new digest on both sides, never a one-sided edit.
 */
const VECTORS_SHA256 = '9829b4e31408d0f5b21e7f444444ae3e1e857f18a2b93f90a304fa8a53be900b';
const raw = readFileSync(
  new URL('../__vectors__/environment-control.v1.json', import.meta.url),
);
const vectors = JSON.parse(raw.toString('utf8')) as ControlVectors;
const { testKey } = vectors.signing;
const verifier = new RuntimeRevisionVerifier({
  getKey: async (keyId) => (keyId === testKey.keyId ? testKey.publicJwk : null),
});

describe('EnvironmentControl v1 golden vectors', () => {
  it('pins the vectors the Platform copies', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
    expect(vectors.schemaVersion).toBe(ENVIRONMENT_CONTROL_SCHEMA_VERSION);
    expect(vectors.negotiation.syncQuery.controlVersion).toBe(String(ENVIRONMENT_CONTROL_SYNC_VERSION));
    expect(vectors.negotiation.registrationCapability).toEqual({
      environmentControl: ENVIRONMENT_CONTROL_CAPABILITY,
    });
  });

  for (const vector of vectors.valid) {
    it(`${vector.name} parses, matches its canonical form and verifies`, async () => {
      const control = EnvironmentControlSchema.parse(vector.control);
      const { signature, ...unsigned } = control;
      expect(canonicalRuntimeJson(unsigned)).toBe(vector.canonical);
      await expect(verifier.verifySignedObject(control)).resolves.toBeUndefined();
      // Ed25519 is deterministic: the Platform signing the canonical form with the test key must produce this value.
      const privateKey = createPrivateKey({ key: testKey.privateJwkTestOnly, format: 'jwk' });
      expect(sign(null, Buffer.from(vector.canonical), privateKey).toString('base64url'))
        .toBe(signature.value);
    });
  }

  for (const vector of vectors.invalid.filter((entry) => entry.failure === 'schema')) {
    it(`${vector.name} fails the schema`, () => {
      expect(EnvironmentControlSchema.safeParse(vector.control).success).toBe(false);
    });
  }

  for (const vector of vectors.invalid.filter((entry) => entry.failure === 'signature')) {
    it(`${vector.name} parses but fails verification`, async () => {
      const control = EnvironmentControlSchema.parse(vector.control);
      await expect(verifier.verifySignedObject(control)).rejects.toThrow();
    });
  }
});

describe('RuntimeSyncBundleSchema control field', () => {
  const bundle = {
    cursor: '2026-11-26T09:00:00.000Z',
    activeSnapshotComplete: true as const,
    deployments: [],
    revocations: [],
  };

  it('stays valid without the negotiated field', () => {
    expect(RuntimeSyncBundleSchema.parse(bundle)).toEqual(bundle);
  });

  it('accepts a control object or null when negotiated', () => {
    expect(RuntimeSyncBundleSchema.parse({ ...bundle, control: null }).control).toBeNull();
    expect(RuntimeSyncBundleSchema.parse({ ...bundle, control: vectors.valid[0]!.control }).control)
      .toEqual(vectors.valid[0]!.control);
  });

  it('rejects an invalid control object', () => {
    expect(RuntimeSyncBundleSchema.safeParse({ ...bundle, control: vectors.invalid[0]!.control }).success)
      .toBe(false);
  });
});
