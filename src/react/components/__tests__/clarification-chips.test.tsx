// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatMessage, ChatTransport, ComposerConfig } from '../../types.js';
import { clarificationAnswerMessage } from '../../utils/clarification.js';
import { AiChatPanel } from '../ai-chat-panel.js';

const ask = {
  id: 'user-0', role: 'user', parts: [{ type: 'text', text: 'Lösche die Aufgabe' }],
} as unknown as ChatMessage;

function clarification(options = [
  { id: 'task-1', label: 'Bericht schreiben' },
  { id: 'task-2', label: 'Release prüfen', description: 'fällig morgen' },
]): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    parts: [{
      type: 'tool-ask_clarification',
      toolCallId: 'call-1',
      state: 'output-available',
      input: { question: 'Welche Aufgabe?', target: 'object' },
      output: { success: true, clarification: { question: 'Welche Aufgabe soll ich löschen?', target: 'object', options, allowFreeText: true } },
    }],
  } as unknown as ChatMessage;
}

function transport(messages: ChatMessage[], status: ChatTransport['status'] = 'ready'): ChatTransport {
  return {
    messages, status, error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function Panel({ chat, composer, language }: { chat: ChatTransport; composer?: ComposerConfig; language?: string }) {
  const config = useMemo(() => composer, [composer]);
  return (
    <AiChatProvider transport={chat} {...(config ? { composer: config } : {})} {...(language ? { language } : {})}>
      <AiChatPanel />
    </AiChatProvider>
  );
}

const chips = () => document.querySelector('[data-component="clarification-chips"]');
const card = () => document.querySelector('[data-component="clarification-card"]')!;
const on: ComposerConfig = { clarificationChips: true };

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe('clarification chips above the composer', () => {
  it('no chips without config', () => {
    render(<Panel chat={transport([ask, clarification()])} />);
    expect(chips()).toBeNull();
    expect(card().querySelectorAll('[data-action="answer-option"]')).toHaveLength(2);
  });

  it('an open clarification shows its options above the composer and the card keeps question and free text only', () => {
    render(<Panel chat={transport([ask, clarification()])} composer={on} language="de" />);
    const group = chips()!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Antwortmöglichkeiten');
    const buttons = Array.from(group.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['Bericht schreiben', 'Release prüfen']);
    expect(buttons[1]!.getAttribute('title')).toBe('fällig morgen');
    expect(buttons[1]!.getAttribute('data-option-id')).toBe('task-2');
    expect(buttons.every((button) => button.getAttribute('type') === 'button' && button.getAttribute('data-element') === 'option')).toBe(true);
    // Above the composer: the chips come before the input in the panel.
    const input = document.querySelector('[data-component="chat-input"], [data-component="mention-input"]')!;
    expect(group.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card().querySelector('[data-action="answer-option"]')).toBeNull();
    expect(card().querySelector('[data-element="question"]')!.textContent).toBe('Welche Aufgabe soll ich löschen?');
    expect(card().querySelector('[data-element="free-text"]')).not.toBeNull();
  });

  it('a chip sends the same answer message as the card', () => {
    const chat = transport([ask, clarification()]);
    render(<Panel chat={chat} composer={on} />);
    fireEvent.click(screen.getByRole('button', { name: 'Release prüfen' }));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect((vi.mocked(chat.sendMessage).mock.calls[0]![0] as { text: string }).text)
      .toBe(clarificationAnswerMessage({ toolCallId: 'call-1', answer: 'Release prüfen', optionId: 'task-2' }));
  });

  it('chips hide while loading and once answered', () => {
    const { rerender } = render(<Panel chat={transport([ask, clarification()], 'streaming')} composer={on} />);
    expect(chips()).toBeNull();
    const answered = {
      id: 'user-2', role: 'user',
      parts: [{ type: 'text', text: clarificationAnswerMessage({ toolCallId: 'call-1', answer: 'Bericht schreiben', optionId: 'task-1' }) }],
    } as unknown as ChatMessage;
    rerender(<Panel chat={transport([ask, clarification(), answered])} composer={on} />);
    expect(chips()).toBeNull();
    const typed = { id: 'user-3', role: 'user', parts: [{ type: 'text', text: 'Die von gestern' }] } as unknown as ChatMessage;
    rerender(<Panel chat={transport([ask, clarification(), typed])} composer={on} />);
    expect(chips()).toBeNull();
  });

  it('no chips for a free-text-only clarification', () => {
    render(<Panel chat={transport([ask, clarification([])])} composer={on} />);
    expect(chips()).toBeNull();
  });
});
