// @vitest-environment jsdom

import React, { useEffect, useReducer } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { useChatContext, type ChatContextValue } from '../provider/chat-context.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import { ChatStarters, useChatQueue, useViewContext } from '../index.js';
import { VercelAiChat } from '../transports/vercel/index.js';
import { defineChatCommand, defineChatEntity } from '../interactions/definitions.js';
import { clarificationAnswerMessage } from '../utils/clarification.js';
import { currentViewContext, registerViewContext } from '../../browser/index.js';
import type { ViewContextEntry } from '../../contracts/view-context.js';
import type {
  AiChatProviderConfig,
  ChatMessage,
  ChatQueueStorage,
  ChatTransport,
  ChatTransportDataHandler,
  FilePart,
  MentionData,
  QueuedMessage,
} from '../types.js';
import { createAiChatHandler } from '../../server/adapters/nextjs/create-ai-chat-handler.js';
import { defineTool, type ToolRegistry } from '../../types.js';

const viewA: ViewContextEntry = { entity: { type: 'order', id: 'ord-1' }, label: 'Order 1', route: '/orders/ord-1' };
const viewB: ViewContextEntry = { entity: { type: 'order', id: 'ord-2' }, label: 'Order 2' };

/** Switches the one view of the page, as a router would: A, B, or nothing. */
const show = (entry: ViewContextEntry | null) => { registerViewContext('page', entry); };

/** Node ships its own web storage stub, so the tests bring working ones; everything written lands here. */
const disk = { local: new Map<string, string>(), session: new Map<string, string>() };
const webStorage = (map: Map<string, string>) => ({
  getItem: (key: string) => map.get(key) ?? null,
  setItem: (key: string, value: string) => { map.set(key, String(value)); },
  removeItem: (key: string) => { map.delete(key); },
  clear: () => map.clear(),
  key: (index: number) => [...map.keys()][index] ?? null,
  get length() { return map.size; },
});
const everythingStored = () => JSON.stringify([...disk.local, ...disk.session]);

beforeEach(() => {
  vi.stubGlobal('localStorage', webStorage(disk.local));
  vi.stubGlobal('sessionStorage', webStorage(disk.session));
});
afterEach(() => {
  cleanup();
  show(null);
  registerViewContext('other', null);
  disk.local.clear();
  disk.session.clear();
  vi.unstubAllGlobals();
  expect(currentViewContext()).toEqual([]);
});

type SentMessage = { text: string; files?: FilePart[]; viewContext?: ReadonlyArray<ViewContextEntry> };

/** A transport of the app's own: records the first argument as it came, streams until `finish`. */
class FakeChat {
  messages: ChatMessage[] = [];
  status: ChatTransport['status'] = 'ready';
  error: Error | null = null;
  sent: SentMessage[] = [];
  private listeners = new Set<() => void>();
  private dataHandlers = new Set<ChatTransportDataHandler>();
  private pending: Array<() => void> = [];
  private counter = 0;

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  sendMessage = vi.fn((message: SentMessage) => {
    this.sent.push(message);
    this.counter += 1;
    this.messages = [...this.messages, { id: `u${this.counter}`, role: 'user', parts: [{ type: 'text', text: message.text }] }];
    this.status = 'streaming';
    this.notify();
    return new Promise<void>((resolve) => { this.pending.push(resolve); });
  });

  stop = vi.fn(() => { this.status = 'ready'; this.settle(); this.notify(); });
  setMessages = vi.fn((messages: ChatMessage[]) => { this.messages = messages; this.notify(); });
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

