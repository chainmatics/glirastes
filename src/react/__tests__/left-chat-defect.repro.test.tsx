// @vitest-environment jsdom
// REPRODUCTIONS (`it.fails`, red on main by design): a request of chat A that still runs when the host opens
// chat B (`session.activeId`) writes into B, because one transport (one AI SDK `Chat`) serves every chat.
// The planned fix: a pool of one AI SDK `Chat` per session inside the transport, offered to the provider as an
// optional `transport.sessions` capability, so a left chat's request goes on in the background. Its pull requests
// flip these to `it`: R1, R3 and R4 the transport pool and the provider policy (the fake transport then gets the
// `sessions` capability), R5 the
// `VercelAiChat` step (PR5). R2 (`clear()` during a run) is not here: it ships with its own fix (the clear() pull request) as a
// passing test (clear-during-run.test.tsx).
// The patterns the fix must keep are pinned in left-chat-patterns.test.tsx.

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { MessageList } from '../components/message-list.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import { VercelAiChat } from '../transports/vercel/vercel-ai-chat.js';
import type { ChatMessage, SessionConfig } from '../types.js';
import { ctx, Host, Probe, renderedTurns, StreamingChat } from './streaming-chat.js';
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
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const storedOutcome = (messages: ChatMessage[] | undefined, id: string) =>
  (messages?.find((message) => message.id === id) as { metadata?: Record<string, unknown> } | undefined)
    ?.metadata?.glirastesTurnOutcome as { status?: string } | undefined;

/** A host-owned store: `activeId` comes from the host, `save` writes back into it. */
function store(initial: Record<string, ChatMessage[]>) {
  const histories: Record<string, ChatMessage[]> = { ...initial };
  const session = (activeId: string): SessionConfig => ({
    activeId,
    load: async (id: string) => histories[id] ?? [],
    save: (id: string, messages: ChatMessage[]) => { histories[id] = messages; },
  });
  return { histories, session };
}

function VercelHost({ session }: { session: SessionConfig }) {
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  return (
    <AiChatProvider transport={transport} session={session}>
      <Probe />
      <MessageList />
    </AiChatProvider>
  );
}

describe('R1 a host switch A to B while A streams', () => {
  it.fails('fake transport: B shows, stores and sends nothing of A; A\'s store gets the answer and the outcome', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    const aUser = ctx.messages[0]!.id;
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();

    expect(JSON.stringify(ctx.messages)).not.toContain('ANSWER');
    expect(JSON.stringify(histories.B)).not.toContain('ANSWER');
    expect(JSON.stringify(histories.A)).toContain('ANSWER OF A');
    expect(storedOutcome(histories.A, aUser)?.status).toBe('completed');
    await act(async () => { ctx.send('b follow-up'); });
    expect(JSON.stringify(chat.requests.at(-1))).not.toContain('ANSWER');
  });

  it.fails('Vercel transport: B shows, stores and sends nothing of A; A\'s store gets the answer and the outcome', async () => {
    const { histories, session } = store({ A: [], B });
    const view = render(<VercelHost session={session('A')} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    const aUser = ctx.messages[0]!.id;
    for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
    await waitFor(() => expect(JSON.stringify(ctx.messages)).toContain('ANSWER'));
    view.rerender(<VercelHost session={session('B')} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    await act(async () => {
      requests[0]!.push({ type: 'text-delta', id: 't', delta: 'OF A' });
      requests[0]!.push({ type: 'text-end', id: 't' });
      requests[0]!.push({ type: 'finish-step' });
      requests[0]!.push({ type: 'finish' });
      requests[0]!.end();
    });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();

    expect(requests[0]!.aborted).toBe(false);
    expect(JSON.stringify(ctx.messages)).not.toContain('ANSWER');
    expect(JSON.stringify(histories.B)).not.toContain('ANSWER');
    expect(JSON.stringify(histories.A)).toContain('ANSWER OF A');
    expect(storedOutcome(histories.A, aUser)?.status).toBe('completed');
    await act(async () => { ctx.send('b follow-up'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:b question', 'assistant:b answer', 'user:b follow-up']);
  });
});

describe('R3 a reload after the run of a left chat ended', () => {
  it.fails('A loads with its answer and the notice of how its turn ended', async () => {
    const { session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    act(() => chat.stream([{ type: 'text', text: 'PARTIAL OF A' }]));
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    // A's request fails in the background.
    await act(async () => { chat.fail(); });
    await settle();

    // A page load: a new provider and a new transport open A from the store.
    view.unmount();
    render(<Host chat={new StreamingChat()} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    const turns = renderedTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toContain('PARTIAL OF A');
    expect(turns[0]!.notice).not.toBeNull();
  });
});

describe('R4 the pipeline of a left chat', () => {
  it.fails('pipeline state and steps of A\'s request do not reach B', async () => {
    const { session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(shownIds()).toEqual(['b-u1', 'b-a1']));
    act(() => {
      chat.emit({ type: 'data-step-report', data: { stepNumber: 0, toolCalls: [], finishReason: 'tool-calls' } });
      chat.emit({
        type: 'data-pipeline-state',
        data: { status: 'running', totalSteps: 1, maxSteps: 4, stepLimitSource: 'safety', updatedAt: 'x' },
      });
    });
    await settle();
    expect(ctx.pipelineSteps).toEqual([]);
    expect(ctx.pipelineState).toBeNull();
  });
});

describe('R5 VercelAiChat with sessions', () => {
  /** A's request asks for an approval; the user approves while the run still streams. */
  async function approvedWhileStreaming() {
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('delete t1'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.body.sessionId).toBe('A');
    await act(async () => {
      requests[0]!.push({ type: 'start' });
      requests[0]!.push({ type: 'start-step' });
      requests[0]!.push({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'tasks_delete', input: { id: 't1' } });
      requests[0]!.push({ type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'c1' });
    });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { await ctx.approve('ap-1'); });
  }
  const endRun = () => act(async () => {
    requests[0]!.push({ type: 'finish-step' });
    requests[0]!.push({ type: 'finish' });
    requests[0]!.end();
  });
  const sessions = (activeId: string): SessionConfig => ({ activeId, load: async () => [], save: () => {} });

  // Control for the repro below: the same setup without a switch works today, so a broken setup cannot hide
  // behind `it.fails`.
  it('control: without a switch the continuation is sent once the run ended, with sessionId A and the approval answer', async () => {
    render(<VercelAiChat endpoint="/api/chat" sessions={sessions('A')}><Probe /></VercelAiChat>);
    await approvedWhileStreaming();
    expect(requests).toHaveLength(1);
    await endRun();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.body.sessionId).toBe('A');
    const parts = (requests[1]!.body.messages as Array<{ role: string; parts: Array<{ toolCallId?: string; approval?: unknown }> }>)
      .at(-1)!.parts.filter((part) => part.toolCallId === 'c1');
    expect(parts.map((part) => part.approval)).toEqual([expect.objectContaining({ id: 'ap-1', approved: true })]);
    await act(async () => { requests[1]!.answer('Deleted.'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
  });

  it.fails('a continuation request of chat A carries sessionId A, also when B is active by then', async () => {
    const view = render(<VercelAiChat endpoint="/api/chat" sessions={sessions('A')}><Probe /></VercelAiChat>);
    await approvedWhileStreaming();
    view.rerender(<VercelAiChat endpoint="/api/chat" sessions={sessions('B')}><Probe /></VercelAiChat>);
    await settle();
    await endRun();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.body.sessionId).toBe('A');
  });
});
