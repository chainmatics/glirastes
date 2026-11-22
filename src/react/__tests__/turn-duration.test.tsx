// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalSessionStore } from '../utils/local-session-store.js';
import { composerContextOf } from '../provider/composer-context.js';
import { TURN_OUTCOME_METADATA_KEY } from '../utils/turn-outcomes.js';
import type { ChatMessage, SessionConfig, TurnOutcome } from '../types.js';
import { ctx, Host, memoryStorage, StreamingChat } from './streaming-chat.js';

const START = new Date('2026-11-22T10:00:00.000Z').getTime();

beforeEach(() => {
  // Only the clock: the chat's own timers and `waitFor` keep running.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Moves the clock on (nothing else happens). */
function elapse(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

const text = (value: string) => ({ type: 'text', text: value, state: 'streaming' });
const userId = (chat: StreamingChat, index = 0) => chat.messages.filter((message) => message.role === 'user')[index]!.id;
const outcomeOf = (chat: StreamingChat, index = 0) => ctx.turnOutcomes.get(userId(chat, index));

function storeFor(key: string, storage = memoryStorage()): SessionConfig {
  return createLocalSessionStore({ storageKey: key, storage, attachmentStore: null });
}

describe('TurnOutcome.durationMs: the working time of a turn', () => {
  it('a completed turn records its working time', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([text('Hel')]));
    elapse(3200);
    act(() => chat.finish());
    expect(outcomeOf(chat)).toMatchObject({ status: 'completed', reason: 'finished', durationMs: 3200 });
  });

  it('a stopped turn records the time until the stop', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    elapse(1500);
    await act(async () => { ctx.stop(); });
    expect(outcomeOf(chat)).toMatchObject({ status: 'aborted', reason: 'stopped', durationMs: 1500 });
  });

  it('approval wait is not counted', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    elapse(1000);
    act(() => chat.finish([{
      type: 'tool-tasks_delete', toolCallId: 'call-1', state: 'approval-requested', input: {}, approval: { id: 'ap-1' },
    }]));
    expect(outcomeOf(chat)).toBeUndefined();
    elapse(60_000);
    chat.messages = chat.messages.map((message) => (message.role !== 'assistant' ? message : {
      ...message,
      parts: message.parts.map((part) => ({ ...part, state: 'approval-responded', approval: { id: 'ap-1', approved: true } })),
    }) as ChatMessage);
    act(() => chat.resume());
    elapse(500);
    act(() => chat.finish([text('Deleted')]));
    expect(outcomeOf(chat)).toMatchObject({ status: 'completed', durationMs: 1500 });
  });

  it('a retry measures afresh', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    elapse(2000);
    act(() => chat.finish());
    expect(outcomeOf(chat)?.durationMs).toBe(2000);
    act(() => chat.retry());
    await waitFor(() => expect(outcomeOf(chat)).toBeUndefined());
    elapse(700);
    act(() => chat.finish());
    expect(outcomeOf(chat)).toMatchObject({ status: 'completed', durationMs: 700 });
  });

  it('a continuation after a UI action result adds up', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    elapse(1000);
    act(() => chat.finish([{
      type: 'tool-ui_navigate', toolCallId: 'call-1', state: 'output-available', input: {}, output: { success: true },
    }]));
    expect(outcomeOf(chat)).toMatchObject({ status: 'completed', durationMs: 1000 });
    // The UI action reports its outcome; the same turn continues without a new user message.
    elapse(4000);
    act(() => chat.resume());
    await waitFor(() => expect(outcomeOf(chat)).toBeUndefined());
    elapse(500);
    act(() => chat.finish([text('Opened')]));
    expect(outcomeOf(chat)).toMatchObject({ status: 'completed', durationMs: 1500 });
  });

  it('a new user message after a continuation measures afresh', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    await act(async () => { ctx.send('one'); });
    elapse(1000);
    act(() => chat.finish());
    await act(async () => { ctx.send('two'); });
    elapse(300);
    act(() => chat.finish());
    expect(outcomeOf(chat, 1)).toMatchObject({ status: 'completed', durationMs: 300 });
  });

  it('the duration survives a reload with the session store', async () => {
    const storage = memoryStorage();
    const store = storeFor('duration', storage);
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ session: store }} />);
    await waitFor(() => expect(ctx.canCompose).toBe(true));
    await act(async () => { ctx.send('one'); });
    elapse(800);
    act(() => chat.finish());
    await waitFor(async () => {
      const stored = await store.load!('default') as Array<ChatMessage & { metadata?: Record<string, unknown> }>;
      expect(stored[0]?.metadata?.[TURN_OUTCOME_METADATA_KEY]).toMatchObject({ durationMs: 800 });
    });
    const raw = [...Array(storage.length).keys()].map((index) => storage.getItem(storage.key(index)!) ?? '').join('');
    expect(raw).toContain('"durationMs":800');
    expect(JSON.stringify(chat.requests)).not.toContain('durationMs');
    expect(JSON.stringify(chat.requests)).not.toContain(TURN_OUTCOME_METADATA_KEY);
    const id = userId(chat);
    view.unmount();
    const reloaded = new StreamingChat();
    render(<Host chat={reloaded} config={{ session: store }} />);
    await waitFor(() => expect(ctx.turnOutcomes.get(id)).toMatchObject({ status: 'completed', durationMs: 800 }));
  });

  it('a stored outcome with a bad durationMs keeps its status', async () => {
    const store = storeFor('bad-duration');
    await store.save!('default', [{
      id: 'u1', role: 'user', parts: [{ type: 'text', text: 'one' }],
      metadata: { [TURN_OUTCOME_METADATA_KEY]: { status: 'completed', reason: 'finished', at: 'x', durationMs: 'x' } },
    } as unknown as ChatMessage, {
      id: 'u2', role: 'user', parts: [{ type: 'text', text: 'two' }],
      metadata: { [TURN_OUTCOME_METADATA_KEY]: { status: 'completed', reason: 'finished', at: 'y', durationMs: -5 } },
    } as unknown as ChatMessage]);
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ session: store }} />);
    await waitFor(() => expect(ctx.turnOutcomes.get('u1')).toBeDefined());
    expect(ctx.turnOutcomes.get('u1')).toEqual({ userMessageId: 'u1', status: 'completed', reason: 'finished', at: 'x' });
    expect(ctx.turnOutcomes.get('u2')).toEqual({ userMessageId: 'u2', status: 'completed', reason: 'finished', at: 'y' });
  });

  it('onTurnEnd receives the duration', async () => {
    const seen: TurnOutcome[] = [];
    const chat = new StreamingChat();
    render(<Host chat={chat} config={{ onTurnEnd: (outcome) => { seen.push(outcome); } }} />);
    await act(async () => { ctx.send('one'); });
    elapse(1200);
    act(() => chat.finish());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ status: 'completed', durationMs: 1200 });
  });

  it('turnWorkedMs follows the running turn', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} />);
    const worked = () => composerContextOf(ctx).turnWorkedMs?.() ?? null;
    expect(worked()).toBeNull();
    await act(async () => { ctx.send('one'); });
    expect(worked()).toBe(0);
    elapse(1000);
    expect(worked()).toBe(1000);
    act(() => chat.finish([{
      type: 'tool-tasks_delete', toolCallId: 'call-1', state: 'approval-requested', input: {}, approval: { id: 'ap-1' },
    }]));
    expect(worked()).toBeNull();
    elapse(30_000);
    act(() => chat.resume());
    expect(worked()).toBe(1000);
    elapse(250);
    expect(worked()).toBe(1250);
    act(() => chat.finish([text('Deleted')]));
    expect(worked()).toBeNull();
  });
});
