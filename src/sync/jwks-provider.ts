import type {
  RuntimePublicJwk,
  RuntimePublicKeyProvider,
} from './signature-verifier.js';

export class HttpRuntimePublicKeyProvider implements RuntimePublicKeyProvider {
  private keys = new Map<string, RuntimePublicJwk>();
  private expiresAt = 0;

  constructor(private readonly options: {
    baseUrl: string;
    apiKey: string;
    fetchImpl?: typeof fetch;
    cacheTtlMs?: number;
  }) {}

  async getKey(keyId: string): Promise<RuntimePublicJwk | null> {
    if (Date.now() >= this.expiresAt) await this.refresh();
    const cached = this.keys.get(keyId);
    if (cached) return cached;

    // A missing key may indicate rotation; refresh once even while the normal
    // cache is still valid.
    await this.refresh();
    return this.keys.get(keyId) ?? null;
  }

  private async refresh(): Promise<void> {
    const response = await (this.options.fetchImpl ?? fetch)(
      `${this.options.baseUrl.replace(/\/$/, '')}/v1/runtime-revisions/jwks`,
      {
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(`Runtime JWKS request failed (${response.status})`);
    }
    const payload = await response.json() as { keys?: unknown };
    if (!Array.isArray(payload.keys)) {
      throw new Error('Runtime JWKS response is invalid');
    }
    const next = new Map<string, RuntimePublicJwk>();
    for (const raw of payload.keys) {
      if (!raw || typeof raw !== 'object') {
        throw new Error('Runtime JWKS contains an invalid key');
      }
      const key = raw as RuntimePublicJwk & {
        kid?: string;
        d?: string;
        alg?: string;
        use?: string;
      };
      if (key.d) {
        throw new Error('Runtime JWKS must never contain private key material');
      }
      if (
        key.kty !== 'OKP'
        || key.crv !== 'Ed25519'
        || typeof key.x !== 'string'
        || typeof key.kid !== 'string'
      ) {
        throw new Error('Runtime JWKS key must be public Ed25519');
      }
      next.set(key.kid, key);
    }
    this.keys = next;
    this.expiresAt = Date.now() + (this.options.cacheTtlMs ?? 300_000);
  }
}
