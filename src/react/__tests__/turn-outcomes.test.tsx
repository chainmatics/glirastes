// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { clearLocalSessionStore, createLocalSessionStore } from '../utils/local-session-store.js';
import { useTurnOutcome } from '../hooks/use-turn-outcome.js';
import { useMessageParts } from '../components/message-bubble.js';
import { TURN_OUTCOME_METADATA_KEY } from '../utils/turn-outcomes.js';
import type {
  AiChatProviderConfig,
  ChatMessage,
  MessageBubbleProps,
  MessagePartsProps,
  SessionConfig,
  TurnNoticeProps,
  TurnOutcome,
} from '../types.js';
import { ctx, Host, memoryStorage, renderedTurns, StreamingChat } from './streaming-chat.js';

afterEach(cleanup);

const STOPPED = 'Stopped';
const stepStart = { type: 'step-start' };
const text = (value: string) => ({ type: 'text', text: value, state: 'streaming' });
const runningTool = (id: string) => ({ type: 'tool-tasks_list', toolCallId: id, state: 'input-available', input: {} });
const pipelineState = (status: string) => ({
  type: 'data-pipeline-state', data: { status, maxSteps: 5, stepLimitSource: 'safety', totalSteps: 1 },
});

/** Per user question, in list order: its recorded outcome and what follows it (answer text, own notice). */
function turnsByQuestion() {
  const list = document.querySelector('[data-component="message-list"]')!;
  const rows: Array<{ question: string; outcome: string | null; answer: string | null; notice: string | null }> = [];
  for (const node of [...list.children]) {
    if (node.matches('[data-role="user"]')) {
      const question = node.textContent ?? '';
      const message = ctx.messages.find((entry) => entry.role === 'user'
        && entry.parts.some((part) => 'text' in part && part.text === question));
      const outcome = message ? ctx.turnOutcomes?.get(message.id) : undefined;
      rows.push({ question, outcome: outcome ? `${outcome.status}/${outcome.reason}` : null, answer: null, notice: null });
    } else if (node.matches('[data-role="assistant"]')) {
      const notice = node.querySelector('[data-component="turn-notice"], [data-element="activity-notice"]');
      rows.at(-1)!.answer = [...node.querySelectorAll('[data-component="markdown"]')].map((md) => md.textContent).join('');
      if (notice) rows.at(-1)!.notice = notice.textContent;
    } else if (node.matches('[data-component="turn-notice"]')) {
      rows.at(-1)!.notice = `own: ${node.textContent}`;
    }
  }
  return rows;
}

async function ready() {
  await waitFor(() => expect(ctx.canCompose).toBe(true));
}

function storeFor(key: string, storage = memoryStorage()): SessionConfig {
  return createLocalSessionStore({ storageKey: key, storage, attachmentStore: null });
}

async function reloadWith(store: SessionConfig, config: Partial<AiChatProviderConfig>, view: { unmount(): void }) {
  view.unmount();
  const chat = new StreamingChat();
  render(<Host chat={chat} config={{ ...config, session: store }} />);
  await waitFor(() => expect(document.querySelectorAll('[data-component="message-bubble"]').length).toBeGreaterThan(0));
  return chat;
}

