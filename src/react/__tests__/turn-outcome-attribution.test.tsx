// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, FilePart, SessionConfig } from '../types.js';
import { ctx, Host, StreamingChat } from './streaming-chat.js';

afterEach(cleanup);

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const answer = (id: string, text: string): ChatMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text }] });
const B = [user('b-u1', 'b question'), answer('b-a1', 'b answer')];
const storedOutcome = (messages: ChatMessage[] | undefined, id: string) =>
  (messages?.find((message) => message.id === id) as { metadata?: Record<string, unknown> } | undefined)
    ?.metadata?.glirastesTurnOutcome as { status?: string } | undefined;

/** A host-owned store: `activeId` comes from the host (`session.activeId`), `save` writes back into it. */
function store(initial: Record<string, ChatMessage[]>) {
  const histories: Record<string, ChatMessage[]> = { ...initial };
  const saves: Array<{ id: string; messages: ChatMessage[] }> = [];
  const session = (activeId: string): SessionConfig => ({
    activeId,
    load: async (id: string) => histories[id] ?? [],
    save: (id: string, messages: ChatMessage[]) => {
      saves.push({ id, messages });
      histories[id] = messages;
    },
  });
  return { histories, saves, session };
}

/** Chat A sends a message and its request is still running. */
async function runningInA() {
  await waitFor(() => expect(ctx.canCompose).toBe(true));
  await act(async () => { ctx.send('a question'); });
  expect(ctx.isLoading).toBe(true);
  const aUser = ctx.messages.find((message) => message.role === 'user')!.id;
  return aUser;
}

describe('a turn outcome belongs to the chat and the user message its request was started for', () => {
  it("a failure of chat A's request after a host switch to B is not recorded on B, and lands on A when A opens again", async () => {
    const { histories, saves, session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await runningInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ctx.messages.map((m) => m.id)).toEqual(['b-u1', 'b-a1']));
    await act(async () => { chat.fail(); });
    expect(ctx.turnOutcomes?.get('b-u1')).toBeUndefined();
    expect(saves.filter((entry) => entry.id === 'B').every((entry) => !storedOutcome(entry.messages, 'b-u1'))).toBe(true);
    // Back to A: its turn shows the failure and the store gets it.
    view.rerender(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.messages.map((m) => m.id)).toEqual([aUser]));
    await waitFor(() => expect(ctx.turnOutcomes?.get(aUser)?.status).toBe('error'));
    await waitFor(() => expect(storedOutcome(histories.A, aUser)?.status).toBe('error'));
  });

  it("stop() of chat A's running request after a host switch records nothing on B's turn", async () => {
    const { saves, session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await runningInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ctx.messages.map((m) => m.id)).toEqual(['b-u1', 'b-a1']));
    expect(ctx.isLoading).toBe(true);
    await act(async () => { ctx.stop(); });
    expect(ctx.turnOutcomes?.get('b-u1')).toBeUndefined();
    expect(saves.filter((entry) => entry.id === 'B').every((entry) => !storedOutcome(entry.messages, 'b-u1'))).toBe(true);
  });

  it("a pipeline end of chat A's request after a host switch is not recorded on B", async () => {
    const { session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await runningInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ctx.messages.map((m) => m.id)).toEqual(['b-u1', 'b-a1']));
    await act(async () => {
      chat.emit({ type: 'data-pipeline-state', data: { status: 'safety-stop', totalSteps: 1, maxSteps: 1, stepLimitSource: 'safety', updatedAt: 'x' } });
    });
    await act(async () => { chat.finish(); });
    expect(ctx.turnOutcomes?.get('b-u1')).toBeUndefined();
  });

  it('A to B to A while A runs: the outcome lands on A\'s turn and is stored for A', async () => {
    const { histories, session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    const aUser = await runningInA();
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ctx.messages.map((m) => m.id)).toEqual(['b-u1', 'b-a1']));
    view.rerender(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.messages.map((m) => m.id)).toEqual([aUser]));
    await act(async () => { chat.fail(); });
    await waitFor(() => expect(ctx.turnOutcomes?.get(aUser)?.status).toBe('error'));
    await waitFor(() => expect(storedOutcome(histories.A, aUser)?.status).toBe('error'));
    expect(storedOutcome(histories.B, 'b-u1')).toBeUndefined();
  });

  it('a host switch to a new, empty chat while A runs: the new chat gets no outcome', async () => {
    const { session } = store({ A: [] });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await runningInA();
    view.rerender(<Host chat={chat} config={{ session: session('C') }} />);
    await waitFor(() => expect(ctx.messages).toEqual([]));
    await act(async () => { ctx.stop(); });
    // The new chat's first turn starts after the stop: it never inherits A's outcome.
    await act(async () => { ctx.send('c question'); });
    await act(async () => { chat.finish(); });
    const cUser = ctx.messages.find((message) => message.role === 'user')!.id;
    expect(ctx.turnOutcomes?.get(cUser)?.status).toBe('completed');
    expect([...(ctx.turnOutcomes?.values() ?? [])].map((outcome) => outcome.userMessageId)).toEqual([cUser]);
  });

  it('clear() while a request runs: the failure of the cleared run is recorded nowhere', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('first'); });
    await act(async () => { ctx.clear(); });
    await act(async () => { chat.fail(); });
    expect(ctx.turnOutcomes?.size ?? 0).toBe(0);
  });
});

describe('lastRejection belongs to the chat it was refused in', () => {
  const file: FilePart = { type: 'file', mediaType: 'text/plain', url: 'data:text/plain;base64,aGk=', filename: 'a.txt' };

  it('is null again after clear()', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.submitWithResult('with file', { files: [file] }); });
    expect(ctx.lastRejection?.reason).toBe('attachments-off');
    await act(async () => { ctx.clear(); });
    expect(ctx.lastRejection).toBeNull();
  });

  it('is null again after a session switch (host-owned activeId and switchSession)', async () => {
    const { session } = store({ A: [], B });
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: session('A') }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.submitWithResult('with file', { files: [file] }); });
    expect(ctx.lastRejection?.reason).toBe('attachments-off');
    view.rerender(<Host chat={chat} config={{ session: session('B') }} />);
    await waitFor(() => expect(ctx.messages.map((m) => m.id)).toEqual(['b-u1', 'b-a1']));
    expect(ctx.lastRejection).toBeNull();
  });
});

