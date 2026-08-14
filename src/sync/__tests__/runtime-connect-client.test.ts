import { describe, expect, it, vi } from 'vitest';
import { RuntimeConnectClient } from '../runtime-connect-client.js';

const appId = '019fa9a9-d5f7-7ec3-a3c7-8899de400001';
const environmentId = '019fa9a9-d5f7-7ec3-a3c7-8899de400002';
const artifactDigest = `sha256:${'A'.repeat(43)}`;
const deviceCode = `device_${'x'.repeat(43)}`;

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('RuntimeConnectClient', () => {
  it('starts pairing with only bounded local identity evidence', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      schemaVersion: 1,
      deviceCode,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://platform.example/connect/pair',
      expiresInSeconds: 60,
      pollIntervalMs: 1_000,
    }));
    const client = new RuntimeConnectClient({
      baseUrl: 'https://control.example/',
      fetchImpl,
    });

    const started = await client.startPairing({
      schemaVersion: 1,
      localAppId: appId,
      localAppName: 'fixture-app',
      artifactDigest,
    });

    expect(started.userCode).toBe('ABCD-EFGH');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://control.example/v1/runtime-connect/pairings');
    expect(init).toMatchObject({ method: 'POST' });
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({
      schemaVersion: 1,
      localAppId: appId,
      localAppName: 'fixture-app',
      artifactDigest,
    });
    expect(Object.keys(sent)).not.toEqual(expect.arrayContaining([
      'prompts', 'inputSchema', 'outputSchema', 'source', 'credentials', 'apiKey',
    ]));
  });

  it('polls at each server-provided interval until connected', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ status: 'pending', pollAfterMs: 2_000 }))
      .mockResolvedValueOnce(response({ status: 'connected', connection: {
        schemaVersion: 1,
        baseUrl: 'https://control.example',
        appId,
        environmentId,
        runnerKey: 'server-runner',
      }, apiKey: `gl_${'k'.repeat(40)}` }));
    let time = 0;
    const sleep = vi.fn(async (milliseconds: number) => { time += milliseconds; });
    const client = new RuntimeConnectClient({
      baseUrl: 'https://control.example', fetchImpl, sleep, now: () => time,
    });

    const result = await client.pollForConnection({
      deviceCode,
      pollIntervalMs: 1_000,
      expiresInSeconds: 60,
    });

    expect(result.status).toBe('connected');
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000, undefined);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls as Array<[string, RequestInit]>) {
      expect(JSON.parse(String(init.body))).toEqual({ deviceCode });
    }
  });

  it('returns denial and expiry without another poll', async () => {
    for (const status of ['denied', 'expired'] as const) {
      const fetchImpl = vi.fn().mockResolvedValue(response({ status }));
      const client = new RuntimeConnectClient({
        baseUrl: 'https://control.example',
        fetchImpl,
        sleep: vi.fn().mockResolvedValue(undefined),
      });
      await expect(client.pollForConnection({
        deviceCode, pollIntervalMs: 1_000, expiresInSeconds: 60,
      })).resolves.toEqual({ status });
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it('bounds polling by the server expiry and supports cancellation', async () => {
    let time = 0;
    const fetchImpl = vi.fn().mockResolvedValue(
      response({ status: 'pending', pollAfterMs: 30_000 }),
    );
    const client = new RuntimeConnectClient({
      baseUrl: 'https://control.example',
      fetchImpl,
      now: () => time,
      sleep: vi.fn(async (milliseconds: number) => { time += milliseconds; }),
    });
    await expect(client.pollForConnection({
      deviceCode, pollIntervalMs: 30_000, expiresInSeconds: 60,
    })).rejects.toMatchObject({ code: 'E-CONNECT-TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledOnce();

    const controller = new AbortController();
    controller.abort();
    await expect(client.pollForConnection({
      deviceCode,
      pollIntervalMs: 1_000,
      expiresInSeconds: 60,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'E-CONNECT-CANCELLED' });
  });

  it('rejects unsafe base URLs and invalid response bodies', async () => {
    expect(() => new RuntimeConnectClient({
      baseUrl: 'http://public.example',
    })).toThrow(/HTTPS|loopback/);
    expect(() => new RuntimeConnectClient({
      baseUrl: 'https://name:password@control.example',
    })).toThrow(/credentials/);

    const client = new RuntimeConnectClient({
      baseUrl: 'https://control.example',
      fetchImpl: vi.fn().mockResolvedValue(response({
        schemaVersion: 1,
        deviceCode,
        userCode: 'ABCD-EFGH',
        verificationUri: 'http://public.example/connect',
        expiresInSeconds: 60,
        pollIntervalMs: 1_000,
      })),
    });
    await expect(client.startPairing({
      schemaVersion: 1,
      localAppId: appId,
      localAppName: 'fixture',
      artifactDigest,
    })).rejects.toMatchObject({ code: 'E-CONNECT-RESPONSE-INVALID' });
  });
});
