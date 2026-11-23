// @vitest-environment jsdom
// clear() while a request runs: the request is stopped and its answer is neither shown nor stored, also when
// parts of it still arrive afterwards. Nothing of it is recorded (no outcome, no onTurnEnd).

import React, { StrictMode, useMemo } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chat, useChat } from '@ai-sdk/react';
import { GLIRASTES_NAVIGATE_ACTION_ID, registerNavigationBridge, UiActionBus } from '../../browser/index.js';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { MessageList } from '../components/message-list.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import { useLangGraphChatTransport } from '../transports/langgraph.js';
import type { AiChatProviderConfig, ChatMessage, ChatTransport, MentionData, SessionConfig, TurnEndInfo, TurnOutcome } from '../types.js';
import { defineChatCommand } from '../interactions/definitions.js';
import { useChatContext } from '../provider/chat-context.js';
import { MEMORY_NOTES_PART } from '../../contracts/memory.js';
import type { BrowserMemoryStore } from '../utils/local-memory-store.js';
import { ctx, Host, Probe, StreamingChat } from './streaming-chat.js';
import { carried, stubControlledFetch, textChunks, type ControlledRequest } from './controlled-fetch.js';

let requests: ControlledRequest[];
// A stream still delivers what it had in flight after an abort, so "not shown" is the provider's doing.
beforeEach(() => {
  ({ requests } = stubControlledFetch({ deliverInFlightAfterAbort: true }));
});
afterEach(() => {
  for (const request of requests) request.close();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

// ---------------------------------------------------------------------------------------------------------------
// A message sent while the cleared request is still ending (the window).
// ---------------------------------------------------------------------------------------------------------------

/** A Vercel chat with a store and onTurnEnd whose first request streams the start of its answer. */
async function vercelRunning(config: Partial<AiChatProviderConfig> = {}) {
  const store = sessionStore();
  const turnEnds = recorder();
  render(<VercelHost session={store.session} onTurnEnd={turnEnds.onTurnEnd} {...config} />);
  await waitFor(() => expect(ctx.canCompose).toBe(true));
  await act(async () => { ctx.send('a question'); });
  await waitFor(() => expect(requests).toHaveLength(1));
  for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
  await waitFor(() => expect(seen()).toContain('ANSWER'));
  return { store, turnEnds };
}

/** The fresh message reached the transport alone, its answer is shown and stored, and its turn reports. */
async function freshTurnGoesOn(store: ReturnType<typeof sessionStore>, turnEnds: ReturnType<typeof recorder>, index = 1) {
  await waitFor(() => expect(requests).toHaveLength(index + 1));
  expect(requests[0]!.aborted).toBe(true);
  expect(carried(requests[index]!)).toEqual(['user:fresh']);
  await act(async () => { requests[index]!.answer('FRESH ANSWER'); });
  await waitFor(() => expect(ctx.isLoading).toBe(false));
  await settle();
  expect(ctx.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  expect(seen()).toContain('fresh');
  expect(seen()).toContain('FRESH ANSWER');
  expect(seen()).not.toContain('ANSWER OF');
  expect(JSON.stringify(store.histories.A)).toContain('FRESH ANSWER');
  expect(JSON.stringify(store.histories.A)).not.toContain('a question');
  expect(ctx.turnOutcomes.get(ctx.messages[0]!.id)?.status).toBe('completed');
  expect(turnEnds.calls.map((call) => call.outcome.status)).toEqual(['completed']);
}

describe('a message sent while the cleared request is still ending', () => {
  it('without the queue, in the same tick as clear(): it is held, reported as queued, and sent into the emptied chat', async () => {
    const { store, turnEnds } = await vercelRunning();
    let result: unknown;
    await act(async () => {
      ctx.clear();
      result = ctx.submitWithResult('fresh');
    });
    expect(result).toEqual({ status: 'queued' });
    await freshTurnGoesOn(store, turnEnds);
  });

  it('without the queue, in the next tick while the old stream still delivers chunks: held, then sent alone', async () => {
    ({ requests } = stubControlledFetch({ deliverInFlightAfterAbort: true }));
    const { store, turnEnds } = await vercelRunning();
    act(() => { ctx.clear(); });
    let result: unknown;
    act(() => {
      requests[0]!.push({ type: 'text-delta', id: 't', delta: 'OF THE CLEARED CHAT' });
      result = ctx.submitWithResult('fresh');
    });
    expect(result).toEqual({ status: 'queued' });
    expect(ctx.messages).toEqual([]);
    expect(requests).toHaveLength(1);
    await freshTurnGoesOn(store, turnEnds);
  });

  it('without the queue, two sends: the first is held, the second is refused (session) and never sent', async () => {
    const { store, turnEnds } = await vercelRunning();
    const results: unknown[] = [];
    await act(async () => {
      ctx.clear();
      results.push(ctx.submitWithResult('fresh'));
      results.push(ctx.submitWithResult('second'));
    });
    expect(results).toEqual([{ status: 'queued' }, { status: 'rejected', reason: 'session' }]);
    expect(ctx.lastRejection?.reason).toBe('session');
    await freshTurnGoesOn(store, turnEnds);
    expect(requests).toHaveLength(2);
  });

  it('without the queue, a send and then clear() again: the held message is dropped, nothing is sent', async () => {
    const { store } = await vercelRunning();
    await act(async () => {
      ctx.clear();
      ctx.submitWithResult('fresh');
      ctx.clear();
    });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(requests).toHaveLength(1);
    expect(ctx.messages).toEqual([]);
    expect(store.histories.A).toEqual([]);
  });

  it('with the queue, in the same tick: queued, then sent into the emptied chat', async () => {
    const { store, turnEnds } = await vercelRunning({ queue: { enabled: true } });
    let result: unknown;
    await act(async () => {
      ctx.clear();
      result = ctx.submitWithResult('fresh');
    });
    expect(result).toEqual({ status: 'queued' });
    await freshTurnGoesOn(store, turnEnds);
  });

  it('a host switch during the window drops a held message', async () => {
    const histories: Record<string, ChatMessage[]> = { A: [], B: [] };
    const session = (activeId: string): SessionConfig => ({
      activeId, load: async (id: string) => histories[id] ?? [], save: (id, messages) => { histories[id] = messages; },
    });
    const chat = new UnstoppableChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.clear(); ctx.submitWithResult('fresh'); });
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('B'));
    await act(async () => { chat.fail(); });
    await settle();
    expect(chat.sent).toEqual(['a question']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Stop during the window, a host switch during it, a stop that fails, the auto-continuation, LangGraph.
// ---------------------------------------------------------------------------------------------------------------

describe('during the window', () => {
  it('Stop asks the transport again but records and pauses nothing; a message queued after the clear is sent into the emptied chat', async () => {
    const chat = new UnstoppableChat();
    render(<Host chat={chat} config={{ queue: { enabled: true } }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.clear(); });
    await act(async () => { expect(ctx.submitWithResult('fresh')).toEqual({ status: 'queued' }); });
    // A new chat or another one cannot be opened from the provider during the window, as during any run.
    let created: unknown = 'unset';
    await act(async () => { created = await ctx.createSession(); });
    expect(created).toBeNull();
    await act(async () => { ctx.stop(); });
    expect(chat.stop).toHaveBeenCalledTimes(2);
    expect(ctx.pipelineState).toBeNull();
    expect(ctx.queue.paused).toBe(false);
    await act(async () => { chat.finish([{ type: 'text', text: 'OLD' }]); });
    await waitFor(() => expect(chat.sent).toEqual(['a question', 'fresh']));
    expect(chat.requests.at(-1)!.map((message) => (message.parts[0] as { text: string }).text)).toEqual(['fresh']);
    expect(ctx.pipelineState).toBeNull();
    expect(JSON.stringify(ctx.messages)).not.toContain('OLD');
  });

  it('a host switch to B: B shows what it loaded during the window, the run\'s data parts are dropped, B is not emptied at the end', async () => {
    const B = [
      { id: 'b-u1', role: 'user', parts: [{ type: 'text', text: 'b question' }] },
      { id: 'b-a1', role: 'assistant', parts: [{ type: 'text', text: 'b answer' }] },
    ] as ChatMessage[];
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    const session = (activeId: string): SessionConfig => ({
      activeId, load: async (id: string) => histories[id] ?? [], save: (id, messages) => { histories[id] = messages; },
    });
    const chat = new UnstoppableChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.clear(); });
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ctx.messages.map((message) => message.id)).toEqual(['b-u1', 'b-a1']));
    expect(ctx.isLoading).toBe(true);
    act(() => { chat.emit({ type: 'data-step-report', data: { stepNumber: 0, toolCalls: [], finishReason: 'tool-calls' } }); });
    expect(ctx.pipelineSteps).toEqual([]);
    await act(async () => { chat.fail(); });
    await settle();
    expect(ctx.isLoading).toBe(false);
    expect(ctx.error).toBeNull();
    expect(ctx.messages.map((message) => message.id)).toEqual(['b-u1', 'b-a1']);
    expect(histories.B).toEqual(B);
  });

  it.each([
    ['throws', () => { throw new Error('stop failed'); }],
    ['rejects', () => Promise.reject(new Error('stop failed'))],
  ])('a stop() that %s: clear() still empties the chat, its store and its queue', async (_name, failingStop) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = sessionStore();
    const chat = new StreamingChat();
    chat.stop.mockImplementation(failingStop as () => void);
    render(<Host chat={chat} config={{ session: store.session, queue: { enabled: true } }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.send('queued'); });
    await act(async () => { ctx.clear(); });
    await settle();
    expect(chat.stop).toHaveBeenCalledTimes(1);
    expect(ctx.messages).toEqual([]);
    expect(ctx.queue.items).toHaveLength(0);
    expect(store.cleared).toEqual(['A']);
    expect(warn).toHaveBeenCalledWith('[glirastes] The transport could not stop the request');
  });

  it('a transport without stop(): clear() still empties the chat', async () => {
    const chat = new StreamingChat();
    function NoStopHost() {
      const [, force] = React.useReducer((count: number) => count + 1, 0);
      React.useEffect(() => chat.subscribe(force), []);
      const { stop: _stop, ...rest } = chat.transport;
      return <AiChatProvider transport={rest as ChatTransport}><Probe /><MessageList /></AiChatProvider>;
    }
    render(<NoStopHost />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.clear(); });
    expect(ctx.messages).toEqual([]);
    await act(async () => { chat.finish([{ type: 'text', text: 'OLD' }]); });
    await settle();
    expect(ctx.isLoading).toBe(false);
    expect(ctx.messages).toEqual([]);
  });

  it('a later failure with the same error object as the cleared run\'s is shown', async () => {
    const failure = new Error('network');
    const chat = new UnstoppableChat();
    render(<Host chat={chat} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.clear(); });
    await act(async () => { chat.fail(failure); });
    await settle();
    expect(ctx.error).toBeNull();
    await act(async () => { ctx.send('again'); });
    await act(async () => { chat.fail(failure); });
    await settle();
    expect(ctx.error).toBe(failure);
  });
});

