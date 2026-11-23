// @vitest-environment jsdom
// clear() while a request runs: the request is stopped and its answer is neither shown nor stored, also when
// parts of it still arrive afterwards. Nothing of it is recorded (no outcome, no onTurnEnd).
// docs/plans/2026-11-23-design-left-chat.md ("clear() im Lauf").

import React, { StrictMode } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { MessageList } from '../components/message-list.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import type { AiChatProviderConfig, ChatMessage, SessionConfig, TurnEndInfo, TurnOutcome } from '../types.js';
import { ctx, Host, Probe, StreamingChat } from './streaming-chat.js';
import { carried, stubControlledFetch, textChunks, type ControlledRequest } from './controlled-fetch.js';

let requests: ControlledRequest[];
beforeEach(() => {
  ({ requests } = stubControlledFetch());
});
afterEach(cleanup);

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

function recorder() {
  const calls: Array<{ outcome: TurnOutcome; info: TurnEndInfo }> = [];
  return { calls, onTurnEnd: (outcome: TurnOutcome, info: TurnEndInfo) => { calls.push({ outcome, info }); } };
}

/** A store the provider owns the active id of (`defaultActiveId`), as the built-in session switcher uses it. */
function sessionStore() {
  const histories: Record<string, ChatMessage[]> = { A: [] };
  const saves: Array<{ id: string; messages: ChatMessage[] }> = [];
  const cleared: string[] = [];
  const session: SessionConfig = {
    defaultActiveId: 'A',
    load: async (id: string) => histories[id] ?? [],
    save: (id: string, messages: ChatMessage[]) => { saves.push({ id, messages }); histories[id] = messages; },
    clear: (id = 'A') => { cleared.push(id); histories[id] = []; },
  };
  return { histories, saves, cleared, session };
}

function VercelHost(props: Partial<AiChatProviderConfig>) {
  const transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  return (
    <AiChatProvider transport={transport} {...props}>
      <Probe />
      <MessageList />
    </AiChatProvider>
  );
}

/** Streams the rest of an answer started with `textChunks` and ends the request. */
function finish(request: ControlledRequest, tail: string) {
  request.push({ type: 'text-delta', id: 't', delta: tail });
  request.push({ type: 'text-end', id: 't' });
  request.push({ type: 'finish-step' });
  request.push({ type: 'finish' });
  request.end();
}

const seen = () => JSON.stringify(ctx.messages);

