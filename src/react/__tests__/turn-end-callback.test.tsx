// @vitest-environment jsdom

import React, { useMemo, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLIRASTES_NAVIGATE_ACTION_ID, registerDocumentNavigation, registerNavigationBridge, UiActionBus } from '../../browser/index.js';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { clearLocalSessionStore, createLocalSessionStore } from '../utils/local-session-store.js';
import type {
  AiChatProviderConfig,
  ChatMessage,
  ChatTransport,
  SessionConfig,
  TurnEndInfo,
  TurnOutcome,
} from '../types.js';
import { ctx, Host, memoryStorage, Probe, StreamingChat } from './streaming-chat.js';

const RENDERS_IN_0_20_0 = 13;

type Call = { outcome: TurnOutcome; info: TurnEndInfo; inState: TurnOutcome | undefined; loading: boolean };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  warn.mockRestore();
});

/** An `onTurnEnd` that records each call with what the chat context said at that moment. */
function recorder() {
  const calls: Call[] = [];
  const onTurnEnd = (outcome: TurnOutcome, info: TurnEndInfo) => {
    calls.push({ outcome, info, inState: ctx.turnOutcomes.get(outcome.userMessageId), loading: ctx.isLoading });
  };
  const seen = () => calls.map((call) => `${call.outcome.status}/${call.outcome.reason}`);
  return { calls, onTurnEnd, seen };
}

const stepStart = { type: 'step-start' };
const text = (value: string) => ({ type: 'text', text: value, state: 'streaming' });
const tool = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  type: 'tool-tasks_list', toolCallId: id, state, input: {}, ...extra,
});
const pipelineState = (status: string) => ({
  type: 'data-pipeline-state', data: { status, maxSteps: 5, stepLimitSource: 'safety', totalSteps: 1 },
});
const userId = (chat: StreamingChat, index = 0) => chat.messages.filter((message) => message.role === 'user')[index]!.id;
const settle = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

