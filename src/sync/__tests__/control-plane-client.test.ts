import { describe, expect, it, vi } from 'vitest';
import {
  RuntimeControlPlaneClient,
  RuntimeControlPlaneRequestError,
} from '../control-plane-client.js';

const baseOptions = {
  baseUrl: 'https://control.example.test',
  apiKey: 'gl_secret_runtime_key',
  appId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901',
  environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
  runnerKey: 'get-it-done-production',
  version: '1.0.0',
};

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    return caught as Error;
  }
  throw new Error('expected the control plane request to reject');
}

describe('RuntimeControlPlaneClient', () => {
  it('registers and polls using only the app-scoped credential header', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'runner-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        cursor: '2026-07-28T20:00:00.000Z',
        activeSnapshotComplete: true,
        deployments: [],
        revocations: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const manager = { apply: vi.fn().mockResolvedValue({}) };
    const client = new RuntimeControlPlaneClient({
      ...baseOptions,
      fetchImpl,
      manager: manager as never,
    });

    await client.register({
      capabilities: { aiSdk: true },
      technicalMetadata: { runtimeVersion: '1.0.0' },
    });
    await client.syncOnce();

    expect(fetchImpl.mock.calls[0][1].headers).toEqual({
      authorization: `Bearer ${baseOptions.apiKey}`,
      'content-type': 'application/json',
    });
    expect(fetchImpl.mock.calls[1][0]).toContain('/sync?runnerKey=');
    expect(manager.apply).toHaveBeenCalledOnce();
  });

  it('sends the runner key on the stream only when read-only', async () => {
    const urls: string[] = [];
    const connect = vi.fn(async (input: { url: string }) => { urls.push(input.url); });
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      cursor: 'c', activeSnapshotComplete: true, deployments: [], revocations: [],
    }), { status: 200 }));
    for (const readOnly of [true, false]) {
      const client = new RuntimeControlPlaneClient({
        ...baseOptions, runnerKey: 'dev-abcdefghijklm', fetchImpl, readOnly,
        manager: { apply: vi.fn().mockResolvedValue({}) } as never,
        push: { connect: connect as never }, pollIntervalMs: 1_000,
      });
      const running = client.start();
      await vi.waitFor(() => expect(urls.length).toBe(readOnly ? 1 : 2));
      client.stop();
      await running;
    }
    expect(urls[0]).toMatch(/\/runners\/stream\?runnerKey=dev-abcdefghijklm$/);
    expect(urls[1]).toMatch(/\/runners\/stream$/);
  });

  it('refuses to register or heartbeat when read-only', async () => {
    const fetchImpl = vi.fn();
    const client = new RuntimeControlPlaneClient({
      ...baseOptions, fetchImpl, readOnly: true, manager: { apply: vi.fn() } as never,
    });
    await expect(client.register({ capabilities: {} })).rejects.toThrow(/read-only/);
    await expect(client.heartbeat({ health: 'healthy' })).rejects.toThrow(/read-only/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('continues polling when the optional push connector fails', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      cursor: '2026-07-28T20:00:00.000Z',
      activeSnapshotComplete: true,
      deployments: [],
      revocations: [],
    }), { status: 200 }));
    const manager = { apply: vi.fn().mockResolvedValue({}) };
    const pushError = new Error('stream unavailable');
    const onError = vi.fn();
    const client = new RuntimeControlPlaneClient({
      ...baseOptions,
      fetchImpl,
      manager: manager as never,
      push: {
        connect: vi.fn().mockRejectedValue(pushError),
      },
      pollIntervalMs: 5,
      onError,
    });

    const running = client.start();
    try {
      await vi.advanceTimersByTimeAsync(16);
      expect(manager.apply).toHaveBeenCalledTimes(4);
      expect(onError).toHaveBeenCalledExactlyOnceWith(pushError);
      client.stop();
      await running;
      await vi.advanceTimersByTimeAsync(20);
      expect(manager.apply).toHaveBeenCalledTimes(4);
    } finally {
      client.stop();
      await running;
      vi.useRealTimers();
    }
  });

  it('reports the failed operation and status without exposing response content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: 'sensitive upstream detail',
    }), { status: 500 }));
    const client = new RuntimeControlPlaneClient({
      ...baseOptions,
      fetchImpl,
      manager: { apply: vi.fn() } as never,
    });

    const error = await rejectionOf(client.register());

    expect(error).toBeInstanceOf(RuntimeControlPlaneRequestError);
    expect(error).toMatchObject({
      operation: 'register',
      status: 500,
    });
    expect(error.message).toBe(
      'Glirastes Control Plane register request failed (500)',
    );
    expect(error.message).not.toContain('sensitive upstream detail');
  });
});
