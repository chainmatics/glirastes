import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PrivacyPolicyBlockSchema,
  PrivacyRuntimeStatusSchema,
  mergePrivacyPolicy,
  normalizeProviderEndpoint,
  privacyLoosening,
  type LocalPrivacyPolicy,
  type LocalPrivacyProviders,
  type PrivacyPolicyBlock,
  type ProviderBinding,
} from '../privacy-policy.js';
import { PrivacyDecisionsEventSchema, RuntimeMetricEventSchema, TechnicalRuntimeEventBatchSchema } from '../events.js';
import { RuntimePolicyRevisionSchema, RuntimeRevisionEnvelopeSchema } from '../revisions.js';
import { findForbiddenPlatformContentPath } from '../content-boundary.js';
import { canonicalRuntimeJson, RuntimeRevisionVerifier } from '../../sync/signature-verifier.js';
import { canonicalDigest, privacyPolicyDigest, providerBindingDigest } from '../../sync/privacy-digest.js';

/**
 * sha256 of `__vectors__/privacy-policy.v1.json`. The Platform copies the
 * file byte for byte and pins the same digest, so a changed vector changes
 * this digest on purpose and goes to the Platform together with it.
 */
const PRIVACY_POLICY_VECTORS_SHA256 =
  '511bee0483b6cee7fc4cec0383f71aff595b9d655da120199d8683e90eb0133a';

interface Vectors {
  providerBindings: Array<{ name: string; binding: ProviderBinding; digest: string }>;
  endpoints: Array<{ input: string; expected: string }>;
  blocks: Array<{ name: string; block: unknown; valid: boolean }>;
  merges: Array<{
    name: string;
    platform: PrivacyPolicyBlock | null;
    local: LocalPrivacyPolicy;
    providers: LocalPrivacyProviders;
    expected: unknown;
  }>;
  loosening: Array<{ name: string; previous: PrivacyPolicyBlock | null; next: PrivacyPolicyBlock | null; expected: string[] }>;
  events: Array<{ name: string; event: unknown; valid: boolean }>;
  statuses: Array<{ name: string; status: unknown; valid: boolean }>;
  canonical: Array<{ name: string; value: unknown; undefinedPaths?: Array<Array<string | number>>; canonical: string; digest: string }>;
  signedRevision: {
    keyId: string;
    publicJwk: Record<string, unknown>;
    envelope: unknown;
    payloadDigest: string;
    privacyDigest: string;
  };
}

const raw = readFileSync(new URL('../__vectors__/privacy-policy.v1.json', import.meta.url));
const vectors = JSON.parse(raw.toString('utf8')) as Vectors;

function withUndefined(value: unknown, paths: ReadonlyArray<ReadonlyArray<string | number>> = []): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  for (const path of paths) {
    let node = copy;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
    node[path.at(-1)!] = undefined;
  }
  return copy;
}