describe('onTurnEnd: once per turn, for every outcome', () => {
  it('a completed turn: once, after the outcome is in the context, with the same object', async () => {
    const { calls, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, text('Part')]));
    expect(calls).toEqual([]);
    act(() => chat.finish());
    await settle();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.outcome).toMatchObject({ userMessageId: userId(chat), status: 'completed', reason: 'finished' });
    expect(call!.inState).toBe(call!.outcome);
    expect(call!.loading).toBe(false);
    expect(call!.info).toEqual({ sessionId: 'default' });
    expect(ctx.turnOutcomes.get(userId(chat))).toBe(call!.outcome);
  });

  it('a stop before the first token (no assistant message): once, aborted/stopped', async () => {
    const { calls, seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.stop(); });
    await settle();
    expect(chat.messages.map((message) => message.role)).toEqual(['user']);
    expect(seen()).toEqual(['aborted/stopped']);
    expect(calls[0]!.inState).toBe(calls[0]!.outcome);
  });

  it('a stop with partial text: once, aborted/stopped', async () => {
    const { seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, text('Partial')]));
    await act(async () => { ctx.stop(); });
    await settle();
    expect(seen()).toEqual(['aborted/stopped']);
  });

  it('a request failure before the first token: once, error/request-failed', async () => {
    const { calls, seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.fail());
    await settle();
    expect(seen()).toEqual(['error/request-failed']);
    expect(calls[0]!.inState).toBe(calls[0]!.outcome);
    // The next turn is its own.
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    await settle();
    expect(seen()).toEqual(['error/request-failed', 'completed/finished']);
    expect(calls.map((call) => call.outcome.userMessageId)).toEqual([userId(chat, 0), userId(chat, 1)]);
  });

  it('a server safety stop during a multi-step tool turn: once, when the run ended, not when the state arrived', async () => {
    const { seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, tool('c1', 'input-available')]));
    act(() => chat.stream([stepStart, tool('c1', 'output-available', { output: { items: [] } }), stepStart, tool('c2', 'input-available')]));
    act(() => chat.emit(pipelineState('safety-stop')));
    await settle();
    expect(seen()).toEqual([]);
    act(() => chat.finish([stepStart, tool('c1', 'output-available', { output: { items: [] } }), stepStart, text('Partial')]));
    await settle();
    expect(seen()).toEqual(['safety-stop/pipeline']);
  });

  it('a multi-step tool turn that finishes: once, completed, at the very end', async () => {
    const { seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, tool('c1', 'input-available')]));
    act(() => chat.emit({ type: 'data-step-report', data: { stepNumber: 0, toolCalls: [], finishReason: 'tool-calls' } }));
    act(() => chat.stream([stepStart, tool('c1', 'output-available', { output: {} }), stepStart, tool('c2', 'input-available')]));
    act(() => chat.emit(pipelineState('running')));
    expect(seen()).toEqual([]);
    act(() => chat.finish([stepStart, tool('c1', 'output-available', { output: {} }), stepStart, tool('c2', 'output-available', { output: {} }), stepStart, text('Done')]));
    await settle();
    expect(seen()).toEqual(['completed/finished']);
  });

  it("queue sendNow with 'abort': the interrupted turn once (send-now), then the next turn once", async () => {
    const { calls, seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd, queue: { enabled: true, sendNowBehavior: 'abort' } }} />);
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.submit('two'); });
    await act(async () => { ctx.sendNow(ctx.queue.items[0]!.id); });
    await waitFor(() => expect(chat.sent).toEqual(['one', 'two']));
    await settle();
    expect(seen()).toEqual(['aborted/send-now']);
    act(() => chat.finish());
    await settle();
    expect(seen()).toEqual(['aborted/send-now', 'completed/finished']);
    expect(calls.map((call) => call.outcome.userMessageId)).toEqual([userId(chat, 0), userId(chat, 1)]);
  });

  it('a run that stops at an open approval: nothing yet; once completed after the approved run finished', async () => {
    const { seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.finish([stepStart, tool('c1', 'approval-requested', { approval: { id: 'ap-1' } })]));
    await settle();
    expect(seen()).toEqual([]);
    // The user approved: the part is answered and the transport sends on.
    chat.messages = chat.messages.map((message) => (message.role !== 'assistant' ? message : {
      ...message,
      parts: message.parts.map((part) => ({ ...part, state: 'approval-responded', approval: { id: 'ap-1', approved: true } })),
    }) as ChatMessage);
    act(() => chat.resume());
    act(() => chat.finish([stepStart, text('Deleted')]));
    await settle();
    expect(seen()).toEqual(['completed/finished']);
  });

  it('a retry is a new attempt: each attempt reports its own end once', async () => {
    const { calls, seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.stop(); });
    act(() => chat.retry());
    act(() => chat.finish());
    await settle();
    expect(seen()).toEqual(['aborted/stopped', 'completed/finished']);
    expect(new Set(calls.map((call) => call.outcome.userMessageId)).size).toBe(1);
  });

  it('a stop while idle reports nothing more', async () => {
    const { seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.finish());
    await act(async () => { ctx.stop(); });
    await settle();
    expect(seen()).toEqual(['completed/finished']);
  });
});

