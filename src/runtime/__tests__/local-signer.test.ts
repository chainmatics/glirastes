import { describe, expect, it } from 'vitest';
import {
  RuntimeRevisionVerifier,
  type RuntimePublicJwk,
} from '../../sync/signature-verifier.js';
import { createEphemeralLocalSigner } from '../local-signer.js';

function verifierFor(signer: {
  keyId: string;
  publicKeyJwk: RuntimePublicJwk;
}): RuntimeRevisionVerifier {
  return new RuntimeRevisionVerifier({
    getKey: async (keyId) => (
      keyId === signer.keyId ? signer.publicKeyJwk : null
    ),
  });
}

describe('createEphemeralLocalSigner', () => {
  it('produces signatures the existing verifier accepts', async () => {
    const signer = createEphemeralLocalSigner();
    const signed = signer.sign({
      revisionId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
    });
    expect(signed.signature.algorithm).toBe('Ed25519');
    expect(signed.signature.keyId).toBe(signer.keyId);
    await expect(
      verifierFor(signer).verifySignedObject(signed),
    ).resolves.toBeUndefined();
  });

  it('rejects tampered payloads through the existing verifier', async () => {
    const signer = createEphemeralLocalSigner();
    const signed = signer.sign({
      revisionId: '00000000-0000-4000-8000-000000000001',
      revision: 1,
    });
    const tampered = { ...signed, revision: 2 };
    await expect(
      verifierFor(signer).verifySignedObject(tampered),
    ).rejects.toThrow(/signature/i);
  });

  it('generates a fresh key and keyId per boot', () => {
    const first = createEphemeralLocalSigner();
    const second = createEphemeralLocalSigner();
    expect(first.keyId).not.toBe(second.keyId);
    expect(first.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('never mutates the unsigned input', () => {
    const signer = createEphemeralLocalSigner();
    const unsigned = { revisionId: '00000000-0000-4000-8000-000000000001', revision: 1 };
    signer.sign(unsigned);
    expect(unsigned).not.toHaveProperty('signature');
  });
});
