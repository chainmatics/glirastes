// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalSessionStore } from '../utils/local-session-store.js';
import type { AiChatProviderConfig, SessionConfig } from '../types.js';
import { ctx, Host, memoryStorage, renderedTurns, StreamingChat } from './streaming-chat.js';

afterEach(cleanup);

// A turn stopped during a tool call, before any text, used to be dropped from the history by the next send.

const STOPPED = 'Stopped';
const stepStart = { type: 'step-start' };
const text = (value: string) => ({ type: 'text', text: value, state: 'streaming' });
const runningTool = (id: string) => ({ type: 'tool-tasks_list', toolCallId: id, state: 'input-available', input: {} });

type Mode = 'queue' | 'manual';

/** Sends the next message: from the queue (queued while running, resumed after the stop) or by hand after the stop. */
async function stopThenNext(chat: StreamingChat, mode: Mode, next: string) {
  if (mode === 'queue') {
    await act(async () => { ctx.submit(next); });
    await act(async () => { ctx.stop(); });
    // The user's stop pauses the queue; resuming sends what waits.
    await act(async () => { ctx.resumeQueue(); });
  } else {
    await act(async () => { ctx.stop(); });
    await act(async () => { ctx.send(next); });
  }
  await waitFor(() => expect(chat.sent.at(-1)).toBe(next));
}

/** The stored conversation has loaded: a send is not refused. */
async function ready() {
  await waitFor(() => expect(ctx.canCompose).toBe(true));
}

function storeFor(key: string): SessionConfig {
  return createLocalSessionStore({ storageKey: key, storage: memoryStorage(), attachmentStore: null });
}

async function reload(store: SessionConfig, config: Partial<AiChatProviderConfig>, view: { unmount(): void }) {
  view.unmount();
  render(<Host chat={new StreamingChat()} config={{ ...config, session: store }} />);
  await waitFor(() => expect(document.querySelectorAll('[data-component="message-bubble"]').length).toBeGreaterThan(0));
}

describe.each<Mode>(['queue', 'manual'])('a turn stopped during a tool step stays after later turns (%s)', (mode) => {
  const base: Partial<AiChatProviderConfig> = mode === 'queue' ? { queue: { enabled: true } } : {};

  it('one stopped turn, then a completed one, then a reload', async () => {
    const store = storeFor(`stop-tool-${mode}`);
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ ...base, session: store }} />);
    await ready();
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, runningTool('call-1')]));
    await stopThenNext(chat, mode, 'two');
    act(() => chat.finish());
    const expected = [
      { text: '', steps: ['aborted'], notice: STOPPED },
      { text: 'done', steps: [], notice: null },
    ];
    expect(renderedTurns()).toEqual(expected);
    await reload(store, base, view);
    expect(renderedTurns()).toEqual(expected);
  });

  it('two stopped turns in a row (text, then a tool step), then a completed one', async () => {
    const store = storeFor(`stop-two-${mode}`);
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ ...base, session: store }} />);
    await ready();
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, text('First partial')]));
    await stopThenNext(chat, mode, 'two');
    act(() => chat.stream([stepStart, runningTool('call-2')]));
    await stopThenNext(chat, mode, 'three');
    act(() => chat.finish());
    const expected = [
      { text: 'First partial', steps: [], notice: STOPPED },
      { text: '', steps: ['aborted'], notice: STOPPED },
      { text: 'done', steps: [], notice: null },
    ];
    expect(renderedTurns()).toEqual(expected);
    await reload(store, base, view);
    expect(renderedTurns()).toEqual(expected);
  });
});

it("keeps the turn a sendNow with sendNowBehavior 'abort' stopped during a tool step", async () => {
  const store = storeFor('stop-send-now');
  const config: Partial<AiChatProviderConfig> = { queue: { enabled: true, sendNowBehavior: 'abort' } };
  const chat = new StreamingChat();
  const view = render(<Host chat={chat} config={{ ...config, session: store }} />);
  await ready();
  await act(async () => { ctx.send('one'); });
  act(() => chat.stream([stepStart, runningTool('call-1')]));
  await act(async () => { ctx.submit('two'); });
  await act(async () => { ctx.sendNow(ctx.queue.items[0]!.id); });
  await waitFor(() => expect(chat.sent).toEqual(['one', 'two']));
  expect(chat.stop).toHaveBeenCalledTimes(1);
  act(() => chat.finish());
  const expected = [
    { text: '', steps: ['aborted'], notice: STOPPED },
    { text: 'done', steps: [], notice: null },
  ];
  expect(renderedTurns()).toEqual(expected);
  await reload(store, config, view);
  expect(renderedTurns()).toEqual(expected);
});

