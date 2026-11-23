// @vitest-environment jsdom
// CHARACTERISATION (green on main): app patterns around a running request and a change of the open chat that
// work today. The session pool planned in docs/plans/2026-11-23-design-left-chat.md must keep every one of them.
// The defect itself (one transport shared by every chat) is reproduced in left-chat-defect.repro.test.tsx.

import React, { useMemo } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Chat, useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { MessageList } from '../components/message-list.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import type { AiChatProviderConfig, ChatMessage, ChatTransport, SessionConfig } from '../types.js';
import { ctx, Host, Probe, StreamingChat } from './streaming-chat.js';
import { carried, stubControlledFetch, textChunks, type ControlledRequest } from './controlled-fetch.js';

let requests: ControlledRequest[];
beforeEach(() => {
  ({ requests } = stubControlledFetch());
});
afterEach(() => {
  cleanup();
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

function AppOwnedChats({ chats, activeId }: { chats: Map<string, Chat<UIMessage>>; activeId: string }) {
  const transport = useAppChatTransport(chats.get(activeId)!);
  return (
    <AiChatProvider transport={transport} session={{ activeId }}>
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

describe('C1 an app-owned AI SDK Chat per conversation', () => {
  it('A to B while A streams: nothing is stopped, A\'s Chat gets the answer, B stays as it was', async () => {
    const chats = appChats();
    const view = render(<AppOwnedChats chats={chats} activeId="A" />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
    await waitFor(() => expect(chats.get('A')!.status).toBe('streaming'));

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
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
    await waitFor(() => expect(chats.get('A')!.status).toBe('streaming'));

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
});

// ---------------------------------------------------------------------------------------------------------------
// C2: a draft id replaced by the real id while the first request runs (one built-in Vercel transport).
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
  const saves: Array<{ id: string; messages: ChatMessage[] }> = [];
  const save = (id: string, messages: ChatMessage[]) => { saves.push({ id, messages }); histories[id] = messages; };
  return { histories, saves, save };
}

/** Sends the first message in the draft chat and streams the start of its answer. */
async function firstRequestInDraft() {
  await waitFor(() => expect(ctx.canCompose).toBe(true));
  await act(async () => { ctx.send('first question'); });
  await waitFor(() => expect(requests).toHaveLength(1));
  for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
  await waitFor(() => expect(textOf(ctx.messages)).toEqual(['user:first question', 'assistant:ANSWER ']));
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
    // The app moves the draft's stored history to the real id.
    const loaded: string[] = [];
    const load = async (id: string) => { loaded.push(id); return store.histories[id === 'real' ? 'draft' : id] ?? []; };
    const view = render(<VercelHost session={{ activeId: 'draft', load, save: store.save }} />);
    await firstRequestInDraft();
    view.rerender(<VercelHost session={{ activeId: 'real', load, save: store.save }} />);
    await waitFor(() => expect(loaded).toContain('real'));
    await settle();
    await act(async () => { finish(requests[0]!, 'DONE'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(requests[0]!.aborted).toBe(false);
    expect(textOf(ctx.messages)).toEqual(['user:first question', 'assistant:ANSWER DONE']);
    expect(textOf(store.histories.real!)).toEqual(['user:first question', 'assistant:ANSWER DONE']);
  });

  it('C2c with load returning re-id\'d messages (as of main): not aborted; the loaded partial answer stays in the history as its own message next to the streamed answer, the chat shows one bubble', async () => {
    const store = draftStore();
    // The backend hands back what it stored for the draft under its own ids.
    const loaded: string[] = [];
    const load = async (id: string) => {
      loaded.push(id);
      return id === 'real'
        ? (store.histories.draft ?? []).map((message, index) => ({ ...message, id: `srv-${index}` }))
        : store.histories[id] ?? [];
    };
    const view = render(<VercelHost session={{ activeId: 'draft', load, save: store.save }} />);
    await firstRequestInDraft();
    view.rerender(<VercelHost session={{ activeId: 'real', load, save: store.save }} />);
    await waitFor(() => expect(loaded).toContain('real'));
    await settle();
    await act(async () => { finish(requests[0]!, 'DONE'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(requests[0]!.aborted).toBe(false);
    // Shown: the loaded question and one answer bubble with the whole streamed text.
    expect(textOf(ctx.messages)).toEqual(['user:first question', 'assistant:ANSWER DONE']);
    const streamedId = shownIds()[1]!;
    expect(shownIds()).toEqual(['srv-0', streamedId]);
    expect(streamedId).not.toBe('srv-1');
    // Stored (and held by the transport): the loaded partial answer `srv-1` stays as a message of its own.
    expect(store.histories.real!.map((message) => message.id)).toEqual(['srv-0', 'srv-1', streamedId]);
    expect(textOf(store.histories.real!)).toEqual(['user:first question', 'assistant:ANSWER ', 'assistant:ANSWER DONE']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C3: a wrapper that hands the provider a new transport object on every render.
// ---------------------------------------------------------------------------------------------------------------

let renders = 0;
function WrappedHost({ session }: { session: SessionConfig }) {
  renders += 1;
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  // A new object per render, as an app's own wrapper often does.
  const wrapped: ChatTransport = { ...transport, stop: () => transport.stop() };
  return (
    <AiChatProvider transport={wrapped} session={session}>
      <Probe />
      <MessageList />
    </AiChatProvider>
  );
}

describe('C3 a transport wrapper that is a new object on every render', () => {
  it('renders a bounded number of times; send, stop and a switch act on the right request', async () => {
    renders = 0;
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id: string) => histories[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => { histories[id] = messages; },
    });
    const view = render(<WrappedHost session={session('A')} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await settle();
    const idle = renders;
    await settle();
    expect(renders).toBe(idle);

    // Send: one request with A's message.
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(carried(requests[0]!)).toEqual(['user:a question']);
    for (const chunk of textChunks('partial')) requests[0]!.push(chunk);
    await waitFor(() => expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:partial']));

    // Stop: aborts that request, the partial answer stays, the turn is recorded as stopped.
    await act(async () => { ctx.stop(); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    expect(requests[0]!.aborted).toBe(true);
    expect(textOf(ctx.messages)).toEqual(['user:a question', 'assistant:partial']);
    const aUser = ctx.messages[0]!.id;
    expect(ctx.turnOutcomes.get(aUser)?.status).toBe('aborted');

    // Switch while idle: B is shown and B's next request carries B's history only.
    view.rerender(<WrappedHost session={session('B')} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('b follow-up'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:b question', 'assistant:b answer', 'user:b follow-up']);
    await act(async () => { requests[1]!.answer('B DONE'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    expect(requests[1]!.aborted).toBe(false);
    expect(textOf(histories.A!)).toEqual(['user:a question', 'assistant:partial']);

    // Bounded: no render loop once idle again.
    await settle();
    const after = renders;
    await settle();
    expect(renders).toBe(after);
    expect(after).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C4: a custom transport (no AI SDK, no session capability). The queue and outcome attribution of this case are
// pinned in chat-queue-session-switch, turn-outcome-attribution and turn-end-callback; this adds what is missing.
// ---------------------------------------------------------------------------------------------------------------

describe('C4 a custom transport without a session capability', () => {
  it('a host switch A to B to A while A runs neither stops nor resends; the transport object is the app\'s, unchanged', async () => {
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id: string) => histories[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => { histories[id] = messages; },
    });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    act(() => chat.stream([{ type: 'text', text: 'partial' }]));
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    view.rerender(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('A'));
    await settle();
    expect(chat.stop).not.toHaveBeenCalled();
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(Object.keys(chat.transport)).not.toContain('sessions');
  });
});
