// @vitest-environment jsdom
// CHARACTERISATION (green on main): app patterns around a running request and a change of the open chat that
// work today. The session pool planned in docs/plans/2026-11-23-design-left-chat.md must keep every one of them.
// The defect itself (one transport shared by every chat) is reproduced in left-chat-defect.repro.test.tsx.
// Tests marked KNOWN DEFECT are `it.fails`: they assert the correct behaviour that main does not have yet.

import React, { useEffect, useMemo } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat, useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { MessageList } from '../components/message-list.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import type { AiChatProviderConfig, ChatMessage, ChatTransport, SessionConfig } from '../types.js';
import { useChatContext } from '../provider/chat-context.js';
import { ctx, Probe, StreamingChat } from './streaming-chat.js';
import { carried, stubControlledFetch, textChunks, type ControlledRequest } from './controlled-fetch.js';

let requests: ControlledRequest[];
beforeEach(() => {
  ({ requests } = stubControlledFetch());
});
afterEach(() => {
  // No stream stays open past its test.
  for (const request of requests) request.close();
  cleanup();
  vi.unstubAllGlobals();
});

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const answer = (id: string, text: string): ChatMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] });
const B = [user('b-u1', 'b question'), answer('b-a1', 'b answer')];
const shownIds = () => ctx.messages.map((message) => message.id);
const textOf = (messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>) => messages.map((message) => `${message.role}:${
  message.parts.map((part) => ((part as { type: string }).type === 'text' ? (part as { text: string }).text : '')).join('')}`);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

/** Streams the rest of an answer started with `textChunks` and ends the request. */
function finish(request: ControlledRequest, tail: string) {
  request.push({ type: 'text-delta', id: 't', delta: tail });
  request.push({ type: 'text-end', id: 't' });
  request.push({ type: 'finish-step' });
  request.push({ type: 'finish' });
  request.end();
}

/** A store whose `activeId` the host owns. */
function hostStore(initial: Record<string, ChatMessage[]>) {
  const histories: Record<string, ChatMessage[]> = { ...initial };
  const saves: Array<{ id: string; text: string }> = [];
  const loads: string[] = [];
  const session = (activeId: string): SessionConfig => ({
    activeId,
    load: async (id: string) => { loads.push(id); return histories[id] ?? []; },
    save: (id: string, messages: ChatMessage[]) => { saves.push({ id, text: JSON.stringify(messages) }); histories[id] = messages; },
  });
  return { histories, saves, loads, session };
}

// ---------------------------------------------------------------------------------------------------------------
// C1: the app owns one AI SDK `Chat` per conversation and hands the provider the open one's transport.
// ---------------------------------------------------------------------------------------------------------------

/** The app's adapter from its own `Chat` to the provider's `ChatTransport`. */
function useAppChatTransport(chat: Chat<UIMessage>): ChatTransport {
  const { messages, status, error, sendMessage, stop, setMessages, addToolApprovalResponse } = useChat({ chat });
  return useMemo<ChatTransport>(() => ({
    messages: messages as unknown as ChatMessage[],
    status,
    error: error ?? null,
    sendMessage: ({ text }) => sendMessage({ text }),
    stop,
    setMessages: setMessages as unknown as ChatTransport['setMessages'],
    addToolApprovalResponse,
  }), [messages, status, error, sendMessage, stop, setMessages, addToolApprovalResponse]);
}

function AppOwnedChats({ chats, activeId, session, wrap = false }: {
  chats: Map<string, Chat<UIMessage>>;
  activeId: string;
  session?: SessionConfig;
  /** C3 on top: a new transport object on every render. */
  wrap?: boolean;
}) {
  const transport = useAppChatTransport(chats.get(activeId)!);
  const handed = wrap ? { ...transport, stop: () => transport.stop() } : transport;
  return (
    <AiChatProvider transport={handed} session={session ?? { activeId }}>
      <Probe />
      <MessageList />
    </AiChatProvider>
  );
}

function appChats() {
  const make = (id: string, messages: UIMessage[] = []) => new Chat<UIMessage>({
    id, messages, transport: new DefaultChatTransport({ api: '/api/chat' }),
  });
  return new Map([['A', make('A')], ['B', make('B', B as unknown as UIMessage[])]]);
}

