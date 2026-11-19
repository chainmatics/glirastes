// @vitest-environment jsdom

import React, { StrictMode, useEffect, useReducer } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { AiChatPanel } from '../components/ai-chat-panel.js';
import { ChatInput } from '../components/chat-input.js';
import { ChatQueue, useChatQueue } from '../components/chat-queue.js';
import { MentionInput } from '../components/mention-input.js';
import { UiActionBus } from '../../browser/ui-action-bus.js';
import { useChatContext, type ChatContextValue } from '../provider/chat-context.js';
import type {
  AiChatProviderConfig,
  ChatMessage,
  ChatQueueChangeEvent,
  ChatQueueStorage,
  ChatTransport,
  ChatTransportDataHandler,
  FilePart,
  QueuedMessage,
} from '../types.js';

afterEach(cleanup);

/** A transport that behaves like the AI SDK's: a send streams until the test finishes it. */
class FakeChat {
  messages: ChatMessage[] = [];
  status: ChatTransport['status'] = 'ready';
  error: Error | null = null;
  sent: Array<{ text: string; files?: FilePart[] }> = [];
  approvals: Array<{ id: string; approved: boolean }> = [];
  /** Continue by itself after an answered approval (AI SDK `sendAutomaticallyWhen`). */
  autoResume = false;
  private listeners = new Set<() => void>();
  private dataHandlers = new Set<ChatTransportDataHandler>();
  private pending: Array<() => void> = [];
  private counter = 0;

  constructor(messages: ChatMessage[] = []) {
    this.messages = messages;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  sendMessage = vi.fn(({ text, files }: { text: string; files?: FilePart[] }) => {
    this.sent.push(files ? { text, files } : { text });
    this.counter += 1;
    this.messages = [...this.messages, { id: `u${this.counter}`, role: 'user', parts: [{ type: 'text', text }] }];
    this.status = 'streaming';
    this.error = null;
    this.notify();
    return new Promise<void>((resolve) => { this.pending.push(resolve); });
  });

  stop = vi.fn(() => {
    this.status = 'ready';
    this.settle();
    this.notify();
  });

  setMessages = vi.fn((messages: ChatMessage[]) => {
    this.messages = messages;
    this.notify();
  });

  addToolApprovalResponse = vi.fn(async ({ id, approved }: { id: string; approved: boolean }) => {
    this.approvals.push({ id, approved });
    this.messages = this.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        const record = part as unknown as { approval?: { id: string } };
        return record.approval?.id === id
          ? { ...part, state: 'approval-responded', approval: { id, approved } } as never
          : part;
      }),
    }));
    if (this.autoResume) this.status = 'streaming';
    this.notify();
  });

  subscribeToData = (handler: ChatTransportDataHandler) => {
    this.dataHandlers.add(handler);
    return () => { this.dataHandlers.delete(handler); };
  };

  emit(part: { type: string; data: unknown }) {
    for (const handler of this.dataHandlers) handler(part);
  }

  private settle() {
    const pending = this.pending;
    this.pending = [];
    for (const resolve of pending) resolve();
  }

  /** Ends the running request with an assistant answer (or other parts). */
  finish(options: { parts?: unknown[]; status?: ChatTransport['status']; error?: Error } = {}) {
    this.counter += 1;
    this.messages = [...this.messages, {
      id: `a${this.counter}`,
      role: 'assistant',
      parts: (options.parts ?? [{ type: 'text', text: 'ok' }]) as ChatMessage['parts'],
    }];
    this.status = options.status ?? 'ready';
    this.error = options.error ?? null;
    this.settle();
    this.notify();
  }

  get transport(): ChatTransport {
    return {
      messages: this.messages,
      status: this.status,
      error: this.error,
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

function Host({ chat, config, children }: {
  chat: FakeChat;
  config?: Partial<AiChatProviderConfig>;
  children?: React.ReactNode;
}) {
  const [, force] = useReducer((count: number) => count + 1, 0);
  useEffect(() => chat.subscribe(force), [chat]);
  return (
    <AiChatProvider transport={chat.transport} {...config}>
      <Probe />
      {children}
    </AiChatProvider>
  );
}

const texts = (chat: FakeChat) => chat.sent.map((entry) => entry.text);
const queuedTexts = () => ctx.queue.items.map((item) => item.text);

const approvalParts = (id = 'approval-1') => [{
  type: 'tool-tasks_delete', toolCallId: `call-${id}`, state: 'approval-requested',
  input: { id: 't1' }, approval: { id },
}];

async function startRun(chat: FakeChat, text = 'first') {
  await act(async () => { ctx.send(text); });
  expect(chat.status).toBe('streaming');
}

describe('chat queue disabled (default)', () => {
  it('behaves as before: send while loading goes to the transport, approval open refuses', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat}><ChatInput /></Host>);
    await startRun(chat);
    const box = document.querySelector('textarea')!;
    expect(box.disabled).toBe(true);
    expect(document.querySelector('[data-action="stop"]')).not.toBeNull();
    expect(document.querySelector('[data-action="send"]')).toBeNull();
    expect(ctx.queue).toEqual({ enabled: false, items: [], paused: false });
    expect(ctx.canCompose).toBe(false);

    // The provider's send never checked loading; it still does not.
    let result = false;
    await act(async () => { result = ctx.send('second'); });
    expect(result).toBe(true);
    expect(texts(chat)).toEqual(['first', 'second']);

    await act(async () => { chat.finish({ parts: approvalParts() }); });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    let submitted = '';
    await act(async () => { submitted = ctx.submit('ja'); });
    expect(submitted).toBe('rejected');
    expect(ctx.approvalReminder).toBe(true);
    expect(texts(chat)).toEqual(['first', 'second']);
    expect(ctx.queue.items).toHaveLength(0);
  });

  it('renders the same panel markup with `queue: { enabled: false }` as without the option', async () => {
    const markup = async (config?: Partial<AiChatProviderConfig>) => {
      const chat = new FakeChat();
      const view = render(<Host chat={chat} config={config}><AiChatPanel /></Host>);
      await startRun(chat);
      // The markdown renderer loads lazily; compare once it rendered.
      await waitFor(() => expect(view.container.querySelector('[data-component="markdown"] p')).not.toBeNull());
      const html = view.container.innerHTML;
      view.unmount();
      return html;
    };
    const without = await markup();
    const disabled = await markup({ queue: { enabled: false } });
    expect(disabled).toBe(without);
    expect(without).not.toContain('chat-queue');
  });
});