it('keeps a turn whose only step failed when the next message is sent', async () => {
  const chat = new StreamingChat();
  render(<Host chat={chat} />);
  await act(async () => { ctx.send('one'); });
  act(() => chat.finish([stepStart, {
    type: 'tool-tasks_list', toolCallId: 'call-1', state: 'output-error', input: {}, errorText: 'boom',
  }]));
  await act(async () => { ctx.send('two'); });
  act(() => chat.finish());
  expect(renderedTurns()).toEqual([
    { text: '', steps: ['error'], notice: null },
    { text: 'done', steps: [], notice: null },
  ]);
  // As in 0.19.0, the request leaves it out.
  expect(shape(chat.requests.at(-1)!)).toEqual(['user:one', 'user:two']);
});

/** Role and first text (or the first tool part's state) of each message of a request: what the backend receives. */
function shape(messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>): string[] {
  return messages.map((message) => {
    const textPart = message.parts.find((part) => (part as { type?: string }).type === 'text') as { text?: string } | undefined;
    const tool = message.parts.find((part) => String((part as { type?: string }).type).startsWith('tool-')) as
      { state?: string } | undefined;
    return `${message.role}:${textPart?.text ?? (tool ? `tool(${tool.state})` : '')}`;
  });
}

describe.each<Mode>(['queue', 'manual'])('the request after a stop is the one of 0.19.0 (%s)', (mode) => {
  const base: Partial<AiChatProviderConfig> = mode === 'queue' ? { queue: { enabled: true } } : {};

  it('leaves out a stopped message with only an unfinished tool part, also after a reload; keeps it on screen', async () => {
    const store = storeFor(`request-tool-${mode}`);
    const chat = new StreamingChat();
    const view = render(<Host chat={chat} config={{ ...base, session: store }} />);
    await ready();
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, runningTool('call-1')]));
    await stopThenNext(chat, mode, 'two');
    expect(shape(chat.requests.at(-1)!)).toEqual(['user:one', 'user:two']);
    act(() => chat.finish());
    expect(renderedTurns()[0]).toEqual({ text: '', steps: ['aborted'], notice: STOPPED });

    view.unmount();
    const reloaded = new StreamingChat();
    render(<Host chat={reloaded} config={{ ...base, session: store }} />);
    await waitFor(() => expect(renderedTurns()).toHaveLength(2));
    expect(renderedTurns()[0]).toEqual({ text: '', steps: ['aborted'], notice: STOPPED });
    // The transport gets the stored history without it, as 0.19.0 loaded it.
    expect(shape(reloaded.messages)).toEqual(['user:one', 'user:two', 'assistant:done']);
    await ready();
    await act(async () => { ctx.send('three'); });
    expect(shape(reloaded.requests.at(-1)!)).toEqual(['user:one', 'user:two', 'assistant:done', 'user:three']);
    act(() => reloaded.finish());
    // Still shown and stored, never sent.
    expect(renderedTurns().map((turn) => turn.steps)).toEqual([['aborted'], [], []]);
    const stored = await store.load!('default') as Array<{ role: string; parts: unknown[] }>;
    expect(shape(stored)).toEqual([
      'user:one', 'assistant:tool(input-available)', 'user:two', 'assistant:done', 'user:three', 'assistant:done',
    ]);
  });

  it('sends a stopped message with text, as before', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={base} />);
    await act(async () => { ctx.send('one'); });
    act(() => chat.stream([stepStart, text('Partial'), runningTool('call-1')]));
    await stopThenNext(chat, mode, 'two');
    expect(shape(chat.requests.at(-1)!)).toEqual(['user:one', 'assistant:Partial', 'user:two']);
  });
});