  finish(parts: unknown[] = [{ type: 'text', text: 'ok' }]) {
    this.counter += 1;
    this.messages = [...this.messages, { id: `a${this.counter}`, role: 'assistant', parts: parts as ChatMessage['parts'] }];
    this.status = 'ready';
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

function Host({ chat, config }: { chat: FakeChat; config?: Partial<AiChatProviderConfig> }) {
  const [, force] = useReducer((count: number) => count + 1, 0);
  useEffect(() => chat.subscribe(force), [chat]);
  return (
    <AiChatProvider transport={chat.transport} {...config}>
      <Probe />
    </AiChatProvider>
  );
}

const queue = { queue: { enabled: true } } as const;

async function startRun(chat: FakeChat, text = 'first') {
  await act(async () => { ctx.send(text); });
  expect(chat.status).toBe('streaming');
}

describe('a queued message keeps the view context of the moment it was queued', () => {
  it('queued at A, the view switches to B, flushed: it carries A', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={queue} />);
    await startRun(chat);
    show(viewA);
    await act(async () => { expect(ctx.submit('Delete this')).toBe('queued'); });
    show(viewB);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sent).toHaveLength(2));
    expect(chat.sent[1]).toEqual({ text: 'Delete this', viewContext: [viewA] });
  });

  it('queued with nothing registered, A registered before the flush: no field', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={queue} />);
    await startRun(chat);
    await act(async () => { ctx.submit('Delete this'); });
    show(viewA);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sent).toHaveLength(2));
    expect(chat.sent[1]).toEqual({ text: 'Delete this' });
    expect(Object.keys(chat.sent[1]!)).toEqual(['text']);
  });

  it('queued at A, everything unregistered before the flush: the frozen A goes out', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={queue} />);
    await startRun(chat);
    show(viewA);
    await act(async () => { ctx.submit('Delete this'); });
    show(null);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sent).toHaveLength(2));
    expect(chat.sent[1]!.viewContext).toEqual([viewA]);
  });

  it('an edit keeps the view context of the moment it was queued', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={queue} />);
    await startRun(chat);
    show(viewA);
    await act(async () => { ctx.submit('Delete this'); });
    const id = ctx.queue.items[0]!.id;
    show(viewB);
    await act(async () => { ctx.beginEdit(id); });
    await act(async () => { expect(ctx.editQueued(id, 'Archive this')).toBe(true); });
    expect(ctx.queue.items[0]!.viewContext).toEqual([viewA]);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sent).toHaveLength(2));
    expect(chat.sent[1]).toEqual({ text: 'Archive this', viewContext: [viewA] });
  });

  it('several queued messages keep each their own view context; sendNow keeps it too', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={queue} />);
    await startRun(chat);
    show(viewA);
    await act(async () => { ctx.submit('one'); });
    show(viewB);
    await act(async () => { ctx.submit('two'); });
    show(null);
    await act(async () => { ctx.submit('three'); });
    registerViewContext('other', { selection: { type: 'order', ids: ['o-1', 'o-2'] } });
    show(viewA);
    await act(async () => { ctx.submit('four'); });
    expect(ctx.queue.items.map((item) => item.viewContext)).toEqual([
      [viewA], [viewB], undefined, [{ selection: { type: 'order', ids: ['o-1', 'o-2'] } }, viewA],
    ]);
    // `four` jumps the queue and still carries its own.
    await act(async () => { ctx.sendNow(ctx.queue.items[3]!.id); });
    for (let index = 0; index < 4; index += 1) {
      await act(async () => { chat.finish(); });
    }
    await waitFor(() => expect(chat.sent).toHaveLength(5));
    expect(chat.sent.slice(1)).toEqual([
      { text: 'four', viewContext: [{ selection: { type: 'order', ids: ['o-1', 'o-2'] } }, viewA] },
      { text: 'one', viewContext: [viewA] },
      { text: 'two', viewContext: [viewB] },
      { text: 'three' },
    ]);
  });

  it('the queued snapshot is a copy: changing the registered entry object later does not change it', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={queue} />);
    await startRun(chat);
    const entry = { entity: { type: 'order', id: 'ord-1' }, label: 'Order 1' };
    show(entry);
    await act(async () => { ctx.submit('Delete this'); });
    entry.entity.id = 'ord-9';
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sent).toHaveLength(2));
    expect(chat.sent[1]!.viewContext).toEqual([{ entity: { type: 'order', id: 'ord-1' }, label: 'Order 1' }]);
  });
});

