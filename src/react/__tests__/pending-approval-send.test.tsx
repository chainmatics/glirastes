// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { AiChatPanel } from '../components/ai-chat-panel.js';
import { ChatInput } from '../components/chat-input.js';
import { useChatContext } from '../provider/chat-context.js';
import type { ChatTransport } from '../types.js';

afterEach(cleanup);

function transport(): ChatTransport {
  return {
    messages: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Lösch die Aufgabe' }] },
      {
        id: 'a1', role: 'assistant',
        parts: [{
          type: 'tool-tasks_delete', toolCallId: 'call-1', state: 'approval-requested',
          input: { id: 't1' }, approval: { id: 'approval-1' },
        } as never],
      },
    ],
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

let send: (text: string) => boolean = () => true;
function Sender() {
  send = useChatContext().send;
  return null;
}

describe('a message typed while an approval is open', () => {
  it('keeps the approval open, sends nothing and points to the card', async () => {
    const chat = transport();
    render(
      <AiChatProvider transport={chat} locale={{ approvalPendingHint: 'Bitte erst bestätigen oder ablehnen.' }}>
        <AiChatPanel />
        <Sender />
      </AiChatProvider>,
    );
    await waitFor(() => expect(document.querySelector('[data-component="approval-card"]')).not.toBeNull());

    let accepted = true;
    await act(async () => { accepted = send('ja'); });

    expect(accepted).toBe(false);

    expect(chat.addToolApprovalResponse).not.toHaveBeenCalled();
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(chat.setMessages).not.toHaveBeenCalled();
    expect(document.querySelector('[data-component="approval-card"]')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Bitte erst bestätigen oder ablehnen.');
  });

  it('leaves the typed text in the composer', async () => {
    const chat = transport();
    render(
      <AiChatProvider transport={chat}>
        <ChatInput />
      </AiChatProvider>,
    );
    const box = document.querySelector('textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(box).not.toBeNull());

    fireEvent.change(box, { target: { value: 'ja, lösch sie' } });
    await act(async () => { fireEvent.submit(box.closest('form')!); });

    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(box.value).toBe('ja, lösch sie');
  });
});