describe('chat queue enabled', () => {
  const enabled = { queue: { enabled: true } } as const;

  it('queues a message sent while a run is loading', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    let result = '';
    await act(async () => { result = ctx.submit('second'); });
    expect(result).toBe('queued');
    expect(texts(chat)).toEqual(['first']);
    expect(queuedTexts()).toEqual(['second']);
    let sent = false;
    await act(async () => { sent = ctx.send('third'); });
    expect(sent).toBe(true);
    expect(queuedTexts()).toEqual(['second', 'third']);
  });

  it('sends an idle message at once', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    let result = '';
    await act(async () => { result = ctx.submit('hello'); });
    expect(result).toBe('sent');
    expect(texts(chat)).toEqual(['hello']);
  });

  it('flushes FIFO, one run at a time', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); ctx.submit('b'); });
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'a']));
    expect(queuedTexts()).toEqual(['b']);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'a', 'b']));
    expect(ctx.queue.items).toHaveLength(0);
  });

  it('sends each queued message once under StrictMode', async () => {
    const chat = new FakeChat();
    render(<StrictMode><Host chat={chat} config={enabled} /></StrictMode>);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); ctx.submit('b'); });
    await act(async () => { chat.finish(); });
    await act(async () => { chat.finish(); });
    await act(async () => { chat.finish(); });
    expect(texts(chat)).toEqual(['first', 'a', 'b']);
  });

  it('autoFlush false keeps the queue until sendNow', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ queue: { enabled: true, autoFlush: false } }} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); ctx.submit('b'); });
    await act(async () => { chat.finish(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(texts(chat)).toEqual(['first']);
    const b = ctx.queue.items[1]!.id;
    await act(async () => { expect(ctx.sendNow(b)).toBe(true); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'b']));
    expect(queuedTexts()).toEqual(['a']);
  });

  it("sendNow 'next' moves the message to the head without stopping the run", async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); ctx.submit('b'); });
    await act(async () => { ctx.sendNow(ctx.queue.items[1]!.id); });
    expect(queuedTexts()).toEqual(['b', 'a']);
    expect(chat.stop).not.toHaveBeenCalled();
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'b']));
  });

  it("sendNow 'next' sends one message of a paused queue", async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); ctx.submit('b'); ctx.pauseQueue(); });
    await act(async () => { chat.finish(); });
    expect(texts(chat)).toEqual(['first']);
    await act(async () => { ctx.sendNow(ctx.queue.items[1]!.id); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'b']));
    await act(async () => { chat.finish(); });
    expect(texts(chat)).toEqual(['first', 'b']);
    expect(ctx.queue.paused).toBe(true);
  });

  it("sendNow 'abort' stops the run and sends without pausing", async () => {
    const chat = new FakeChat();
    const events: ChatQueueChangeEvent[] = [];
    render(<Host chat={chat} config={{ queue: { enabled: true, sendNowBehavior: 'abort', onQueueChange: (event) => events.push(event) } }} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); ctx.submit('b'); });
    await act(async () => { ctx.sendNow(ctx.queue.items[1]!.id); });
    expect(chat.stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'b']));
    expect(ctx.queue.paused).toBe(false);
    expect(events.map((event) => event.reason)).not.toContain('paused');
    // The rest goes on by itself.
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'b', 'a']));
  });

  it('removes and edits queued messages; the edited text is sent', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); ctx.submit('b'); });
    const [a, b] = ctx.queue.items;
    await act(async () => { expect(ctx.removeQueued(a!.id)).toBe(true); });
    expect(ctx.removeQueued('missing')).toBe(false);
    await act(async () => { expect(ctx.editQueued(b!.id, 'b edited')).toBe(true); });
    expect(ctx.editQueued(b!.id, '   ')).toBe(false);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'b edited']));
  });

  it('refuses a message when the queue is full (default 10, maxSize, null lifts it)', async () => {
    const chat = new FakeChat();
    const view = render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    const results: string[] = [];
    await act(async () => { for (let index = 0; index < 11; index += 1) results.push(ctx.submit(`m${index}`)); });
    expect(results.filter((result) => result === 'queued')).toHaveLength(10);
    expect(results.at(-1)).toBe('rejected');
    expect(ctx.send('more')).toBe(false);
    view.unmount();

    const small = new FakeChat();
    const second = render(<Host chat={small} config={{ queue: { enabled: true, maxSize: 1 } }} />);
    await startRun(small);
    await act(async () => { results.length = 0; results.push(ctx.submit('a'), ctx.submit('b')); });
    expect(results).toEqual(['queued', 'rejected']);
    second.unmount();

    const open = new FakeChat();
    render(<Host chat={open} config={{ queue: { enabled: true, maxSize: null } }} />);
    await startRun(open);
    await act(async () => { for (let index = 0; index < 20; index += 1) ctx.submit(`m${index}`); });
    expect(ctx.queue.items).toHaveLength(20);
  });

  it('queues while an approval is open, shows the hint and waits until it is decided', async () => {
    const chat = new FakeChat();
    chat.autoResume = true;
    render(<Host chat={chat} config={enabled}><AiChatPanel /></Host>);
    await startRun(chat);
    await act(async () => { chat.finish({ parts: approvalParts() }); });
    let result = '';
    await act(async () => { result = ctx.submit('next please'); });
    expect(result).toBe('queued');
    expect(ctx.approvalReminder).toBe(true);
    await waitFor(() => expect(document.querySelector('[data-component="approval-reminder"]')).not.toBeNull());
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
    expect(texts(chat)).toEqual(['first']);

    await act(async () => { ctx.approve('approval-1'); });
    // The transport continues the approved call by itself; the queue waits for that run.
    expect(chat.status).toBe('streaming');
    expect(texts(chat)).toEqual(['first']);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'next please']));
  });

  it('goes on after an answered approval when the transport does not continue by itself', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    await act(async () => { chat.finish({ parts: approvalParts() }); });
    await act(async () => { ctx.submit('later'); });
    await act(async () => { ctx.reject('approval-1'); });
    expect(texts(chat)).toEqual(['first']);
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'later']), { timeout: 3000 });
  });

  it("sendNow during an approval refuses by default and shows the hint", async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    await act(async () => { chat.finish({ parts: approvalParts() }); });
    await act(async () => { ctx.submit('x'); });
    let result = true;
    await act(async () => { result = ctx.sendNow(ctx.queue.items[0]!.id); });
    expect(result).toBe(false);
    expect(ctx.approvalReminder).toBe(true);
    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
  });

  it("sendNow with 'reject-approval' rejects the open approvals, then sends", async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ queue: { enabled: true, sendNowDuringApproval: 'reject-approval' } }} />);
    await startRun(chat);
    await act(async () => { chat.finish({ parts: approvalParts() }); });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { ctx.submit('x'); });
    await act(async () => { expect(ctx.sendNow(ctx.queue.items[0]!.id)).toBe(true); });
    expect(chat.approvals).toEqual([{ id: 'approval-1', approved: false }]);
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'x']), { timeout: 3000 });
  });

  it('pauses after an error until resumeQueue', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); });
    await act(async () => { chat.finish({ status: 'error', error: new Error('boom') }); });
    expect(ctx.queue.paused).toBe(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(texts(chat)).toEqual(['first']);
    await act(async () => { ctx.resumeQueue(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'a']));
  });

  it('pauses after the user stops the run', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); });
    await act(async () => { ctx.stop(); });
    expect(ctx.queue.paused).toBe(true);
    expect(texts(chat)).toEqual(['first']);
    await act(async () => { ctx.resumeQueue(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'a']));
  });

  it('pauses after a safety stop and after a truncation', async () => {
    for (const part of [
      { type: 'data-pipeline-state', data: { status: 'safety-stop', maxSteps: 5, stepLimitSource: 'safety', totalSteps: 5 } },
      { type: 'data-truncation', data: { completedTools: ['a'], message: 'More to do' } },
    ]) {
      const chat = new FakeChat();
      const view = render(<Host chat={chat} config={enabled} />);
      await startRun(chat);
      await act(async () => { ctx.submit('a'); });
      await act(async () => { chat.emit(part); });
      await act(async () => { chat.finish(); });
      expect(ctx.queue.paused, part.type).toBe(true);
      expect(texts(chat)).toEqual(['first']);
      view.unmount();
    }
  });

  it('does not pause for an ending that is not in pauseOn', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ queue: { enabled: true, pauseOn: ['error'] } }} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); });
    await act(async () => { ctx.stop(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'a']));
  });

  it('holds while a clarification is open; a message sent meanwhile answers it first', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled} />);
    await startRun(chat);
    await act(async () => { ctx.submit('queued one'); });
    await act(async () => {
      chat.finish({
        parts: [{
          type: 'tool-ask_clarification', toolCallId: 'clar-1', state: 'output-available',
          input: { question: 'Which one?' }, output: { clarification: { question: 'Which one?' } },
        }],
      });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(texts(chat)).toEqual(['first']);
    let result = '';
    await act(async () => { result = ctx.submit('the second'); });
    expect(result).toBe('sent');
    expect(texts(chat)[1]).toContain('the second');
    expect(texts(chat)[1]).not.toBe('the second');
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(texts(chat)[2]).toBe('queued one'));
  });

  it('processes a queued message when it is sent (onBeforeSend, mentions)', async () => {
    const chat = new FakeChat();
    const onBeforeSend = vi.fn((text: string) => `${text}!`);
    render(<Host chat={chat} config={{ ...enabled, onBeforeSend }} />);
    await startRun(chat);
    onBeforeSend.mockClear();
    const mention = { id: 'p1', type: 'person', label: 'Ada', displayName: 'Ada' };
    await act(async () => { ctx.addActiveMention(mention); });
    await act(async () => { ctx.submit('ask'); });
    expect(onBeforeSend).not.toHaveBeenCalled();
    expect(ctx.activeMentions).toEqual([]);
    expect(ctx.queue.items[0]!.mentions).toEqual([mention]);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first!', 'ask!']));
    expect(onBeforeSend).toHaveBeenCalledWith('ask', [mention]);
  });

  it('queues files only while attachments are on', async () => {
    const file: FilePart = { type: 'file', mediaType: 'text/plain', url: 'data:text/plain;base64,aGk=', filename: 'a.txt' };
    const off = new FakeChat();
    const first = render(<Host chat={off} config={enabled} />);
    await startRun(off);
    expect(ctx.submit('with file', { files: [file] })).toBe('rejected');
    first.unmount();

    const on = new FakeChat();
    render(<Host chat={on} config={{ ...enabled, attachments: true }} />);
    await startRun(on);
    await act(async () => { expect(ctx.submit('with file', { files: [file] })).toBe('queued'); });
    await act(async () => { on.finish(); });
    await waitFor(() => expect(on.sent[1]).toEqual({ text: 'with file', files: [file] }));
  });

  it('clear() and another conversation empty the queue; a language change keeps it', async () => {
    const chat = new FakeChat();
    const events: string[] = [];
    const config = (activeId: string, lang: string): Partial<AiChatProviderConfig> => ({
      queue: { enabled: true, onQueueChange: (event) => events.push(event.reason) },
      session: { activeId },
      language: lang,
    });
    const view = render(<Host chat={chat} config={config('s1', 'en')} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); });
    view.rerender(<Host chat={chat} config={config('s1', 'de')} />);
    expect(queuedTexts()).toEqual(['a']);
    await act(async () => { ctx.clear(); });
    expect(ctx.queue.items).toHaveLength(0);
    await act(async () => { ctx.submit('b'); });
    expect(queuedTexts()).toEqual(['b']);
    await act(async () => { view.rerender(<Host chat={chat} config={config('s2', 'de')} />); });
    expect(ctx.queue.items).toHaveLength(0);
    expect(events).toEqual(['added', 'cleared', 'added', 'cleared']);
  });

  it('refuses while the conversation is not loaded yet', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ ...enabled, session: { load: () => new Promise(() => {}) } }} />);
    expect(ctx.canCompose).toBe(false);
    expect(ctx.submit('early')).toBe('rejected');
  });

  it('restores a stored queue paused, without file items, and ignores a stale load', async () => {
    const stored: Record<string, QueuedMessage[]> = {
      s1: [
        { id: 'q1', text: 'kept', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'q2', text: 'has file', createdAt: '2026-01-01T00:00:00.000Z', files: [{ type: 'file', mediaType: 'text/plain', url: 'blob:x' }] },
      ],
      s2: [{ id: 'q3', text: 'other chat', createdAt: '2026-01-01T00:00:00.000Z' }],
    };
    let releaseS2!: () => void;
    const storage: ChatQueueStorage = {
      load: (id) => (id === 's2'
        ? new Promise((resolve) => { releaseS2 = () => resolve(stored.s2!); })
        : stored[id] ?? []),
      save: vi.fn(),
    };
    const chat = new FakeChat();
    const config = (activeId: string): Partial<AiChatProviderConfig> => ({
      queue: { enabled: true, storage }, session: { activeId },
    });
    const view = render(<Host chat={chat} config={config('s1')} />);
    await waitFor(() => expect(queuedTexts()).toEqual(['kept']));
    expect(ctx.queue.paused).toBe(true);
    expect(texts(chat)).toEqual([]);

    await act(async () => { ctx.submit('new one'); });
    expect(storage.save).toHaveBeenLastCalledWith('s1', [
      expect.objectContaining({ text: 'kept' }),
      expect.objectContaining({ text: 'new one' }),
    ]);

    // Switch to s2 (slow load), then on to s3 before it answers.
    await act(async () => { view.rerender(<Host chat={chat} config={config('s2')} />); });
    await act(async () => { view.rerender(<Host chat={chat} config={config('s3')} />); });
    await act(async () => { releaseS2(); await Promise.resolve(); });
    expect(ctx.queue.items).toHaveLength(0);

    await act(async () => { ctx.resumeQueue(); });
    expect(texts(chat)).toEqual([]);
  });

  it('clear() during a slow storage load keeps the cleared queue cleared', async () => {
    let release!: () => void;
    const storage: ChatQueueStorage = {
      load: () => new Promise((resolve) => {
        release = () => resolve([{ id: 'q1', text: 'old', createdAt: '2026-01-01T00:00:00.000Z' }]);
      }),
      save: vi.fn(),
    };
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ queue: { enabled: true, storage } }} />);
    await act(async () => { ctx.clear(); });
    expect(storage.save).toHaveBeenLastCalledWith('default', []);
    await act(async () => { release(); await Promise.resolve(); });
    expect(ctx.queue.items).toHaveLength(0);
  });

  it('a sendNow message whose onBeforeSend throws pauses once and stays queued', async () => {
    const chat = new FakeChat();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onBeforeSend = vi.fn((text: string) => {
      if (text === 'bad') throw new Error('app bug');
      return text;
    });
    render(<Host chat={chat} config={{ ...enabled, onBeforeSend }} />);
    await startRun(chat);
    await act(async () => { ctx.submit('bad'); ctx.pauseQueue(); });
    await act(async () => { chat.finish(); });
    onBeforeSend.mockClear();
    await act(async () => { ctx.sendNow(ctx.queue.items[0]!.id); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(onBeforeSend).toHaveBeenCalledTimes(1);
    expect(queuedTexts()).toEqual(['bad']);
    expect(ctx.queue.paused).toBe(true);
    expect(texts(chat)).toEqual(['first']);
    warn.mockRestore();
  });

  it('writes the stored queue one at a time, the latest state last', async () => {
    const writes: Array<{ items: string[]; done: () => void }> = [];
    const storage: ChatQueueStorage = {
      load: () => [],
      save: vi.fn((_id: string, items: ReadonlyArray<QueuedMessage>) => new Promise<void>((resolve) => {
        writes.push({ items: items.map((item) => item.text), done: resolve });
      })),
    };
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ queue: { enabled: true, storage } }} />);
    await act(async () => { await Promise.resolve(); });
    await startRun(chat);
    await act(async () => { ctx.submit('a'); });
    await act(async () => { ctx.submit('b'); ctx.clearQueue(); });
    // The first write is still running: nothing else started.
    expect(writes.map((write) => write.items)).toEqual([['a']]);
    await act(async () => { writes[0]!.done(); await Promise.resolve(); await Promise.resolve(); });
    // Only the latest state follows.
    expect(writes.map((write) => write.items)).toEqual([['a'], []]);
  });

  it('reads a conversation again only after its pending write landed', async () => {
    const db = new Map<string, QueuedMessage[]>();
    const pending: Array<() => void> = [];
    const storage: ChatQueueStorage = {
      load: (id) => db.get(id) ?? [],
      save: (id, items) => new Promise<void>((resolve) => {
        pending.push(() => { db.set(id, [...items]); resolve(); });
      }),
    };
    const chat = new FakeChat();
    const config = (activeId: string): Partial<AiChatProviderConfig> => ({
      queue: { enabled: true, storage }, session: { activeId },
    });
    const view = render(<Host chat={chat} config={config('s1')} />);
    await act(async () => { await Promise.resolve(); });
    await startRun(chat);
    await act(async () => { ctx.submit('a'); });
    await act(async () => { pending.shift()!(); await Promise.resolve(); });
    // Removing it writes [] slowly; meanwhile the user leaves and comes back.
    await act(async () => { ctx.removeQueued(ctx.queue.items[0]!.id); });
    await act(async () => { view.rerender(<Host chat={chat} config={config('s2')} />); });
    await act(async () => { view.rerender(<Host chat={chat} config={config('s1')} />); });
    await act(async () => { pending.shift()!(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(ctx.queue.items).toHaveLength(0);
  });

  it('never saves file items', async () => {
    const storage: ChatQueueStorage = { load: () => [], save: vi.fn() };
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ queue: { enabled: true, storage }, attachments: true }} />);
    await waitFor(() => expect(storage.save).not.toHaveBeenCalled());
    await startRun(chat);
    const file: FilePart = { type: 'file', mediaType: 'text/plain', url: 'data:text/plain;base64,aGk=' };
    await act(async () => { ctx.submit('with file', { files: [file] }); ctx.submit('plain'); });
    expect(storage.save).toHaveBeenLastCalledWith('default', [expect.objectContaining({ text: 'plain' })]);
  });

  it('reports every change to onQueueChange and ignores a throw', async () => {
    const chat = new FakeChat();
    const reasons: string[] = [];
    render(<Host chat={chat} config={{
      queue: {
        enabled: true,
        onQueueChange: (event) => { reasons.push(event.reason); throw new Error('app bug'); },
      },
    }} />);
    await startRun(chat);
    await act(async () => { ctx.submit('a'); ctx.submit('b'); ctx.submit('c'); });
    const [a, b, c] = ctx.queue.items;
    await act(async () => { ctx.editQueued(a!.id, 'a2'); ctx.removeQueued(b!.id); ctx.sendNow(c!.id); });
    await act(async () => { ctx.pauseQueue(); ctx.resumeQueue(); ctx.pauseQueue(); });
    await act(async () => { ctx.resumeQueue(); });
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'c']));
    await act(async () => { ctx.clearQueue(); });
    expect(reasons).toEqual([
      'added', 'added', 'added', 'edited', 'removed', 'reordered', 'paused', 'resumed', 'paused', 'resumed', 'sent', 'cleared',
    ]);
  });

  it('keeps the composer usable while loading and queues what is typed', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled}><ChatInput /></Host>);
    await startRun(chat);
    const box = document.querySelector('textarea')!;
    expect(box.disabled).toBe(false);
    expect(document.querySelector('[data-action="stop"]')).not.toBeNull();
    expect(document.querySelector('[data-action="send"]')).not.toBeNull();
    fireEvent.change(box, { target: { value: 'typed while busy' } });
    await act(async () => { fireEvent.submit(box.closest('form')!); });
    expect(box.value).toBe('');
    expect(queuedTexts()).toEqual(['typed while busy']);
  });

  it('keeps the provider composer (MentionInput) usable while loading, with send and stop', async () => {
    const off = new FakeChat();
    const first = render(<Host chat={off} config={{ attachments: true }}><MentionInput /></Host>);
    await startRun(off);
    expect(document.querySelector('[contenteditable]')!.getAttribute('contenteditable')).toBe('false');
    expect(document.querySelector('[data-action="send"]')).toBeNull();
    first.unmount();

    const chat = new FakeChat();
    render(<Host chat={chat} config={{ ...enabled, attachments: true }}><MentionInput /></Host>);
    await startRun(chat);
    expect(document.querySelector('[contenteditable]')!.getAttribute('contenteditable')).toBe('true');
    expect(document.querySelector('[data-action="stop"]')).not.toBeNull();
    expect(document.querySelector('[data-action="send"]')).not.toBeNull();
  });

  it('waits for UI actions of the last result before sending the next message', async () => {
    const chat = new FakeChat();
    const bus = new UiActionBus();
    let release!: () => void;
    const handler = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    bus.subscribeByType('glirastes.navigate', handler);
    render(<Host chat={chat} config={{ ...enabled, uiActionBus: bus }} />);
    await startRun(chat);
    await act(async () => { ctx.submit('after the action'); });
    await act(async () => {
      chat.finish({
        parts: [{
          type: 'tool-open_page', toolCallId: 'ui-1', state: 'output-available', input: {},
          output: { success: true, uiAction: { type: 'glirastes.navigate', actionId: 'glirastes.navigate', payload: { href: '/x' } } },
        }],
      });
    });
    await waitFor(() => expect(handler).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(texts(chat)).toEqual(['first']);
    await act(async () => { release(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'after the action']));
  });

  it('keeps the draft of a refused message', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ queue: { enabled: true, maxSize: 0 } }}><ChatInput /></Host>);
    await startRun(chat);
    const box = document.querySelector('textarea')!;
    fireEvent.change(box, { target: { value: 'no room' } });
    await act(async () => { fireEvent.submit(box.closest('form')!); });
    expect(box.value).toBe('no room');
  });
});

