import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  RuntimeRevisionEnvelope,
  SecurityRevocation,
} from '../../contracts/revisions.js';
import {
  canonicalRuntimeJson,
  RuntimeRevisionVerifier,
} from '../signature-verifier.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'runtime-key';
const provider = {
  getKey: async (requestedKeyId: string) => (
    requestedKeyId === keyId
      ? publicKey.export({ format: 'jwk' })
      : null
  ),
};

function signatureFor(unsigned: unknown) {
  return {
    algorithm: 'Ed25519' as const,
    keyId,
    value: sign(
      null,
      Buffer.from(canonicalRuntimeJson(unsigned)),
      privateKey,
    ).toString('base64url'),
  };
}

function signedRevision(
  payload: unknown = { modelAlias: 'standard' },
): RuntimeRevisionEnvelope {
  const unsigned = {
    schemaVersion: 1 as const,
    revisionId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901',
    revisionType: 'agent' as const,
    revision: 1,
    tenantId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
    targetAppId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3903',
    subjectId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3904',
    contentHash: `sha256:${createHash('sha256')
      .update(canonicalRuntimeJson(payload))
      .digest('base64url')}`,
    payload,
    publishedAt: '2026-07-28T20:00:00.000Z',
  };
  return { ...unsigned, signature: signatureFor(unsigned) };
}

describe('RuntimeRevisionVerifier', () => {
  it('verifies Ed25519 revision envelopes and their canonical content hash', async () => {
    const verifier = new RuntimeRevisionVerifier(provider);
    await expect(verifier.verifyRevision(signedRevision())).resolves.toBeUndefined();
  });

  it('rejects tampering and unknown signing keys', async () => {
    const verifier = new RuntimeRevisionVerifier(provider);
    const revision = signedRevision();
    await expect(verifier.verifyRevision({
      ...revision,
      payload: { modelAlias: 'tampered' },
    })).rejects.toThrow(/content hash/i);
    await expect(verifier.verifyRevision({
      ...revision,
      signature: { ...revision.signature, keyId: 'unknown' },
    })).rejects.toThrow(/signing key/i);
  });

  it('never verifies a confirmation relaxation added to a signed policy (D16)', async () => {
    const verifier = new RuntimeRevisionVerifier(provider);
    const toolId = '019fa9a9-d5f7-7ec3-a3c7-8899de1d3905';
    const policy = { toolPolicies: [], toolOverrides: [] };
    const revision = signedRevision(policy);
    const relaxed = {
      ...policy,
      toolOverrides: [{ toolId, requiresApproval: false, pin: { toolId, atRiskClass: 'write' } }],
    };
    await expect(verifier.verifyRevision({ ...revision, payload: relaxed }))
      .rejects.toThrow(/content hash/i);
    await expect(verifier.verifyRevision({
      ...revision,
      payload: relaxed,
      contentHash: `sha256:${createHash('sha256')
        .update(canonicalRuntimeJson(relaxed))
        .digest('base64url')}`,
    })).rejects.toThrow(/signature is invalid/i);
  });

  it('verifies signed security revocations', async () => {
    const unsigned = {
      revocationId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3910',
      environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3911',
      effectiveAt: '2026-07-28T20:00:00.000Z',
      reasonCode: 'deployment-security-revocation',
      toolIds: ['019fa9a9-d5f7-7ec3-a3c7-8899de1d3912'],
      agentRevisionIds: [],
      policyRevisionIds: [],
    };
    const revocation: SecurityRevocation = {
      ...unsigned,
      signature: signatureFor(unsigned),
    };
    const verifier = new RuntimeRevisionVerifier(provider);
    await expect(verifier.verifyRevocation(revocation)).resolves.toBeUndefined();
  });
});
