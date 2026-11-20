// @vitest-environment jsdom
// A chat the host leaves (`session.activeId`) while its turn runs: nothing of that turn reaches the newly
// opened chat (its messages, its stored history, its requests); the left chat's turn is stopped at the
// switch, recorded as `aborted` / `chat-left` and stored with that chat at once (`session.save` with its id).

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, SessionConfig, TurnEndInfo, TurnOutcome } from '../types.js';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { ctx, Host, Probe, renderedTurns, StreamingChat } from './streaming-chat.js';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { cleanup(); warn.mockRestore(); });

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const answer = (id: string, text: string): ChatMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] });
const B = [user('b-u1', 'b question'), answer('b-a1', 'b answer')];
const C = [user('c-u1', 'c question'), answer('c-a1', 'c answer')];
const settle = (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const ids = (messages: ReadonlyArray<{ id: string }> | undefined) => (messages ?? []).map((message) => message.id);
const texts = (messages: ReadonlyArray<ChatMessage> | undefined) => JSON.stringify(messages ?? []);
const storedOutcome = (messages: ChatMessage[] | undefined, id: string) =>
  (messages?.find((message) => message.id === id) as { metadata?: Record<string, unknown> } | undefined)
    ?.metadata?.glirastesTurnOutcome as { status?: string; reason?: string } | undefined;

/**
 * A transport whose `stop` does not end the request (it cannot cancel): the left request goes on until the test
 * ends it. A transport that aborts (the AI SDK) writes after the switch at most a chunk already on its way, before
 * its status settles; the removal window covers both.
 */
class NoCancelChat extends StreamingChat {
  override stop = vi.fn(() => {});
}

/** A host-owned store; `delay` makes `load` and `save` async and slow. */
function store(initial: Record<string, ChatMessage[]>, options: { delay?: number; save?: boolean; load?: boolean } = {}) {
  const histories: Record<string, ChatMessage[]> = { ...initial };
  const saves: Array<{ id: string; messages: ChatMessage[] }> = [];
  const wait = () => new Promise((resolve) => setTimeout(resolve, options.delay));
  const session = (activeId: string): SessionConfig => ({
    activeId,
    ...(options.load === false ? {} : {
      load: async (id: string) => {
        if (options.delay) await wait();
        return histories[id] ?? [];
      },
    }),
    ...(options.save === false ? {} : {
      save: async (id: string, messages: ChatMessage[]) => {
        if (options.delay) await wait();
        saves.push({ id, messages });
        histories[id] = messages;
      },
    }),
  });
  return { histories, saves, session };
}

async function sendInA(text = 'a question') {
  await waitFor(() => expect(ctx.canCompose).toBe(true));
  await act(async () => { ctx.send(text); });
  expect(ctx.isLoading).toBe(true);
  return ctx.messages.filter((message) => message.role === 'user').at(-1)!.id;
}

describe.each([{ queue: undefined }, { queue: { enabled: true } }])('host switch while a request runs (queue: $queue)', ({ queue }) => {
  const extra = queue ? { queue } : {};

  it('the left chat\'s answer stays out of the new chat, its store and its next request (the reported case)', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A'), ...extra }} />);
    await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B'), ...extra }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    // The stream goes on (a transport that cannot stop, or a chunk already on its way): it writes into the history it holds.
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();

    expect(texts(ctx.messages)).not.toContain('ANSWER OF A');
    expect(texts(chat.messages)).not.toContain('ANSWER OF A');
    expect(texts(histories.B)).not.toContain('ANSWER OF A');

    await act(async () => { ctx.send('b follow-up'); });
    expect(ids(chat.requests.at(-1))).toEqual(['b-u1', 'b-a1', chat.requests.at(-1)!.at(-1)!.id]);
    expect(texts(chat.requests.at(-1))).not.toContain('ANSWER OF A');
  });

  it('stops the left request at the switch and stores its turn with A at once (aborted / chat-left), not with B', async () => {
    const { histories, saves, session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A'), ...extra }} />);
    const aUser = await sendInA();
    act(() => chat.stream([{ type: 'text', text: 'partial of A' }]));
    const aAnswer = chat.messages.at(-1)!.id;
    expect(chat.stop).not.toHaveBeenCalled();
    view.rerender(<Host chat={chat} config={{ session: session('B'), ...extra }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    expect(chat.stop).toHaveBeenCalledTimes(1);
    // A's stored history: its question, the partial answer, and the outcome; without A being opened again.
    await waitFor(() => expect(storedOutcome(histories.A, aUser)).toMatchObject({ status: 'aborted', reason: 'chat-left' }));
    expect(ids(histories.A)).toEqual([aUser, aAnswer]);
    expect(texts(histories.A)).toContain('partial of A');
    // B: nothing of A, and no outcome.
    expect(saves.filter((entry) => entry.id === 'B').every((entry) => !texts(entry.messages).includes('of A'))).toBe(true);
    expect(storedOutcome(histories.B, 'b-u1')).toBeUndefined();
    expect(ctx.turnOutcomes.size).toBe(0);
    expect(ctx.isLoading).toBe(false);
    // B's next request carries B's history only.
    await act(async () => { ctx.send('b follow-up'); });
    expect(ids(chat.requests.at(-1)).slice(0, 2)).toEqual(['b-u1', 'b-a1']);
    expect(chat.requests.at(-1)).toHaveLength(3);
  });

  it('a switch to a new, empty chat: the new chat gets nothing, its first request carries only its own message', async () => {
    const { histories, session } = store({ A: [] });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A'), ...extra }} />);
    const aUser = await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('N'), ...extra }} />);
    await waitFor(() => expect(ctx.messages).toEqual([]));
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    expect(ctx.messages).toEqual([]);
    expect(histories.N).toBeUndefined();
    await act(async () => { ctx.send('n question'); });
    expect(chat.requests.at(-1)!.map((message) => message.role)).toEqual(['user']);
    expect(texts(chat.requests.at(-1))).not.toContain('a question');
    expect(storedOutcome(histories.A, aUser)?.status).toBe('aborted');
  });
});

