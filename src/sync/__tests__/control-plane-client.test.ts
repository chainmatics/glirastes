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

  it('reconnects the push stream with backoff and catches up after a reconnect', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      cursor: 'c', activeSnapshotComplete: true, deployments: [], revocations: [],
    }), { status: 200 }));
    const manager = { apply: vi.fn().mockResolvedValue({}) };
    const onError = vi.fn();
    const attempts: number[] = [];
    const connect = vi.fn(async (input: { onOpen?: () => void | Promise<void> }) => {
      attempts.push(Date.now());
      if (attempts.length <= 2) throw new Error('Runtime push stream failed (524)');
      await input.onOpen?.();
      if (attempts.length === 3) return;
      await new Promise(() => {});
    });
    const client = new RuntimeControlPlaneClient({
      ...baseOptions, fetchImpl, manager: manager as never, onError,
      push: { connect: connect as never }, pollIntervalMs: 600_000,
    });

    const running = client.start();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(connect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connect).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(connect).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(3);
      expect(onError).toHaveBeenCalledTimes(2);

      const syncsBefore = manager.apply.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connect).toHaveBeenCalledTimes(4);
      expect(manager.apply.mock.calls.length).toBe(syncsBefore + 1);
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

  it('negotiates environment control on sync and reports the capability', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      cursor: '2026-07-28T20:00:00.000Z', activeSnapshotComplete: true, deployments: [], revocations: [],
    }), { status: 200 }));
    const client = new RuntimeControlPlaneClient({
      ...baseOptions, fetchImpl, manager: { apply: vi.fn().mockResolvedValue({}) } as never,
    });

    await client.register({ capabilities: { aiSdk: true } });
    await client.syncOnce();

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).capabilities).toEqual({
      aiSdk: true,
      environmentControl: 1,
    });
    const syncUrl = new URL(fetchImpl.mock.calls[1][0]);
    expect(syncUrl.searchParams.get('controlVersion')).toBe('1');
    expect(syncUrl.searchParams.get('runnerKey')).toBe(baseOptions.runnerKey);
  });

  it('refuses a caller-supplied environmentControl capability that differs', async () => {
    const client = new RuntimeControlPlaneClient({
      ...baseOptions, fetchImpl: vi.fn(), manager: { apply: vi.fn() } as never,
    });
    await expect(client.register({ capabilities: { environmentControl: 2 } }))
      .rejects.toThrow(/environmentControl/);
  });

  it('aborts a request that hangs past requestTimeoutMs', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const client = new RuntimeControlPlaneClient({
      ...baseOptions, fetchImpl: fetchImpl as never, requestTimeoutMs: 5,
      manager: { apply: vi.fn() } as never,
    });
    await expect(client.heartbeat({ health: 'healthy' })).rejects.toThrow();
    expect(fetchImpl.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
  describe('environment control heartbeat', () => {
    const syncResponse = () => new Response(JSON.stringify({
      cursor: '2026-07-28T20:00:00.000Z', activeSnapshotComplete: true, deployments: [], revocations: [], control: null,
    }), { status: 200 });
    const applied = (outcome: string, control: unknown) => ({ control: outcome, state: { control } });

    function clientWith(results: unknown[], options: Record<string, unknown> = {}) {
      const fetchImpl = vi.fn().mockImplementation(async (url: string) => (
        url.includes('/sync?') ? syncResponse() : new Response(JSON.stringify({ ok: true }), { status: 200 })
      ));
      const apply = vi.fn();
      for (const result of results) apply.mockResolvedValueOnce(result);
      const client = new RuntimeControlPlaneClient({ ...baseOptions, fetchImpl, manager: { apply } as never, ...options });
      const heartbeats = () => fetchImpl.mock.calls
        .filter(([url]) => String(url).endsWith('/heartbeat'))
        .map(([, init]) => JSON.parse(init.body));
      return { client, heartbeats };
    }

    it('reports the applied control sequence and assistant state, content-free, when it changes', async () => {
      const halt = { accepted: { sequence: 3, assistant: 'halted', reasonCode: 'operator-halt' }, localHalt: null };
      const { client, heartbeats } = clientWith([
        applied('accepted', halt),
        applied('stale', halt),
        applied('unverifiable', { accepted: halt.accepted, localHalt: { kind: 'local', sequence: 3 } }),
      ]);
      await client.syncOnce();
      await client.syncOnce();
      await client.syncOnce();
      expect(heartbeats()).toEqual([
        { runnerKey: baseOptions.runnerKey, health: 'healthy', technicalMetadata: { controlSequence: 3, assistantState: 'halted' } },
        { runnerKey: baseOptions.runnerKey, health: 'degraded', technicalMetadata: { controlSequence: 3, assistantState: 'halted' } },
      ]);
      expect(JSON.stringify(heartbeats())).not.toContain('operator-halt');
    });

    it('repeats the report after the heartbeat interval', async () => {
      const enabled = { accepted: { sequence: 1, assistant: 'enabled' }, localHalt: null };
      const { client, heartbeats } = clientWith(
        [applied('accepted', enabled), applied('stale', enabled)],
        { controlHeartbeatIntervalMs: 0 },
      );
      await client.syncOnce();
      await client.syncOnce();
      expect(heartbeats()).toHaveLength(2);
      expect(heartbeats()[1].technicalMetadata).toEqual({ controlSequence: 1, assistantState: 'enabled' });
    });

    it('sends nothing for a Platform without control or a read-only connection', async () => {
      const absent = clientWith([applied('absent', undefined)]);
      await absent.client.syncOnce();
      expect(absent.heartbeats()).toEqual([]);

      const readOnly = clientWith([applied('accepted', { accepted: { sequence: 1, assistant: 'halted' }, localHalt: null })], { readOnly: true });
      await readOnly.client.syncOnce();
      expect(readOnly.heartbeats()).toEqual([]);
    });

    it('adds the control state to deployment heartbeats once known', async () => {
      const { client, heartbeats } = clientWith([applied('kept', { accepted: null, localHalt: null })]);
      await client.syncOnce();
      await client.heartbeat({ health: 'healthy', technicalMetadata: { activationStage: 'signature-schema-bindings' } });
      expect(heartbeats().at(-1).technicalMetadata).toEqual({
        activationStage: 'signature-schema-bindings', controlSequence: 0, assistantState: 'enabled',
      });
    });
  });
});