describe('clear() while a request of the built-in Vercel transport runs', () => {
  it('aborts the request; the answer is neither shown nor stored; nothing is recorded; the chat goes on empty', async () => {
    const store = sessionStore();
    const { calls, onTurnEnd } = recorder();
    render(<VercelHost session={store.session} onTurnEnd={onTurnEnd} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
    await waitFor(() => expect(seen()).toContain('ANSWER'));

    const savesBeforeClear = store.saves.length;
    await act(async () => { ctx.clear(); });
    expect(requests[0]!.aborted).toBe(true);
    // Whatever the server still sends is gone with the aborted request.
    await act(async () => { finish(requests[0]!, 'OF THE CLEARED CHAT'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();

    expect(ctx.messages).toEqual([]);
    expect(store.cleared).toEqual(['A']);
    expect(JSON.stringify(store.histories)).not.toContain('ANSWER');
    // No save after the clear carries any of it.
    expect(store.saves.slice(savesBeforeClear).filter((entry) => JSON.stringify(entry.messages).includes('ANSWER'))).toEqual([]);
    expect(ctx.turnOutcomes.size).toBe(0);
    expect(ctx.pipelineState).toBeNull();
    expect(calls).toEqual([]);

    // The next message starts a new conversation: its request carries only itself, and its turn reports.
    await act(async () => { ctx.send('after clear'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:after clear']);
    await act(async () => { requests[1]!.answer('NEW'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(seen()).not.toContain('ANSWER');
    expect(JSON.stringify(store.histories.A)).toContain('NEW');
    expect(JSON.stringify(store.histories.A)).not.toContain('ANSWER');
    expect(calls.map((call) => call.outcome.status)).toEqual(['completed']);
  });

  it('chunks already on their way when clear() is called do not reach the cleared chat', async () => {
    const store = sessionStore();
    render(<VercelHost session={store.session} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
    await waitFor(() => expect(seen()).toContain('ANSWER'));
    // More of the answer is in the stream already, and clear() comes in the same task.
    await act(async () => {
      requests[0]!.push({ type: 'text-delta', id: 't', delta: 'MORE' });
      requests[0]!.push({ type: 'data-pipeline-state', data: { status: 'running', totalSteps: 1, maxSteps: 4, stepLimitSource: 'safety', updatedAt: 'x' } });
      ctx.clear();
    });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(ctx.messages).toEqual([]);
    expect(ctx.pipelineState).toBeNull();
    expect(JSON.stringify(store.histories)).not.toContain('ANSWER');
  });

  it('before the first token (request submitted): aborted, nothing shown or stored', async () => {
    const store = sessionStore();
    render(<VercelHost session={store.session} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => { ctx.clear(); });
    expect(requests[0]!.aborted).toBe(true);
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(ctx.messages).toEqual([]);
    expect(store.histories.A).toEqual([]);
    expect(ctx.error).toBeNull();
  });

  it('under StrictMode: the same', async () => {
    const store = sessionStore();
    render(<StrictMode><VercelHost session={store.session} /></StrictMode>);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
    await waitFor(() => expect(seen()).toContain('ANSWER'));
    await act(async () => { ctx.clear(); });
    await act(async () => { finish(requests[0]!, 'LATE'); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(requests[0]!.aborted).toBe(true);
    expect(ctx.messages).toEqual([]);
    expect(JSON.stringify(store.histories)).not.toContain('ANSWER');
    await act(async () => { ctx.send('after clear'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(carried(requests[1]!)).toEqual(['user:after clear']);
  });

  it('with the queue: queued messages are dropped, nothing is sent after the aborted request ends', async () => {
    render(<VercelHost queue={{ enabled: true }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => { ctx.send('queued'); });
    expect(ctx.queue.items.map((item) => item.text)).toEqual(['queued']);
    await act(async () => { ctx.clear(); });
    expect(ctx.queue.items).toHaveLength(0);
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(requests).toHaveLength(1);
    expect(ctx.messages).toEqual([]);
  });
});

/** A custom transport whose `stop()` does not end its request: the run goes on until the server ends it. */
class UnstoppableChat extends StreamingChat {
  constructor() {
    super();
    this.stop.mockImplementation(() => {});
  }
}

describe('clear() while a request of a custom transport runs', () => {
  it('calls the transport\'s stop(); a transport that cannot stop: the chat stays busy and empty until its run ends, and nothing of the run is shown, stored or recorded', async () => {
    const store = sessionStore();
    const { calls, onTurnEnd } = recorder();
    const chat = new UnstoppableChat();
    render(<Host chat={chat} config={{ session: store.session, onTurnEnd }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    act(() => chat.stream([{ type: 'text', text: 'ANSWER ' }]));
    await act(async () => { ctx.clear(); });
    expect(chat.stop).toHaveBeenCalledTimes(1);
    expect(ctx.messages).toEqual([]);
    expect(ctx.isLoading).toBe(true);

    // The run goes on and ends: still nothing of it.
    act(() => {
      chat.stream([{ type: 'text', text: 'ANSWER STILL' }]);
      chat.emit({ type: 'data-step-report', data: { stepNumber: 0, toolCalls: [], finishReason: 'tool-calls' } });
    });
    expect(ctx.messages).toEqual([]);
    expect(ctx.pipelineSteps).toEqual([]);
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER END' }]); });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(ctx.messages).toEqual([]);
    expect(chat.messages).toEqual([]);
    expect(JSON.stringify(store.histories)).not.toContain('ANSWER');
    expect(ctx.turnOutcomes.size).toBe(0);
    expect(calls).toEqual([]);

    await act(async () => { ctx.send('after clear'); });
    expect(chat.requests.at(-1)!.map((message) => (message.parts[0] as { text: string }).text)).toEqual(['after clear']);
  });

  it('a transport that cannot stop and whose run then fails: no failure is shown for the cleared run', async () => {
    const chat = new UnstoppableChat();
    render(<Host chat={chat} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.clear(); });
    await act(async () => { chat.fail(); });
    await settle();
    expect(ctx.isLoading).toBe(false);
    expect(ctx.error).toBeNull();
    expect(ctx.messages).toEqual([]);
    expect(ctx.turnOutcomes.size).toBe(0);
  });

  it('the host opens another chat before the cleared run ended: that chat keeps the history it loaded', async () => {
    const B = [
      { id: 'b-u1', role: 'user', parts: [{ type: 'text', text: 'b question' }] },
      { id: 'b-a1', role: 'assistant', parts: [{ type: 'text', text: 'b answer' }] },
    ] as ChatMessage[];
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id: string) => histories[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => { histories[id] = messages; },
    });
    const chat = new UnstoppableChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.clear(); });
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('B'));
    await settle();
    // It ends without writing (a write would land in B: the shared-transport case of the left-chat design).
    await act(async () => { chat.fail(); });
    await settle();
    expect(ctx.isLoading).toBe(false);
    expect(ctx.error).toBeNull();
    expect(ctx.messages.map((message) => message.id)).toEqual(['b-u1', 'b-a1']);
    expect(histories.B).toEqual(B);
  });

  it('a transport that stops: stop() once, the chat is idle and empty at once', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    act(() => chat.stream([{ type: 'text', text: 'ANSWER ' }]));
    await act(async () => { ctx.clear(); });
    expect(chat.stop).toHaveBeenCalledTimes(1);
    await settle();
    expect(ctx.isLoading).toBe(false);
    expect(ctx.messages).toEqual([]);
    expect(chat.messages).toEqual([]);
  });

  it('clear() while idle does not call stop()', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { chat.finish(); });
    await act(async () => { ctx.clear(); });
    expect(chat.stop).not.toHaveBeenCalled();
    expect(ctx.messages).toEqual([]);
  });
});
