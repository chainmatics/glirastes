// @vitest-environment jsdom

import React, { useEffect, useReducer } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { MessageList } from '../components/message-list.js';
import { useChatContext, type ChatContextValue } from '../provider/chat-context.js';
import { createLocalSessionStore } from '../utils/local-session-store.js';
import type {
  AiChatProviderConfig,
  ChatMessage,
  ChatTransport,
  ChatTransportDataHandler,
  SessionConfig,
} from '../types.js';

afterEach(cleanup);

/**
 * A transport that behaves like the AI SDK's `useChat` on a stop: the assistant
 * message streamed so far stays in the history; `stop()` only ends the request.
 */
class StreamingChat {
  messages: ChatMessage[] = [];
  status: ChatTransport['status'] = 'ready';
  sent: string[] = [];
  private listeners = new Set<() => void>();
  private dataHandlers = new Set<ChatTransportDataHandler>();
  private pending: Array<() => void> = [];
  private counter = 0;
  private streamingId: string | null = null;

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  sendMessage = vi.fn(({ text }: { text: string }) => {
    this.sent.push(text);
    this.counter += 1;
    this.messages = [...this.messages, { id: `u${this.counter}`, role: 'user', parts: [{ type: 'text', text }] }];
    this.status = 'submitted';
    this.streamingId = null;
    this.notify();
    return new Promise<void>((resolve) => { this.pending.push(resolve); });
  });

  /** The assistant message of the running request, as streamed so far. */
  stream(parts: unknown[]) {
    if (!this.streamingId) {
      this.counter += 1;
      this.streamingId = `a${this.counter}`;
      this.messages = [...this.messages, { id: this.streamingId, role: 'assistant', parts: parts as ChatMessage['parts'] }];
    } else {
      const id = this.streamingId;
      this.messages = this.messages.map((message) => (
        message.id === id ? { ...message, parts: parts as ChatMessage['parts'] } : message
      ));
    }
    this.status = 'streaming';
    this.notify();
  }

  stop = vi.fn(() => {
    this.status = 'ready';
    this.streamingId = null;
    this.settle();
    this.notify();
  });

  finish(parts: unknown[] = [{ type: 'text', text: 'done' }]) {
    this.stream(parts);
    this.status = 'ready';
    this.streamingId = null;
    this.settle();
    this.notify();
  }

  setMessages = vi.fn((messages: ChatMessage[]) => {
    this.messages = messages;
    this.notify();
  });

  addToolApprovalResponse = vi.fn(async () => {});

  subscribeToData = (handler: ChatTransportDataHandler) => {
    this.dataHandlers.add(handler);
    return () => { this.dataHandlers.delete(handler); };
  };

  private settle() {
    const pending = this.pending;
    this.pending = [];
    for (const resolve of pending) resolve();
  }

  get transport(): ChatTransport {
    return {
      messages: this.messages,
      status: this.status,
      error: null,
      sendMessage: this.sendMessage,
      stop: this.stop,
      setMessages: this.setMessages,
      addToolApprovalResponse: this.addToolApprovalResponse,
      subscribeToData: this.subscribeToData,
    };
  }
}

let ctx: ChatContextValue;
function Probe() {
  ctx = useChatContext();
  return null;
}

function Host({ chat, config }: { chat: StreamingChat; config?: Partial<AiChatProviderConfig> }) {
  const [, force] = useReducer((count: number) => count + 1, 0);
  useEffect(() => chat.subscribe(force), [chat]);
  return (
    <AiChatProvider transport={chat.transport} {...config}>
      <Probe />
      <MessageList />
    </AiChatProvider>
  );
}

interface RenderedTurn {
  text: string;
  steps: string[];
  notice: string | null;
}

/** What every assistant bubble shows: its text, the status of each logged step, and a stop notice. */
function renderedTurns(): RenderedTurn[] {
  return [...document.querySelectorAll('[data-component="message-bubble"][data-role="assistant"]')].map((bubble) => {
    const notice = bubble.querySelector('[data-element="activity-notice"], [data-component="turn-notice"]');
    return {
      text: [...bubble.querySelectorAll('[data-component="markdown"]')].map((node) => node.textContent ?? '').join(''),
      steps: [...bubble.querySelectorAll('[data-element="activity-step"]')].map((step) => step.getAttribute('data-status') ?? ''),
      notice: notice?.textContent ?? null,
    };
  });
}

