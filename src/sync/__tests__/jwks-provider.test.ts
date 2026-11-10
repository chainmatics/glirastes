import { describe, expect, it, vi } from 'vitest';
import { HttpRuntimePublicKeyProvider } from '../jwks-provider.js';

describe('HttpRuntimePublicKeyProvider', () => {
  it('loads and caches public Ed25519 keys without accepting private material', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      keys: [{
        kty: 'OKP',
        crv: 'Ed25519',
        x: 'public-key',
        kid: 'runtime-key',
        alg: 'EdDSA',
        use: 'sig',
      }],
    }), { status: 200 }));
    const provider = new HttpRuntimePublicKeyProvider({
      baseUrl: 'https://control.example.test',
      apiKey: 'gl_runtime',
      fetchImpl,
    });

    expect(await provider.getKey('runtime-key')).toEqual(expect.objectContaining({
      kid: 'runtime-key',
      kty: 'OKP',
    }));
    expect(await provider.getKey('runtime-key')).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a JWKS response containing private key material', async () => {
    const provider = new HttpRuntimePublicKeyProvider({
      baseUrl: 'https://control.example.test',
      apiKey: 'gl_runtime',
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        keys: [{
          kty: 'OKP',
          crv: 'Ed25519',
          x: 'public-key',
          d: 'private-key',
          kid: 'runtime-key',
        }],
      }), { status: 200 })),
    });
    await expect(provider.getKey('runtime-key')).rejects.toThrow(/private/i);
  });
});
