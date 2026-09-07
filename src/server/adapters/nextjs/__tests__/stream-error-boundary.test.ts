import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

describe.each(['throw', 'stream-error'])(
  'default stream provider error boundary (%s)', (failureMode) => {
  it.each([true, false])(
    'does not log provider content with an error callback: %s',
    async (withCallback) => {
      const providerError = new Error('private-provider-response-marker');
      const onError = vi.fn();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const request = new Request('http://localhost/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{
          id: 'stream-error-test', role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        }] }),
      });
      try {
        const handler = createAiChatHandler({
          tools: {}, systemPrompt: 'Assistant',
          model: new MockLanguageModelV3({
            doStream: async () => {
              if (failureMode === 'throw') throw providerError;
              return { stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: 'error', error: providerError });
                  controller.close();
                },
              }) };
            },
          }),
          ...(withCallback ? { onError } : {}),
        });
        const response = await handler(request);
        const body = await response.text();
        expect(body).toContain('"type":"error"');
        expect(body.match(/"type":"error"/g)).toHaveLength(1);
        expect(body).toContain('"status":"error"');
        expect(body).not.toContain('private-provider-response-marker');
        expect(consoleError).not.toHaveBeenCalled();
        if (withCallback) {
          expect(onError).toHaveBeenCalledExactlyOnceWith(providerError, request);
        }
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});