describe('counter-examples', () => {
  it('a switch during a tool step: the step stays with A (stored, stopped), its late result neither runs nor reaches B', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new NoCancelChat();
    const onToolResult = vi.fn();
    const view = render(<Host chat={chat} config={{ session: session('A'), onToolResult }} />);
    const aUser = await sendInA();
    act(() => chat.stream([{ type: 'step-start' }, { type: 'tool-tasks_list', toolCallId: 'c1', state: 'input-available', input: {} }]));
    view.rerender(<Host chat={chat} config={{ session: session('B'), onToolResult }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await waitFor(() => expect(storedOutcome(histories.A, aUser)?.reason).toBe('chat-left'));
    expect(texts(histories.A)).toContain('"toolCallId":"c1"');
    act(() => chat.finish([{ type: 'step-start' }, { type: 'tool-tasks_list', toolCallId: 'c1', state: 'output-available', input: {}, output: { success: true } }]));
    await settle();
    expect(onToolResult).not.toHaveBeenCalled();
    expect(texts(ctx.messages)).not.toContain('c1');
    expect(texts(histories.B)).not.toContain('c1');
    await act(async () => { ctx.send('b follow-up'); });
    expect(texts(chat.requests.at(-1))).not.toContain('c1');
  });

  it('a switch at an open approval: nothing runs, so nothing is stopped or written; as before', async () => {
    const { histories, saves, session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    act(() => chat.finish([{ type: 'step-start' }, { type: 'tool-tasks_delete', toolCallId: 'c1', state: 'approval-requested', input: {}, approval: { id: 'ap-1' } }]));
    await settle();
    const savesOfA = saves.filter((entry) => entry.id === 'A').length;
    const storedA = histories.A;
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await settle();
    expect(chat.stop).not.toHaveBeenCalled();
    expect(saves.filter((entry) => entry.id === 'A')).toHaveLength(savesOfA);
    expect(histories.A).toBe(storedA);
    expect(storedOutcome(histories.A, aUser)).toBeUndefined();
    await act(async () => { ctx.send('b follow-up'); });
    expect(ids(chat.requests.at(-1)).slice(0, 2)).toEqual(['b-u1', 'b-a1']);
    expect(texts(chat.requests.at(-1))).not.toContain('ap-1');
  });

  it('a switch during a queued flush: the flushed turn is stopped and stored with A, the earlier one keeps completed', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A'), queue: { enabled: true } }} />);
    const first = await sendInA('one');
    await act(async () => { ctx.submit('two'); });
    expect(ctx.queue.items).toHaveLength(1);
    await act(async () => { chat.finish([{ type: 'text', text: 'answer one' }]); });
    await waitFor(() => expect(chat.sent).toEqual(['one', 'two']));
    expect(ctx.isLoading).toBe(true);
    const second = chat.messages.filter((message) => message.role === 'user').at(-1)!.id;
    view.rerender(<Host chat={chat} config={{ session: session('B'), queue: { enabled: true } }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    expect(storedOutcome(histories.A, first)).toMatchObject({ status: 'completed', reason: 'finished' });
    expect(storedOutcome(histories.A, second)).toMatchObject({ status: 'aborted', reason: 'chat-left' });
    expect(texts(histories.B)).not.toContain('ANSWER OF A');
    await act(async () => { ctx.send('b follow-up'); });
    expect(chat.sent).toEqual(['one', 'two', 'b follow-up']);
    expect(ids(chat.requests.at(-1)).slice(0, 2)).toEqual(['b-u1', 'b-a1']);
    expect(chat.requests.at(-1)).toHaveLength(3);
  });

  it('A to B to A before A\'s turn would have ended: A shows its turn as stopped, a late chunk lands nowhere', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    view.rerender(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual([aUser]));
    await waitFor(() => expect(ctx.turnOutcomes.get(aUser)).toMatchObject({ status: 'aborted', reason: 'chat-left' }));
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    expect(ids(ctx.messages)).toEqual([aUser]);
    expect(texts(histories.A)).not.toContain('ANSWER OF A');
    expect(storedOutcome(histories.A, aUser)?.reason).toBe('chat-left');
    expect(texts(histories.B)).not.toContain('a question');
    await act(async () => { ctx.send('a again'); });
    expect(ids(chat.requests.at(-1))).toEqual([aUser, chat.requests.at(-1)!.at(-1)!.id]);
  });

  it('two quick switches A to B to C, the request ends before C\'s history arrives: neither B nor C gets anything of A; A keeps its finished answer', async () => {
    const { histories, saves, session } = store({ A: [], B, C }, { delay: 5 });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    view.rerender(<Host chat={chat} config={{ session: session('C') }} />);
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['c-u1', 'c-a1']));
    await settle(40);
    expect(texts(ctx.messages)).not.toContain('ANSWER OF A');
    expect(texts(histories.B)).not.toContain('of A');
    expect(texts(histories.C)).not.toContain('of A');
    expect(saves.filter((entry) => entry.id === 'B')).toEqual([]);
    // Nothing decided the leave before the request ended by itself: it was not stopped, its answer is stored with A.
    expect(chat.stop).not.toHaveBeenCalled();
    expect(texts(histories.A)).toContain('ANSWER OF A');
    expect(storedOutcome(histories.A, aUser)).toBeUndefined();
    await act(async () => { ctx.send('c follow-up'); });
    expect(ids(chat.requests.at(-1)).slice(0, 2)).toEqual(['c-u1', 'c-a1']);
    expect(chat.requests.at(-1)).toHaveLength(3);
  });

  it('slow async storage: the request ends during B\'s load; nothing reaches B, A keeps what it showed', async () => {
    const { histories, saves, session } = store({ A: [], B }, { delay: 30 });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    act(() => chat.stream([{ type: 'text', text: 'partial of A' }]));
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    // B still loads: a chunk of A arrives meanwhile.
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await settle(80);
    expect(texts(ctx.messages)).not.toContain('of A');
    expect(saves.filter((entry) => entry.id === 'B').every((entry) => !texts(entry.messages).includes('of A'))).toBe(true);
    expect(storedOutcome(histories.A, aUser)).toBeUndefined();
    // (This test transport writes its later chunks only into a message it still holds: the cleared one is gone.)
    expect(ids(histories.A)[0]).toBe(aUser);
    expect(texts(histories.A)).toContain('partial of A');
    await act(async () => { ctx.send('b follow-up'); });
    expect(chat.requests.at(-1)).toHaveLength(3);
  });

  it('a store without save: the outcome stays in memory and joins A when it is opened again (as before)', async () => {
    const { histories, session } = store({ A: [], B }, { save: false });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    expect(texts(ctx.messages)).not.toContain('ANSWER OF A');
    expect(histories.A).toEqual([]);
    // A stored history without the turn (nothing was saved): the outcome waits for a turn that is not there.
    view.rerender(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.messages).toEqual([]));
    expect(ctx.turnOutcomes.get(aUser)).toBeUndefined();
  });

  it('a host that sets the new chat\'s history itself (no session.load): B stays clean, A is stored from what it held', async () => {
    const { histories, session } = store({ A: [], B }, { load: false });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    act(() => chat.stream([{ type: 'text', text: 'partial of A' }]));
    await act(async () => {
      chat.setMessages(B);
      view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    });
    expect(chat.stop).toHaveBeenCalledTimes(1);
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']);
    expect(texts(histories.B)).not.toContain('of A');
    expect(storedOutcome(histories.A, aUser)?.reason).toBe('chat-left');
    expect(texts(histories.A)).toContain('partial of A');
    await act(async () => { ctx.send('b follow-up'); });
    expect(chat.requests.at(-1)).toHaveLength(3);
  });

  it('a reload after leaving A: A loads with its stopped turn and its notice', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await waitFor(() => expect(storedOutcome(histories.A, aUser)?.reason).toBe('chat-left'));
    view.unmount();
    // The page loads again (a new transport, a new provider) and opens A.
    const fresh = new StreamingChat();
    render(<Host chat={fresh} config={{ session: session('A') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual([aUser]));
    expect(ctx.turnOutcomes.get(aUser)).toMatchObject({ status: 'aborted', reason: 'chat-left' });
    expect(document.querySelector('[data-component="turn-notice"]')).not.toBeNull();
    expect(renderedTurns()).toEqual([]);
  });

  it('onTurnEnd: a left chat\'s turn is not reported, at the switch or when A opens again; B\'s turns are', async () => {
    const { session } = store({ A: [], B });
    const calls: Array<[string, string, string]> = [];
    const onTurnEnd = (outcome: TurnOutcome, info: TurnEndInfo) => { calls.push([outcome.status, outcome.reason, info.sessionId]); };
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A'), onTurnEnd }} />);
    await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B'), onTurnEnd }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    view.rerender(<Host chat={chat} config={{ session: session('A'), onTurnEnd }} />);
    await settle();
    expect(calls).toEqual([]);
    view.rerender(<Host chat={chat} config={{ session: session('B'), onTurnEnd }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await act(async () => { ctx.send('b follow-up'); });
    await act(async () => { chat.finish(); });
    await settle();
    expect(calls).toEqual([['completed', 'finished', 'B']]);
  });
});

describe('unchanged', () => {
  it('a chat that is never left mid-request: no stop, the same requests and saves as before', async () => {
    const { histories, saves, session } = store({ A: [] });
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    await act(async () => { chat.finish([{ type: 'text', text: 'answer' }]); });
    await settle();
    expect(chat.stop).not.toHaveBeenCalled();
    expect(saves.every((entry) => entry.id === 'A')).toBe(true);
    expect(storedOutcome(histories.A, aUser)).toMatchObject({ status: 'completed', reason: 'finished' });
    await act(async () => { ctx.send('two'); });
    expect(ids(chat.requests.at(-1))).toEqual([aUser, ids(histories.A)[1], chat.requests.at(-1)!.at(-1)!.id]);
  });

  it('switchSession() stays refused while a request runs', async () => {
    const { session } = store({ A: [], B });
    const chat = new StreamingChat();
    const cfg = { ...session('A'), activeId: undefined, defaultActiveId: 'A' };
    render(<Host chat={chat} config={{ session: cfg }} />);
    await sendInA();
    await act(async () => { await ctx.switchSession('B'); });
    expect(chat.stop).not.toHaveBeenCalled();
    expect(ctx.isLoading).toBe(true);
  });
});


describe('review: the removal window and given histories', () => {
  it('A to B to A without a send: A keeps its partial answer on screen and in its store', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    act(() => chat.stream([{ type: 'text', text: 'partial of A' }]));
    const aAnswer = chat.messages.at(-1)!.id;
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    view.rerender(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual([aUser, aAnswer]));
    await settle();
    expect(ids(ctx.messages)).toEqual([aUser, aAnswer]);
    expect(ids(histories.A)).toEqual([aUser, aAnswer]);
    expect(texts(histories.A)).toContain('partial of A');
    expect(storedOutcome(histories.A, aUser)?.reason).toBe('chat-left');
    await act(async () => { ctx.send('a again'); });
    expect(ids(chat.requests.at(-1)).slice(0, 2)).toEqual([aUser, aAnswer]);
  });

  it('A to B to C to A without a send: A keeps its partial answer', async () => {
    const { histories, session } = store({ A: [], B, C });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    act(() => chat.stream([{ type: 'text', text: 'partial of A' }]));
    const aAnswer = chat.messages.at(-1)!.id;
    for (const id of ['B', 'C']) {
      view.rerender(<Host chat={chat} config={{ session: session(id) }} />);
      await waitFor(() => expect(ids(ctx.messages)[0]).toBe(`${id.toLowerCase()}-u1`));
    }
    view.rerender(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual([aUser, aAnswer]));
    await settle();
    expect(ids(histories.A)).toEqual([aUser, aAnswer]);
  });

  it('a host without load that restores A itself: A keeps its partial answer', async () => {
    const { histories, session } = store({ A: [], B }, { load: false });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    act(() => chat.stream([{ type: 'text', text: 'partial of A' }]));
    const aAnswer = chat.messages.at(-1)!.id;
    await act(async () => { chat.setMessages(B); view.rerender(<Host chat={chat} config={{ session: session('B') }} />); });
    await settle();
    expect(ids(histories.A)).toEqual([aUser, aAnswer]);
    await act(async () => { chat.setMessages(histories.A); view.rerender(<Host chat={chat} config={{ session: session('A') }} />); });
    await settle();
    expect(ids(ctx.messages)).toEqual([aUser, aAnswer]);
    expect(ids(histories.A)).toEqual([aUser, aAnswer]);
  });

  it('a given history whose ids collide with the left turn\'s keeps them', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await sendInA();
    act(() => chat.stream([{ type: 'text', text: 'partial of A' }]));
    const aAnswer = chat.messages.at(-1)!.id;
    // A custom transport with counter ids: B's stored answer has the same id.
    histories.B = [user('b-u1', 'b question'), answer(aAnswer, 'b answer, same id')];
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', aAnswer]));
    await settle();
    expect(ids(ctx.messages)).toEqual(['b-u1', aAnswer]);
    expect(texts(ctx.messages)).toContain('b answer, same id');
    expect(texts(histories.B)).toContain('b answer, same id');
  });

  it('an assistant message the host appends to B after the left request ended stays (also after more switches)', async () => {
    const { histories, session } = store({ A: [], B, C });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await settle();
    const note = answer('note-b', 'a notification');
    await act(async () => { chat.setMessages([...chat.messages, note]); });
    await settle();
    expect(ids(chat.messages)).toEqual(['b-u1', 'b-a1', 'note-b']);
    expect(ids(histories.B)).toEqual(['b-u1', 'b-a1', 'note-b']);
    view.rerender(<Host chat={chat} config={{ session: session('C') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['c-u1', 'c-a1']));
    await act(async () => { chat.setMessages([...chat.messages, answer('note-c', 'another')]); });
    await settle();
    expect(ids(histories.C)).toEqual(['c-u1', 'c-a1', 'note-c']);
  });

  it('while the left request still runs (stop cannot cancel), a new assistant message appended to B is taken as its answer; once it ended, the window is closed', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    expect(chat.stop).toHaveBeenCalledTimes(1);
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']);
    expect(texts(histories.B)).not.toContain('ANSWER OF A');
    // Ended: an append now is the host's.
    await act(async () => { chat.setMessages([...chat.messages, answer('note-b', 'a notification')]); });
    await settle();
    expect(ids(histories.B)).toEqual(['b-u1', 'b-a1', 'note-b']);
  });

  it('hosts with one transport per chat: A keeps streaming across A to B to A, untouched; its answer arrives in A, nothing in B', async () => {
    const { histories, session } = store({ A: [], B });
    const chats: Record<string, StreamingChat> = { A: new StreamingChat(), B: new StreamingChat() };
    const view = render(<Host chat={chats.A!} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    act(() => chats.A!.stream([{ type: 'text', text: 'partial of A' }]));
    view.rerender(<Host chat={chats.B!} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    view.rerender(<Host chat={chats.A!} config={{ session: session('A') }} />);
    await waitFor(() => expect(ids(ctx.messages)[0]).toBe(aUser));
    await settle();
    expect(chats.A!.stop).not.toHaveBeenCalled();
    expect(chats.B!.stop).not.toHaveBeenCalled();
    await act(async () => { chats.A!.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    expect(texts(ctx.messages)).toContain('ANSWER OF A');
    expect(texts(histories.A)).toContain('ANSWER OF A');
    expect(storedOutcome(histories.A, aUser)?.reason).not.toBe('chat-left');
    expect(texts(histories.B)).not.toContain('of A');
    expect(chats.B!.requests).toEqual([]);
  });

  it('the left request\'s step reports and pipeline state do not reach B\'s timeline', async () => {
    const { session } = store({ A: [], B });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await sendInA();
    act(() => chat.emit({ type: 'data-step-report', data: { stepNumber: 0, toolCalls: ['tasks_list'], finishReason: 'tool-calls' } }));
    act(() => chat.emit({ type: 'data-pipeline-state', data: { status: 'running', totalSteps: 1, maxSteps: 5, stepLimitSource: 'safety' } }));
    expect(ctx.pipelineSteps).toHaveLength(1);
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    expect(ctx.pipelineSteps).toEqual([]);
    expect(ctx.pipelineState).toBeNull();
    act(() => chat.emit({ type: 'data-step-report', data: { stepNumber: 1, toolCalls: ['tasks_list'], finishReason: 'tool-calls' } }));
    act(() => chat.emit({ type: 'data-pipeline-state', data: { status: 'running', totalSteps: 2, maxSteps: 5, stepLimitSource: 'safety' } }));
    await act(async () => { chat.finish(); });
    await settle();
    expect(ctx.pipelineSteps).toEqual([]);
    expect(ctx.pipelineState).toBeNull();
  });

  it('late chunks of a left request that cannot be cancelled cause no extra save of B', async () => {
    const { saves, session } = store({ A: [], B });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await settle();
    const before = saves.filter((entry) => entry.id === 'B').length;
    for (const text of ['one', 'one two', 'one two three']) {
      await act(async () => { chat.stream([{ type: 'text', text }]); });
    }
    await act(async () => { chat.finish(); });
    await settle();
    expect(saves.filter((entry) => entry.id === 'B').length).toBe(before);
  });
});

describe('review: save order with a store that completes out of order', () => {
  /** Saves before the switch take long, later ones are quick; a write lands when it completes. */
  function racingStore(initial: Record<string, ChatMessage[]>) {
    const histories: Record<string, ChatMessage[]> = { ...initial };
    let slow = true;
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id: string) => histories[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => new Promise<void>((resolve) => {
        setTimeout(() => { histories[id] = messages; resolve(); }, slow ? 60 : 1);
      }),
    });
    return { histories, session, fast: () => { slow = false; } };
  }

  it('the leave save of A lands after A\'s earlier saves; a quick return to A loads it', async () => {
    const { histories, session, fast } = racingStore({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    act(() => chat.stream([{ type: 'text', text: 'partial of A' }]));
    const aAnswer = chat.messages.at(-1)!.id;
    fast();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    // Back before A's earlier (slow) saves completed.
    view.rerender(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual([aUser, aAnswer]));
    await settle(150);
    expect(ctx.turnOutcomes.get(aUser)?.reason).toBe('chat-left');
    expect(ids(histories.A)).toEqual([aUser, aAnswer]);
    expect(storedOutcome(histories.A, aUser)?.reason).toBe('chat-left');
  });
});

describe('review 2: an id change that is not a leave', () => {
  /** What a store saw, as `id[ids]` with `!` on a stored outcome. */
  const trace = (saves: Array<{ id: string; messages: ChatMessage[] }>, map: (id: string) => string) => saves.map((entry) =>
    `${entry.id}[${entry.messages.map((message) => map(message.id) + (storedOutcome([message], message.id) ? '!' : '')).join(',')}]`);

  it('a host without load renames the draft while the first request runs: as on main, the answer finishes in that chat', async () => {
    const { histories, saves, session } = store({}, { load: false });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('draft') }} />);
    const u = await sendInA('q');
    act(() => chat.stream([{ type: 'text', text: 'part' }]));
    const a = chat.messages.at(-1)!.id;
    view.rerender(<Host chat={chat} config={{ session: session('chat-1') }} />);
    await settle();
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER' }]); });
    await settle();
    const name = (id: string) => (id === u ? 'u' : id === a ? 'a' : id);
    // Observed on main's provider with the same steps.
    expect(chat.stop).not.toHaveBeenCalled();
    expect(ids(ctx.messages)).toEqual([u, a]);
    expect(texts(ctx.messages)).toContain('ANSWER');
    expect([...ctx.turnOutcomes.values()]).toEqual([]);
    expect(trace(saves, name)).toEqual(['draft[u]', 'draft[u,a]', 'chat-1[u,a]', 'chat-1[u,a]']);
    expect(texts(histories['chat-1'])).toContain('ANSWER');
    expect(storedOutcome(histories.draft, u)).toBeUndefined();
    await act(async () => { ctx.send('q2'); });
    expect(ids(chat.requests.at(-1)).slice(0, 2)).toEqual([u, a]);
  });

  it('a host with load renames the draft and load returns the same messages: as on main, the answer finishes in that chat', async () => {
    const { histories, session } = store({});
    const aliasing = (activeId: string): SessionConfig => ({
      ...session(activeId),
      load: async (id: string) => histories[id] ?? histories.draft ?? [],
    });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: aliasing('draft') }} />);
    const u = await sendInA('q');
    act(() => chat.stream([{ type: 'text', text: 'part' }]));
    view.rerender(<Host chat={chat} config={{ session: aliasing('chat-1') }} />);
    await waitFor(() => expect(ids(ctx.messages)[0]).toBe(u));
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER' }]); });
    await settle();
    expect(chat.stop).not.toHaveBeenCalled();
    expect(texts(ctx.messages)).toContain('ANSWER');
    expect(texts(histories['chat-1'])).toContain('ANSWER');
    expect(storedOutcome(histories.draft, u)).toBeUndefined();
  });

  it('a host without load that sets B\'s history a render after the id change: stopped then, B clean', async () => {
    const { histories, session } = store({ A: [], B }, { load: false });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    act(() => chat.stream([{ type: 'text', text: 'partial of A' }]));
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await settle();
    expect(chat.stop).not.toHaveBeenCalled();
    await act(async () => { chat.setMessages(B); });
    expect(chat.stop).toHaveBeenCalledTimes(1);
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    expect(ids(chat.messages)).toEqual(['b-u1', 'b-a1']);
    expect(texts(histories.B)).not.toContain('of A');
    expect(storedOutcome(histories.A, aUser)?.reason).toBe('chat-left');
    expect(texts(histories.A)).toContain('partial of A');
  });
});