describe('onTurnEnd: not for history, other chats or a cleared run', () => {
  it('restoring a stored history (also a reload) calls nothing', async () => {
    const storage = memoryStorage();
    const store = createLocalSessionStore({ storageKey: 'turn-end-restore', storage, attachmentStore: null });
    const first = recorder();
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: store, onTurnEnd: first.onTurnEnd }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.stop(); });
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    await settle();
    expect(first.seen()).toEqual(['aborted/stopped', 'completed/finished']);
    view.unmount();

    const second = recorder();
    render(<Host chat={new StreamingChat()} config={{ session: store, onTurnEnd: second.onTurnEnd }} />);
    await waitFor(() => expect(ctx.turnOutcomes.size).toBe(2));
    await settle();
    expect(second.calls).toEqual([]);
    await clearLocalSessionStore({ storageKey: 'turn-end-restore', storage, attachmentStore: null });
  });

  it('a stored history the app hands to its transport calls nothing', async () => {
    const { calls, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    chat.messages = [{
      id: 'u-old', role: 'user', parts: [{ type: 'text', text: 'old' }],
      metadata: { glirastesTurnOutcome: { status: 'aborted', reason: 'stopped', at: 'x' } },
    } as unknown as ChatMessage];
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await waitFor(() => expect(ctx.turnOutcomes.get('u-old')?.status).toBe('aborted'));
    await settle();
    expect(calls).toEqual([]);
  });

  it("a turn of a chat the host left: no call when it ends, none when the chat opens again; the open chat's turns still report", async () => {
    const histories: Record<string, ChatMessage[]> = {
      A: [],
      B: [{ id: 'b-u1', role: 'user', parts: [{ type: 'text', text: 'b' }] }],
    };
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id: string) => histories[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => { histories[id] = messages; },
    });
    const { calls, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A'), onTurnEnd }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    const aUser = userId(chat);
    view.rerender(<Host chat={chat} config={{ session: session('B'), onTurnEnd }} />);
    await waitFor(() => expect(ctx.messages.map((message) => message.id)).toEqual(['b-u1']));
    await act(async () => { chat.fail(); });
    await settle();
    expect(calls).toEqual([]);
    view.rerender(<Host chat={chat} config={{ session: session('A'), onTurnEnd }} />);
    await waitFor(() => expect(ctx.turnOutcomes.get(aUser)?.status).toBe('error'));
    await settle();
    expect(calls).toEqual([]);
    // A turn of the open chat reports with that chat's id.
    await act(async () => { ctx.send('again'); });
    act(() => chat.finish());
    await settle();
    expect(calls.map((call) => [call.outcome.status, call.info.sessionId])).toEqual([['completed', 'A']]);
  });

  it('A to B to A while A runs, then it fails: once, because A is the open chat when its turn ends', async () => {
    const histories: Record<string, ChatMessage[]> = {
      A: [],
      B: [{ id: 'b-u1', role: 'user', parts: [{ type: 'text', text: 'b' }] }],
    };
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id: string) => histories[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => { histories[id] = messages; },
    });
    const { calls, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A'), onTurnEnd }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('a question'); });
    const aUser = userId(chat);
    view.rerender(<Host chat={chat} config={{ session: session('B'), onTurnEnd }} />);
    await waitFor(() => expect(ctx.messages.map((message) => message.id)).toEqual(['b-u1']));
    view.rerender(<Host chat={chat} config={{ session: session('A'), onTurnEnd }} />);
    await waitFor(() => expect(ctx.messages.map((message) => message.id)).toEqual([aUser]));
    await act(async () => { chat.fail(); });
    await settle();
    expect(calls.map((call) => [call.outcome.userMessageId, call.outcome.status, call.outcome.reason, call.info.sessionId]))
      .toEqual([[aUser, 'error', 'request-failed', 'A']]);
  });

  it('clear() while a request runs: its end reports nothing', async () => {
    const { calls, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.clear(); });
    await act(async () => { chat.fail(); });
    await settle();
    expect(calls).toEqual([]);
  });
});

describe('onTurnEnd: robustness', () => {
  it('under StrictMode: once per turn', async () => {
    const { seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<React.StrictMode><Host chat={chat} config={{ onTurnEnd }} /></React.StrictMode>);
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.stop(); });
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    await act(async () => { ctx.send('three'); });
    act(() => chat.fail());
    await settle();
    expect(seen()).toEqual(['aborted/stopped', 'completed/finished', 'error/request-failed']);
  });

  it('a throwing callback is caught and reported; the chat goes on and the next turn reports too', async () => {
    const onTurnEnd = vi.fn(() => { throw new Error('app bug'); });
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.finish());
    await settle();
    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[glirastes] onTurnEnd threw');
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    await settle();
    expect(onTurnEnd).toHaveBeenCalledTimes(2);
    expect(ctx.turnOutcomes.size).toBe(2);
  });

  it('an async callback that rejects is caught and reported like a throw', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const onTurnEnd = vi.fn(async () => { throw new Error('async app bug'); });
      const chat = new StreamingChat();
      render(<Host chat={chat} config={{ onTurnEnd }} />);
      await act(async () => { ctx.send('one'); });
      act(() => chat.finish());
      await settle(30);
      expect(onTurnEnd).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[glirastes] onTurnEnd threw');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('uses the latest callback without a stale closure', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ onTurnEnd: first }} />);
    await act(async () => { ctx.send('one'); });
    view.rerender(<Host chat={chat} config={{ onTurnEnd: second }} />);
    act(() => chat.finish());
    await settle();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('without onTurnEnd the provider renders as often as in 0.20.0 (no extra render)', async () => {
    let renders = 0;
    const chat = new StreamingChat();
    // Every commit of the provider's tree, also the ones its own state updates cause.
    function CountingHost() {
      const [, force] = React.useReducer((count: number) => count + 1, 0);
      React.useEffect(() => chat.subscribe(force), []);
      return (
        <React.Profiler id="chat" onRender={() => { renders += 1; }}>
          <AiChatProvider transport={chat.transport}><Probe /></AiChatProvider>
        </React.Profiler>
      );
    }
    render(<CountingHost />);
    await settle();
    const start = renders;
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.stop(); });
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    await act(async () => { ctx.send('three'); });
    act(() => chat.fail());
    await settle();
    // Measured with the provider of 0.20.0 (origin/main before this change) for the same sequence.
    expect(renders - start).toBe(RENDERS_IN_0_20_0);
  });

  it('without onTurnEnd the outcomes and the requests are as before', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.finish());
    expect(ctx.turnOutcomes.get(userId(chat))).toMatchObject({ status: 'completed', reason: 'finished' });
    expect(chat.requests).toEqual([[{ id: userId(chat), role: 'user', parts: [{ type: 'text', text: 'one' }] }]]);
  });
});