const STOPPED = 'Stopped';
const stepStart = { type: 'step-start' };
const text = (value: string) => ({ type: 'text', text: value, state: 'streaming' });
const runningTool = (id: string) => ({ type: 'tool-tasks_list', toolCallId: id, state: 'input-available', input: {} });

type Mode = 'queue' | 'manual';
const queueOn: Partial<AiChatProviderConfig> = { queue: { enabled: true } };

/** Sends the next message: from the queue (queued while running, resumed after the stop) or by hand after the stop. */
async function stopThenNext(chat: StreamingChat, mode: Mode, next: string) {
  if (mode === 'queue') {
    await act(async () => { ctx.submit(next); });
    await act(async () => { ctx.stop(); });
    // The user's stop pauses the queue; resuming sends what waits.
    await act(async () => { ctx.resumeQueue(); });
  } else {
    await act(async () => { ctx.stop(); });
    await act(async () => { ctx.send(next); });
  }
  await waitFor(() => expect(chat.sent.at(-1)).toBe(next));
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

/** The stored conversation has loaded: a send is not refused. */
async function ready() {
  await waitFor(() => expect(ctx.canCompose).toBe(true));
}

async function reload(store: SessionConfig, config: Partial<AiChatProviderConfig>, view: { unmount(): void }) {
  view.unmount();
  const chat = new StreamingChat();
  render(<Host chat={chat} config={{ ...config, session: store }} />);
  await waitFor(() => expect(document.querySelectorAll('[data-component="message-bubble"]').length).toBeGreaterThan(0));
  return chat;
}

describe.each<Mode>(['queue', 'manual'])('a stopped turn keeps its output after later turns (%s)', (mode) => {
  const base = mode === 'queue' ? queueOn : {};

  it('a: stopped mid-answer, then a completed turn', async () => {
    const store = createLocalSessionStore({ storageKey: `stop-a-${mode}`, storage: memoryStorage(), attachmentStore: null });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ ...base, session: store }} />);
    await ready();
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, text('Partial answer')]));
    await stopThenNext(chat, mode, 'two');
    act(() => chat.finish([stepStart, { type: 'text', text: 'Full answer' }]));
    await waitFor(() => expect(renderedTurns()).toHaveLength(2));
    expect(renderedTurns()).toEqual([
      { text: 'Partial answer', steps: [], notice: null },
      { text: 'Full answer', steps: [], notice: null },
    ]);
    await reload(store, base, view);
    expect(renderedTurns().map((turn) => turn.text)).toEqual(['Partial answer', 'Full answer']);
  });

  it('b: stopped before the first token (no assistant message yet), then a completed turn', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={base} />);
    await act(async () => { ctx.send('one'); });
    if (mode === 'queue') await act(async () => { ctx.submit('two'); });
    await act(async () => { ctx.stop(); });
    // No assistant message: the notice has nothing to attach to and is not rendered (known open wish).
    expect(renderedTurns()).toEqual([]);
    expect(ctx.pipelineState?.status).toBe('aborted');
    if (mode === 'queue') await act(async () => { ctx.resumeQueue(); });
    else await act(async () => { ctx.send('two'); });
    await waitFor(() => expect(chat.sent).toEqual(['one', 'two']));
    act(() => chat.finish());
    expect(renderedTurns()).toEqual([{ text: 'done', steps: [], notice: null }]);
  });

  it('b: stopped after the step started but before a token, then a completed turn', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={base} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart]));
    await stopThenNext(chat, mode, 'two');
    act(() => chat.finish());
    // The empty stopped turn had only its notice, which belongs to the latest turn.
    expect(renderedTurns()).toEqual([{ text: 'done', steps: [], notice: null }]);
  });

  it('b: an empty stopped turn shows its notice while it is the latest', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={base} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart]));
    await act(async () => { ctx.stop(); });
    expect(renderedTurns()).toEqual([{ text: '', steps: [], notice: STOPPED }]);
  });

  it('c: stopped during a running tool step, then a completed turn', async () => {
    const store = createLocalSessionStore({ storageKey: `stop-c-${mode}`, storage: memoryStorage(), attachmentStore: null });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ ...base, session: store }} />);
    await ready();
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, runningTool('call-1')]));
    if (mode === 'queue') await act(async () => { ctx.submit('two'); });
    await act(async () => { ctx.stop(); });
    // The latest stopped turn: its step reads stopped, with the notice in the log.
    expect(renderedTurns()).toEqual([{ text: '', steps: ['aborted'], notice: STOPPED }]);
    if (mode === 'queue') await act(async () => { ctx.resumeQueue(); });
    else await act(async () => { ctx.send('two'); });
    await waitFor(() => expect(chat.sent).toEqual(['one', 'two']));
    act(() => chat.finish());
    // The stopped turn's log stays, its step still stopped.
    expect(renderedTurns()).toEqual([
      { text: '', steps: ['aborted'], notice: null },
      { text: 'done', steps: [], notice: null },
    ]);
    await reload(store, base, view);
    expect(renderedTurns()).toEqual([
      { text: '', steps: ['aborted'], notice: null },
      { text: 'done', steps: [], notice: null },
    ]);
  });

  it('e: two stopped turns in a row (text, then a tool step), then a completed one', async () => {
    const store = createLocalSessionStore({ storageKey: `stop-e-${mode}`, storage: memoryStorage(), attachmentStore: null });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ ...base, session: store }} />);
    await ready();
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, text('First partial')]));
    await stopThenNext(chat, mode, 'two');
    act(() => chat.stream([stepStart, runningTool('call-2')]));
    await stopThenNext(chat, mode, 'three');
    act(() => chat.finish());
    expect(renderedTurns()).toEqual([
      { text: 'First partial', steps: [], notice: null },
      { text: '', steps: ['aborted'], notice: null },
      { text: 'done', steps: [], notice: null },
    ]);
    await reload(store, base, view);
    expect(renderedTurns()).toEqual([
      { text: 'First partial', steps: [], notice: null },
      { text: '', steps: ['aborted'], notice: null },
      { text: 'done', steps: [], notice: null },
    ]);
  });
});

