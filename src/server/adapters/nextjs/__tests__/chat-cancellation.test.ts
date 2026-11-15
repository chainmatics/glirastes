import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

function request(signal: AbortSignal) {
  return new Request('https://app.test/chat', { method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] }),
  });
}

describe('chat cancellation', () => {
  it('exposes the request signal to a custom stream handler', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const handler = createAiChatHandler({ tools: {}, model: {}, systemPrompt: 'Help', streamHandler: async (ctx) => {
      received = ctx.abortSignal; return new Response('ok');
    } });
    await handler(request(controller.signal));
    controller.abort();
    expect(received?.aborted).toBe(true);
  });

  it('aborts the default model stream when the HTTP request is cancelled', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let modelSignal: AbortSignal | undefined;
    const model = new MockLanguageModelV3({ doStream: async (options) => {
      modelSignal = options.abortSignal;
      return { stream: new ReadableStream({ start(stream) {
        stream.enqueue({ type: 'stream-start', warnings: [] });
        modelSignal!.addEventListener('abort', () => stream.error(modelSignal!.reason), { once: true });
        started();
      } }) };
    } });
    const handler = createAiChatHandler({ tools: {}, model, systemPrompt: 'Help' });
    const response = await handler(request(controller.signal));
    const consumed = response.text();
    await ready;
    controller.abort();
    await consumed;
    expect(modelSignal?.aborted).toBe(true);
  });
});
