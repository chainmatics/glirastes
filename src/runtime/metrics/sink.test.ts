import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TechnicalRuntimeEventV2 } from '../../contracts/index.js';
import {
  createRuntimeMetricsSink,
  createRuntimeMetricsSinkFromEnv,
  type RuntimeMetricsDropReason,
} from './sink.js';

const vectors = JSON.parse(readFileSync(
  new URL('../../contracts/__vectors__/runtime-metric-event.v2.json', import.meta.url),
  'utf8',
)) as { base: TechnicalRuntimeEventV2 };

const BASE_URL = 'https://control.example';
const API_KEY = `gl_${'k'.repeat(40)}`;
const APP_ID = vectors.base.appId;
const ENVIRONMENT_ID = vectors.base.environmentId;
const ENDPOINT = `${BASE_URL}/v1/runtime/apps/${APP_ID}/environments/${ENVIRONMENT_ID}/metrics/events`;

let counter = 0;
function event(patch: Partial<TechnicalRuntimeEventV2> = {}): TechnicalRuntimeEventV2 {
  counter += 1;
  return {
    ...vectors.base,
    eventId: `019fb900-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`,
    ...patch,
  };
}

function recordingFetch(status = 202) {
  const calls: Array<{ url: string; init: RequestInit; body: { schemaVersion: number; events: unknown[] } }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body)) as { schemaVersion: number; events: unknown[] },
    });
    return new Response(null, { status });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, mock: fetch };
}