describe("d: sendNow with sendNowBehavior 'abort'", () => {
  it.each([
    ['mid-answer', [stepStart, text('Partial answer')], { text: 'Partial answer', steps: [] as string[], notice: null }],
    ['during a tool step', [stepStart, runningTool('call-1')], { text: '', steps: ['aborted'], notice: null }],
  ])('keeps the turn it stopped (%s)', async (_name, parts, expected) => {
    const store = createLocalSessionStore({ storageKey: `stop-d-${_name}`, storage: memoryStorage(), attachmentStore: null });
    const config: Partial<AiChatProviderConfig> = { queue: { enabled: true, sendNowBehavior: 'abort' } };
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ ...config, session: store }} />);
    await ready();
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream(parts));
    await act(async () => { ctx.submit('two'); });
    await act(async () => { ctx.sendNow(ctx.queue.items[0]!.id); });
    await waitFor(() => expect(chat.sent).toEqual(['one', 'two']));
    expect(chat.stop).toHaveBeenCalledTimes(1);
    act(() => chat.finish());
    expect(renderedTurns()).toEqual([expected, { text: 'done', steps: [], notice: null }]);
    await reload(store, config, view);
    expect(renderedTurns()).toEqual([expected, { text: 'done', steps: [], notice: null }]);
  });
});

describe.each([
  ['log', 'message'],
  ['message', 'message'],
  ['log', 'sections'],
  ['message', 'sections'],
] as const)('the stop notice (noticePlacement %s, grouping %s)', (noticePlacement, grouping) => {
  it('shows on the latest stopped turn and goes with the next turn, with and without the queue', async () => {
    for (const config of [queueOn, {}]) {
      const chat = new StreamingChat();
      const view = render(<Host chat={chat} config={{ ...config, activityLog: { noticePlacement, grouping } }} />);
      await act(async () => { ctx.send('one'); });
      act(() => chat.stream([stepStart, text('Looking'), runningTool('call-1')]));
      await act(async () => { ctx.stop(); });
      expect(renderedTurns()).toEqual([{ text: 'Looking', steps: ['aborted'], notice: STOPPED }]);
      await act(async () => { ctx.send('two'); });
      await waitFor(() => expect(chat.sent).toEqual(['one', 'two']));
      act(() => chat.finish());
      // The notice is the latest turn's (provider `pipelineState`); the stopped step keeps its status.
      expect(renderedTurns()).toEqual([
        { text: 'Looking', steps: ['aborted'], notice: null },
        { text: 'done', steps: [], notice: null },
      ]);
      view.unmount();
    }
  });
});

describe('a turn with only tool steps and no text', () => {
  it('stays in the history when the next message is sent (a failed step)', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.finish([stepStart, {
      type: 'tool-tasks_list', toolCallId: 'call-1', state: 'output-error', input: {}, errorText: 'boom',
    }]));
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    expect(renderedTurns()).toEqual([
      { text: '', steps: ['error'], notice: null },
      { text: 'done', steps: [], notice: null },
    ]);
  });
});