describe('the reported sequence: three questions, two queued, stop before the first token, resume', () => {
  const config: Partial<AiChatProviderConfig> = {
    queue: { enabled: true, maxSize: 5 },
    activityLog: { noticePlacement: 'message' },
  };

  async function run(chat: StreamingChat, stopSecondToo: boolean) {
    await act(async () => { ctx.send('q1'); });
    await act(async () => { ctx.submit('q2'); });
    await act(async () => { ctx.submit('q3'); });
    expect(ctx.queue.items.map((item) => item.text)).toEqual(['q2', 'q3']);
    await act(async () => { ctx.stop(); });
    expect(ctx.queue.paused).toBe(true);
    await act(async () => { ctx.resumeQueue(); });
    await waitFor(() => expect(chat.sent).toEqual(['q1', 'q2']));
    if (stopSecondToo) {
      await act(async () => { ctx.stop(); });
      await act(async () => { ctx.resumeQueue(); });
    } else {
      act(() => chat.finish([stepStart, { type: 'text', text: 'a2' }]));
    }
    await waitFor(() => expect(chat.sent).toEqual(['q1', 'q2', 'q3']));
    act(() => chat.finish([stepStart, { type: 'text', text: 'a3' }]));
  }

  it('the stopped question keeps its own notice after the queued turns ran, and after a reload', async () => {
    const store = storeFor('reported');
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ ...config, session: store }} />);
    await ready();
    await run(chat, false);
    const expected = [
      { question: 'q1', outcome: 'aborted/stopped', answer: null, notice: `own: ${STOPPED}` },
      { question: 'q2', outcome: 'completed/finished', answer: 'a2', notice: null },
      { question: 'q3', outcome: 'completed/finished', answer: 'a3', notice: null },
    ];
    expect(turnsByQuestion()).toEqual(expected);
    await reloadWith(store, config, view);
    await waitFor(() => expect(turnsByQuestion()).toEqual(expected));
  });

  it('two questions stopped before the first token: each keeps its notice', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={config} />);
    await run(chat, true);
    expect(turnsByQuestion()).toEqual([
      { question: 'q1', outcome: 'aborted/stopped', answer: null, notice: `own: ${STOPPED}` },
      { question: 'q2', outcome: 'aborted/stopped', answer: null, notice: `own: ${STOPPED}` },
      { question: 'q3', outcome: 'completed/finished', answer: 'a3', notice: null },
    ]);
  });

  it("noticeScope 'latest' restores the behaviour before: no notice for any of them", async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ ...config, activityLog: { noticePlacement: 'message', noticeScope: 'latest' } }} />);
    await run(chat, true);
    expect(turnsByQuestion().map((row) => row.notice)).toEqual([null, null, null]);
    // The outcomes are recorded all the same.
    expect(turnsByQuestion().map((row) => row.outcome)).toEqual(['aborted/stopped', 'aborted/stopped', 'completed/finished']);
  });
});

describe.each([
  ['log', 'message'],
  ['message', 'message'],
  ['log', 'sections'],
  ['message', 'sections'],
] as const)('an earlier stopped turn (noticePlacement %s, grouping %s)', (noticePlacement, grouping) => {
  it('keeps its notice in the same place as while it was the latest turn', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ activityLog: { noticePlacement, grouping } }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, text('Looking'), runningTool('call-1'), text('more')]));
    await act(async () => { ctx.stop(); });
    const bubble = () => document.querySelector('[data-component="message-bubble"][data-role="assistant"]')!.outerHTML;
    const whileLatest = bubble();
    expect(renderedTurns()).toEqual([{ text: 'Lookingmore', steps: ['aborted'], notice: STOPPED }]);
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    expect(bubble()).toBe(whileLatest);
    expect(renderedTurns()).toEqual([
      { text: 'Lookingmore', steps: ['aborted'], notice: STOPPED },
      { text: 'done', steps: [], notice: null },
    ]);
  });
});

