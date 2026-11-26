// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatTransport } from '../types.js';
import { useVercelAiChatTransport } from '../transports/vercel.js';
import { deChatLocale } from '../locale-de.js';
import { ctx, Host, StreamingChat } from './streaming-chat.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stop = (continuable: boolean) => ({ type: 'data-budget-stop', data: { v: 1, continuable } });
const notice = { type: 'text', text: 'I stopped here.\n\nStill open: your question is not answered yet.', state: 'done' };
const read = { type: 'tool-tasks_list', toolCallId: 'c1', state: 'output-available', input: {}, output: { tasks: [] } };

function stoppedChat(continuable = true): StreamingChat {
  const chat = new StreamingChat();
  chat.messages = [
    { id: 'u-stop', role: 'user', parts: [{ type: 'text', text: 'Plan my week' }] },
    { id: 'a-stop', role: 'assistant', parts: [{ type: 'step-start' }, read, stop(continuable), notice] } as unknown as ChatMessage,
  ];
  return chat;
}

function withContinue(chat: StreamingChat) {
  const go = vi.fn(async () => {});
  const base = Object.getOwnPropertyDescriptor(StreamingChat.prototype, 'transport')!.get!;
  Object.defineProperty(chat, 'transport', { get: () => ({ ...base.call(chat), continueAfterBudgetStop: go }) });
  return go;
}

const continueButton = () => document.querySelector('[data-element="budget-continue"] button');