describe('the AI SDK continuation of a cleared turn', () => {
  it('clear() during the request that continues after an approval: aborted, no further request, also when chunks arrive after the abort', async () => {
    ({ requests } = stubControlledFetch({ deliverInFlightAfterAbort: true }));
    render(<VercelHost />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('delete t1'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      requests[0]!.push({ type: 'start' });
      requests[0]!.push({ type: 'start-step' });
      requests[0]!.push({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'tasks_delete', input: { id: 't1' } });
      requests[0]!.push({ type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'c1' });
      requests[0]!.push({ type: 'finish-step' });
      requests[0]!.push({ type: 'finish' });
      requests[0]!.end();
    });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { await ctx.approve('ap-1'); });
    // The AI SDK sends the history with the approval answer by itself.
    await waitFor(() => expect(requests).toHaveLength(2));
    act(() => { ctx.clear(); });
    // What the continuation had in flight: the end of the approved step, with no new step after it.
    act(() => {
      requests[1]!.push({ type: 'start' });
      requests[1]!.push({ type: 'finish-step' });
      requests[1]!.push({ type: 'finish' });
    });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(requests[1]!.aborted).toBe(true);
    expect(requests).toHaveLength(2);
    expect(ctx.messages).toEqual([]);
  });
});

function LangGraphHost() {
  const transport = useLangGraphChatTransport({ endpoint: '/api/graph' });
  return <AiChatProvider transport={transport}><Probe /><MessageList /></AiChatProvider>;
}
const langGraphMessage = (content: string) => `event: message\ndata: ${JSON.stringify({ content })}\n\n`;