describe('turn outcomes', () => {
  it('a completed turn records completed and shows nothing new', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.finish());
    expect(ctx.turnOutcomes?.get(chat.messages[0]!.id)).toMatchObject({ status: 'completed', reason: 'finished' });
    expect(document.querySelector('[data-component="turn-notice"], [data-element="activity-notice"]')).toBeNull();
  });

  it.each(['log', 'message'] as const)('partial text and a stop: exactly one notice (noticePlacement %s)', async (noticePlacement) => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ activityLog: { noticePlacement } }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, text('Partial')]));
    await act(async () => { ctx.stop(); });
    const notices = () => document.querySelectorAll('[data-component="turn-notice"], [data-element="activity-notice"]');
    expect(notices()).toHaveLength(1);
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    expect(notices()).toHaveLength(1);
    expect(renderedTurns()[0]).toEqual({ text: 'Partial', steps: [], notice: STOPPED });
  });

  it('an error before the first token: the question keeps an error notice after the next turn', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.fail());
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    expect(turnsByQuestion()).toEqual([
      { question: 'one', outcome: 'error/request-failed', answer: null, notice: `own: ${ctx.locale.pipelineErrorLabel}` },
      { question: 'two', outcome: 'completed/finished', answer: 'done', notice: null },
    ]);
    expect(document.querySelector('[data-component="turn-notice"]')!.getAttribute('data-status')).toBe('error');
  });

  it('a safety stop the server reports stays on its turn', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, text('Partial')]));
    act(() => chat.emit(pipelineState('safety-stop')));
    act(() => chat.finish([stepStart, text('Partial')]));
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    expect(turnsByQuestion()[0]).toMatchObject({ outcome: 'safety-stop/pipeline', answer: 'Partial' });
    expect(renderedTurns()[0]!.notice).toBe(ctx.locale.pipelineSafetyStopLabel);
  });

  it("sendNow with 'abort': the stopped turn records send-now and keeps its notice", async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ queue: { enabled: true, sendNowBehavior: 'abort' } }} />);
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.submit('two'); });
    await act(async () => { ctx.sendNow(ctx.queue.items[0]!.id); });
    await waitFor(() => expect(chat.sent).toEqual(['one', 'two']));
    act(() => chat.finish());
    expect(turnsByQuestion()).toEqual([
      { question: 'one', outcome: 'aborted/send-now', answer: null, notice: `own: ${STOPPED}` },
      { question: 'two', outcome: 'completed/finished', answer: 'done', notice: null },
    ]);
  });

  it('a retry of a stopped turn: the old notice goes, the new attempt decides', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.stop(); });
    const user = chat.messages[0]!;
    expect(ctx.turnOutcomes?.get(user.id)?.status).toBe('aborted');
    act(() => chat.retry());
    await waitFor(() => expect(ctx.turnOutcomes?.has(user.id)).toBe(false));
    expect(document.querySelector('[data-component="turn-notice"]')).toBeNull();
    act(() => chat.finish());
    expect(ctx.turnOutcomes?.get(user.id)?.status).toBe('completed');
    act(() => chat.retry());
    act(() => chat.fail());
    expect(ctx.turnOutcomes?.get(user.id)?.status).toBe('error');
  });

  it('a run that ends with an open approval is not completed yet', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.finish([{
      type: 'tool-tasks_delete', toolCallId: 'call-1', state: 'approval-requested', input: {}, approval: { id: 'ap-1' },
    }]));
    expect(ctx.turnOutcomes?.size).toBe(0);
  });

  it('a stop while idle records nothing', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.finish());
    await act(async () => { ctx.stop(); });
    expect(ctx.turnOutcomes?.get(chat.messages[0]!.id)?.status).toBe('completed');
  });
});

describe('persistence', () => {
  it('stores the outcome in the user message metadata; the transport and the requests never carry it', async () => {
    const store = storeFor('persist');
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: store }} />);
    await ready();
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.stop(); });
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    expect(chat.messages.some((message) => 'metadata' in message)).toBe(false);
    const stored = await store.load!('default') as Array<ChatMessage & { metadata?: Record<string, unknown> }>;
    expect(stored.map((message) => message.metadata?.[TURN_OUTCOME_METADATA_KEY])).toEqual([
      expect.objectContaining({ status: 'aborted', reason: 'stopped' }),
      expect.objectContaining({ status: 'completed', reason: 'finished' }),
      undefined,
    ]);
    const reloaded = await reloadWith(store, {}, view);
    await waitFor(() => expect(ctx.turnOutcomes?.get(stored[0]!.id)?.status).toBe('aborted'));
    expect(reloaded.messages.some((message) => 'metadata' in message)).toBe(false);
  });

  it("keeps the app's own metadata on a stored user message", async () => {
    const store = storeFor('app-meta');
    await store.save!('default', [{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }],
      metadata: { app: 1, [TURN_OUTCOME_METADATA_KEY]: { status: 'error', reason: 'request-failed', at: 'x' } },
    } as unknown as ChatMessage]);
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ session: store }} />);
    await waitFor(() => expect(chat.messages).toHaveLength(1));
    expect((chat.messages[0] as { metadata?: unknown }).metadata).toEqual({ app: 1 });
    expect(ctx.turnOutcomes?.get('u1')).toEqual({ userMessageId: 'u1', status: 'error', reason: 'request-failed', at: 'x' });
  });

  it('loads an old stored session unchanged and invents no notice', async () => {
    const store = storeFor('old');
    const history: ChatMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'two' }] },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
    ];
    await store.save!('default', history);
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ session: store }} />);
    await waitFor(() => expect(chat.messages).toHaveLength(3));
    expect(chat.messages).toEqual(history);
    expect(ctx.turnOutcomes?.size).toBe(0);
    expect(document.querySelector('[data-component="turn-notice"]')).toBeNull();
  });

  it('goes with its conversation on maxSessions eviction and clearLocalSessionStore', async () => {
    const storage = memoryStorage();
    let id = 0;
    const options = { storageKey: 'evict', storage, attachmentStore: null, maxSessions: 1, createId: () => `s${++id}`, now: () => id };
    const store = createLocalSessionStore(options);
    const withOutcome = [{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }],
      metadata: { [TURN_OUTCOME_METADATA_KEY]: { status: 'aborted', reason: 'stopped', at: 'x' } },
    } as unknown as ChatMessage];
    await store.save!('default', withOutcome);
    await store.create!();
    expect(await store.load!('default')).toBeNull();
    await store.save!('s1', withOutcome);
    await clearLocalSessionStore(options);
    expect(await store.load!('s1')).toBeNull();
  });
});