describe('onTurnEnd: a turn whose UI action outcome continues it with a second request', () => {
  const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Open the tasks' }] } as ChatMessage;
  const uiPart = {
    type: 'tool-ui_navigate', toolCallId: 'c1', state: 'output-available', input: {},
    output: {
      handedOff: true, message: 'Handed to the app.', awaitsOutcome: true,
      uiAction: { type: 'glirastes.navigate', actionId: GLIRASTES_NAVIGATE_ACTION_ID, payload: { href: '/tasks' } },
    },
  };
  let control: { set(messages: ChatMessage[], status?: ChatTransport['status']): void };

  /**
   * Like the bundled transport: writing the outcome puts it into the result and starts the continuation
   * request at once, except for a page load (`initiated`: the next page continues with `continueTurn`).
   */
  function OutcomeHost({ config, initial = [] }: { config: AiChatProviderConfig; initial?: ChatMessage[] }) {
    const [messages, setMessages] = useState<ChatMessage[]>(initial);
    const [status, setStatus] = useState<ChatTransport['status']>('ready');
    control = { set: (next, nextStatus) => { setMessages(next); if (nextStatus) setStatus(nextStatus); } };
    const transport = useMemo<ChatTransport>(() => ({
      messages,
      status,
      error: null,
      sendMessage: async () => {},
      stop: () => {},
      setMessages,
      addToolApprovalResponse: () => {},
      addToolOutput: async (value: { tool: string; toolCallId: string; output: unknown }) => {
        setMessages((current) => current.map((message, index) => (index !== current.length - 1 ? message : {
          ...message,
          parts: message.parts.map((part) => ((part as { toolCallId?: string }).toolCallId === value.toolCallId
            ? { ...part, output: value.output }
            : part)),
        }) as ChatMessage));
        if (((value.output as { outcome?: { code?: string } }).outcome)?.code !== 'initiated') setStatus('submitted');
      },
      continueTurn: () => { setStatus('submitted'); },
      setUiOutcomeReporting: () => {},
    }), [messages, status]);
    return <AiChatProvider transport={transport} {...config}><Probe /></AiChatProvider>;
  }

  it('reports once, completed, after the continuation finished', async () => {
    const bus = new UiActionBus();
    let release!: () => void;
    const stopBridge = registerNavigationBridge({ bus, push: () => new Promise<void>((resolve) => { release = resolve; }) });
    const { seen, onTurnEnd } = recorder();
    render(<OutcomeHost config={{ uiActionBus: bus, onTurnEnd }} />);
    const first = { id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, uiPart] } as unknown as ChatMessage;
    await act(async () => { control.set([user], 'submitted'); });
    await act(async () => { control.set([user, first], 'streaming'); });
    await act(async () => { control.set([user, first], 'ready'); });
    await settle();
    // The first request ended, but the turn waits for the outcome and its continuation.
    expect(seen()).toEqual([]);
    await act(async () => { release(); });
    await waitFor(() => expect(ctx.isLoading).toBe(true));
    await settle();
    expect(seen()).toEqual([]);
    const answer = { id: 'a2', role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'Opened.' }] } as unknown as ChatMessage;
    await act(async () => { control.set([user, first, answer], 'streaming'); });
    await act(async () => { control.set([user, first, answer], 'ready'); });
    await settle();
    expect(seen()).toEqual(['completed/finished']);
    stopBridge();
  });

  it('a UI action that loads a new page: nothing on the page that is left, once on the page that continues the turn', async () => {
    sessionStorage.clear();
    const stored: Record<string, ChatMessage[]> = {};
    const session: SessionConfig = {
      load: async (id: string) => stored[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => { stored[id] = messages; },
    };
    const pagePart = { ...uiPart, toolCallId: 'c-page' };
    const first = { id: 'a1', role: 'assistant', parts: [{ type: 'step-start' }, pagePart] } as unknown as ChatMessage;
    const bus = new UiActionBus();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    const stopNavigation = registerDocumentNavigation({ bus });
    const page1 = recorder();
    const view = render(<OutcomeHost config={{ uiActionBus: bus, session, onTurnEnd: page1.onTurnEnd }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { control.set([user], 'submitted'); });
    await act(async () => { control.set([user, first], 'streaming'); });
    await act(async () => { control.set([user, first], 'ready'); });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    await settle(60);
    // The page goes: the turn goes on on the next page.
    expect(page1.seen()).toEqual([]);
    view.unmount();
    stopNavigation();
    vi.unstubAllGlobals();

    const page2 = recorder();
    render(<OutcomeHost config={{ session, onTurnEnd: page2.onTurnEnd }} />);
    await waitFor(() => expect(ctx.isLoading).toBe(true));
    const saved = ctx.messages;
    await settle();
    expect(page2.seen()).toEqual([]);
    const answer = { id: 'a2', role: 'assistant', parts: [{ type: 'step-start' }, { type: 'text', text: 'Opened.' }] } as unknown as ChatMessage;
    await act(async () => { control.set([...saved, answer], 'streaming'); });
    await act(async () => { control.set([...saved, answer], 'ready'); });
    await settle();
    expect(page2.seen()).toEqual(['completed/finished']);
    expect(page2.calls[0]!.outcome.userMessageId).toBe('u1');
  });
});