describe('"Continue" after a budget stop', () => {
  it('is a real button under the stop notice and continues the turn', async () => {
    const chat = stoppedChat();
    const go = withContinue(chat);
    render(<Host chat={chat} />);
    const button = await screen.findByRole('button', { name: 'Continue' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(continueButton()).toBe(button);
    fireEvent.click(button);
    expect(go).toHaveBeenCalledTimes(1);
    expect(chat.sent).toEqual([]);
  });

  it('continues once for a double click and not while a request runs', async () => {
    const chat = stoppedChat();
    let settle: () => void = () => {};
    const go = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    const base = Object.getOwnPropertyDescriptor(StreamingChat.prototype, 'transport')!.get!;
    Object.defineProperty(chat, 'transport', { get: () => ({ ...base.call(chat), continueAfterBudgetStop: go }) });
    render(<Host chat={chat} />);
    const button = await screen.findByRole('button', { name: 'Continue' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(go).toHaveBeenCalledTimes(1);
    await act(async () => { settle(); });
    // A running request: the context call does nothing.
    act(() => { chat.resume(); });
    act(() => { ctx.continueAfterBudgetStop!(); });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('says "Weitermachen" in German', async () => {
    const chat = stoppedChat();
    withContinue(chat);
    render(<Host chat={chat} config={{ locale: deChatLocale }} />);
    expect(await screen.findByRole('button', { name: 'Weitermachen' })).toBeTruthy();
  });

  it('is not offered for a stop that is not continuable, an older message or without transport support', async () => {
    const notContinuable = stoppedChat(false);
    withContinue(notContinuable);
    const view = render(<Host chat={notContinuable} />);
    await waitFor(() => expect(document.querySelectorAll('[data-component="message-bubble"]').length).toBe(2));
    expect(continueButton()).toBeNull();
    view.unmount();

    const later = stoppedChat();
    withContinue(later);
    later.messages = [...later.messages,
      { id: 'u-next', role: 'user', parts: [{ type: 'text', text: 'Something else' }] },
      { id: 'a-next', role: 'assistant', parts: [{ type: 'text', text: 'Sure.' }] }];
    const second = render(<Host chat={later} />);
    await waitFor(() => expect(document.querySelectorAll('[data-component="message-bubble"]').length).toBe(4));
    expect(continueButton()).toBeNull();
    second.unmount();

    render(<Host chat={stoppedChat()} />);
    await waitFor(() => expect(document.querySelectorAll('[data-component="message-bubble"]').length).toBe(2));
    expect(continueButton()).toBeNull();
    expect(ctx.continueAfterBudgetStop).toBeUndefined();
  });

  it('is gone while the continued turn runs', async () => {
    const chat = stoppedChat();
    withContinue(chat);
    render(<Host chat={chat} />);
    await screen.findByRole('button', { name: 'Continue' });
    act(() => { chat.resume(); });
    await waitFor(() => expect(continueButton()).toBeNull());
  });
});

describe('the continue hint of a stop notice', () => {
  const hint = 'Use the button below to go on with the open steps.';
  const hinted = { type: 'text', text: `I stopped here.\n\nStill open: Plan the week.\n\n${hint}`, state: 'done' };
  const bubbleText = () => document.querySelectorAll('[data-component="message-bubble"]')[1]?.textContent ?? '';

  function hintedChat(after: unknown[] = []): StreamingChat {
    const chat = new StreamingChat();
    chat.messages = [
      { id: 'u-stop', role: 'user', parts: [{ type: 'text', text: 'Plan my week' }] },
      { id: 'a-stop', role: 'assistant', parts: [{ type: 'step-start' }, read, stop(true), hinted, ...after] } as unknown as ChatMessage,
    ];
    return chat;
  }

  it('shows while "Continue" is offered', async () => {
    const chat = hintedChat();
    withContinue(chat);
    render(<Host chat={chat} />);
    await screen.findByRole('button', { name: 'Continue' });
    expect(bubbleText()).toContain(hint);
  });

  it('is gone once the stop was continued, the rest of the notice stays', async () => {
    const chat = hintedChat([{ type: 'step-start' }, { type: 'text', text: 'All done now.', state: 'done' }]);
    withContinue(chat);
    render(<Host chat={chat} />);
    await waitFor(() => expect(bubbleText()).toContain('All done now.'));
    expect(continueButton()).toBeNull();
    expect(bubbleText()).toContain('Still open: Plan the week.');
    expect(bubbleText()).not.toContain(hint);
  });

  it('is gone when the user wrote on instead', async () => {
    const later = hintedChat();
    withContinue(later);
    later.messages = [...later.messages,
      { id: 'u-next', role: 'user', parts: [{ type: 'text', text: 'Something else' }] },
      { id: 'a-next', role: 'assistant', parts: [{ type: 'text', text: 'Sure.' }] }];
    const view = render(<Host chat={later} />);
    await waitFor(() => expect(document.querySelectorAll('[data-component="message-bubble"]').length).toBe(4));
    expect(bubbleText()).toContain('Still open: Plan the week.');
    expect(bubbleText()).not.toContain(hint);
    view.unmount();
  });

  it('stays in a chat without "Continue", whose app sets its own continueHint', async () => {
    render(<Host chat={hintedChat()} />);
    await waitFor(() => expect(bubbleText()).toContain(hint));
    expect(continueButton()).toBeNull();
  });

  it.each([
    ['legacy notice', {}, 'Still open: confirm the date.', true],
    ['custom hint', { continueHint: 'First hint.\n\nSecond hint.' }, 'First hint.\n\nSecond hint.', true],
    ['custom hint without button support', { continueHint: 'First hint.' }, 'First hint.', false],
  ] as const)('preserves notice content for %s', async (_, metadata, ending, supported) => {
    const chat = stoppedChat();
    const marker = stop(true);
    chat.messages = [chat.messages[0]!, {
      id: 'a-stop', role: 'assistant', parts: [
        { ...marker, data: { ...marker.data, ...metadata } },
        { type: 'text', text: 'Original summary.\n\n' + ending },
        { type: 'step-start' }, { type: 'text', text: 'Later answer.' },
      ],
    } as unknown as ChatMessage];
    if (supported) withContinue(chat);
    render(<Host chat={chat} />);
    await waitFor(() => expect(bubbleText()).toContain('Later answer.'));
    expect(bubbleText()).toContain('Original summary.');
    if (supported && 'continueHint' in metadata) {
      expect(bubbleText()).not.toContain('First hint.');
      expect(bubbleText()).not.toContain('Second hint.');
    } else {
      expect(bubbleText()).toContain(ending);
    }
  });

  it('keeps the typed hint of a stop that cannot be continued', async () => {
    const typed = 'Write “continue” to go on with the open steps.';
    const chat = new StreamingChat();
    chat.messages = [
      { id: 'u-stop', role: 'user', parts: [{ type: 'text', text: 'Plan my week' }] },
      { id: 'a-stop', role: 'assistant', parts: [read, stop(false), { type: 'text', text: `I stopped here.\n\n${typed}`, state: 'done' }] } as unknown as ChatMessage,
    ];
    withContinue(chat);
    render(<Host chat={chat} />);
    await waitFor(() => expect(bubbleText()).toContain(typed));
  });
});

describe('Vercel transport', () => {
  let transport: ChatTransport;
  const bodies: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    bodies.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = ['{"type":"start"}', '{"type":"finish"}'].map((chunk) => `data: ${chunk}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
    }));
  });

  function Probe() {
    transport = useVercelAiChatTransport({ endpoint: '/api/chat' });
    return null;
  }

  it('sends the history again with the budget continuation marker and no new message', async () => {
    render(<Probe />);
    const history = stoppedChat().messages;
    act(() => { transport.setMessages(history); });
    await act(async () => { await transport.continueAfterBudgetStop!(); });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ glirastesContinuation: 'budget' });
    const sent = bodies[0]!.messages as Array<{ id: string }>;
    expect(sent.map((message) => message.id)).toEqual(['u-stop', 'a-stop']);
  });

  it('sends no marker with a normal message', async () => {
    render(<Probe />);
    await act(async () => { await transport.sendMessage({ text: 'hi' }); });
    expect(bodies[0]).not.toHaveProperty('glirastesContinuation');
  });
});
