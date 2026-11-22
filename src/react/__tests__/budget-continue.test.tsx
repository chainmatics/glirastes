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