describe('the snapshot is never persisted', () => {
  /** Keeps the queue as JSON in localStorage, as an app would. */
  const storage: ChatQueueStorage = {
    load: (id) => JSON.parse(localStorage.getItem(`queue:${id}`) ?? '[]') as QueuedMessage[],
    save: (id, items) => { localStorage.setItem(`queue:${id}`, JSON.stringify(items)); },
  };

  it('queue.storage gets the items without it; a restored message goes out without view context', async () => {
    const save = vi.spyOn(storage, 'save');
    const chat = new FakeChat();
    const view = render(<Host chat={chat} config={{ queue: { enabled: true, storage } }} />);
    await waitFor(() => expect(ctx.queue.restoring).toBe(false));
    await startRun(chat);
    show(viewA);
    await act(async () => { ctx.submit('Delete this'); });
    expect(ctx.queue.items[0]!.viewContext).toEqual([viewA]);
    const saved = save.mock.calls.at(-1)![1];
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0]!)).toEqual(['id', 'text', 'createdAt']);
    const everything = everythingStored();
    expect(everything).toContain('Delete this');
    expect(everything).not.toContain('ord-1');
    expect(everything).not.toContain('viewContext');
    view.unmount();

    // A reload: the same page shows A again, the restored message still goes without it.
    const after = new FakeChat();
    render(<Host chat={after} config={{ queue: { enabled: true, storage } }} />);
    await waitFor(() => expect(ctx.queue.items.map((item) => item.text)).toEqual(['Delete this']));
    expect(ctx.queue.items[0]!.viewContext).toBeUndefined();
    expect(ctx.queue.paused).toBe(true);
    await act(async () => { ctx.resumeQueue(); });
    await waitFor(() => expect(after.sent).toHaveLength(1));
    expect(after.sent[0]).toEqual({ text: 'Delete this' });
    save.mockRestore();
  });

  it('a storage that hands back items with a viewContext field still restores them without it', async () => {
    const forged: ChatQueueStorage = {
      load: () => [{ id: 'q1', text: 'old', createdAt: '2026-01-01T00:00:00.000Z', viewContext: [viewB] } as QueuedMessage],
      save: vi.fn(),
    };
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ queue: { enabled: true, storage: forged } }} />);
    await waitFor(() => expect(ctx.queue.items).toHaveLength(1));
    expect(ctx.queue.items[0]).not.toHaveProperty('viewContext');
  });

  it('an unchanged app saves the same items as on main', async () => {
    const save = vi.fn();
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ queue: { enabled: true, storage: { load: () => [], save } } }} />);
    await waitFor(() => expect(ctx.queue.restoring).toBe(false));
    await startRun(chat);
    await act(async () => { ctx.submit('Later'); });
    const item = ctx.queue.items[0]!;
    expect(Object.keys(item)).toEqual(['id', 'text', 'createdAt']);
    // The very item object, as on main: nothing copied or stripped.
    expect(save.mock.calls.at(-1)![1][0]).toBe(item);
  });
});