describe('ChatQueue component', () => {
  const enabled = { queue: { enabled: true } } as const;

  it('renders the queue above the composer in AiChatPanel, with its actions', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={enabled}><AiChatPanel /></Host>);
    expect(document.querySelector('[data-component="chat-queue"]')).toBeNull();
    await startRun(chat);
    await act(async () => { ctx.submit('one'); ctx.submit('two'); });
    const root = document.querySelector('[data-component="chat-queue"]')!;
    expect(root).not.toBeNull();
    // Above the composer.
    expect(root.nextElementSibling?.getAttribute('data-component')).toMatch(/input/);
    expect(screen.getByText('Queued (2)')).toBeTruthy();
    const items = root.querySelectorAll('[data-element="item"]');
    expect([...items].map((item) => item.querySelector('[data-element="text"]')?.textContent)).toEqual(['one', 'two']);

    fireEvent.click(items[0]!.querySelector('[data-action="remove"]')!);
    expect(queuedTexts()).toEqual(['two']);

    fireEvent.click(document.querySelector('[data-component="chat-queue"] [data-action="edit"]')!);
    const editor = document.querySelector('[data-component="chat-queue"] textarea') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'two edited' } });
    fireEvent.click(document.querySelector('[data-component="chat-queue"] [data-action="save"]')!);
    expect(queuedTexts()).toEqual(['two edited']);

    await act(async () => { ctx.pauseQueue(); });
    expect(document.querySelector('[data-component="chat-queue"]')!.getAttribute('data-state')).toBe('paused');
    fireEvent.click(document.querySelector('[data-component="chat-queue"] [data-action="resume"]')!);
    expect(ctx.queue.paused).toBe(false);

    fireEvent.click(document.querySelector('[data-component="chat-queue"] [data-action="send-now"]')!);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(texts(chat)).toEqual(['first', 'two edited']));
  });

  it('uses German texts, the classNames key and works unstyled', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ ...enabled, language: 'de', unstyled: true, classNames: { chatQueue: 'my-queue' } }}><ChatQueue /></Host>);
    await startRun(chat);
    await act(async () => { ctx.submit('eins'); });
    const root = document.querySelector('[data-component="chat-queue"]')!;
    expect(root.className).toBe('my-queue');
    expect(root.getAttribute('data-unstyled')).toBe('true');
    expect(root.textContent).toContain('In der Warteschlange (1)');
    expect(root.textContent).toContain('Jetzt senden');
  });

  it('takes a render prop, and components.ChatQueue replaces or hides it', async () => {
    function Custom() {
      const queue = useChatQueue();
      return <ul data-testid="custom">{queue.items.map((item) => <li key={item.id}>{item.text}</li>)}</ul>;
    }
    const chat = new FakeChat();
    const view = render(<Host chat={chat} config={{ ...enabled, components: { ChatQueue: Custom } }}><AiChatPanel /></Host>);
    await startRun(chat);
    await act(async () => { ctx.submit('x'); });
    expect(screen.getByTestId('custom').textContent).toBe('x');
    expect(document.querySelector('[data-component="chat-queue"]')).toBeNull();
    view.unmount();

    const hidden = new FakeChat();
    const second = render(<Host chat={hidden} config={{ ...enabled, components: { ChatQueue: null } }}><AiChatPanel /></Host>);
    await startRun(hidden);
    await act(async () => { ctx.submit('x'); });
    expect(document.querySelector('[data-component="chat-queue"]')).toBeNull();
    second.unmount();

    const prop = new FakeChat();
    render(<Host chat={prop} config={enabled}>
      <ChatQueue>{(queue) => <span data-testid="count">{queue.items.length}:{String(queue.paused)}</span>}</ChatQueue>
    </Host>);
    await startRun(prop);
    await act(async () => { ctx.submit('x'); ctx.submit('y'); });
    expect(screen.getByTestId('count').textContent).toBe('2:false');
  });
});
