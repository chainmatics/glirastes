import { describe, expect, it, vi } from 'vitest';
import { RuntimeControlPlaneClient } from '../control-plane-client.js';

const baseOptions = {
  baseUrl: 'https://control.example.test',
  apiKey: 'gl_secret_runtime_key',
  appId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3901',
  environmentId: '019fa9a9-d5f7-7ec3-a3c7-8899de1d3902',
  runnerKey: 'get-it-done-production',
  version: '1.0.0',
};

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

  it('continues polling when the optional push connector fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      cursor: '2026-07-28T20:00:00.000Z',
      activeSnapshotComplete: true,
      deployments: [],
      revocations: [],
    }), { status: 200 }));
    const client = new RuntimeControlPlaneClient({
      ...baseOptions,
      fetchImpl,
      manager: { apply: vi.fn().mockResolvedValue({}) } as never,
      push: {
        connect: vi.fn().mockRejectedValue(new Error('stream unavailable')),
      },
      pollIntervalMs: 5,
    });

    const running = client.start();
    await new Promise((resolve) => setTimeout(resolve, 18));
    client.stop();
    await running;
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });
});
