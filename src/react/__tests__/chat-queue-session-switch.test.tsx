// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatQueueChangeEvent, ChatQueueStorage, QueuedMessage, SessionConfig } from '../types.js';
import { ctx, Host, StreamingChat } from './streaming-chat.js';

afterEach(cleanup);

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const answer = (id: string, text: string): ChatMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] });
const B = [user('b-u1', 'b question'), answer('b-a1', 'b answer')];
const idsOf = () => ctx.messages.map((message) => message.id);
const queuedTexts = () => ctx.queue.items.map((item) => item.text);
const approvalParts = (id = 'approval-1') => [{
  type: 'tool-tasks_delete', toolCallId: `call-${id}`, state: 'approval-requested',
  input: { id: 't1' }, approval: { id },
}];
const file = { type: 'file' as const, mediaType: 'text/plain', url: 'data:text/plain;base64,aGk=', filename: 'a.txt' };

/**
 * The user messages each request carried to the backend. Only user messages: the answer of a request that
 * ends after a host switch is not kept apart from the new chat yet (left-chat-answer repro), so assistant
 * messages are deliberately not asserted here.
 */
const carriedUsers = (chat: StreamingChat) => chat.requests.map((request) => request
  .filter((message) => message.role === 'user')
  .map((message) => (message.parts[0] as { text: string }).text));

/** Which chat was open when each message reached the transport. */
class SessionChat extends StreamingChat {
  sentIn: Array<{ text: string; session: string }> = [];
  constructor() {
    super();
    const base = this.sendMessage;
    this.sendMessage = vi.fn((message: { text: string }) => {
      this.sentIn.push({ text: message.text, session: ctx.activeSessionId });
      return base(message);
    }) as typeof this.sendMessage;
    // A decision is written into the approval part, as the AI SDK does; the test decides when the run goes on.
    this.addToolApprovalResponse = vi.fn(async ({ id, approved }: { id: string; approved: boolean }) => {
      this.status = 'submitted';
      this.setMessages(this.messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) => {
          const record = part as unknown as { approval?: { id: string } };
          return record.approval?.id === id
            ? { ...part, state: 'approval-responded', approval: { id, approved } } as never
            : part;
        }),
      })));
    }) as typeof this.addToolApprovalResponse;
  }
}

/** A host-owned store: `activeId` comes from the host, as in the turn-outcome tests. */
function store(initial: Record<string, ChatMessage[]>) {
  const histories: Record<string, ChatMessage[]> = { ...initial };
  const session = (activeId: string): SessionConfig => ({
    activeId,
    load: async (id: string) => histories[id] ?? [],
    save: (id: string, messages: ChatMessage[]) => { histories[id] = messages; },
  });
  return { histories, session };
}

const enabled = { enabled: true } as const;
type View = ReturnType<typeof render>;

function open(chat: SessionChat, sessions: ReturnType<typeof store>, id: string, queue: object = enabled, view?: View) {
  const element = <Host chat={chat} config={{ session: sessions.session(id), queue }} />;
  if (view) { view.rerender(element); return view; }
  return render(element);
}

/** Switches the host-owned active chat and waits until its history is shown. */
async function switchTo(chat: SessionChat, sessions: ReturnType<typeof store>, view: View, id: string, queue: object = enabled) {
  open(chat, sessions, id, queue, view);
  await waitFor(() => expect(ctx.activeSessionId).toBe(id));
  await waitFor(() => expect(ctx.canCompose).toBe(true));
}

