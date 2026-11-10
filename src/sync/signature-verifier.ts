import {
  createHash,
  createPublicKey,
  verify,
  webcrypto,
} from 'node:crypto';
import type {
  ExecutionLease,
  RuntimeRevisionEnvelope,
  SecurityRevocation,
} from '../contracts/revisions.js';
import type {
  PromptBundle,
  SignedPromptBinding,
} from '../contracts/prompt-bundle.js';

export type RuntimePublicJwk = webcrypto.JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
};

export interface RuntimePublicKeyProvider {
  getKey(keyId: string): Promise<RuntimePublicJwk | null>;
}

export class RuntimeSyncVerificationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'content_hash_mismatch'
      | 'signing_key_unavailable'
      | 'invalid_signing_key'
      | 'signature_invalid',
  ) {
    super(message);
    this.name = 'RuntimeSyncVerificationError';
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (
      item === undefined ? null : canonicalValue(item)
    ));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalRuntimeJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export class RuntimeRevisionVerifier {
  constructor(private readonly keys: RuntimePublicKeyProvider) {}

  async verifyRevision(revision: RuntimeRevisionEnvelope): Promise<void> {
    const actualHash = `sha256:${createHash('sha256')
      .update(canonicalRuntimeJson(revision.payload))
      .digest('base64url')}`;
    if (actualHash !== revision.contentHash) {
      throw new RuntimeSyncVerificationError(
        'Runtime revision content hash does not match its payload',
        'content_hash_mismatch',
      );
    }
    const { signature, ...unsigned } = revision;
    await this.verifyEnvelope(unsigned, signature);
  }

  /**
   * A prompt bundle is content-addressed: its digest must match its canonical
   * sections and its publisher signature must verify before anything downstream
   * may parse or activate it.
   */
  async verifyPromptBundle(bundle: PromptBundle): Promise<void> {
    const actualDigest = `sha256:${createHash('sha256')
      .update(canonicalRuntimeJson(bundle.sections))
      .digest('base64url')}`;
    if (actualDigest !== bundle.bundleDigest) {
      throw new RuntimeSyncVerificationError(
        'Prompt bundle digest does not match its sections',
        'content_hash_mismatch',
      );
    }
    const { signature, ...unsigned } = bundle;
    await this.verifyEnvelope(unsigned, signature);
  }

  async verifyPromptBinding(binding: SignedPromptBinding): Promise<void> {
    const { signature, ...unsigned } = binding;
    await this.verifyEnvelope(unsigned, signature);
  }

  /**
   * Verify any signed object of the `{ ...unsigned, signature }` envelope
   * shape. Used by the standalone runtime source, whose locally
   * materialized revisions must pass the same chain as managed ones.
   */
  async verifySignedObject(
    value: { signature: RuntimeRevisionEnvelope['signature'] } & object,
  ): Promise<void> {
    const { signature, ...unsigned } = value;
    await this.verifyEnvelope(unsigned, signature);
  }

  async verifyRevocation(revocation: SecurityRevocation): Promise<void> {
    const { signature, ...unsigned } = revocation;
    await this.verifyEnvelope(unsigned, signature);
  }

  async verifyExecutionLease(lease: ExecutionLease): Promise<void> {
    const { signature, ...unsigned } = lease;
    await this.verifyEnvelope(unsigned, signature);
  }

  private async verifyEnvelope(
    unsigned: unknown,
    signature: RuntimeRevisionEnvelope['signature'],
  ): Promise<void> {
    const jwk = await this.keys.getKey(signature.keyId);
    if (!jwk) {
      throw new RuntimeSyncVerificationError(
        `Runtime signing key ${signature.keyId} is unavailable`,
        'signing_key_unavailable',
      );
    }
    let publicKey;
    try {
      publicKey = createPublicKey({ key: jwk, format: 'jwk' });
      if (publicKey.asymmetricKeyType !== 'ed25519') {
        throw new Error('not Ed25519');
      }
    } catch {
      throw new RuntimeSyncVerificationError(
        'Runtime signing key is not a valid Ed25519 public key',
        'invalid_signing_key',
      );
    }
    const valid = verify(
      null,
      Buffer.from(canonicalRuntimeJson(unsigned)),
      publicKey,
      Buffer.from(signature.value, 'base64url'),
    );
    if (!valid) {
      throw new RuntimeSyncVerificationError(
        'Runtime revision signature is invalid',
        'signature_invalid',
      );
    }
  }
}
