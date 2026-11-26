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

  it('aborts a JWKS request that hangs past timeoutMs', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const provider = new HttpRuntimePublicKeyProvider({
      baseUrl: 'https://control.example', apiKey: 'runtime-secret', fetchImpl: fetchImpl as never, timeoutMs: 5,
    });
    await expect(provider.getKey('runtime-key')).rejects.toThrow();
    expect(fetchImpl.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
  it('keeps serving a cached key when a refresh fails and fails only for unknown keys', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'public-key', kid: 'runtime-key' }],
      }), { status: 200 }))
      .mockResolvedValue(new Response('', { status: 503 }));
    const provider = new HttpRuntimePublicKeyProvider({
      baseUrl: 'https://control.example.test', apiKey: 'gl_runtime', fetchImpl, cacheTtlMs: 0,
    });
    await provider.getKey('runtime-key');
    expect(await provider.getKey('runtime-key')).toEqual(expect.objectContaining({ kid: 'runtime-key' }));
    await expect(provider.getKey('rotated-key')).rejects.toThrow(/503/);
  });
});