/** Lets a flush that would be triggered by the last change run, without a timer the code under test depends on. */
/** Decides the approval of the left chat (the id is all a stale card or a custom UI would hold), lets its resumed run end. */
async function decideLeftApproval(chat: SessionChat, decision: 'approve' | 'reject') {
  await act(async () => { await ctx[decision]('approval-1'); });
  expect(chat.addToolApprovalResponse).toHaveBeenCalledWith(expect.objectContaining({ id: 'approval-1' }));
  await act(async () => { chat.finish(); });
  await settle();
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

async function ready(chat: SessionChat, sessions: ReturnType<typeof store>, queue: object = enabled) {
  const view = open(chat, sessions, 'A', queue);
  await waitFor(() => expect(ctx.canCompose).toBe(true));
  return view;
}

describe('queue flush versus session switch: running turn', () => {
  it('(a, b, e) the queue of the left chat is emptied; after the end of its turn no further request is made', async () => {
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const events: string[] = [];
    const queue = { ...enabled, onQueueChange: (event: ChatQueueChangeEvent) => events.push(event.reason) };
    const view = await ready(chat, sessions, queue);
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.send('queued in A 1'); ctx.send('queued in A 2'); });
    expect(queuedTexts()).toEqual(['queued in A 1', 'queued in A 2']);

    await switchTo(chat, sessions, view, 'B', queue);
    expect(idsOf()).toEqual(['b-u1', 'b-a1']);
    expect(ctx.queue.items).toHaveLength(0);
    expect(ctx.queue.paused).toBe(false);
    expect(events).toEqual(['added', 'added', 'cleared']);

    // The request of A ends while B is open.
    await act(async () => { chat.finish(); });
    await settle();
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(carriedUsers(chat)).toEqual([['first']]);
    expect(ctx.queue.items).toHaveLength(0);
    // Its outcome is not recorded on B's turn.
    expect(ctx.turnOutcomes?.get('b-u1')).toBeUndefined();
    expect(ctx.turnOutcomes?.size ?? 0).toBe(0);

    // Back in A the queued messages are gone (no storage): nothing is sent.
    await switchTo(chat, sessions, view, 'A', queue);
    await settle();
    expect(ctx.queue.items).toHaveLength(0);
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(carriedUsers(chat)).toEqual([['first']]);
    expect(events).toEqual(['added', 'added', 'cleared']);
  });

  it('(b, c) with storage the left chat\'s queue comes back paused on return and is sent into that chat only', async () => {
    const db = new Map<string, QueuedMessage[]>();
    const storage: ChatQueueStorage = {
      load: (id) => [...(db.get(id) ?? [])],
      save: (id, items) => { db.set(id, [...items]); },
    };
    const queue = { ...enabled, storage };
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions, queue);
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.send('queued in A'); });
    await switchTo(chat, sessions, view, 'B', queue);
    expect(ctx.queue.items).toHaveLength(0);
    // Leaving does not erase what the adapter stores for A.
    expect(db.get('A')?.map((item) => item.text)).toEqual(['queued in A']);
    await act(async () => { chat.finish(); });
    await settle();
    expect(chat.sentIn.map((entry) => entry.text)).toEqual(['first']);

    await switchTo(chat, sessions, view, 'A', queue);
    await waitFor(() => expect(queuedTexts()).toEqual(['queued in A']));
    expect(ctx.queue.paused).toBe(true);
    await settle();
    expect(chat.sentIn.map((entry) => entry.text)).toEqual(['first']);

    await act(async () => { ctx.resumeQueue(); });
    await waitFor(() => expect(chat.sentIn).toEqual([
      { text: 'first', session: 'A' }, { text: 'queued in A', session: 'A' },
    ]));
    expect(carriedUsers(chat)).toEqual([['first'], ['first', 'queued in A']]);
    expect(db.get('A') ?? []).toEqual([]);
    // B never saw it.
    expect(db.get('B') ?? []).toEqual([]);
  });

  it('(e) a message queued in B while the request of A still runs is sent once, into B, after A ends', async () => {
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions);
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.send('queued in A'); });
    await switchTo(chat, sessions, view, 'B');
    expect(ctx.isLoading).toBe(true);
    let result = '';
    await act(async () => { result = ctx.submit('queued in B'); });
    expect(result).toBe('queued');
    expect(queuedTexts()).toEqual(['queued in B']);
    await settle();
    expect(chat.sentIn.map((entry) => entry.text)).toEqual(['first']);

    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sentIn).toEqual([
      { text: 'first', session: 'A' }, { text: 'queued in B', session: 'B' },
    ]));
    expect(ctx.queue.items).toHaveLength(0);
    // The request carries B's history and the new text, nothing the user typed in A.
    expect(carriedUsers(chat)).toEqual([['first'], ['b question', 'queued in B']]);
    // The end of A's request was not booked on B's old turn; only B's own new turn has an outcome.
    expect(ctx.turnOutcomes?.get('b-u1')).toBeUndefined();
    await act(async () => { chat.finish(); });
    await settle();
    const own = ctx.messages.filter((message) => message.role === 'user' && message.id !== 'b-u1').map((message) => message.id);
    expect(own).toHaveLength(1);
    expect(ctx.turnOutcomes?.get(own[0]!)?.status).toBe('completed');
    expect([...(ctx.turnOutcomes?.keys() ?? [])]).toEqual(own);
    expect(chat.sentIn).toHaveLength(2);
  });

  it('(c) A to B to A while the request of A runs: both queues are gone, no further request is made', async () => {
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions);
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.send('queued in A'); });
    await switchTo(chat, sessions, view, 'B');
    await act(async () => { ctx.send('queued in B'); });
    expect(queuedTexts()).toEqual(['queued in B']);
    await switchTo(chat, sessions, view, 'A');
    expect(ctx.queue.items).toHaveLength(0);
    await act(async () => { chat.finish(); });
    await settle();
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(carriedUsers(chat)).toEqual([['first']]);
    expect(ctx.queue.items).toHaveLength(0);
  });

  it('(f) switching while a flush is in flight: that message is not sent again, the rest of the old queue is dropped, and B\'s message carries none of A\'s texts', async () => {
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions);
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.send('flushed'); ctx.send('dropped'); });
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sentIn.map((entry) => entry.text)).toEqual(['first', 'flushed']));
    expect(queuedTexts()).toEqual(['dropped']);
    expect(ctx.isLoading).toBe(true);

    await switchTo(chat, sessions, view, 'B');
    expect(ctx.queue.items).toHaveLength(0);
    await act(async () => { ctx.send('queued in B'); });
    expect(queuedTexts()).toEqual(['queued in B']);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sentIn).toEqual([
      { text: 'first', session: 'A' }, { text: 'flushed', session: 'A' }, { text: 'queued in B', session: 'B' },
    ]));
    await act(async () => { chat.finish(); });
    await settle();
    expect(chat.sentIn).toHaveLength(3);
    expect(carriedUsers(chat)).toEqual([['first'], ['first', 'flushed'], ['b question', 'queued in B']]);
    expect(ctx.queue.items).toHaveLength(0);
  });

  // The old queue is also guarded by the in-flight flag and the immediate clear; this pins the outcome.
  it.each([
    ['the switch first, then the end of the request', true],
    ['the end of the request first, then the switch', false],
  ])('(f) the switch and the end of the request in one batch (%s): nothing of the old queue goes out', async (_name, switchFirst) => {
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions);
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.send('queued in A'); });
    await act(async () => {
      if (switchFirst) {
        open(chat, sessions, 'B', enabled, view);
        chat.finish();
      } else {
        chat.finish();
        open(chat, sessions, 'B', enabled, view);
      }
    });
    await waitFor(() => expect(ctx.activeSessionId).toBe('B'));
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await settle();
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(carriedUsers(chat)).toEqual([['first']]);
    expect(ctx.queue.items).toHaveLength(0);
  });

  it('(a, d) while the new chat loads a message is refused with reason session, nothing of the old queue is sent after the load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions);
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.send('queued in A'); });
    const slow = sessions.session('B');
    view.rerender(<Host chat={chat} config={{ session: { ...slow, load: async (id: string) => { await gate; return slow.load!(id); } }, queue: enabled }} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('B'));
    expect(ctx.canCompose).toBe(false);
    expect(ctx.queue.items).toHaveLength(0);
    // While B loads the composer refuses, queue or not.
    expect(ctx.submitWithResult('too early')).toEqual({ status: 'rejected', reason: 'session' });
    await act(async () => { chat.finish(); });
    await settle();
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    await act(async () => { release(); });
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await settle();
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(carriedUsers(chat)).toEqual([['first']]);
    expect(ctx.queue.items).toHaveLength(0);
  });
});