describe('review 2: same transport, waits and other requests', () => {
  it('a host that wraps the transport (`{ ...t, stop }` per render) still gets the left request stopped', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new StreamingChat();
    function Wrapped({ id }: { id: string }) {
      const [, force] = React.useReducer((count: number) => count + 1, 0);
      React.useEffect(() => chat.subscribe(force), []);
      const t = chat.transport;
      return <AiChatProvider transport={{ ...t, stop: () => t.stop() }} session={session(id)}><Probe /></AiChatProvider>;
    }
    const view = render(<Wrapped id="A" />);
    const aUser = await sendInA();
    view.rerender(<Wrapped id="B" />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    expect(chat.stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(storedOutcome(histories.A, aUser)?.reason).toBe('chat-left'));
  });

  it('one transport per chat: B sends, back to A while both run: neither is stopped', async () => {
    const { session } = store({ A: [], B });
    const chats: Record<string, StreamingChat> = { A: new StreamingChat(), B: new StreamingChat() };
    const view = render(<Host chat={chats.A!} config={{ session: session('A') }} />);
    await sendInA();
    view.rerender(<Host chat={chats.B!} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await act(async () => { ctx.send('b question 2'); });
    expect(chats.B!.status).toBe('submitted');
    view.rerender(<Host chat={chats.A!} config={{ session: session('A') }} />);
    await settle();
    expect(chats.A!.stop).not.toHaveBeenCalled();
    expect(chats.B!.stop).not.toHaveBeenCalled();
  });

  it('a leave save of A that never settles does not keep A from loading on return', async () => {
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    let hang = false;
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id: string) => histories[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => (hang && id === 'A' ? new Promise<void>(() => {}) : void (histories[id] = messages)),
    });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    hang = true;
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    view.rerender(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true), { timeout: 3000 });
    expect(ids(ctx.messages)).toEqual([aUser]);
  });

  it('removeSession(A) while A\'s leave save still waits: no save of A after the removal', async () => {
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    const calls: string[] = [];
    let slow = true;
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id: string) => histories[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => {
        calls.push(`save:${id}`);
        return new Promise<void>((resolve) => setTimeout(() => { histories[id] = messages; resolve(); }, slow ? 80 : 1));
      },
      list: async () => Object.keys(histories).map((id) => ({ id, title: id })),
      create: async () => ({ id: 'N', title: 'N' }),
      remove: async (id: string) => { calls.push(`remove:${id}`); delete histories[id]; },
    });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await sendInA();
    act(() => chat.stream([{ type: 'text', text: 'partial of A' }]));
    slow = false;
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await act(async () => { await ctx.removeSession('A'); });
    await settle(200);
    const removed = calls.indexOf('remove:A');
    expect(removed).toBeGreaterThan(-1);
    expect(calls.slice(removed + 1)).not.toContain('save:A');
  });

  it('a page-load continuation of the newly opened chat is its own request, also while the window is open', async () => {
    const at = Date.now();
    const uiPart = {
      type: 'tool-ui_navigate', toolCallId: 'c-b', state: 'output-available', input: {},
      output: { handedOff: true, message: 'Handed to the app.', awaitsOutcome: true, uiAction: { type: 'glirastes.navigate' }, outcome: { v: 1, code: 'initiated', at } },
    };
    const bWaiting = [user('b-u1', 'open tasks'), { id: 'b-a1', role: 'assistant', parts: [{ type: 'step-start' }, uiPart] } as unknown as ChatMessage];
    const { histories, session } = store({ A: [], B: bWaiting });
    class ContinuingChat extends NoCancelChat {
      continued = 0;
      override get transport() {
        return {
          ...super.transport,
          addToolOutput: async () => {},
          setUiOutcomeReporting: () => {},
          continueTurn: () => { this.continued += 1; this.resume(); },
        };
      }
    }
    const chat = new ContinuingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    // B's history arrives while the left request still runs (the window is open); B continues once.
    await waitFor(() => expect(chat.continued).toBe(1));
    expect(chat.stop).toHaveBeenCalledTimes(1);
    act(() => chat.emit({ type: 'data-pipeline-state', data: { status: 'running', totalSteps: 1, maxSteps: 5, stepLimitSource: 'safety' } }));
    expect(ctx.pipelineState?.status).toBe('running');
    await act(async () => { chat.finish([{ type: 'text', text: 'B continued' }]); });
    await settle();
    expect(texts(chat.messages)).toContain('B continued');
    expect(texts(histories.B)).toContain('B continued');
  });

  it('a loaded history that starts with an assistant message is kept while the window is open', async () => {
    const greeting = [answer('c-greet', 'Hello, how can I help?')];
    // A load that takes a moment: the cleared transport is shown before the history arrives.
    const { histories, session } = store({ A: [], B, C: greeting }, { delay: 10 });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(chat.messages)).toEqual(['b-u1', 'b-a1']));
    expect(chat.stop).toHaveBeenCalledTimes(1);
    // The left request still runs: the window is open when C's history arrives.
    view.rerender(<Host chat={chat} config={{ session: session('C') }} />);
    await waitFor(() => expect(ids(chat.messages)).toEqual(['c-greet']));
    await settle();
    expect(ids(ctx.messages)).toEqual(['c-greet']);
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    expect(ids(chat.messages)).toEqual(['c-greet']);
    expect(histories.C).toEqual(greeting);
  });
});

