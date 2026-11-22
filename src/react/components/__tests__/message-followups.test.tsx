// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../../provider/chat-context.js';
import { MessageFooter } from '../message-footer.js';
import type { AiChatProviderConfig, ChatMessage } from '../../types.js';
import { ctx, Host, StreamingChat } from '../../__tests__/streaming-chat.js';

afterEach(cleanup);

const MESSAGE: Partial<AiChatProviderConfig> = { suggestions: { placement: 'message' } };
const text = (value: string) => ({ type: 'text', text: value });
const followups = (list: string[]) => ({
  type: 'tool-suggest_followups', toolCallId: 'f1', state: 'output-available', input: {}, output: { followups: list },
});

async function answered(config: Partial<AiChatProviderConfig>, parts: unknown[] = [text('Done.'), followups(['A', 'B', 'C', 'D'])]) {
  const chat = new StreamingChat();
  render(<Host chat={chat} config={config} />);
  await act(async () => { ctx.send('question'); });
  act(() => chat.finish(parts));
  return chat;
}

const group = () => document.querySelector('[data-element="follow-ups"]');
const followupButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-action="follow-up"]')];
const labels = () => followupButtons().map((button) => button.textContent);

describe('follow-ups under the latest answer', () => {
  it('default placement keeps follow-ups out of the answer', async () => {
    await answered({});
    expect(group()).toBeNull();
    expect(document.querySelector('[data-component="message-footer"]')).toBeNull();
  });

  it('placement message shows them under the latest answer', async () => {
    await answered(MESSAGE);
    expect(labels()).toEqual(['A', 'B', 'C']);
    const named = screen.getByRole('group', { name: 'Ask next' });
    expect(named).toBe(group());
    expect(followupButtons().every((button) => button.type === 'button' && !button.disabled)).toBe(true);
  });

  it('count limits them', async () => {
    await answered({ suggestions: { placement: 'message', count: 2 } });
    expect(labels()).toEqual(['A', 'B']);
  });

  it('trailing list fallback', async () => {
    await answered(MESSAGE, [text('Done.\n\nSuggestions:\n- X\n- Y')]);
    expect(labels()).toEqual(['X', 'Y']);
    const answer = () => document.querySelector('[data-role="assistant"] [data-component="markdown"]');
    await waitFor(() => expect(answer()?.querySelector('p')).not.toBeNull());
    expect(answer()!.textContent).toBe('Done.');
  });

  it('a click sends', async () => {
    const chat = await answered(MESSAGE);
    await act(async () => { fireEvent.click(followupButtons()[0]!); });
    expect(chat.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'A' }));
  });

  it('hidden while a new question runs', async () => {
    const chat = await answered(MESSAGE);
    expect(group()).not.toBeNull();
    await act(async () => { ctx.send('next'); });
    expect(group()).toBeNull();
    act(() => chat.stream([text('Work')]));
    expect(group()).toBeNull();
  });

  it('hidden while an approval is open', async () => {
    await answered(MESSAGE, [
      followups(['A']),
      { type: 'tool-tasks_delete', toolCallId: 'c1', state: 'approval-requested', input: {}, approval: { id: 'ap-1' } },
    ]);
    await waitFor(() => expect(ctx.pendingApprovals).toHaveLength(1));
    expect(group()).toBeNull();
  });

  it('hidden while a clarification is open', async () => {
    await answered(MESSAGE, [
      followups(['A']),
      {
        type: 'tool-ask_clarification', toolCallId: 'q1', state: 'output-available',
        input: { question: 'Which one?', target: 'object', options: [{ id: 'a', label: 'First' }] },
        output: { success: true },
      },
    ]);
    await waitFor(() => expect(document.querySelector('[data-component="clarification-card"]')).not.toBeNull());
    expect(group()).toBeNull();
  });

  it('hidden after a stop', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={MESSAGE} />);
    await act(async () => { ctx.send('question'); });
    act(() => chat.stream([text('Partial'), followups(['A'])]));
    await act(async () => { ctx.stop(); });
    expect(ctx.isLoading).toBe(false);
    expect(group()).toBeNull();
  });

  it('hidden after an error', async () => {
    const chat = new StreamingChat();
    render(<Host chat={chat} config={MESSAGE} />);
    await act(async () => { ctx.send('question'); });
    act(() => chat.stream([text('Partial'), followups(['A'])]));
    act(() => chat.fail());
    expect(group()).toBeNull();
  });

  it('only under the latest answer', async () => {
    const chat = await answered(MESSAGE, [text('one'), followups(['A'])]);
    await act(async () => { ctx.send('second'); });
    act(() => chat.finish([text('two'), followups(['B'])]));
    const bubbles = [...document.querySelectorAll('[data-component="message-bubble"][data-role="assistant"]')];
    expect(bubbles.map((bubble) => bubble.querySelector('[data-element="follow-ups"]') !== null)).toEqual([false, true]);
    expect(labels()).toEqual(['B']);
  });

  it('enabled false hides them', async () => {
    await answered({ suggestions: { placement: 'message', enabled: false } });
    expect(group()).toBeNull();
  });

  it('German heading', async () => {
    await answered({ ...MESSAGE, language: 'de' });
    expect(screen.getByRole('group', { name: 'Weiterfragen' })).toBeTruthy();
  });

  it('without messageFooter only the follow-ups render', async () => {
    await answered(MESSAGE);
    expect(document.querySelector('[data-component="message-footer"]')).not.toBeNull();
    expect(document.querySelector('[data-element="footer-actions"]')).toBeNull();
  });

  it('with messageFooter they follow the footer actions', async () => {
    await answered({ ...MESSAGE, messageFooter: true });
    const footer = document.querySelector('[data-component="message-footer"]')!;
    const children = [...footer.children].map((child) => child.getAttribute('data-element'));
    expect(children[0]).toBe('footer-actions');
    expect(children.at(-1)).toBe('follow-ups');
  });

  it('no suggestion bar with placement message', async () => {
    await answered(MESSAGE);
    expect(document.querySelector('[data-component="suggestion-bar"]')).toBeNull();
  });
});

describe('disabled while the composer is locked', () => {
  it('renders the follow-ups disabled when canCompose is false', () => {
    const message = { id: 'a1', role: 'assistant', parts: [followups(['A'])] } as unknown as ChatMessage;
    const selectSuggestion = vi.fn();
    const value = {
      suggestions: { placement: 'message' },
      isLoading: false,
      canCompose: false,
      pendingApprovals: [],
      messages: [message],
      pipelineState: null,
      locale: { stopButton: 'Stop' },
      selectSuggestion,
      stop: vi.fn(),
    } as unknown as React.ContextType<typeof ChatContext>;
    render(
      <ChatContext.Provider value={value}>
        <MessageFooter message={message} text="" hasText={false} isLastOfTurn isLatest turnOutcome={null} active={false} />
      </ChatContext.Provider>,
    );
    const button = followupButtons()[0]!;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(selectSuggestion).not.toHaveBeenCalled();
  });
});