describe('queue flush versus session switch: open approval', () => {
  it('(a, b, c) queued behind an approval, the chat is switched: the queue is dropped, also when A is opened again', async () => {
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions);
    await act(async () => { ctx.send('first'); });
    await act(async () => { chat.finish(approvalParts()); });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { ctx.send('queued behind approval'); });
    expect(queuedTexts()).toEqual(['queued behind approval']);

    await switchTo(chat, sessions, view, 'B');
    expect(ctx.queue.items).toHaveLength(0);
    expect(ctx.pendingApprovals).toHaveLength(0);
    expect(ctx.approvalReminder).toBe(false);
    await decideLeftApproval(chat, 'approve');
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(carriedUsers(chat)).toEqual([['first']]);

    // Back in A the queue is empty (an open approval is not part of the stored history), so nothing is sent.
    await switchTo(chat, sessions, view, 'A');
    expect(ctx.queue.items).toHaveLength(0);
    await settle();
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
  });

  it('(c) with storage the message queued behind an approval comes back paused and is sent only after resumeQueue', async () => {
    const db = new Map<string, QueuedMessage[]>();
    const storage: ChatQueueStorage = {
      load: (id) => [...(db.get(id) ?? [])],
      save: (id, items) => { db.set(id, [...items]); },
    };
    const queue = { ...enabled, storage };
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions, queue);
    await act(async () => { ctx.send('first'); });
    await act(async () => { chat.finish(approvalParts()); });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { ctx.send('queued behind approval'); });
    await switchTo(chat, sessions, view, 'B', queue);
    await switchTo(chat, sessions, view, 'A', queue);
    await waitFor(() => expect(queuedTexts()).toEqual(['queued behind approval']));
    expect(ctx.queue.paused).toBe(true);
    await settle();
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(queuedTexts()).toEqual(['queued behind approval']);
    await act(async () => { ctx.resumeQueue(); });
    await waitFor(() => expect(chat.sentIn.map((entry) => entry.session)).toEqual(['A', 'A']));
    expect(chat.sentIn[1]!.text).toBe('queued behind approval');
  });

  it('(e) an approval left open in A does not hold B: a message sent there goes out at once, once', async () => {
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions);
    await act(async () => { ctx.send('first'); });
    await act(async () => { chat.finish(approvalParts()); });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await switchTo(chat, sessions, view, 'B');
    await act(async () => { ctx.send('queued in B'); });
    // B is idle: it goes at once, there is no approval open in B.
    expect(chat.sentIn).toEqual([
      { text: 'first', session: 'A' }, { text: 'queued in B', session: 'B' },
    ]);
    await act(async () => { chat.finish(); });
    await settle();
    expect(chat.sentIn).toHaveLength(2);
    expect(ctx.queue.items).toHaveLength(0);
  });
});

