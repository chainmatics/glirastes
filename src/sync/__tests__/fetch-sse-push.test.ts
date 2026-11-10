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
});
