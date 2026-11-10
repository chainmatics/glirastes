import type { RuntimePushConnector } from './control-plane-client.js';

export class FetchSsePushConnector implements RuntimePushConnector {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async connect(options: Parameters<RuntimePushConnector['connect']>[0]): Promise<void> {
    const response = await this.fetchImpl(options.url, {
      headers: {
        accept: 'text/event-stream',
        ...options.headers,
      },
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Runtime push stream failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!options.signal.aborted) {
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
  }
}
