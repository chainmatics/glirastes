// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLARIFICATION_MAX_ANSWER_LENGTH } from '../../../contracts/clarification.js';
import type { ChatMessage, ChatTransport } from '../../types.js';
import { AiChatProvider } from '../ai-chat-provider.js';
import { useChatContext } from '../chat-context.js';

function transport(messages: ChatMessage[]): ChatTransport {
  return {
    messages,
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function SendProbe({ text }: { text: string }) {
  const { send } = useChatContext();
  return <button type="button" onClick={() => send(text)}>send</button>;
}

function clarification(
  input: Record<string, unknown>,
  toolCallId = 'call-7',
): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    parts: [{
      type: 'tool-ask_clarification',
      toolCallId,
      state: 'output-available',
      input,
      output: { success: true },
    }],
  } as unknown as ChatMessage;
}

const openClarification = clarification({
  question: 'Wem zuweisen?',
  target: 'person',
  allowFreeText: true,
});

async function sendAs(text: string, messages: ChatMessage[]) {
  const chat = transport(messages);
  render(<AiChatProvider transport={chat}><SendProbe text={text} /></AiChatProvider>);
  await act(async () => { screen.getByRole('button', { name: 'send' }).click(); });
  return chat;
}

describe('composer answers to an open clarification', () => {
  afterEach(cleanup);

  it('marks typed text as the answer so the server resumes the original task', async () => {
    const chat = transport([
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Weise die Aufgabe zu' }] },
      openClarification,
    ]);
    render(<AiChatProvider transport={chat}><SendProbe text="Alice" /></AiChatProvider>);
    await act(async () => { screen.getByRole('button', { name: 'send' }).click(); });
    expect(chat.sendMessage).toHaveBeenCalledWith({
      text: '<!--glirastes:clarification {"toolCallId":"call-7"}-->\nAlice',
    });
  });

  it('leaves ordinary messages untouched when nothing is open', async () => {
    const chat = transport([
      { id: 'assistant-0', role: 'assistant', parts: [{ type: 'text', text: 'Fertig.' }] },
    ]);
    render(<AiChatProvider transport={chat}><SendProbe text="Danke" /></AiChatProvider>);
    await act(async () => { screen.getByRole('button', { name: 'send' }).click(); });
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Danke' });
  });

  it('does not wrap when the clarification only accepts its options', async () => {
    const chat = await sendAs('Alice', [clarification({
      question: 'Wem zuweisen?',
      target: 'person',
      options: [{ id: 'alice', label: 'Alice' }],
      allowFreeText: false,
    })]);
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Alice' });
  });

  it('treats text beyond the answer limit as a new request, not an answer', async () => {
    const longText = 'a'.repeat(CLARIFICATION_MAX_ANSWER_LENGTH + 1);
    const chat = await sendAs(longText, [openClarification]);
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: longText });
  });

  it('does not wrap text that already carries an answer marker', async () => {
    const marked = '<!--glirastes:clarification {"toolCallId":"call-7","optionId":"alice"}-->\nAlice';
    const chat = await sendAs(marked, [openClarification]);
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: marked });
  });

  it('sends the plain answer when the marker cannot carry the tool call id', async () => {
    const chat = await sendAs('Alice', [clarification({
      question: 'Wem zuweisen?',
      target: 'person',
      allowFreeText: true,
    }, 'call 7')]);
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Alice' });
  });
});
