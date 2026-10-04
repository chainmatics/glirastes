// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../types.js';
import { MessageBubble } from '../message-bubble.js';

const clarificationMessage = {
  id: 'assistant-1',
  role: 'assistant',
  parts: [{
    type: 'tool-ask_clarification',
    toolCallId: 'call-1',
    state: 'output-available',
    input: { question: 'Welche Aufgabe?', target: 'object' },
    output: {
      success: true,
      clarification: {
        question: 'Welche Aufgabe soll ich löschen?',
        target: 'object',
        options: [
          { id: 'task-1', label: 'Bericht schreiben' },
          { id: 'task-2', label: 'Release prüfen', description: 'fällig morgen' },
        ],
        allowFreeText: true,
      },
    },
  }],
} as unknown as ChatMessage;

function withToolCallId(toolCallId: string): ChatMessage {
  const [part] = clarificationMessage.parts as unknown as Array<Record<string, unknown>>;
  return { ...clarificationMessage, parts: [{ ...part, toolCallId }] } as unknown as ChatMessage;
}

const chatContext = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('../../provider/chat-context.js', () => ({
  useChatContext: () => chatContext.current,
}));

function setContext(messages: ChatMessage[], overrides: Record<string, unknown> = {}) {
  const send = vi.fn();
  chatContext.current = {
    classNames: {},
    components: { Markdown: ({ content }: { content: string }) => <div>{content}</div> },
    toolResults: { mode: 'default' },
    locale: { clarificationInputLabel: 'Deine Antwort', clarificationSubmitButton: 'Antworten' },
    messages,
    send,
    isLoading: false,
    ...overrides,
  };
  return send;
}

describe('structured clarification card', () => {
  afterEach(cleanup);

  it('answers with a concrete option and resumes the original request', () => {
    const send = setContext([clarificationMessage]);
    render(<MessageBubble message={clarificationMessage} />);

    expect(screen.getByRole('group', { name: 'Welche Aufgabe soll ich löschen?' })).toBeTruthy();
    expect(document.querySelector('[data-component="tool-result"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Release prüfen/ }));

    expect(send).toHaveBeenCalledExactlyOnceWith(
      '<!--glirastes:clarification {"toolCallId":"call-1","optionId":"task-2"}-->\nRelease prüfen',
    );
    expect(screen.getByRole('button', { name: /Bericht schreiben/ }).hasAttribute('disabled'))
      .toBe(true);
  });

  it('answers with free text from the keyboard', () => {
    const send = setContext([clarificationMessage]);
    render(<MessageBubble message={clarificationMessage} />);

    const input = screen.getByRole('textbox', { name: 'Deine Antwort' });
    fireEvent.change(input, { target: { value: 'die von gestern' } });
    fireEvent.submit(input.closest('form')!);

    expect(send).toHaveBeenCalledExactlyOnceWith(
      '<!--glirastes:clarification {"toolCallId":"call-1"}-->\ndie von gestern',
    );
  });

  it('is read-only once a newer message exists or a turn is running', () => {
    const answer = {
      id: 'user-2', role: 'user',
      parts: [{ type: 'text', text: '<!--glirastes:clarification {"toolCallId":"call-1"}-->\nAlice' }],
    } as ChatMessage;
    setContext([clarificationMessage, answer]);
    const { rerender } = render(<MessageBubble message={clarificationMessage} />);
    expect(document.querySelector('[data-component="clarification-card"]')?.getAttribute('data-state'))
      .toBe('answered');
    expect(screen.queryByRole('textbox')).toBeNull();

    setContext([clarificationMessage], { isLoading: true });
    rerender(<MessageBubble message={clarificationMessage} />);
    expect(screen.getByRole('button', { name: /Bericht schreiben/ }).hasAttribute('disabled'))
      .toBe(true);
    expect(document.querySelector('[data-component="clarification-card"]')?.getAttribute('data-state'))
      .toBe('disabled');
  });

  it('answers a clarification whose provider id contains dots and colons', () => {
    const kimi = withToolCallId('functions.ask_clarification:0');
    const send = setContext([kimi]);
    render(<MessageBubble message={kimi} />);

    fireEvent.click(screen.getByRole('button', { name: /Release prüfen/ }));

    expect(send).toHaveBeenCalledExactlyOnceWith(
      '<!--glirastes:clarification {"toolCallId":"functions.ask_clarification:0","optionId":"task-2"}-->\nRelease prüfen',
    );
  });

  it.each([
    ['longer than the marker allows', 'c'.repeat(201)],
    ['holding characters the marker cannot carry', 'fn/ask clarification:0'],
  ])('still sends the plain answer when the provider id is %s', (_label, toolCallId) => {
    const odd = withToolCallId(toolCallId);
    const send = setContext([odd]);
    render(<MessageBubble message={odd} />);

    fireEvent.click(screen.getByRole('button', { name: /Release prüfen/ }));

    expect(send).toHaveBeenCalledExactlyOnceWith('Release prüfen');
    expect(document.querySelector('[data-component="clarification-card"]')?.getAttribute('data-state'))
      .toBe('answered');
  });

  it('sends the plain free-text answer when the provider id cannot carry a marker', () => {
    const odd = withToolCallId('c'.repeat(201));
    const send = setContext([odd]);
    render(<MessageBubble message={odd} />);

    const input = screen.getByRole('textbox', { name: 'Deine Antwort' });
    fireEvent.change(input, { target: { value: 'die von gestern' } });
    fireEvent.submit(input.closest('form')!);

    expect(send).toHaveBeenCalledExactlyOnceWith('die von gestern');
  });

  it('shows only the visible answer in the user bubble', () => {
    const answer = {
      id: 'user-2', role: 'user',
      parts: [{ type: 'text', text: '<!--glirastes:clarification {"toolCallId":"call-1"}-->\nAlice' }],
    } as ChatMessage;
    setContext([clarificationMessage, answer]);
    render(<MessageBubble message={answer} />);
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(document.body.textContent).not.toContain('glirastes:clarification');
  });

  it('renders a request from tool input when stored output is incomplete', () => {
    const legacy = {
      ...clarificationMessage,
      parts: [{
        type: 'tool-ask_clarification', toolCallId: 'call-9', state: 'output-available',
        input: { question: 'Wen meinst du?', target: 'person', options: [{ id: 'a', label: 'Alice' }] },
        output: { success: true },
      }],
    } as unknown as ChatMessage;
    setContext([legacy]);
    render(<MessageBubble message={legacy} />);
    expect(screen.getByRole('group', { name: 'Wen meinst du?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Alice' })).toBeTruthy();
  });
});