describe('custom rendering', () => {
  it('hands the outcome to components.TurnNotice in the default bubble and after a question without an answer', async () => {
    const notices: TurnNoticeProps[] = [];
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ components: { TurnNotice: (props) => { notices.push(props); return null; } } }} />);
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.stop(); });
    expect(notices.at(-1)).toMatchObject({ status: 'aborted', placement: 'message', outcome: { status: 'aborted', reason: 'stopped' } });
    await act(async () => { ctx.send('two'); });
    act(() => chat.stream([stepStart, text('Partial')]));
    await act(async () => { ctx.stop(); });
    expect(notices.at(-1)).toMatchObject({ placement: 'message', outcome: { userMessageId: chat.messages[1]!.id } });
  });

  it('gives a custom MessageBubble, MessageParts, useMessageParts and useTurnOutcome the outcome', async () => {
    const seen: Array<{ id: string; prop: TurnOutcome | null | undefined; hook: TurnOutcome | null; parts: TurnOutcome | null }> = [];
    function Bubble({ message, turnOutcome }: MessageBubbleProps) {
      const hook = useTurnOutcome(message);
      const parts = useMessageParts(message);
      seen.push({ id: message.id, prop: turnOutcome, hook, parts: parts.turnOutcome });
      return <div data-component="message-bubble" data-role={message.role}>{parts.text}</div>;
    }
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ components: { MessageBubble: Bubble } }} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, text('Partial')]));
    await act(async () => { ctx.stop(); });
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    const [u1, a1, u2] = chat.messages;
    const latest = (id: string) => seen.filter((entry) => entry.id === id).at(-1)!;
    for (const id of [u1!.id, a1!.id]) {
      expect(latest(id).prop).toMatchObject({ userMessageId: u1!.id, status: 'aborted' });
      expect(latest(id).hook?.status).toBe('aborted');
      expect(latest(id).parts?.status).toBe('aborted');
    }
    expect(latest(u2!.id).hook?.status).toBe('completed');

    const arranged: Array<MessagePartsProps['turnOutcome']> = [];
    cleanup();
    const second = new StreamingChat();
    render(<Host chat={second} config={{
      components: { MessageParts: (props) => { arranged.push(props.turnOutcome); return <>{props.children}</>; } },
    }} />);
    await act(async () => { ctx.send('one'); });
    act(() => second.stream([stepStart, text('Partial')]));
    await act(async () => { ctx.stop(); });
    expect(arranged.at(-1)).toMatchObject({ status: 'aborted' });
  });

  it('an app that draws its own notice turns the built-in one off with components.TurnNotice: () => null', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ components: { TurnNotice: () => null } }} />);
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.stop(); });
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    expect(document.querySelector('[data-component="turn-notice"], [data-element="activity-notice"]')).toBeNull();
  });

  it('the notice after a question without an answer stays right after it while later turns arrive', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    await act(async () => { ctx.stop(); });
    const notice = document.querySelector('[data-component="turn-notice"]')!;
    expect(notice.previousElementSibling!.textContent).toBe('one');
    await act(async () => { ctx.send('two'); });
    act(() => chat.finish());
    await act(async () => { ctx.send('three'); });
    act(() => chat.finish());
    const notices = document.querySelectorAll('[data-component="turn-notice"]');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.previousElementSibling!.textContent).toBe('one');
    expect(notices[0]!.nextElementSibling!.textContent).toBe('two');
  });
});