describe('onTurnEnd: a turn that reaches an approval', () => {
  const approvalPart = (state: string, approval: Record<string, unknown> = { id: 'ap-1' }) =>
    tool('c1', state, { approval });
  const answerApproval = (chat: StreamingChat, approved: boolean) => {
    chat.messages = chat.messages.map((message) => (message.role !== 'assistant' ? message : {
      ...message,
      parts: message.parts.map((part) => ((part as { state?: string }).state === 'approval-requested'
        ? { ...part, state: 'approval-responded', approval: { id: 'ap-1', approved } }
        : part)),
    }) as ChatMessage);
  };

  /** The server's safety stop on the last allowed step, which asks for an approval (finishReason 'tool-calls'). */
  async function safetyStopAtApproval(chat: StreamingChat) {
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, approvalPart('input-available')]));
    act(() => chat.emit(pipelineState('safety-stop')));
    act(() => chat.finish([stepStart, approvalPart('approval-requested')]));
    await settle();
  }

  it.each([true, false])('safety stop at an open approval: nothing while it is open; once after the decided run (approved %s)', async (approved) => {
    const { calls, seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await safetyStopAtApproval(chat);
    expect(ctx.turnOutcomes.get(userId(chat))?.status).toBe('safety-stop');
    expect(seen()).toEqual([]);
    answerApproval(chat, approved);
    act(() => chat.resume());
    act(() => chat.finish([stepStart, text(approved ? 'Deleted' : 'Not deleted')]));
    await settle();
    expect(seen()).toEqual(['completed/finished']);
    expect(calls[0]!.inState).toBe(calls[0]!.outcome);
  });

  it('an approval never decided, then the session is cleared: no call, nothing stays pending', async () => {
    const { seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd }} />);
    await safetyStopAtApproval(chat);
    await act(async () => { ctx.clear(); });
    await settle();
    expect(seen()).toEqual([]);
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    await settle();
    expect(seen()).toEqual(['completed/finished']);
    expect(chat.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it("the user sends a new message instead of deciding (queue, 'reject-approval', no resend): each turn once", async () => {
    const { calls, seen, onTurnEnd } = recorder();
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd, queue: { enabled: true, sendNowDuringApproval: 'reject-approval' } }} />);
    // A transport that answers the call but does not send on by itself (`autoResumeOnApproval: false`).
    chat.addToolApprovalResponse.mockImplementation(async (response: { approved: boolean }) => {
      answerApproval(chat, response.approved);
      chat.setMessages(chat.messages);
    });
    await safetyStopAtApproval(chat);
    expect(seen()).toEqual([]);
    const first = userId(chat);
    await act(async () => { ctx.submit('two'); });
    await act(async () => { ctx.sendNow(ctx.queue.items[0]!.id); });
    // The rejected call is not continued; the queue sends after its grace period.
    await waitFor(() => expect(chat.sent).toEqual(['one', 'two']), { timeout: 4000 });
    await settle();
    act(() => chat.finish());
    await settle();
    // The left turn ends with what it recorded, once; the new turn once.
    expect(seen()).toEqual(['safety-stop/pipeline', 'completed/finished']);
    expect(calls.map((call) => call.outcome.userMessageId)).toEqual([first, userId(chat, 1)]);
  }, 10_000);
});