describe('queue flush versus session switch: switchSession, createSession, clear', () => {
  function uncontrolled(initial: Record<string, ChatMessage[]>) {
    const histories: Record<string, ChatMessage[]> = { ...initial };
    let created = 0;
    const session: SessionConfig = {
      defaultActiveId: 'A',
      list: async () => Object.keys(histories).map((id) => ({ id, title: id, updatedAt: '2026-01-01T00:00:00.000Z' })),
      create: async () => { created += 1; const id = `N${created}`; histories[id] = []; return { id, title: id, updatedAt: '2026-01-01T00:00:00.000Z' }; },
      remove: async (id: string) => { delete histories[id]; },
      load: async (id: string) => histories[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => { histories[id] = messages; },
    };
    return session;
  }

  const mount = async (chat: SessionChat, session: SessionConfig) => {
    const view = render(<Host chat={chat} config={{ session, queue: enabled }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    return view;
  };

  it('(a) switchSession and createSession are refused while a request runs: the queue stays, nothing moves', async () => {
    const chat = new SessionChat();
    await mount(chat, uncontrolled({ A: [], B }));
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.send('queued in A'); });
    await act(async () => { await ctx.switchSession('B'); });
    let created: unknown = 'unset';
    await act(async () => { created = await ctx.createSession(); });
    expect(created).toBeNull();
    expect(ctx.activeSessionId).toBe('A');
    expect(queuedTexts()).toEqual(['queued in A']);
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sentIn.map((entry) => entry.text)).toEqual(['first', 'queued in A']));
    expect(chat.sentIn.every((entry) => entry.session === 'A')).toBe(true);
  });

  it('(a, b) switchSession while an approval is open drops the queue; approving the left chat\'s approval afterwards sends nothing', async () => {
    const chat = new SessionChat();
    await mount(chat, uncontrolled({ A: [], B }));
    await act(async () => { ctx.send('first'); });
    await act(async () => { chat.finish(approvalParts()); });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { ctx.send('queued behind approval'); });
    await act(async () => { await ctx.switchSession('B'); });
    await waitFor(() => expect(ctx.activeSessionId).toBe('B'));
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    expect(ctx.queue.items).toHaveLength(0);
    await decideLeftApproval(chat, 'approve');
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(carriedUsers(chat)).toEqual([['first']]);
    expect(ctx.queue.items).toHaveLength(0);
  });

  it('(a, b) createSession while an approval is open drops the queue; rejecting the left approval afterwards sends nothing into the new chat', async () => {
    const chat = new SessionChat();
    await mount(chat, uncontrolled({ A: [] }));
    await act(async () => { ctx.send('first'); });
    await act(async () => { chat.finish(approvalParts()); });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { ctx.send('queued behind approval'); });
    await act(async () => { await ctx.createSession(); });
    await waitFor(() => expect(ctx.activeSessionId).toBe('N1'));
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    expect(ctx.queue.items).toHaveLength(0);
    expect(idsOf()).toEqual([]);
    await decideLeftApproval(chat, 'reject');
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(carriedUsers(chat)).toEqual([['first']]);
    // The new chat works as a fresh one.
    await act(async () => { expect(ctx.submit('hello new')).toBe('sent'); });
    expect(chat.sentIn[1]).toEqual({ text: 'hello new', session: 'N1' });
    expect(carriedUsers(chat)[1]).toEqual(['hello new']);
  });

  it('(a, b) removing the active chat while an approval is open drops its queue; rejecting afterwards sends nothing', async () => {
    const chat = new SessionChat();
    await mount(chat, uncontrolled({ A: [], B }));
    await act(async () => { ctx.send('first'); });
    await act(async () => { chat.finish(approvalParts()); });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { ctx.send('queued behind approval'); });
    await act(async () => { await ctx.removeSession('A'); });
    await waitFor(() => expect(ctx.activeSessionId).toBe('B'));
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    expect(ctx.queue.items).toHaveLength(0);
    await decideLeftApproval(chat, 'reject');
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(carriedUsers(chat)).toEqual([['first']]);
  });

  it('(b, e) clear() while a request runs drops the queue; the end of the cleared run sends nothing and records no outcome', async () => {
    const chat = new SessionChat();
    await mount(chat, uncontrolled({ A: [] }));
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.send('queued'); });
    await act(async () => { ctx.clear(); });
    expect(ctx.queue.items).toHaveLength(0);
    await act(async () => { chat.finish(); });
    await settle();
    expect(chat.sentIn).toEqual([{ text: 'first', session: 'A' }]);
    expect(ctx.turnOutcomes?.size ?? 0).toBe(0);
    // The cleared chat takes messages again.
    await act(async () => { expect(ctx.submit('after clear')).toBe('sent'); });
    expect(chat.sentIn.map((entry) => entry.text)).toEqual(['first', 'after clear']);
  });

  it('(b) clear() while an approval is open drops the queue; approving afterwards sends nothing', async () => {
    const chat = new SessionChat();
    await mount(chat, uncontrolled({ A: [] }));
    await act(async () => { ctx.send('first'); });
    await act(async () => { chat.finish(approvalParts()); });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { ctx.send('queued behind approval'); });
    await act(async () => { ctx.clear(); });
    expect(ctx.queue.items).toHaveLength(0);
    await decideLeftApproval(chat, 'approve');
    expect(chat.sentIn.map((entry) => entry.text)).toEqual(['first']);
    expect(carriedUsers(chat)).toEqual([['first']]);
    expect(ctx.queue.items).toHaveLength(0);
  });
});