describe('when each send path freezes the view context', () => {
  const ping = defineChatCommand({ id: 'tasks.ping', label: 'Ping', run: { kind: 'tool', tool: 'tasks.ping' } });
  const budget = defineChatCommand({
    id: 'tasks.budget', label: 'Budget', args: [{ name: 'amount', label: 'Cost', required: true }],
    run: { kind: 'tool', tool: 'tasks.budget' },
  });
  const person = defineChatEntity({
    type: 'person', label: 'Person', search: () => [{ id: 'alice', label: 'Alice' }],
    actions: [{ id: 'person.ping', label: 'Ping', entityArg: 'who', run: { kind: 'tool', tool: 'people.ping' } }],
  });
  const pingMention: MentionData = { id: 'tasks.ping', type: 'command', label: 'Ping', prefix: '/', slug: 'ping' };
  const budgetMention: MentionData = { id: 'tasks.budget', type: 'command', label: 'Budget', prefix: '/', slug: 'budget' };
  const chatInteractions = { commands: [ping, budget], entities: [person] };

  for (const withQueue of [false, true]) {
    describe(withQueue ? 'with the queue' : 'without the queue', () => {
      const config: Partial<AiChatProviderConfig> = { chatInteractions, ...(withQueue ? queue : {}) };

      it('a typed message, a starter or follow-up chip and a clarification answer: at the send', async () => {
        const chat = new FakeChat();
        render(<Host chat={chat} config={config} />);
        show(viewA);
        await act(async () => { ctx.send('typed'); });
        show(viewB);
        await act(async () => { chat.finish(); });
        await act(async () => { ctx.selectSuggestion('a chip'); });
        show(null);
        await act(async () => { chat.finish(); });
        const answer = clarificationAnswerMessage({ toolCallId: 'c1', answer: 'Yes', optionId: 'yes' });
        show(viewA);
        await act(async () => { ctx.send(answer); });
        await waitFor(() => expect(chat.sent).toHaveLength(3));
        expect(chat.sent).toEqual([
          { text: 'typed', viewContext: [viewA] },
          { text: 'a chip', viewContext: [viewB] },
          { text: answer, viewContext: [viewA] },
        ]);
      });

      it('a direct command: at the send', async () => {
        const chat = new FakeChat();
        render(<Host chat={chat} config={config} />);
        show(viewA);
        await act(async () => { ctx.send('/ping', { mentions: [pingMention] }); });
        await waitFor(() => expect(chat.sent).toHaveLength(1));
        expect(chat.sent[0]!.text).toContain('<!--glirastes:command');
        expect(chat.sent[0]!.viewContext).toEqual([viewA]);
      });

      it('a command form: when the form is submitted', async () => {
        const chat = new FakeChat();
        render(<Host chat={chat} config={config} />);
        show(viewA);
        await act(async () => { ctx.send('/budget', { mentions: [budgetMention] }); });
        expect(ctx.pendingCommand).not.toBeNull();
        show(viewB);
        await act(async () => { expect(ctx.submitPendingCommand({ amount: '5' })).toBe(true); });
        await waitFor(() => expect(chat.sent).toHaveLength(1));
        expect(chat.sent[0]!.viewContext).toEqual([viewB]);
      });

      it('an entity action: at the click', async () => {
        const chat = new FakeChat();
        render(<Host chat={chat} config={config} />);
        show(viewB);
        await act(async () => { ctx.runEntityAction({ type: 'person', id: 'alice', label: 'Alice' }, 'person.ping'); });
        await waitFor(() => expect(chat.sent).toHaveLength(1));
        expect(chat.sent[0]!.viewContext).toEqual([viewB]);
      });

      it('"continue" after a cut-off answer: at the click', async () => {
        const chat = new FakeChat();
        render(<Host chat={chat} config={config} />);
        show(viewA);
        await act(async () => { ctx.continueTruncation(); });
        await waitFor(() => expect(chat.sent).toHaveLength(1));
        expect(chat.sent[0]).toEqual({ text: 'Please continue.', viewContext: [viewA] });
      });

      it('an unchanged app: every path calls the transport with exactly the argument of main', async () => {
        const chat = new FakeChat();
        render(<Host chat={chat} config={config} />);
        const file: FilePart = { type: 'file', mediaType: 'text/plain', url: 'data:text/plain;base64,aGk=', filename: 'a.txt' };
        await act(async () => { ctx.send('typed'); });
        await act(async () => { chat.finish(); });
        await act(async () => { ctx.selectSuggestion('a chip'); });
        await act(async () => { chat.finish(); });
        await act(async () => { ctx.send('/ping', { mentions: [pingMention] }); });
        await act(async () => { chat.finish(); });
        await act(async () => { ctx.send('/budget', { mentions: [budgetMention] }); });
        await act(async () => { ctx.submitPendingCommand({ amount: '5' }); });
        await act(async () => { chat.finish(); });
        await act(async () => { ctx.runEntityAction({ type: 'person', id: 'alice', label: 'Alice' }, 'person.ping'); });
        await act(async () => { chat.finish(); });
        await act(async () => { ctx.continueTruncation(); });
        await act(async () => { chat.finish(); });
        await waitFor(() => expect(chat.sent).toHaveLength(6));
        for (const message of chat.sent) expect(Object.keys(message)).toEqual(['text']);
        for (const call of chat.sendMessage.mock.calls) expect(call).toHaveLength(1);
        // With files: `text` and `files`, as on main.
        const withFiles = new FakeChat();
        cleanup();
        render(<Host chat={withFiles} config={{ ...config, attachments: true }} />);
        await act(async () => { ctx.send('look', { files: [file] }); });
        await waitFor(() => expect(withFiles.sent).toHaveLength(1));
        expect(Object.keys(withFiles.sent[0]!)).toEqual(['text', 'files']);
      });
    });
  }

  it('a queued command that needs arguments: when its form is submitted', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ chatInteractions, ...queue }} />);
    await startRun(chat);
    show(viewA);
    await act(async () => { ctx.submit('/budget', { mentions: [budgetMention] }); });
    expect(ctx.queue.items[0]!.viewContext).toEqual([viewA]);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(ctx.pendingCommand).not.toBeNull());
    show(viewB);
    await act(async () => { ctx.submitPendingCommand({ amount: '5' }); });
    await waitFor(() => expect(chat.sent).toHaveLength(2));
    expect(chat.sent[1]!.viewContext).toEqual([viewB]);
  });

  it('a message with files carries it next to the files', async () => {
    const chat = new FakeChat();
    render(<Host chat={chat} config={{ ...queue, attachments: true }} />);
    const file: FilePart = { type: 'file', mediaType: 'text/plain', url: 'data:text/plain;base64,aGk=', filename: 'a.txt' };
    await startRun(chat);
    show(viewA);
    await act(async () => { ctx.submit('look', { files: [file] }); });
    show(viewB);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sent).toHaveLength(2));
    expect(chat.sent[1]).toEqual({ text: 'look', files: [file], viewContext: [viewA] });
  });
});