/** A sends and streams the start of its answer (request 0). */
async function aStreams(chats: Map<string, Chat<UIMessage>>) {
  await waitFor(() => expect(ctx.canCompose).toBe(true));
  await act(async () => { ctx.send('a question'); });
  await waitFor(() => expect(requests).toHaveLength(1));
  for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
  await waitFor(() => expect(chats.get('A')!.status).toBe('streaming'));
}

/** In the open chat B: sends and streams the start of B's answer (request 1). */
async function bStreams(chats: Map<string, Chat<UIMessage>>) {
  await act(async () => { ctx.send('b follow-up'); });
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(carried(requests[1]!)).toEqual(['user:b question', 'assistant:b answer', 'user:b follow-up']);
  for (const chunk of textChunks('B ANSWER ')) requests[1]!.push(chunk);
  await waitFor(() => expect(chats.get('B')!.status).toBe('streaming'));
}

describe('C1 an app-owned AI SDK Chat per conversation', () => {
  it('A to B while A streams: nothing is stopped, A\'s Chat gets the answer, B stays as it was', async () => {
    const chats = appChats();
    const view = render(<AppOwnedChats chats={chats} activeId="A" />);
    await aStreams(chats);

    view.rerender(<AppOwnedChats chats={chats} activeId="B" />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    expect(ctx.isLoading).toBe(false);

    await act(async () => { finish(requests[0]!, 'OF A'); });
    await waitFor(() => expect(chats.get('A')!.status).toBe('ready'));
    await settle();
    expect(requests[0]!.aborted).toBe(false);
    expect(textOf(chats.get('A')!.messages)).toEqual(['user:a question', 'assistant:ANSWER OF A']);
    expect(textOf(chats.get('B')!.messages)).toEqual(['user:b question', 'assistant:b answer']);
    expect(shownIds()).toEqual(['b-u1', 'b-a1']);
    expect(JSON.stringify(ctx.messages)).not.toContain('ANSWER');

    // B's next request carries only B's history.
    await act(async () => { ctx.send('b follow-up'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:b question', 'assistant:b answer', 'user:b follow-up']);
  });

  it('A to B to A while A streams: A shows its live request and its whole answer, nothing is stopped', async () => {
    const chats = appChats();
    const view = render(<AppOwnedChats chats={chats} activeId="A" />);
    await aStreams(chats);

    view.rerender(<AppOwnedChats chats={chats} activeId="B" />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    view.rerender(<AppOwnedChats chats={chats} activeId="A" />);
    await waitFor(() => expect(ctx.isLoading).toBe(true));
    expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:ANSWER ']);

    await act(async () => { finish(requests[0]!, 'OF A'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    expect(requests[0]!.aborted).toBe(false);
    expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:ANSWER OF A']);
    expect(textOf(chats.get('B')!.messages)).toEqual(['user:b question', 'assistant:b answer']);
  });

  // KNOWN DEFECT (main): A's turn, which ends while A is open again, gets no outcome (no `completed`): returning
  // to a live A loses the turn binding.
  // Not covered by the pool design: the app-owned adapter has no `sessions` capability, so no row of
  // docs/plans/2026-11-23-design-left-chat.md applies and no planned PR flips this. A defect of the app-owned-Chat
  // pattern on main, to be decided separately.
  it.fails('KNOWN DEFECT A to B to A while A streams: A\'s turn is recorded as completed when it ends in A', async () => {
    const chats = appChats();
    const view = render(<AppOwnedChats chats={chats} activeId="A" />);
    await aStreams(chats);
    view.rerender(<AppOwnedChats chats={chats} activeId="B" />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    view.rerender(<AppOwnedChats chats={chats} activeId="A" />);
    await waitFor(() => expect(ctx.isLoading).toBe(true));
    await act(async () => { finish(requests[0]!, 'OF A'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(ctx.turnOutcomes.get(ctx.messages[0]!.id)?.status).toBe('completed');
  });

  it.each([false, true])('stop() in B aborts only B\'s request; A streams on and completes (wrapper per render: %s)', async (wrap) => {
    const chats = appChats();
    const view = render(<AppOwnedChats chats={chats} activeId="A" wrap={wrap} />);
    await aStreams(chats);
    view.rerender(<AppOwnedChats chats={chats} activeId="B" wrap={wrap} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    await bStreams(chats);

    await act(async () => { ctx.stop(); });
    await waitFor(() => expect(chats.get('B')!.status).toBe('ready'));
    expect(requests[1]!.aborted).toBe(true);
    expect(requests[0]!.aborted).toBe(false);
    expect(chats.get('A')!.status).toBe('streaming');
    // B's stopped turn is B's: its partial answer stays and the turn is recorded as stopped.
    expect(textOf(ctx.messages)).toEqual(['user:b question', 'assistant:b answer', 'user:b follow-up', 'assistant:B ANSWER ']);
    expect(ctx.turnOutcomes.get(ctx.messages[2]!.id)?.status).toBe('aborted');

    await act(async () => { finish(requests[0]!, 'OF A'); });
    await waitFor(() => expect(chats.get('A')!.status).toBe('ready'));
    expect(textOf(chats.get('A')!.messages)).toEqual(['user:a question', 'assistant:ANSWER OF A']);
  });

  it.each([false, true])('back in A while A and B stream: stop() aborts only A\'s request; B completes in B (wrapper per render: %s)', async (wrap) => {
    const chats = appChats();
    const view = render(<AppOwnedChats chats={chats} activeId="A" wrap={wrap} />);
    await aStreams(chats);
    view.rerender(<AppOwnedChats chats={chats} activeId="B" wrap={wrap} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    await bStreams(chats);
    view.rerender(<AppOwnedChats chats={chats} activeId="A" wrap={wrap} />);
    await waitFor(() => expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:ANSWER ']));

    await act(async () => { ctx.stop(); });
    await waitFor(() => expect(chats.get('A')!.status).toBe('ready'));
    expect(requests[0]!.aborted).toBe(true);
    expect(requests[1]!.aborted).toBe(false);
    expect(chats.get('B')!.status).toBe('streaming');
    expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:ANSWER ']);

    await act(async () => { finish(requests[1]!, 'DONE'); });
    await waitFor(() => expect(chats.get('B')!.status).toBe('ready'));
    expect(textOf(chats.get('B')!.messages)).toEqual(['user:b question', 'assistant:b answer', 'user:b follow-up', 'assistant:B ANSWER DONE']);
    expect(textOf(chats.get('A')!.messages)).toEqual(['user:a question', 'assistant:ANSWER ']);
  });
});

describe('C1 known defects of outcome attribution', () => {
  // KNOWN DEFECT (main): returning to a live A loses A's turn binding (as above), so a stop in A records nothing
  // on A's turn; whether B sent meanwhile does not matter (see the control below).
  // Not covered by the pool design: the app-owned adapter has no `sessions` capability, so no row of
  // docs/plans/2026-11-23-design-left-chat.md applies and no planned PR flips this. A defect of the app-owned-Chat
  // pattern on main, to be decided separately.
  it.fails('KNOWN DEFECT back in A while A and B stream: stop() records the aborted outcome on A\'s turn', async () => {
    const chats = appChats();
    const view = render(<AppOwnedChats chats={chats} activeId="A" />);
    await aStreams(chats);
    view.rerender(<AppOwnedChats chats={chats} activeId="B" />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    await bStreams(chats);
    view.rerender(<AppOwnedChats chats={chats} activeId="A" />);
    await waitFor(() => expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:ANSWER ']));
    await act(async () => { ctx.stop(); });
    await waitFor(() => expect(chats.get('A')!.status).toBe('ready'));
    expect(ctx.turnOutcomes.get(ctx.messages[0]!.id)?.status).toBe('aborted');
  });

  // Same defect without a request of B: A to B to A while A streams, stop in A.
  // Not covered by the pool design: the app-owned adapter has no `sessions` capability, so no row of
  // docs/plans/2026-11-23-design-left-chat.md applies and no planned PR flips this. A defect of the app-owned-Chat
  // pattern on main, to be decided separately.
  it.fails('KNOWN DEFECT A to B to A while A streams (B never sends): stop() records the aborted outcome on A\'s turn', async () => {
    const chats = appChats();
    const view = render(<AppOwnedChats chats={chats} activeId="A" />);
    await aStreams(chats);
    view.rerender(<AppOwnedChats chats={chats} activeId="B" />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    view.rerender(<AppOwnedChats chats={chats} activeId="A" />);
    await waitFor(() => expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:ANSWER ']));
    await act(async () => { ctx.stop(); });
    await waitFor(() => expect(chats.get('A')!.status).toBe('ready'));
    expect(requests[0]!.aborted).toBe(true);
    expect(ctx.turnOutcomes.get(ctx.messages[0]!.id)?.status).toBe('aborted');
  });
});

describe('C1 with a session store (load/save) next to the app-owned Chats', () => {
  it('A to B while A streams: nothing is stopped, A\'s Chat gets the answer, B shows and keeps its own history', async () => {
    const chats = appChats();
    const store = hostStore({ A: [], B });
    const view = render(<AppOwnedChats chats={chats} activeId="A" session={store.session('A')} />);
    await aStreams(chats);
    view.rerender(<AppOwnedChats chats={chats} activeId="B" session={store.session('B')} />);
    await waitFor(() => expect(store.loads).toContain('B'));
    await settle();
    expect(textOf(ctx.messages)).toEqual(['user:b question', 'assistant:b answer']);
    await act(async () => { finish(requests[0]!, 'OF A'); });
    await waitFor(() => expect(chats.get('A')!.status).toBe('ready'));
    await settle();
    expect(requests[0]!.aborted).toBe(false);
    expect(textOf(chats.get('A')!.messages)).toEqual(['user:a question', 'assistant:ANSWER OF A']);
    expect(textOf(chats.get('B')!.messages)).toEqual(['user:b question', 'assistant:b answer']);
    expect(textOf(store.histories.B!)).toEqual(['user:b question', 'assistant:b answer']);
    expect(store.saves.filter((entry) => entry.id === 'B' && entry.text.includes('ANSWER'))).toEqual([]);
  });

  it('A to B to A while A streams: A\'s live request ends in A\'s Chat, is shown and saved under A, nothing is stopped', async () => {
    const chats = appChats();
    const store = hostStore({ A: [], B });
    const view = render(<AppOwnedChats chats={chats} activeId="A" session={store.session('A')} />);
    await aStreams(chats);
    view.rerender(<AppOwnedChats chats={chats} activeId="B" session={store.session('B')} />);
    await waitFor(() => expect(store.loads).toContain('B'));
    await settle();
    view.rerender(<AppOwnedChats chats={chats} activeId="A" session={store.session('A')} />);
    await waitFor(() => expect(store.loads.filter((id) => id === 'A')).toHaveLength(2));
    await settle();
    expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:ANSWER ']);
    await act(async () => { finish(requests[0]!, 'OF A'); });
    await waitFor(() => expect(chats.get('A')!.status).toBe('ready'));
    await settle();
    expect(requests[0]!.aborted).toBe(false);
    expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:ANSWER OF A']);
    expect(textOf(store.histories.A!)).toEqual(['user:a question', 'assistant:ANSWER OF A']);
  });

  // KNOWN DEFECT (main): A's answer completes in A's Chat while B is open, but is never saved under A (only the
  // open chat is saved). Opening A again loads the stored partial answer into A's Chat (`setMessages`), so the
  // completed answer is lost from the Chat and the store.
  // Not covered by the pool design: the app-owned adapter has no `sessions` capability, so no row of
  // docs/plans/2026-11-23-design-left-chat.md applies and no planned PR flips this. A defect of the app-owned-Chat
  // pattern on main, to be decided separately.
  it.fails('KNOWN DEFECT A to B while A streams, A ends in the background, then A again: A shows and stores the whole answer', async () => {
    const chats = appChats();
    const store = hostStore({ A: [], B });
    const view = render(<AppOwnedChats chats={chats} activeId="A" session={store.session('A')} />);
    await aStreams(chats);
    view.rerender(<AppOwnedChats chats={chats} activeId="B" session={store.session('B')} />);
    await waitFor(() => expect(store.loads).toContain('B'));
    await settle();
    await act(async () => { finish(requests[0]!, 'OF A'); });
    await waitFor(() => expect(chats.get('A')!.status).toBe('ready'));
    await settle();
    view.rerender(<AppOwnedChats chats={chats} activeId="A" session={store.session('A')} />);
    await waitFor(() => expect(store.loads.filter((id) => id === 'A')).toHaveLength(2));
    await settle();
    expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:ANSWER OF A']);
    expect(textOf(store.histories.A!)).toEqual(['user:a question', 'assistant:ANSWER OF A']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C2: a draft id replaced by the real id while the first request runs (one built-in Vercel transport).
// The "rename without a signal, with re-id'd messages" case (C2c) is expected to change with `renamedFrom`:
// see the design's tables "Semantik ('background')" (rows "Entwurf->echt ...") and "Verhaltensaenderungen",
// item 5, in docs/plans/2026-11-23-design-left-chat.md.
// ---------------------------------------------------------------------------------------------------------------

function VercelHost({ session, config }: { session: SessionConfig; config?: Partial<AiChatProviderConfig> }) {
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  return (
    <AiChatProvider transport={transport} session={session} {...config}>
      <Probe />
      <MessageList />
    </AiChatProvider>
  );
}

function draftStore() {
  const histories: Record<string, ChatMessage[]> = {};
  const save = (id: string, messages: ChatMessage[]) => { histories[id] = messages; };
  return { histories, save };
}

/** Sends the first message in the draft chat and streams the start of its answer. */
async function firstRequestInDraft() {
  await waitFor(() => expect(ctx.canCompose).toBe(true));
  await act(async () => { ctx.send('first question'); });
  await waitFor(() => expect(requests).toHaveLength(1));
  for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
  await waitFor(() => expect(textOf(ctx.messages)).toEqual(['user:first question', 'assistant:ANSWER ']));
}

/** The draft's stored history under the real id: as stored, or re-id'd by the backend. */
function draftLoad(store: ReturnType<typeof draftStore>, reId: boolean, gate?: Promise<void>) {
  const loaded: string[] = [];
  const load = async (id: string) => {
    if (id !== 'real') return store.histories[id] ?? [];
    const stored = store.histories.draft ?? [];
    if (gate) await gate;
    loaded.push(id);
    return reId ? stored.map((message, index) => ({ ...message, id: `srv-${index}` })) : stored;
  };
  return { load, loaded };
}

/** Renames draft to real, ends the first request, then sends a second message. */
async function renameAndFinish(view: ReturnType<typeof render>, load: SessionConfig['load'], loaded: string[], save: SessionConfig['save']) {
  view.rerender(<VercelHost session={{ activeId: 'real', load, save }} />);
  await waitFor(() => expect(loaded).toContain('real'));
  await settle();
  await act(async () => { finish(requests[0]!, 'DONE'); });
  await waitFor(() => expect(ctx.isLoading).toBe(false));
  await settle();
}

describe('C2 a draft id replaced by the real id while the first request runs', () => {
  it('C2a without load: the answer ends in the chat under the real id, nothing is aborted', async () => {
    const store = draftStore();
    const view = render(<VercelHost session={{ activeId: 'draft', save: store.save }} />);
    await firstRequestInDraft();
    view.rerender(<VercelHost session={{ activeId: 'real', save: store.save }} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('real'));
    await act(async () => { finish(requests[0]!, 'DONE'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(requests[0]!.aborted).toBe(false);
    expect(textOf(ctx.messages)).toEqual(['user:first question', 'assistant:ANSWER DONE']);
    expect(textOf(store.histories.real!)).toEqual(['user:first question', 'assistant:ANSWER DONE']);
    // The next message goes on in the same conversation.
    await act(async () => { ctx.send('second'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:first question', 'assistant:ANSWER DONE', 'user:second']);
  });

  it('C2b with load returning the same messages: the answer ends in the chat under the real id, nothing is aborted', async () => {
    const store = draftStore();
    const { load, loaded } = draftLoad(store, false);
    const view = render(<VercelHost session={{ activeId: 'draft', load, save: store.save }} />);
    await firstRequestInDraft();
    await renameAndFinish(view, load, loaded, store.save);
    expect(requests[0]!.aborted).toBe(false);
    expect(textOf(ctx.messages)).toEqual(['user:first question', 'assistant:ANSWER DONE']);
    expect(textOf(store.histories.real!)).toEqual(['user:first question', 'assistant:ANSWER DONE']);
    await act(async () => { ctx.send('second'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:first question', 'assistant:ANSWER DONE', 'user:second']);
  });

  it('C2b with a slow load and a chunk arriving while it loads: the end state is right, nothing is aborted', async () => {
    const store = draftStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { load, loaded } = draftLoad(store, false, gate);
    const view = render(<VercelHost session={{ activeId: 'draft', load, save: store.save }} />);
    await firstRequestInDraft();
    view.rerender(<VercelHost session={{ activeId: 'real', load, save: store.save }} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('real'));
    await settle();
    await act(async () => { requests[0]!.push({ type: 'text-delta', id: 't', delta: 'MID ' }); });
    await act(async () => { release(); });
    await waitFor(() => expect(loaded).toContain('real'));
    await settle();
    await act(async () => { finish(requests[0]!, 'DONE'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(requests[0]!.aborted).toBe(false);
    expect(textOf(ctx.messages)).toEqual(['user:first question', 'assistant:ANSWER MID DONE']);
    expect(textOf(store.histories.real!)).toEqual(['user:first question', 'assistant:ANSWER MID DONE']);
    await act(async () => { ctx.send('second'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:first question', 'assistant:ANSWER MID DONE', 'user:second']);
  });

  // KNOWN DEFECT (main): while the real id's history loads, the provider has emptied the transport and the next
  // chunk writes the answer into it, so the chat shows the answer without its question until the load ends.
  // With the design's `renamedFrom` no load happens (row "Entwurf->echt mit renamedFrom" of
  // docs/plans/2026-11-23-design-left-chat.md); without the signal no planned PR changes it.
  it.fails('KNOWN DEFECT C2b with a slow load: while it loads the chat never shows the answer without its question', async () => {
    const store = draftStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { load } = draftLoad(store, false, gate);
    const view = render(<VercelHost session={{ activeId: 'draft', load, save: store.save }} />);
    await firstRequestInDraft();
    view.rerender(<VercelHost session={{ activeId: 'real', load, save: store.save }} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('real'));
    await settle();
    await act(async () => { requests[0]!.push({ type: 'text-delta', id: 't', delta: 'MID ' }); });
    await settle();
    const shown = textOf(ctx.messages);
    await act(async () => { release(); });
    expect(shown.length === 0 || shown[0] === 'user:first question').toBe(true);
  });

  // KNOWN DEFECT (main), same as below plus the race: the stored partial and the streamed answer both stay.
  // It can only flip once `renamedFrom` exists: without the signal the design deliberately keeps the answer under
  // the draft id (row "Entwurf->echt ohne Signal, Ids umbenannt" of docs/plans/2026-11-23-design-left-chat.md).
  it.fails('KNOWN DEFECT C2c with a slow load and a chunk arriving while it loads: the next request carries one answer', async () => {
    const store = draftStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { load, loaded } = draftLoad(store, true, gate);
    const view = render(<VercelHost session={{ activeId: 'draft', load, save: store.save }} />);
    await firstRequestInDraft();
    view.rerender(<VercelHost session={{ activeId: 'real', load, save: store.save }} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('real'));
    await settle();
    await act(async () => { requests[0]!.push({ type: 'text-delta', id: 't', delta: 'MID ' }); });
    await act(async () => { release(); });
    await waitFor(() => expect(loaded).toContain('real'));
    await settle();
    await act(async () => { finish(requests[0]!, 'DONE'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(requests[0]!.aborted).toBe(false);
    expect(textOf(ctx.messages)).toEqual(['user:first question', 'assistant:ANSWER MID DONE']);
    await act(async () => { ctx.send('second'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:first question', 'assistant:ANSWER MID DONE', 'user:second']);
  });

  it('C2c with load returning re-id\'d messages (as of main, changes with renamedFrom): the first request is not aborted and the chat shows one answer bubble', async () => {
    const store = draftStore();
    const { load, loaded } = draftLoad(store, true);
    const view = render(<VercelHost session={{ activeId: 'draft', load, save: store.save }} />);
    await firstRequestInDraft();
    await renameAndFinish(view, load, loaded, store.save);
    expect(requests[0]!.aborted).toBe(false);
    expect(textOf(ctx.messages)).toEqual(['user:first question', 'assistant:ANSWER DONE']);
    expect(shownIds()[0]).toBe('srv-0');
  });

  // KNOWN DEFECT (main): the loaded partial answer `srv-1` stays in the history as a message of its own next to
  // the streamed answer; the UI merges them into one bubble, but the store and the next request carry both.
  // It can only flip once `renamedFrom` exists: without the signal the design deliberately keeps the answer under
  // the draft id (row "Entwurf->echt ohne Signal, Ids umbenannt" of docs/plans/2026-11-23-design-left-chat.md).
  it.fails('KNOWN DEFECT C2c: neither the stored history nor the next request carries the loaded partial answer next to the streamed one', async () => {
    const store = draftStore();
    const { load, loaded } = draftLoad(store, true);
    const view = render(<VercelHost session={{ activeId: 'draft', load, save: store.save }} />);
    await firstRequestInDraft();
    await renameAndFinish(view, load, loaded, store.save);
    await act(async () => { ctx.send('second'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(textOf(store.histories.real!).filter((text) => text.startsWith('assistant:'))).toEqual(['assistant:ANSWER DONE']);
    expect(carried(requests[1]!)).toEqual(['user:first question', 'assistant:ANSWER DONE', 'user:second']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C3: a wrapper that hands the provider a new transport object on every render.
// ---------------------------------------------------------------------------------------------------------------

const renders = { host: 0, inner: 0 };
/** Inside the provider and reading its context: renders whenever the provider's value changes. */
function RenderCount() {
  useChatContext();
  renders.inner += 1;
  return null;
}
function WrappedHost({ session }: { session: SessionConfig }) {
  renders.host += 1;
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  // A new object per render, as an app's own wrapper often does.
  const wrapped: ChatTransport = { ...transport, stop: () => transport.stop() };
  return (
    <AiChatProvider transport={wrapped} session={session}>
      <Probe />
      <RenderCount />
      <MessageList />
    </AiChatProvider>
  );
}
const countRenders = () => ({ ...renders });
const since = (start: typeof renders) => ({ host: renders.host - start.host, inner: renders.inner - start.inner });

describe('C3 a transport wrapper that is a new object on every render', () => {
  it('renders a bounded number of times (idle and while streaming); send and stop act on the open chat\'s request, before and after a switch while idle', async () => {
    renders.host = 0;
    renders.inner = 0;
    const store = hostStore({ A: [], B });
    const view = render(<WrappedHost session={store.session('A')} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await settle();
    // Measured on main (deterministic): 3 renders of the host and 3 of a context reader inside the provider until
    // idle; the bound is that plus a fixed slack of 2.
    expect(renders.host).toBeLessThanOrEqual(3 + 2);
    expect(renders.inner).toBeLessThanOrEqual(3 + 2);
    let start = countRenders();
    await settle();
    expect(since(start)).toEqual({ host: 0, inner: 0 });

    // Send: one request with A's message.
    start = countRenders();
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(carried(requests[0]!)).toEqual(['user:a question']);
    for (const chunk of textChunks('partial')) requests[0]!.push(chunk);
    await waitFor(() => expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:partial']));
    for (let index = 0; index < 5; index += 1) {
      await act(async () => { requests[0]!.push({ type: 'text-delta', id: 't', delta: ` ${index}` }); });
    }
    await waitFor(() => expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:partial 0 1 2 3 4']));
    // Measured on main: 8 renders each for the send and six streamed chunks; the bound is that plus 2.
    expect(since(start).host).toBeLessThanOrEqual(8 + 2);
    expect(since(start).inner).toBeLessThanOrEqual(8 + 2);
    // While streaming and nothing arrives: no render.
    start = countRenders();
    await settle();
    expect(since(start)).toEqual({ host: 0, inner: 0 });

    // Stop: aborts that request, the partial answer stays, the turn is recorded as stopped.
    await act(async () => { ctx.stop(); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    expect(requests[0]!.aborted).toBe(true);
    expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:partial 0 1 2 3 4']);
    const aUser = ctx.messages[0]!.id;
    expect(ctx.turnOutcomes.get(aUser)?.status).toBe('aborted');

    // Switch while idle: B is shown and B's next request carries B's history only; stop acts on B's request.
    view.rerender(<WrappedHost session={store.session('B')} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('b follow-up'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:b question', 'assistant:b answer', 'user:b follow-up']);
    for (const chunk of textChunks('B partial')) requests[1]!.push(chunk);
    await waitFor(() => expect(JSON.stringify(ctx.messages)).toContain('B partial'));
    await act(async () => { ctx.stop(); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    expect(requests[1]!.aborted).toBe(true);
    expect(ctx.turnOutcomes.get(ctx.messages[2]!.id)?.status).toBe('aborted');
    expect(textOf(store.histories.A!)).toEqual(['user:a question', 'assistant:partial 0 1 2 3 4']);

    // No render loop once idle again.
    start = countRenders();
    await settle();
    expect(since(start)).toEqual({ host: 0, inner: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C4: a custom transport (no AI SDK, no session capability). The queue and outcome attribution of this case are
// pinned in chat-queue-session-switch, turn-outcome-attribution and turn-end-callback; this adds what is missing.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The optional members of `ChatTransport` the provider may look for, also the planned `sessions` capability (and
 * `setAutomaticSendsPaused` of the clear() fix). Edit this list when `ChatTransport` grows.
 */
const KNOWN_OPTIONAL_MEMBERS = [
  'subscribeToData', 'addToolOutput', 'continueTurn', 'continueAfterBudgetStop', 'setUiOutcomeReporting',
  'setRequestLanguage', 'setAutomaticSendsPaused', 'sessions',
];

/** What the provider does with the transport object it is given: property writes and reads of absent members. */
function watched(chat: StreamingChat) {
  const writes: PropertyKey[] = [];
  const absentReads: PropertyKey[] = [];
  let current: ChatTransport | null = null;
  let proxy: ChatTransport | null = null;
  const transport = () => {
    const next = chat.transport;
    // One proxy per transport state, as an app would hand the same object until something changed.
    if (!current || next.messages !== current.messages || next.status !== current.status || next.error !== current.error) {
      current = Object.freeze({ ...next });
      proxy = new Proxy(current, {
        get(target, key, receiver) {
          if (typeof key === 'string' && !(key in target)) absentReads.push(key);
          return Reflect.get(target, key, receiver);
        },
        has(target, key) {
          if (typeof key === 'string' && !(key in target)) absentReads.push(key);
          return Reflect.has(target, key);
        },
        set(_target, key) { writes.push(key); return false; },
        defineProperty(_target, key) { writes.push(key); return false; },
        deleteProperty(_target, key) { writes.push(key); return false; },
      });
    }
    return proxy!;
  };
  return { writes, absentReads, transport };
}

function WatchedHost({ chat, transport, session }: { chat: StreamingChat; transport: () => ChatTransport; session: SessionConfig }) {
  const [, force] = React.useReducer((count: number) => count + 1, 0);
  useEffect(() => chat.subscribe(force), [chat]);
  return (
    <AiChatProvider transport={transport()} session={session}>
      <Probe />
      <MessageList />
    </AiChatProvider>
  );
}

describe('C4 a custom transport without a session capability', () => {
  it('a host switch A to B to A while A runs neither stops nor resends; the provider writes nothing to the app\'s transport and reads no unknown member', async () => {
    const store = hostStore({ A: [], B });
    const chat = new StreamingChat();
    const seen = watched(chat);
    const view = render(<WatchedHost chat={chat} transport={seen.transport} session={store.session('A')} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    act(() => chat.stream([{ type: 'text', text: 'partial' }]));
    view.rerender(<WatchedHost chat={chat} transport={seen.transport} session={store.session('B')} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    view.rerender(<WatchedHost chat={chat} transport={seen.transport} session={store.session('A')} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('A'));
    await settle();
    await act(async () => { chat.finish(); });
    await settle();
    expect(chat.stop).not.toHaveBeenCalled();
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(seen.writes).toEqual([]);
    // Every absent member it looks for is a known optional one (it need not look for all of them).
    expect([...new Set(seen.absentReads)].filter((key) => !KNOWN_OPTIONAL_MEMBERS.includes(String(key)))).toEqual([]);
  });

  // The shared transport (intended to stay for transports without `sessions`, per the design): B is busy with
  // A's request; stop() in B stops it (the only one running), records nothing on B's turn and the outcome joins
  // A's turn. B's pipeline state shows the stop (R4-like).
  it('stop() in B after a host switch while A runs (intended to stay without sessions): stops the one shared request, the aborted outcome joins A\'s turn', async () => {
    const store = hostStore({ A: [], B });
    const chat = new StreamingChat();
    const seen = watched(chat);
    const view = render(<WatchedHost chat={chat} transport={seen.transport} session={store.session('A')} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    const aUser = ctx.messages[0]!.id;
    act(() => chat.stream([{ type: 'text', text: 'partial' }]));
    view.rerender(<WatchedHost chat={chat} transport={seen.transport} session={store.session('B')} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    expect(ctx.isLoading).toBe(true);
    await act(async () => { ctx.stop(); });
    await settle();
    expect(chat.stop).toHaveBeenCalledTimes(1);
    expect(ctx.isLoading).toBe(false);
    expect(textOf(ctx.messages)).toEqual(['user:b question', 'assistant:b answer']);
    expect(ctx.turnOutcomes.size).toBe(0);
    expect(ctx.pipelineState?.status).toBe('aborted');
    expect(textOf(store.histories.B!)).toEqual(['user:b question', 'assistant:b answer']);
    view.rerender(<WatchedHost chat={chat} transport={seen.transport} session={store.session('A')} />);
    await waitFor(() => expect(store.loads.filter((id) => id === 'A')).toHaveLength(2));
    await waitFor(() => expect(ctx.turnOutcomes.get(aUser)?.status).toBe('aborted'));
    expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:partial']);
  });
});
