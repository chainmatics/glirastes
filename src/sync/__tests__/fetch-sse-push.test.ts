import { describe, expect, it, vi } from 'vitest';
import { FetchSsePushConnector } from '../fetch-sse-push.js';

describe('FetchSsePushConnector', () => {
  it('triggers sync for each complete SSE data event', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"runtime.deployment.pending"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"runtime.security.revoked"}\n\n'));
        controller.close();
      },
    });
    const connector = new FetchSsePushConnector(
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );
    const onEvent = vi.fn().mockResolvedValue(undefined);
    await connector.connect({
      url: 'https://control.example.test/stream',
      headers: { authorization: 'Bearer runtime-key' },
      signal: new AbortController().signal,
      onEvent,
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('ignores data-less keep-alives and reports the open connection', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('\nevent: keep-alive\nid: 1\n\n: comment\n\n'));
        controller.close();
      },
    });
    const connector = new FetchSsePushConnector(
      vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    );
    const onEvent = vi.fn();
    const onOpen = vi.fn();
    await connector.connect({
      url: 'https://control.example.test/stream',
      headers: {},
      signal: new AbortController().signal,
      onEvent,
      onOpen,
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('fails a stream that stays silent past the idle timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200 },
      ));
      const connector = new FetchSsePushConnector(fetchImpl as never, { idleTimeoutMs: 90_000 });
      const outcome = connector.connect({
        url: 'https://control.example.test/stream',
        headers: {},
        signal: new AbortController().signal,
        onEvent: vi.fn(),
      }).then(() => 'ended', (error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(89_999);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatch(/stalled/);
    } finally {
      vi.useRealTimers();
    }
  });
});
