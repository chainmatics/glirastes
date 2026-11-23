// @vitest-environment jsdom
// CHARACTERISATION of the installed AI SDK `Chat`: when it asks `sendAutomaticallyWhen`. The Vercel transport's
// mark for a request cleared with clear() relies on it: asked at most once at the end of a request (only when the
// request did not fail or abort), right after `onFinish` in the same synchronous step, never while a request runs;
// `onFinish` ends every request; a new request always goes through `prepareSendMessagesRequest`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { stubControlledFetch, textChunks, type ControlledRequest } from './controlled-fetch.js';

let requests: ControlledRequest[];
beforeEach(() => {
  ({ requests } = stubControlledFetch({ deliverInFlightAfterAbort: true }));
});
afterEach(() => {
  for (const request of requests) request.close();
  vi.unstubAllGlobals();
});

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean) => {
  for (let index = 0; index < 100 && !check(); index += 1) await tick(5);
  expect(check()).toBe(true);
};

/** A Chat whose `sendAutomaticallyWhen` and `prepareSendMessagesRequest` calls are recorded. */
function recordedChat(answer: (messages: UIMessage[]) => boolean = () => false) {
  const asked: Array<{ status: string }> = [];
  const prepared: number[] = [];
  const chat: Chat<UIMessage> = new Chat<UIMessage>({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      prepareSendMessagesRequest: ({ body, id, messages }) => {
        prepared.push(messages.length);
        return { body: { ...body, id, messages } };
      },
    }),
    sendAutomaticallyWhen: ({ messages }) => {
      asked.push({ status: chat.status });
      return answer(messages as UIMessage[]);
    },
  });
  return { chat, asked, prepared };
}

function endText(request: ControlledRequest, text = 'done') {
  request.push({ type: 'text-delta', id: 't', delta: text });
  request.push({ type: 'text-end', id: 't' });
  request.push({ type: 'finish-step' });
  request.push({ type: 'finish' });
  request.end();
}

describe('the AI SDK asks sendAutomaticallyWhen', () => {
  it('once at the end of a request that finished normally, after the status is ready', async () => {
    const { chat, asked, prepared } = recordedChat();
    void chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 1);
    expect(prepared).toEqual([1]);
    for (const chunk of textChunks('a')) requests[0]!.push(chunk);
    await tick();
    expect(asked).toEqual([]);
    endText(requests[0]!);
    await until(() => chat.status === 'ready');
    await tick();
    expect(asked).toEqual([{ status: 'ready' }]);
  });

  it('once for a request with several steps', async () => {
    const { chat, asked } = recordedChat();
    void chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 1);
    const request = requests[0]!;
    request.push({ type: 'start' });
    for (const step of ['one', 'two', 'three']) {
      request.push({ type: 'start-step' });
      request.push({ type: 'text-start', id: step });
      request.push({ type: 'text-delta', id: step, delta: step });
      request.push({ type: 'text-end', id: step });
      request.push({ type: 'finish-step' });
    }
    request.push({ type: 'finish' });
    request.end();
    await until(() => chat.status === 'ready');
    await tick();
    expect(asked).toHaveLength(1);
  });

  it('never on the abort path (stop() while the request streams)', async () => {
    const { chat, asked } = recordedChat(() => true);
    void chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 1);
    for (const chunk of textChunks('a')) requests[0]!.push(chunk);
    await until(() => chat.status === 'streaming');
    void chat.stop();
    await until(() => chat.status === 'ready');
    await tick(50);
    expect(requests[0]!.aborted).toBe(true);
    expect(asked).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('never on the abort path before the first chunk (stop() while submitted)', async () => {
    const { chat, asked } = recordedChat(() => true);
    void chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 1);
    void chat.stop();
    await until(() => chat.status === 'ready');
    await tick(50);
    expect(asked).toEqual([]);
  });

  it('once when stop() comes after the stream ended but before the status flipped (the request counts as finished)', async () => {
    const { chat, asked } = recordedChat();
    void chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 1);
    for (const chunk of textChunks('a')) requests[0]!.push(chunk);
    await until(() => chat.status === 'streaming');
    endText(requests[0]!);
    void chat.stop();
    await until(() => chat.status === 'ready');
    await tick(50);
    // The stream had ended: the request counts as finished although its signal fired, and the AI SDK asks once.
    expect(asked).toHaveLength(1);
  });

  it('never on the error path (the stream fails)', async () => {
    const { chat, asked } = recordedChat(() => true);
    void chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 1);
    for (const chunk of textChunks('a')) requests[0]!.push(chunk);
    requests[0]!.pushRaw('data: {"type":"error","errorText":"boom"}\n\n');
    requests[0]!.end();
    await until(() => chat.status === 'error');
    await tick(50);
    expect(asked).toEqual([]);
  });

  it('once per request of a continuation chain, each new request through prepareSendMessagesRequest', async () => {
    let answers = 0;
    const { chat, asked, prepared } = recordedChat(() => { answers += 1; return answers === 1; });
    void chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 1);
    for (const chunk of textChunks('a')) requests[0]!.push(chunk);
    endText(requests[0]!);
    // The first answer is true: the AI SDK sends the history again by itself.
    await until(() => requests.length === 2);
    expect(prepared).toHaveLength(2);
    for (const chunk of textChunks('b')) requests[1]!.push(chunk);
    endText(requests[1]!);
    await until(() => chat.status === 'ready');
    await tick(50);
    expect(asked).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });

  it('when idle, also on a written tool output or approval answer (not tied to a request)', async () => {
    const { chat, asked } = recordedChat();
    chat.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'delete' }] },
      {
        id: 'a1', role: 'assistant', parts: [
          { type: 'step-start' },
          { type: 'tool-tasks_delete', toolCallId: 'c1', state: 'approval-requested', input: {}, approval: { id: 'ap-1' } },
        ],
      },
    ] as unknown as UIMessage[];
    await chat.addToolApprovalResponse({ id: 'ap-1', approved: true });
    await tick();
    expect(asked).toEqual([{ status: 'ready' }]);
  });

  it('a request whose signal is already aborted when its fetch starts ends on the abort path', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const asked: number[] = [];
    const chat: Chat<UIMessage> = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: '/api/chat',
        // Headers that take time (a token fetch): the request is submitted, its fetch has not started.
        headers: async () => { await gate; return {}; },
      }),
      sendAutomaticallyWhen: () => { asked.push(1); return true; },
    });
    void chat.sendMessage({ text: 'hi' });
    await tick();
    expect(chat.status).toBe('submitted');
    void chat.stop();
    release();
    await until(() => chat.status === 'ready');
    await tick(50);
    expect(requests).toHaveLength(0);
    expect(asked).toEqual([]);
  });
});