describe('clear() while a request of the LangGraph transport runs', () => {
  it('aborts it; the chat is idle and empty at once; what still arrives is not shown', async () => {
    ({ requests } = stubControlledFetch({ deliverInFlightAfterAbort: true }));
    render(<LangGraphHost />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => { requests[0]!.pushRaw(langGraphMessage('ANSWER ')); });
    await waitFor(() => expect(seen()).toContain('ANSWER'));
    act(() => { ctx.clear(); });
    expect(requests[0]!.aborted).toBe(true);
    expect(ctx.isLoading).toBe(false);
    expect(ctx.messages).toEqual([]);
    act(() => { requests[0]!.pushRaw(langGraphMessage('LATE')); });
    await settle();
    expect(ctx.messages).toEqual([]);
    await act(async () => { ctx.send('fresh'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect((requests[1]!.body.messages as Array<{ content: string }>).map((message) => message.content)).toEqual(['fresh']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// An app-owned AI SDK Chat outlives the provider that cleared it.
// ---------------------------------------------------------------------------------------------------------------

function useAppChatTransport(chat: Chat<UIMessage>): ChatTransport {
  const { messages, status, error, sendMessage, stop, setMessages, addToolApprovalResponse } = useChat({ chat });
  return useMemo<ChatTransport>(() => ({
    messages: messages as unknown as ChatMessage[], status, error: error ?? null,
    sendMessage: ({ text }) => sendMessage({ text }), stop,
    setMessages: setMessages as unknown as ChatTransport['setMessages'], addToolApprovalResponse,
  }), [messages, status, error, sendMessage, stop, setMessages, addToolApprovalResponse]);
}
function AppChatHost({ chat }: { chat: Chat<UIMessage> }) {
  const transport = useAppChatTransport(chat);
  return <AiChatProvider transport={transport}><Probe /><MessageList /></AiChatProvider>;
}

describe('an app-owned AI SDK Chat that outlives the provider', () => {
  it('unmounted during the window: what the cleared request wrote after the clear stays in the app\'s Chat and shows on remount (as of this change)', async () => {
    ({ requests } = stubControlledFetch({ deliverInFlightAfterAbort: true }));
    const chat = new Chat<UIMessage>({ id: 'app', transport: new DefaultChatTransport({ api: '/api/chat' }) });
    const view = render(<AppChatHost chat={chat} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
    await waitFor(() => expect(seen()).toContain('ANSWER'));
    act(() => {
      ctx.clear();
      requests[0]!.push({ type: 'text-delta', id: 't', delta: 'LATE' });
    });
    view.unmount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(chat.status).toBe('ready');
    render(<AppChatHost chat={chat} />);
    await settle();
    // Without a store nothing empties the app's Chat once the provider is gone.
    expect(seen()).toContain('ANSWER LATE');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Review round 2: a continuation whose stream completes normally after the clear, held-message checks.
// ---------------------------------------------------------------------------------------------------------------

describe('a continuation request that completes normally after clear()', () => {
  it('after an approval: no further request is sent and nothing shows', async () => {
    render(<VercelHost />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('delete t1'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      requests[0]!.push({ type: 'start' });
      requests[0]!.push({ type: 'start-step' });
      requests[0]!.push({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'tasks_delete', input: { id: 't1' } });
      requests[0]!.push({ type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'c1' });
      requests[0]!.push({ type: 'finish-step' });
      requests[0]!.push({ type: 'finish' });
      requests[0]!.end();
    });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { await ctx.approve('ap-1'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    act(() => {
      ctx.clear();
      // The rest of the continuation was in flight: it ends the step and the stream closes normally.
      requests[1]!.push({ type: 'start' });
      requests[1]!.push({ type: 'text-start', id: 'late' });
      requests[1]!.push({ type: 'text-delta', id: 'late', delta: 'LATE' });
      requests[1]!.push({ type: 'text-end', id: 'late' });
      requests[1]!.push({ type: 'finish-step' });
      requests[1]!.push({ type: 'finish' });
      requests[1]!.end();
    });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(requests).toHaveLength(2);
    expect(ctx.messages).toEqual([]);
  });

  it('after a UI action outcome: no further request is sent and nothing shows', async () => {
    const bus = new UiActionBus();
    const stopBridge = registerNavigationBridge({ bus, push: async () => {} });
    render(<VercelHost uiActionBus={bus} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('open the tasks'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      requests[0]!.push({ type: 'start' });
      requests[0]!.push({ type: 'start-step' });
      requests[0]!.push({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'ui_navigate', input: {} });
      requests[0]!.push({
        type: 'tool-output-available', toolCallId: 'c1',
        output: {
          handedOff: true, message: 'Handed to the app.', awaitsOutcome: true,
          uiAction: { type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href: '/tasks' } },
        },
      });
      requests[0]!.push({ type: 'finish-step' });
      requests[0]!.push({ type: 'finish' });
      requests[0]!.end();
    });
    // The outcome is written and the AI SDK sends the history again.
    await waitFor(() => expect(requests).toHaveLength(2));
    act(() => {
      ctx.clear();
      requests[1]!.push({ type: 'start' });
      requests[1]!.push({ type: 'text-start', id: 'late' });
      requests[1]!.push({ type: 'text-delta', id: 'late', delta: 'LATE' });
      requests[1]!.push({ type: 'text-end', id: 'late' });
      requests[1]!.push({ type: 'finish-step' });
      requests[1]!.push({ type: 'finish' });
      requests[1]!.end();
    });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(requests).toHaveLength(2);
    expect(ctx.messages).toEqual([]);
    stopBridge();
  });

  it('the app\'s onData gets no data part of the cleared request', async () => {
    const parts: string[] = [];
    function OnDataHost() {
      const transport = useVercelAiChatTransport({ endpoint: '/api/chat', onData: (part) => { parts.push(part.type); } });
      return <AiChatProvider transport={transport}><Probe /><MessageList /></AiChatProvider>;
    }
    render(<OnDataHost />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
    await waitFor(() => expect(seen()).toContain('ANSWER'));
    act(() => {
      ctx.clear();
      requests[0]!.push({ type: 'data-late', data: { x: 1 } });
    });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(parts).toEqual([]);
  });
});

describe('a held message passes the checks of a normal send', () => {
  /** A custom transport chat cleared during its run; the window stays open until the test ends the run. */
  async function clearedWindow(config: Partial<AiChatProviderConfig> = {}) {
    const chat = new UnstoppableChat();
    const view = render(<Host chat={chat} config={config} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.clear(); });
    return { chat, view };
  }
  const file = { type: 'file' as const, mediaType: 'text/plain', url: 'data:text/plain;base64,aGk=', filename: 'a.txt' };

  it('a direct command with files is refused (files-with-command), as without the window', async () => {
    const ping = defineChatCommand({ id: 'tasks.ping', label: 'Ping', run: { kind: 'tool', tool: 'tasks.ping' } });
    const pingMention: MentionData = { id: 'tasks.ping', type: 'command', label: 'Ping', prefix: '/', slug: 'ping' };
    await clearedWindow({ attachments: true, chatInteractions: { commands: [ping] } });
    let result: unknown;
    await act(async () => { result = ctx.submitWithResult('/ping', { mentions: [pingMention], files: [file] }); });
    expect(result).toEqual({ status: 'rejected', reason: 'files-with-command' });
  });

  it('files while attachments are off are refused (attachments-off)', async () => {
    await clearedWindow();
    let result: unknown;
    await act(async () => { result = ctx.submitWithResult('with file', { files: [file] }); });
    expect(result).toEqual({ status: 'rejected', reason: 'attachments-off' });
  });

  it('attachments turned off before it goes out: not sent with its files, refused (attachments-off)', async () => {
    const { chat, view } = await clearedWindow({ attachments: true });
    await act(async () => { expect(ctx.submitWithResult('with file', { files: [file] })).toEqual({ status: 'queued' }); });
    view.rerender(<Host chat={chat} config={{}} />);
    await act(async () => { chat.fail(); });
    await settle();
    expect(chat.sent).toEqual(['a question']);
    expect(ctx.lastRejection?.reason).toBe('attachments-off');
  });

  it('a host switch in the render that closes the window: not sent into the newly opened chat, refused (session)', async () => {
    const histories: Record<string, ChatMessage[]> = { A: [], B: [] };
    const session = (activeId: string): SessionConfig => ({
      activeId, load: async (id: string) => histories[id] ?? [], save: (id, messages) => { histories[id] = messages; },
    });
    const chat = new UnstoppableChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.clear(); ctx.submitWithResult('fresh'); });
    await act(async () => {
      view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
      chat.fail();
    });
    await waitFor(() => expect(ctx.activeSessionId).toBe('B'));
    await settle();
    expect(chat.sent).toEqual(['a question']);
    expect(ctx.lastRejection?.reason).toBe('session');
  });

  it('a host switch during the window drops it and says so (session); a second clear() drops it without a refusal', async () => {
    const histories: Record<string, ChatMessage[]> = { A: [], B: [] };
    const session = (activeId: string): SessionConfig => ({
      activeId, load: async (id: string) => histories[id] ?? [], save: (id, messages) => { histories[id] = messages; },
    });
    const chat = new UnstoppableChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await act(async () => { ctx.clear(); ctx.submitWithResult('fresh'); });
    await act(async () => { ctx.clear(); });
    expect(ctx.lastRejection).toBeNull();
    await act(async () => { ctx.submitWithResult('fresh again'); });
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ctx.activeSessionId).toBe('B'));
    expect(ctx.lastRejection?.reason).toBe('session');
    await act(async () => { chat.fail(); });
    await settle();
    expect(chat.sent).toEqual(['a question']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Review round 3: the pause of automatic sends never outlives the clearing window.
// ---------------------------------------------------------------------------------------------------------------

/** A transport owned above the provider, as an app that mounts the chat conditionally holds it. */
const owned: {
  transports: ChatTransport[];
  data: string[];
  memoryWrites: unknown[];
} = { transports: [], data: [], memoryWrites: [] };
const memory: BrowserMemoryStore = {
  read: () => [],
  write: (entries: unknown) => { owned.memoryWrites.push(entries); },
};

function useOwnedTransport() {
  return useVercelAiChatTransport({ endpoint: '/api/chat', memory, onData: (part) => { owned.data.push(part.type); } });
}
function ChatOn({ transport, providerKey }: { transport: ChatTransport; providerKey?: string }) {
  return <AiChatProvider key={providerKey} transport={transport}><Probe /><MessageList /></AiChatProvider>;
}
function Parent({ show = true, providerKey, strict = false, which = 0, twice = false }: {
  show?: boolean; providerKey?: string; strict?: boolean; which?: number; twice?: boolean;
}) {
  const first = useOwnedTransport();
  const second = useOwnedTransport();
  owned.transports = [first, second];
  const transport = which === 0 ? first : second;
  const chat = show ? <ChatOn transport={transport} providerKey={providerKey} /> : null;
  const both = twice ? <>{chat}<div data-testid="other"><ChatOnOther transport={transport} /></div></> : chat;
  return strict ? <StrictMode>{both}</StrictMode> : both;
}
/** A second provider on the same transport, driven through `otherCtx`. */
let otherCtx: ReturnType<typeof useChatContext>;
function OtherProbe() {
  otherCtx = useChatContext();
  return null;
}
function ChatOnOther({ transport }: { transport: ChatTransport }) {
  return <AiChatProvider transport={transport}><OtherProbe /><MessageList /></AiChatProvider>;
}

/** Clears while a request runs; the abort settles only in a later macrotask, so the window is still open. */
async function clearWithOpenWindow() {
  await waitFor(() => expect(ctx.canCompose).toBe(true));
  await act(async () => { ctx.send('a question'); });
  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  const request = requests.at(-1)!;
  for (const chunk of textChunks('ANSWER ')) request.push(chunk);
  await waitFor(() => expect(seen()).toContain('ANSWER'));
  act(() => { ctx.clear(); });
  expect(ctx.isLoading).toBe(true);
}

/** On `transport`: an approval continuation is sent, and data parts reach the app and memory notes. */
async function everythingWorksOn(transport: ChatTransport) {
  const before = requests.length;
  // Its promise ends with the request: not awaited.
  await act(async () => { void transport.sendMessage({ text: 'delete t1' }); });
  await waitFor(() => expect(requests).toHaveLength(before + 1));
  const first = requests[before]!;
  owned.data.length = 0;
  owned.memoryWrites.length = 0;
  await act(async () => {
    first.push({ type: 'start' });
    first.push({ type: 'data-ping', data: { ok: true } });
    first.push({ type: MEMORY_NOTES_PART, data: { user: [{ id: 'n1', text: 'likes tea' }] } });
    first.push({ type: 'start-step' });
    first.push({ type: 'tool-input-available', toolCallId: 'c9', toolName: 'tasks_delete', input: { id: 't1' } });
    first.push({ type: 'tool-approval-request', approvalId: 'ap-9', toolCallId: 'c9' });
    first.push({ type: 'finish-step' });
    first.push({ type: 'finish' });
    first.end();
  });
  await waitFor(() => expect(transport.status).toBe('ready'));
  expect(owned.data).toContain('data-ping');
  expect(owned.memoryWrites).toHaveLength(1);
  await act(async () => { await transport.addToolApprovalResponse({ id: 'ap-9', approved: true }); });
  // The AI SDK sends the history with the approval answer by itself.
  await waitFor(() => expect(requests).toHaveLength(before + 2));
  await act(async () => { requests[before + 1]!.answer('Deleted.'); });
}

describe('the pause of automatic sends ends with the clearing window', () => {
  it('after a window that closed normally: continuations, data parts and memory notes work again', async () => {
    render(<Parent />);
    await clearWithOpenWindow();
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    await everythingWorksOn(owned.transports[0]!);
  });

  it('during the window the memory notes of the cleared request are not written', async () => {
    render(<Parent />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    for (const chunk of textChunks('ANSWER ')) requests[0]!.push(chunk);
    await waitFor(() => expect(seen()).toContain('ANSWER'));
    owned.memoryWrites.length = 0;
    act(() => {
      ctx.clear();
      requests[0]!.push({ type: MEMORY_NOTES_PART, data: { user: [{ id: 'n1', text: 'from the cleared chat' }] } });
    });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    expect(owned.memoryWrites).toEqual([]);
  });

  it('the provider unmounts during the window and mounts again', async () => {
    const view = render(<Parent />);
    await clearWithOpenWindow();
    view.rerender(<Parent show={false} />);
    await settle();
    view.rerender(<Parent />);
    await settle();
    await everythingWorksOn(owned.transports[0]!);
  });

  it('the provider is remounted with a new key during the window', async () => {
    const view = render(<Parent providerKey="one" />);
    await clearWithOpenWindow();
    view.rerender(<Parent providerKey="two" />);
    await settle();
    await everythingWorksOn(owned.transports[0]!);
  });

  it('under StrictMode, unmounted during the window', async () => {
    const view = render(<Parent strict />);
    await clearWithOpenWindow();
    view.rerender(<Parent strict show={false} />);
    await settle();
    await everythingWorksOn(owned.transports[0]!);
  });

  it('two providers on one transport: one clearing does not keep it paused, and the other unmounting does not end its window early', async () => {
    const view = render(<Parent twice />);
    await clearWithOpenWindow();
    view.rerender(<Parent />);
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await settle();
    await everythingWorksOn(owned.transports[0]!);
  });

  it('two providers on one transport both clear: the one unmounting does not end the other\'s pause', async () => {
    const view = render(<Parent twice />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('delete t1'); });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      requests[0]!.push({ type: 'start' });
      requests[0]!.push({ type: 'start-step' });
      requests[0]!.push({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'tasks_delete', input: { id: 't1' } });
      requests[0]!.push({ type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'c1' });
      requests[0]!.push({ type: 'finish-step' });
      requests[0]!.push({ type: 'finish' });
      requests[0]!.end();
    });
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    await act(async () => { await ctx.approve('ap-1'); });
    await waitFor(() => expect(requests).toHaveLength(2));
    act(() => {
      ctx.clear();
      otherCtx.clear();
    });
    // The other provider goes away while the window is open; this one still holds the pause.
    view.rerender(<Parent />);
    act(() => {
      requests[1]!.push({ type: 'start' });
      requests[1]!.push({ type: 'text-start', id: 'late' });
      requests[1]!.push({ type: 'text-delta', id: 'late', delta: 'LATE' });
      requests[1]!.push({ type: 'text-end', id: 'late' });
      requests[1]!.push({ type: 'finish-step' });
      requests[1]!.push({ type: 'finish' });
      requests[1]!.end();
    });
    await waitFor(() => expect(ctx.isLoading).toBe(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(requests).toHaveLength(2);
    await everythingWorksOn(owned.transports[0]!);
  });

  it('the transport prop switches to another instance during the window: the first one is not left paused', async () => {
    const view = render(<Parent which={0} />);
    await clearWithOpenWindow();
    view.rerender(<Parent which={1} />);
    await settle();
    await everythingWorksOn(owned.transports[0]!);
  });
});
