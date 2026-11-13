import type { RuntimePushConnector } from './control-plane-client.js';

// The platform sends a keep-alive every 25 s; silence beyond this means a dead connection.
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

export class FetchSsePushConnector implements RuntimePushConnector {
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    options: { idleTimeoutMs?: number } = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async connect(options: Parameters<RuntimePushConnector['connect']>[0]): Promise<void> {
    const connection = new AbortController();
    const stop = () => connection.abort(options.signal.reason);
    if (options.signal.aborted) stop();
    options.signal.addEventListener('abort', stop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => connection.abort(new Error('Runtime push stream stalled')),
        this.idleTimeoutMs,
      );
    };

    try {
      armIdle();
      const response = await this.fetchImpl(options.url, {
        headers: {
          accept: 'text/event-stream',
          ...options.headers,
        },
        signal: connection.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Runtime push stream failed (${response.status})`);
      }
      await options.onOpen?.();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!options.signal.aborted) {
          armIdle();
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let separator = buffer.indexOf('\n\n');
          while (separator >= 0) {
            const event = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            if (event.split('\n').some((line) => line.startsWith('data:'))) {
              await options.onEvent();
            }
            separator = buffer.indexOf('\n\n');
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (!options.signal.aborted && connection.signal.aborted) throw connection.signal.reason;
      throw error;
    } finally {
      clearTimeout(idle);
      options.signal.removeEventListener('abort', stop);
    }
  }
}