describe('review 2: robustness of the leave', () => {
  it('resets the truncation notice of the left chat', async () => {
    const { session } = store({ A: [], B });
    const chat = new NoCancelChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await sendInA();
    act(() => chat.emit({ type: 'data-truncation', data: { completedTools: [], message: 'cut' } }));
    expect(ctx.truncation).not.toBeNull();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    expect(ctx.truncation).toBeNull();
  });

  it('a leave save that rejects is reported and does not stick: A loads again and later saves go out', async () => {
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    let reject = false;
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id: string) => histories[id] ?? [],
      save: async (id: string, messages: ChatMessage[]) => {
        if (reject && id === 'A') throw new Error('offline');
        histories[id] = messages;
      },
    });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    reject = true;
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await settle();
    expect(warn).toHaveBeenCalledWith('[AiChatProvider] session.save failed');
    reject = false;
    view.rerender(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual([aUser]));
    await act(async () => { ctx.send('again'); });
    await waitFor(() => expect(ids(histories.A)).toHaveLength(2));
  });

  it('a transport whose stop throws: the turn is still stored with A and B stays clean', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new NoCancelChat();
    chat.stop.mockImplementation(() => { throw new Error('cannot stop'); });
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await act(async () => { chat.finish([{ type: 'text', text: 'ANSWER OF A' }]); });
    await settle();
    expect(texts(histories.B)).not.toContain('ANSWER OF A');
    expect(storedOutcome(histories.A, aUser)?.reason).toBe('chat-left');
  });

  it('under StrictMode: stopped once, A saved once with its outcome', async () => {
    const { saves, session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<React.StrictMode><Host chat={chat} config={{ session: session('A') }} /></React.StrictMode>);
    const aUser = await sendInA();
    view.rerender(<React.StrictMode><Host chat={chat} config={{ session: session('B') }} /></React.StrictMode>);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    await settle();
    expect(chat.stop).toHaveBeenCalledTimes(1);
    expect(saves.filter((entry) => entry.id === 'A' && storedOutcome(entry.messages, aUser))).toHaveLength(1);
  });

  it('unmounting while the leave save waits: the save of A still goes out, nothing throws', async () => {
    const histories: Record<string, ChatMessage[]> = { A: [], B };
    let slow = true;
    const session = (activeId: string): SessionConfig => ({
      activeId,
      load: async (id: string) => histories[id] ?? [],
      save: (id: string, messages: ChatMessage[]) => new Promise<void>((resolve) => {
        setTimeout(() => { histories[id] = messages; resolve(); }, slow ? 60 : 1);
      }),
    });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await sendInA();
    slow = false;
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ids(ctx.messages)).toEqual(['b-u1', 'b-a1']));
    expect(histories.A).toEqual([]);
    view.unmount();
    await settle(150);
    expect(storedOutcome(histories.A, aUser)?.reason).toBe('chat-left');
  });
});