// ---------------------------------------------------------------------------
// The bundled transport and the real chat route
// ---------------------------------------------------------------------------

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const getOrder = defineTool({
  id: 'orders.get',
  description: 'Read one order.',
  method: 'GET',
  inputSchema: z.object({ orderId: z.string() }),
  outputEntities: [{ type: 'order', id: 'id', name: 'name' }],
  inputEntities: [{ type: 'order', args: 'orderId' }],
  execute: async () => ({ id: 'ord-1', name: 'Order 1' }),
});
const registry: ToolRegistry = { orders_get: getOrder };

describe('with the bundled transport and the real chat route', () => {
  const bodies: Array<Record<string, unknown>> = [];
  let models: MockLanguageModelV3[] = [];
  /** Releases the held first answer. */
  let release: (() => void) | undefined;
  let holdNext = false;

  beforeEach(() => {
    bodies.length = 0;
    models = [];
    holdNext = false;
    release = undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const hold = holdNext;
      holdNext = false;
      const gate = hold ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
      const model = new MockLanguageModelV3({
        doStream: async () => {
          await gate;
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'Answer.' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ] as never),
          };
        },
      });
      models.push(model);
      const handler = createAiChatHandler({ tools: registry, systemPrompt: 'Assistant', model } as never);
      return handler(new Request('https://app.example/api/chat', { method: 'POST', headers: init?.headers, body: init?.body }));
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  let transport: ChatTransport;
  function VercelHost({ wrap, config }: { wrap?: boolean; config?: Partial<AiChatProviderConfig> }) {
    const inner = useVercelAiChatTransport({ endpoint: '/api/chat' });
    transport = inner;
    // A wrapper of the app's own that passes the message on as it came.
    const used = wrap ? { ...inner, sendMessage: (message: Parameters<ChatTransport['sendMessage']>[0]) => inner.sendMessage(message) } : inner;
    return (
      <AiChatProvider transport={used} {...config}>
        <Probe />
      </AiChatProvider>
    );
  }

  const promptOf = (model: MockLanguageModelV3 | undefined) => JSON.stringify(model?.doStreamCalls[0]?.prompt);

  for (const wrap of [false, true]) {
    it(`queued at A, switched to B, flushed: the body and the model's block show A${wrap ? ' (through a wrapper)' : ''}`, async () => {
      render(<VercelHost wrap={wrap} config={queue} />);
      holdNext = true;
      await act(async () => { ctx.send('first'); });
      await waitFor(() => expect(release).toBeDefined());
      show(viewA);
      await act(async () => { expect(ctx.submit('Delete this')).toBe('queued'); });
      show(viewB);
      await act(async () => { release!(); });
      await waitFor(() => expect(bodies).toHaveLength(2));
      expect(bodies[0]).not.toHaveProperty('glirastesViewContext');
      expect(bodies[1]!.glirastesViewContext).toEqual({ version: 1, current: [viewA] });
      await waitFor(() => expect(models[1]?.doStreamCalls).toHaveLength(1));
      const prompt = promptOf(models[1]);
      expect(prompt).toContain('<view-context>');
      expect(prompt).toContain('ord-1');
      expect(prompt).not.toContain('ord-2');
    });
  }

  it('queued with nothing registered, A registered before the flush: no field and no block', async () => {
    render(<VercelHost config={queue} />);
    holdNext = true;
    await act(async () => { ctx.send('first'); });
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => { ctx.submit('Delete this'); });
    show(viewA);
    await act(async () => { release!(); });
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).not.toHaveProperty('glirastesViewContext');
    expect(Object.keys(bodies[1]!)).toEqual(['glirastesClientActions', 'glirastesUiOutcomes', 'id', 'messages', 'trigger']);
    await waitFor(() => expect(models[1]?.doStreamCalls).toHaveLength(1));
    expect(promptOf(models[1])).not.toContain('view-context');
  });

  it('an app as on main (VercelAiChat, useViewContext, own composer on the public API, queue with maxSize and autoFlush) needs no change', async () => {
    // Exactly the app code of main: nothing here knows about freezing.
    function OrderPage({ entry }: { entry: ViewContextEntry | null }) {
      useViewContext(entry);
      return null;
    }
    let api!: ReturnType<typeof useChatQueue>;
    let chat!: ChatContextValue;
    function OwnComposer() {
      api = useChatQueue();
      chat = useChatContext();
      return <ChatStarters />;
    }
    function App({ entry }: { entry: ViewContextEntry | null }) {
      return (
        <>
          <OrderPage entry={entry} />
          <VercelAiChat
            endpoint="/api/chat"
            queue={{ enabled: true, maxSize: 5, autoFlush: true }}
            composer={{ starters: [{ label: 'Status', prompt: 'What is the status of this?', send: true }] }}
          >
            <OwnComposer />
          </VercelAiChat>
        </>
      );
    }
    const view = render(<App entry={viewA} />);
    holdNext = true;
    // A starter click while A is open: sent at once, its answer stays open.
    const starter = view.container.querySelector('[data-element="starter"]') as HTMLButtonElement;
    await act(async () => { starter.click(); });
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => { expect(api.submitWithResult('Delete this')).toEqual({ status: 'queued' }); });
    // The model (or the user) navigates to B.
    view.rerender(<App entry={viewB} />);
    await act(async () => { expect(chat.send('And this one')).toBe(true); });
    view.rerender(<App entry={null} />);
    await act(async () => { expect(api.submit('And without a view')).toBe('queued'); });
    expect(api.items.map((item) => item.viewContext)).toEqual([[viewA], [viewB], undefined]);
    view.rerender(<App entry={viewB} />);
    await act(async () => { release!(); });
    await waitFor(() => expect(bodies).toHaveLength(4));
    const sent = bodies.map((body) => (body.glirastesViewContext as { current?: ViewContextEntry[] } | undefined)?.current);
    expect(sent).toEqual([[viewA], [viewA], [viewB], undefined]);
    const lastUserText = (body: Record<string, unknown>) =>
      JSON.stringify((body.messages as Array<{ role: string; parts: unknown[] }>).filter((m) => m.role === 'user').at(-1)?.parts);
    expect(bodies.map(lastUserText).map((text) => /"text":"([^"]+)"/.exec(text)?.[1]))
      .toEqual(['What is the status of this?', 'Delete this', 'And this one', 'And without a view']);
    await waitFor(() => expect(models[1]?.doStreamCalls).toHaveLength(1));
    expect(promptOf(models[1])).toContain('ord-1');
    expect(promptOf(models[1])).not.toContain('ord-2');
  });

  it('the transport sends what the message carries, not what is registered when it sends', async () => {
    render(<VercelHost />);
    show(viewA);
    await act(async () => { await transport.sendMessage({ text: 'no snapshot' }); });
    await act(async () => { await transport.sendMessage({ text: 'with snapshot', viewContext: [viewB] }); });
    await act(async () => { await transport.sendMessage({ text: 'empty', viewContext: [] }); });
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).not.toHaveProperty('glirastesViewContext');
    expect(bodies[1]!.glirastesViewContext).toEqual({ version: 1, current: [viewB] });
    expect(bodies[2]).not.toHaveProperty('glirastesViewContext');
    // Never into the chat history: the user message holds only its text.
    expect(JSON.stringify(bodies[1]!.messages)).not.toContain('ord-2');
  });
});
