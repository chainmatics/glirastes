import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createAiChatHandler } from '../create-ai-chat-handler.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function chatModel() {
  const calls: Array<Record<string, unknown>> = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      calls.push(options as never);
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Okay.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ] as never),
      };
    },
  });
  return { model, calls };
}

function summaryModel() {
  const calls: Array<Record<string, unknown>> = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options as never);
      return { content: [{ type: 'text', text: 'Summary.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] } as never;
    },
  });
  return { model, calls };
}

const user = (id: string, text: string) => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const assistant = (id: string, text: string) => ({ id, role: 'assistant', parts: [{ type: 'text', text }] });

const request = (messages: unknown[], signal?: AbortSignal) => new Request('https://app.example/api/chat', {
  method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }),
});

const conversation = [
  user('u1', 'We plan the Q3 launch, the codename is Heron.'),
  assistant('a1', 'Noted, the launch is called Heron.'),
  user('u2', 'Create a task for the landing page.'),
  assistant('a2', 'Done, the task Landing page exists.'),
  user('u3', 'What was the codename again?'),
];

describe('temperature option', () => {
  it('default temperature stays 0.2', async () => {
    const chat = chatModel();
    const handler = createAiChatHandler({ tools: {}, model: chat.model, systemPrompt: 'Help' });
    await (await handler(request([user('u', 'Hi')]))).text();
    expect(chat.calls[0]!.temperature).toBe(0.2);
  });

  it('an explicit number is sent', async () => {
    const chat = chatModel();
    const handler = createAiChatHandler({ tools: {}, model: chat.model, systemPrompt: 'Help', temperature: 0.7 });
    await (await handler(request([user('u', 'Hi')]))).text();
    expect(chat.calls[0]!.temperature).toBe(0.7);
  });

  it('temperature null sends no temperature to the model', async () => {
    const chat = chatModel();
    const handler = createAiChatHandler({ tools: {}, model: chat.model, systemPrompt: 'Help', temperature: null });
    await (await handler(request([user('u', 'Hi')]))).text();
    expect(chat.calls.length).toBeGreaterThan(0);
    for (const call of chat.calls) expect('temperature' in call && call.temperature !== undefined).toBe(false);
  });

  it('a custom streamHandler gets ctx.temperature undefined for null and the number otherwise', async () => {
    const seen: Array<number | undefined> = [];
    const streamHandler = async (ctx: { temperature?: number }) => { seen.push(ctx.temperature); return new Response('ok'); };
    const chat = chatModel();
    await (await createAiChatHandler({ tools: {}, model: chat.model, systemPrompt: 'Help', temperature: null, streamHandler })(request([user('u', 'Hi')]))).text();
    await (await createAiChatHandler({ tools: {}, model: chat.model, systemPrompt: 'Help', temperature: 0.4, streamHandler })(request([user('u', 'Hi')]))).text();
    expect(seen).toEqual([undefined, 0.4]);
  });

  it('memory extraction omits temperature when the handler sets null', async () => {
    const chat = chatModel();
    const summary = summaryModel();
    const handler = createAiChatHandler({
      tools: {}, model: chat.model, systemPrompt: 'Help', temperature: null,
      memory: { model: summary.model, chat: { autoCompact: 20 } },
    });
    await (await handler(request(conversation))).text();
    expect(summary.calls.length).toBeGreaterThan(0);
    for (const call of summary.calls) expect(call.temperature).toBeUndefined();
  });

  it('memory extraction keeps temperature 0 for a numeric handler setting', async () => {
    const chat = chatModel();
    const summary = summaryModel();
    const handler = createAiChatHandler({
      tools: {}, model: chat.model, systemPrompt: 'Help',
      memory: { model: summary.model, chat: { autoCompact: 20 } },
    });
    await (await handler(request(conversation))).text();
    expect(summary.calls[0]!.temperature).toBe(0);
  });

  it('aborting the request aborts the model call', async () => {
    const controller = new AbortController();
    let modelSignal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const model = new MockLanguageModelV3({ doStream: async (options) => {
      modelSignal = options.abortSignal;
      return { stream: new ReadableStream({ start(stream) {
        stream.enqueue({ type: 'stream-start', warnings: [] });
        modelSignal!.addEventListener('abort', () => stream.error(modelSignal!.reason), { once: true });
        started();
      } }) };
    } });
    const handler = createAiChatHandler({ tools: {}, model, systemPrompt: 'Help' });
    const consumed = (await handler(request([user('u', 'Hi')], controller.signal))).text();
    await ready;
    controller.abort();
    await consumed;
    expect(modelSignal?.aborted).toBe(true);
  });
});