function sinkWith(
  fetch: typeof globalThis.fetch,
  overrides: Partial<Parameters<typeof createRuntimeMetricsSink>[0]> = {},
) {
  const drops: Array<{ reason: RuntimeMetricsDropReason; count: number }> = [];
  const sink = createRuntimeMetricsSink({
    controlPlaneUrl: BASE_URL,
    apiKey: API_KEY,
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    buildId: 'git:4f2c9e1',
    instanceId: 'web-1',
    fetch,
    onDrop: (drop) => drops.push(drop),
    ...overrides,
  });
  return { sink, drops };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createRuntimeMetricsSink', () => {
  it('posts a v2 batch to the environment metrics endpoint with the runtime key', async () => {
    const http = recordingFetch();
    const { sink } = sinkWith(http.fetch);
    const first = event();
    const second = event({ status: 'aborted' });

    sink.record(first);
    sink.record(second);
    expect(sink.pending).toBe(2);
    await sink.flush();

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe(ENDPOINT);
    expect(http.calls[0]!.init.method).toBe('POST');
    expect(http.calls[0]!.init.headers).toEqual({
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
    });
    expect(http.calls[0]!.body).toEqual({ schemaVersion: 2, events: [first, second] });
    expect(JSON.stringify(http.calls[0]!.body)).not.toContain(API_KEY);
    expect(sink.pending).toBe(0);
    expect(sink.identity).toEqual({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-1',
    });
  });

  it('returns from record at once while the Platform hangs and drops after the timeout', async () => {
    const hanging = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
    const { sink, drops } = sinkWith(hanging as unknown as typeof globalThis.fetch, {
      maxBatchSize: 2,
      requestTimeoutMs: 20,
    });

    for (let index = 0; index < 5; index += 1) sink.record(event());
    // Nothing is sent while the caller (the turn) still runs.
    expect(hanging).not.toHaveBeenCalled();
    expect(sink.pending).toBe(5);

    await sink.flush();
    expect(hanging).toHaveBeenCalledTimes(3);
    expect(drops).toEqual([
      { reason: 'send-failed', count: 2 },
      { reason: 'send-failed', count: 2 },
      { reason: 'send-failed', count: 1 },
    ]);
    expect(sink.pending).toBe(0);
  });

  it('drops a rejected batch without retrying it', async () => {
    const http = recordingFetch(503);
    const { sink, drops } = sinkWith(http.fetch);

    sink.record(event());
    await sink.flush();
    await sink.flush();

    expect(http.calls).toHaveLength(1);
    expect(drops).toEqual([{ reason: 'send-failed', count: 1 }]);
  });

  it('splits large queues into batches of at most 50 events', async () => {
    const http = recordingFetch();
    const { sink } = sinkWith(http.fetch);

    for (let index = 0; index < 120; index += 1) sink.record(event());
    await sink.flush();

    expect(http.calls.map((call) => call.body.events.length)).toEqual([50, 50, 20]);
  });

  it('drops events that break the content boundary or belong to another app', async () => {
    const http = recordingFetch();
    const { sink, drops } = sinkWith(http.fetch);

    sink.record({ ...event(), prompt: 'Zeige meine Aufgaben' } as unknown as TechnicalRuntimeEventV2);
    sink.record(event({ buildId: `sk-or-v1-${'a'.repeat(40)}` }));
    sink.record(event({ appId: '019fb900-0000-7000-8000-0000000000a2' }));
    await sink.flush();

    expect(http.calls).toHaveLength(0);
    expect(drops).toEqual([
      { reason: 'invalid', count: 1 },
      { reason: 'invalid', count: 1 },
      { reason: 'invalid', count: 1 },
    ]);
  });

  it('bounds the queue and drops what does not fit', () => {
    const { sink, drops } = sinkWith(recordingFetch().fetch, { maxQueueSize: 2, maxBatchSize: 10 });

    sink.record(event());
    sink.record(event());
    sink.record(event());

    expect(sink.pending).toBe(2);
    expect(drops).toEqual([{ reason: 'queue-full', count: 1 }]);
  });

  it('flushes on its interval and stops after close', async () => {
    vi.useFakeTimers();
    const http = recordingFetch();
    const { sink, drops } = sinkWith(http.fetch, { flushIntervalMs: 1_000 });

    sink.record(event());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(http.calls).toHaveLength(1);

    sink.record(event());
    await sink.close();
    expect(http.calls).toHaveLength(2);

    sink.record(event());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(http.calls).toHaveLength(2);
    expect(drops).toEqual([{ reason: 'closed', count: 1 }]);
  });

  it('never throws from record, even when the drop callback throws', () => {
    const { sink } = sinkWith(recordingFetch().fetch, {
      onDrop: () => {
        throw new Error('callback failed');
      },
    });

    expect(() => sink.record(null as unknown as TechnicalRuntimeEventV2)).not.toThrow();
  });

  it.each([
    ['a plain-http remote URL', { controlPlaneUrl: 'http://control.example' }],
    ['an app id that is no uuid', { appId: 'app-1' }],
    ['a free-text build id', { buildId: 'my build' }],
    ['a batch above 50 events', { maxBatchSize: 51 }],
  ])('refuses %s at creation', (_label, overrides) => {
    expect(() => sinkWith(recordingFetch().fetch, overrides)).toThrow(RangeError);
  });

  it('names failing option paths, never the key', () => {
    try {
      sinkWith(recordingFetch().fetch, { appId: 'app-1' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain('appId');
      expect(String(error)).not.toContain(API_KEY);
    }
  });
});

describe('createRuntimeMetricsSinkFromEnv', () => {
  const connected = {
    GLIRASTES_CONTROL_PLANE_URL: BASE_URL,
    GLIRASTES_API_KEY: API_KEY,
    GLIRASTES_APP_ID: APP_ID,
    GLIRASTES_ENVIRONMENT_ID: ENVIRONMENT_ID,
  };

  it('stays absent and network-silent in standalone mode', () => {
    const http = recordingFetch();
    expect(createRuntimeMetricsSinkFromEnv({}, { fetch: http.fetch })).toBeUndefined();
    expect(createRuntimeMetricsSinkFromEnv({
      ...connected,
      GLIRASTES_CONTROL_PLANE_URL: ' ',
    }, { fetch: http.fetch })).toBeUndefined();
    expect(http.mock).not.toHaveBeenCalled();
  });

  it.each([
    ['without a key', { GLIRASTES_API_KEY: undefined }],
    ['without an environment', { GLIRASTES_ENVIRONMENT_ID: undefined }],
    ['with an invalid app id', { GLIRASTES_APP_ID: 'app-1' }],
  ])('stays absent %s', (_label, patch) => {
    expect(createRuntimeMetricsSinkFromEnv({ ...connected, ...patch })).toBeUndefined();
  });

  it('reports with the connected identity and an optional build id', () => {
    const sink = createRuntimeMetricsSinkFromEnv({
      ...connected,
      GLIRASTES_BUILD_ID: 'git:4f2c9e1',
    }, { instanceId: 'web-2' });
    expect(sink?.identity).toEqual({
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
      buildId: 'git:4f2c9e1',
      instanceId: 'web-2',
    });
  });

  it('ignores an unusable build id and draws a random instance id', () => {
    const sink = createRuntimeMetricsSinkFromEnv({
      ...connected,
      GLIRASTES_BUILD_ID: 'not a label',
    });
    expect(sink?.identity.buildId).toBeNull();
    expect(sink?.identity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('tool_contract_rejected in the sink', () => {
  const rejection = (suffix: number) => ({
    schemaVersion: 2 as const,
    eventId: `019fb900-0000-7000-8000-0000000003${suffix.toString().padStart(2, '0')}`,
    eventType: 'tool_contract_rejected' as const,
    occurredAt: '2026-10-05T10:16:02.000Z',
    appId: APP_ID,
    environmentId: ENVIRONMENT_ID,
    buildId: 'git:4f2c9e1',
    instanceId: 'web-1',
    revisionId: null,
    toolId: '019fb900-0000-7000-8000-0000000000c1',
    inputSchemaDigest: 'sha256:Hk3m0QZrJ8v2bW6cX9fN1pL4sT7uY0aE5dG8iK2oMqA',
    httpStatus: 422 as const,
  });

  it('sends rejections in their own batch, so a Platform without them keeps the turns', async () => {
    const calls: Array<{ events: Array<{ eventType: string }> }> = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: Array<{ eventType: string }> };
      calls.push(body);
      return new Response(null, { status: body.events[0]!.eventType === 'turn.finished' ? 202 : 400 });
    }) as typeof globalThis.fetch;
    const { sink, drops } = sinkWith(fetch);
    sink.record(event());
    sink.record(rejection(1));
    sink.record(event());
    sink.record(rejection(2));
    expect(sink.pending).toBe(4);
    await sink.flush();
    expect(calls.map((call) => call.events.map((entry) => entry.eventType))).toEqual([
      ['turn.finished', 'turn.finished'],
      ['tool_contract_rejected', 'tool_contract_rejected'],
    ]);
    expect(drops).toEqual([{ reason: 'send-failed', count: 2 }]);
    expect(sink.pending).toBe(0);
  });

  it('drops a rejection that carries content or names another app', () => {
    const { sink, drops } = sinkWith(recordingFetch().fetch);
    sink.record({ ...rejection(3), arguments: { title: 'x' } } as never);
    sink.record({ ...rejection(4), appId: '019fb900-0000-7000-8000-0000000000a9' });
    expect(drops).toEqual([{ reason: 'invalid', count: 1 }, { reason: 'invalid', count: 1 }]);
    expect(sink.pending).toBe(0);
  });

  it('sends turns before rejections even when a rejection was recorded first', async () => {
    const http = recordingFetch();
    const { sink } = sinkWith(http.fetch);
    sink.record(rejection(5));
    sink.record(event());
    await sink.flush();
    expect(http.calls.map((call) => (call.body.events[0] as { eventType: string }).eventType))
      .toEqual(['turn.finished', 'tool_contract_rejected']);
  });

  it('sends a turn recorded while a rejection batch is on the wire before close returns', async () => {
    const eventTypes: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: Array<{ eventType: string }> };
      eventTypes.push(body.events[0]!.eventType);
      if (body.events[0]!.eventType === 'tool_contract_rejected') await gate;
      return new Response(null, { status: 202 });
    }) as typeof globalThis.fetch;
    const { sink } = sinkWith(fetch);
    sink.record(event());
    sink.record(rejection(6));
    const flushing = sink.flush();
    await vi.waitFor(() => expect(eventTypes).toEqual(['turn.finished', 'tool_contract_rejected']));
    sink.record(event());
    const closing = sink.close();
    release();
    await Promise.all([flushing, closing]);
    expect(eventTypes).toEqual(['turn.finished', 'tool_contract_rejected', 'turn.finished']);
    expect(sink.pending).toBe(0);
  });
});