describe('onFinish and the ask, in order', () => {
  /** Records `finish`, `ask`, and a microtask queued in onFinish, in the order they happen. */
  function orderedChat() {
    const order: string[] = [];
    const chat: Chat<UIMessage> = new Chat<UIMessage>({
      transport: new DefaultChatTransport({ api: '/api/chat' }),
      onFinish: () => {
        order.push('finish');
        queueMicrotask(() => order.push('microtask'));
      },
      sendAutomaticallyWhen: () => { order.push('ask'); return false; },
    });
    return { chat, order };
  }

  it('a normal end: onFinish, then the ask in the same synchronous step, then the microtask', async () => {
    const { chat, order } = orderedChat();
    void chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 1);
    for (const chunk of textChunks('a')) requests[0]!.push(chunk);
    endText(requests[0]!);
    await until(() => chat.status === 'ready');
    await tick();
    expect(order).toEqual(['finish', 'ask', 'microtask']);
  });

  it('stop() after the stream ended (abort flag, normal end): the same order', async () => {
    const { chat, order } = orderedChat();
    void chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 1);
    for (const chunk of textChunks('a')) requests[0]!.push(chunk);
    await until(() => chat.status === 'streaming');
    endText(requests[0]!);
    void chat.stop();
    await until(() => chat.status === 'ready');
    await tick();
    expect(order).toEqual(['finish', 'ask', 'microtask']);
  });

  it('an abort or an error: onFinish, no ask', async () => {
    const aborted = orderedChat();
    void aborted.chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 1);
    for (const chunk of textChunks('a')) requests[0]!.push(chunk);
    await until(() => aborted.chat.status === 'streaming');
    void aborted.chat.stop();
    await until(() => aborted.chat.status === 'ready');
    await tick(50);
    expect(aborted.order).toEqual(['finish', 'microtask']);

    const failed = orderedChat();
    void failed.chat.sendMessage({ text: 'hi' });
    await until(() => requests.length === 2);
    requests[1]!.pushRaw('data: {"type":"error","errorText":"boom"}\n\n');
    requests[1]!.end();
    await until(() => failed.chat.status === 'error');
    await tick(50);
    expect(failed.order).toEqual(['finish', 'microtask']);
  });
});