describe('queue flush versus session switch: rejection status', () => {
  it('(d) a refusal in A is gone after the switch; B starts with a clean queue (a full queue of A does not refuse B)', async () => {
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const queue = { ...enabled, maxSize: 1 };
    const view = await ready(chat, sessions, queue);
    await act(async () => { ctx.send('first'); });
    await act(async () => { expect(ctx.submitWithResult('fits')).toEqual({ status: 'queued' }); });
    await act(async () => { expect(ctx.submitWithResult('too many')).toEqual({ status: 'rejected', reason: 'queue-full' }); });
    expect(ctx.lastRejection?.reason).toBe('queue-full');

    await switchTo(chat, sessions, view, 'B', queue);
    expect(ctx.lastRejection).toBeNull();
    let result: unknown;
    await act(async () => { result = ctx.submitWithResult('fits in B'); });
    expect(result).toEqual({ status: 'queued' });
    expect(ctx.lastRejection).toBeNull();
    await act(async () => { result = ctx.submitWithResult('too many in B'); });
    expect(result).toEqual({ status: 'rejected', reason: 'queue-full' });
    expect(ctx.lastRejection?.reason).toBe('queue-full');
  });

  it('(d) a refusal in B is not cleared by the end of the run of A, and not by its flush', async () => {
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions);
    await act(async () => { ctx.send('first'); });
    await switchTo(chat, sessions, view, 'B');
    await act(async () => { ctx.submitWithResult('with file', { files: [file] }); });
    expect(ctx.lastRejection?.reason).toBe('attachments-off');
    await act(async () => { ctx.send('queued in B'); });
    expect(ctx.lastRejection).toBeNull();
    await act(async () => { ctx.submitWithResult('with file', { files: [file] }); });
    const refusal = ctx.lastRejection;
    expect(refusal?.reason).toBe('attachments-off');
    await act(async () => { chat.finish(); });
    await waitFor(() => expect(chat.sentIn.map((entry) => entry.session)).toEqual(['A', 'B']));
    // Sending a queued message is not an accepted submit: the refusal stays.
    expect(ctx.lastRejection).toBe(refusal);
  });

  it('(d) a refusal while the new chat loads belongs to the new chat and stays until the next accepted message', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    const view = await ready(chat, sessions);
    await act(async () => { ctx.send('first'); });
    const slow = sessions.session('B');
    view.rerender(<Host chat={chat} config={{ session: { ...slow, load: async (id: string) => { await gate; return slow.load!(id); } }, queue: enabled }} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('B'));
    await act(async () => { expect(ctx.submitWithResult('too early').status).toBe('rejected'); });
    expect(ctx.lastRejection?.reason).toBe('session');
    await act(async () => { release(); });
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    expect(ctx.lastRejection?.reason).toBe('session');
    await act(async () => { chat.finish(); });
    await act(async () => { expect(ctx.submitWithResult('now').status).toBe('sent'); });
    expect(ctx.lastRejection).toBeNull();
    expect(chat.sentIn.map((entry) => entry.session)).toEqual(['A', 'B']);
  });

  it('(d) a refusal in A is gone after clear(), also with the queue on and a run ending later', async () => {
    const sessions = store({ A: [], B });
    const chat = new SessionChat();
    await ready(chat, sessions);
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.submitWithResult('with file', { files: [file] }); });
    expect(ctx.lastRejection?.reason).toBe('attachments-off');
    await act(async () => { ctx.clear(); });
    expect(ctx.lastRejection).toBeNull();
    await act(async () => { chat.finish(); });
    expect(ctx.lastRejection).toBeNull();
  });
});
