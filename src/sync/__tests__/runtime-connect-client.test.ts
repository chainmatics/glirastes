import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000, expect.any(AbortSignal));
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000, expect.any(AbortSignal));
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

  it.each(['fetch', 'json'] as const)(
    'aborts a never-resolving %s at the remaining pairing deadline',
    async (stage) => {
      vi.useFakeTimers();
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn(async (_url, init) => {
        requestSignal = init?.signal as AbortSignal;
        if (stage === 'fetch') {
          return await new Promise<Response>(() => {});
        }
        return {
          ok: true,
          json: () => new Promise<unknown>(() => {}),
        } as Response;
      });
      const client = new RuntimeConnectClient({
        baseUrl: 'https://control.example',
        fetchImpl,
        sleep: vi.fn().mockResolvedValue(undefined),
      });

      const polling = client.pollForConnection({
        deviceCode,
        pollIntervalMs: 1_000,
        expiresInSeconds: 60,
      });
      const rejected = expect(polling).rejects.toMatchObject({
        code: 'E-CONNECT-TIMEOUT',
      });
      await vi.advanceTimersByTimeAsync(60_000);

      await rejected;
      expect(requestSignal?.aborted).toBe(true);
    },
  );

  it('combines external cancellation with the internal request signal', async () => {
    const external = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url, init) => {
      requestSignal = init?.signal as AbortSignal;
      return await new Promise<Response>(() => {});
    });
    const client = new RuntimeConnectClient({
      baseUrl: 'https://control.example',
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    const polling = client.pollForConnection({
      deviceCode,
      pollIntervalMs: 1_000,
      expiresInSeconds: 60,
      signal: external.signal,
    });
    const rejected = expect(polling).rejects.toMatchObject({
      code: 'E-CONNECT-CANCELLED',
    });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    const reason = new Error('operator cancellation');
    external.abort(reason);

    await rejected;
    expect(requestSignal).not.toBe(external.signal);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(reason);
  });

  it('removes external abort listeners after completed timers and polls', async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const add = vi.spyOn(external.signal, 'addEventListener');
    const remove = vi.spyOn(external.signal, 'removeEventListener');
    const client = new RuntimeConnectClient({
      baseUrl: 'https://control.example',
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(response({
          status: 'pending', pollAfterMs: 2_000,
        }))
        .mockResolvedValueOnce(response({ status: 'denied' })),
    });

    const polling = client.pollForConnection({
      deviceCode,
      pollIntervalMs: 1_000,
      expiresInSeconds: 60,
      signal: external.signal,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(polling).resolves.toEqual({ status: 'denied' });

    const abortAdds = add.mock.calls.filter(([type]) => type === 'abort');
    const abortRemoves = remove.mock.calls.filter(([type]) => type === 'abort');
    expect(abortAdds.length).toBeGreaterThan(0);
    expect(abortRemoves).toHaveLength(abortAdds.length);
    expect(vi.getTimerCount()).toBe(0);
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
