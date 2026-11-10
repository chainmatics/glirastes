import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import type { RevisionSignature } from '../contracts/revisions.js';
import {
  canonicalRuntimeJson,
  type RuntimePublicJwk,
} from '../sync/signature-verifier.js';

export interface LocalRevisionSigner {
  readonly keyId: string;
  readonly publicKeyJwk: RuntimePublicJwk;
  sign<T extends object>(unsigned: T): T & { signature: RevisionSignature };
}

/**
 * Standalone mode has no control plane and therefore no platform signing
 * key. It still never lets unsigned data into the runtime: every locally
 * materialized revision is signed with an ephemeral Ed25519 key generated
 * at boot, and verifies through the exact same verifier chain managed
 * revisions use. The key never leaves the process and dies with it.
 */
export function createEphemeralLocalSigner(): LocalRevisionSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);
  const publicKeyJwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: keyId,
  } as RuntimePublicJwk;

  return {
    keyId,
    publicKeyJwk,
    sign<T extends object>(unsigned: T): T & { signature: RevisionSignature } {
      const value = sign(
        null,
        Buffer.from(canonicalRuntimeJson(unsigned)),
        privateKey,
      ).toString('base64url');
      return {
        ...unsigned,
        signature: { algorithm: 'Ed25519', keyId, value },
      };
    },
  };
}
