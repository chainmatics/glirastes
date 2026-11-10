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
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain('private-provider-response-marker');
        if (withCallback) {
          expect(onError).toHaveBeenCalledExactlyOnceWith(providerError, request);
          expect(consoleError).not.toHaveBeenCalled();
        }
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});

describe('a turn that fails before the model answers', () => {
  const request = () => new Request('http://localhost/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] }),
  });
  // An incompatible model object, as an AI SDK major version the SDK does not support produces.
  const incompatibleModel = { specificationVersion: 'v9', provider: 'x', modelId: 'y' };

  it('hands the cause to onError instead of only answering "AI request failed"', async () => {
    const onError = vi.fn();
    const req = request();
    const handler = createAiChatHandler({ tools: {}, systemPrompt: 'Assistant', model: incompatibleModel as never, onError });
    const body = await (await handler(req)).text();
    expect(body).toContain('AI request failed');
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][1]).toBe(req);
  });

  it('tells a developer without onError where to look, without error content', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const handler = createAiChatHandler({ tools: {}, systemPrompt: 'Assistant', model: incompatibleModel as never });
      await (await handler(request())).text();
      expect(consoleError).toHaveBeenCalledOnce();
      expect(String(consoleError.mock.calls[0][0])).toMatch(/\[glirastes\] AI chat turn failed .*onError/);
    } finally {
      consoleError.mockRestore();
    }
  });
});