describe('privacy policy golden vectors v1', () => {
  it('pins the file the Platform copies byte for byte', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(PRIVACY_POLICY_VECTORS_SHA256);
  });

  it('covers every section', () => {
    expect(vectors.blocks.filter((v) => v.valid).length).toBeGreaterThanOrEqual(4);
    expect(vectors.blocks.filter((v) => !v.valid).length).toBeGreaterThanOrEqual(20);
    expect(vectors.merges.length).toBeGreaterThanOrEqual(12);
    expect(vectors.loosening.length).toBeGreaterThanOrEqual(20);
    expect(vectors.events.length).toBeGreaterThanOrEqual(10);
    for (const section of [vectors.blocks, vectors.merges, vectors.loosening, vectors.events, vectors.statuses, vectors.canonical]) {
      expect(new Set(section.map((v) => v.name)).size).toBe(section.length);
    }
  });

  describe('blocks', () => {
    for (const vector of vectors.blocks) {
      it(vector.name, () => {
        expect(PrivacyPolicyBlockSchema.safeParse(vector.block).success).toBe(vector.valid);
      });
    }

    it('field names of a valid block pass the content boundary of both sides', () => {
      for (const vector of vectors.blocks.filter((v) => v.valid)) {
        expect(findForbiddenPlatformContentPath(vector.block)).toBeNull();
      }
    });

    it('a policy revision carries a valid block and refuses an invalid one', () => {
      const base = {
        revisionId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
        revision: 1,
        tenantId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        environmentId: '4c2d1e0f-9a8b-4c7d-8e6f-5a4b3c2d1e0f',
        budget: (vectors.signedRevision.envelope as { payload: { budget: unknown } }).payload.budget,
        toolPolicies: [],
        publishedAt: '2026-11-17T09:30:00.000Z',
        signature: { algorithm: 'Ed25519', keyId: 'k', value: 'signature-value' },
      };
      for (const vector of vectors.blocks) {
        expect(RuntimePolicyRevisionSchema.safeParse({ ...base, privacy: vector.block }).success).toBe(vector.valid);
      }
      const without = RuntimePolicyRevisionSchema.parse(base);
      expect('privacy' in without).toBe(false);
    });
  });

  describe('provider bindings', () => {
    for (const vector of vectors.providerBindings) {
      it(vector.name, () => {
        expect(providerBindingDigest(vector.binding)).toBe(vector.digest);
      });
    }

    it('normalizes endpoints without userinfo, query, fragment and trailing slash', () => {
      for (const vector of vectors.endpoints) {
        expect(normalizeProviderEndpoint(vector.input)).toBe(vector.expected);
      }
    });
  });

  describe('merge (local may only tighten)', () => {
    for (const vector of vectors.merges) {
      it(vector.name, () => {
        expect(mergePrivacyPolicy(vector.platform, vector.local, vector.providers)).toEqual(vector.expected);
      });
    }
  });

  describe('loosening', () => {
    for (const vector of vectors.loosening) {
      it(vector.name, () => {
        expect(privacyLoosening(vector.previous, vector.next)).toEqual(vector.expected);
      });
    }
  });

  describe('privacy.decisions events', () => {
    for (const vector of vectors.events) {
      it(vector.name, () => {
        expect(PrivacyDecisionsEventSchema.safeParse(vector.event).success).toBe(vector.valid);
        expect(RuntimeMetricEventSchema.safeParse(vector.event).success).toBe(vector.valid);
      });
    }

    it('travels in a batch of its own type', () => {
      const event = vectors.events.find((v) => v.name === 'valid/hour')!.event;
      expect(TechnicalRuntimeEventBatchSchema.safeParse({ schemaVersion: 2, events: [event] }).success).toBe(true);
    });
  });

  describe('runtime status', () => {
    for (const vector of vectors.statuses) {
      it(vector.name, () => {
        expect(PrivacyRuntimeStatusSchema.safeParse(vector.status).success).toBe(vector.valid);
      });
    }
  });

  describe('canonical JSON and digests', () => {
    for (const vector of vectors.canonical) {
      it(vector.name, () => {
        const value = withUndefined(vector.value, vector.undefinedPaths);
        expect(canonicalRuntimeJson(value)).toBe(vector.canonical);
        expect(canonicalDigest(value)).toBe(vector.digest);
      });
    }

    it('the privacy digest of a block is the digest of its canonical JSON', () => {
      const block = (vectors.signedRevision.envelope as { payload: { privacy: PrivacyPolicyBlock } }).payload.privacy;
      expect(privacyPolicyDigest(block)).toBe(vectors.signedRevision.privacyDigest);
    });
  });

  describe('signed policy revision', () => {
    it('verifies content hash and Ed25519 signature with the published test key', async () => {
      const envelope = RuntimeRevisionEnvelopeSchema.parse(vectors.signedRevision.envelope);
      expect(envelope.contentHash).toBe(vectors.signedRevision.payloadDigest);
      const verifier = new RuntimeRevisionVerifier({
        getKey: async (keyId: string) => (keyId === vectors.signedRevision.keyId ? vectors.signedRevision.publicJwk : null),
      } as never);
      await expect(verifier.verifyRevision(envelope)).resolves.toBeUndefined();
    });

    it('refuses a payload whose privacy block was changed after signing', async () => {
      const envelope = RuntimeRevisionEnvelopeSchema.parse(structuredClone(vectors.signedRevision.envelope));
      (envelope.payload as { privacy: { screenshots: { mode: string } } }).privacy.screenshots.mode = 'allow-original';
      const verifier = new RuntimeRevisionVerifier({
        getKey: async () => vectors.signedRevision.publicJwk,
      } as never);
      await expect(verifier.verifyRevision(envelope)).rejects.toMatchObject({ code: 'content_hash_mismatch' });
    });
  });
});
