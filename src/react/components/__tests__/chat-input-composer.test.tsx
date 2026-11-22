// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChatComposer, type ChatComposer } from '../../composer/chat-composer.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatTransport } from '../../types.js';
import { ChatInput } from '../chat-input.js';

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

let composer: ChatComposer;
function Grab() {
  composer = useChatComposer();
  return null;
}

function Plain() {
  const chat = useMemo(() => transport(), []);
  return (
    <AiChatProvider transport={chat}>
      <Grab />
      <ChatInput />
    </AiChatProvider>
  );
}

const textarea = () => screen.getByRole('textbox') as HTMLTextAreaElement;

afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
});

describe('plain chat input and useChatComposer', () => {
  it('insertText from useChatComposer reaches the plain input', () => {
    render(<Plain />);
    expect(textarea().tagName).toBe('TEXTAREA');
    act(() => composer.insertText('Hallo'));
    expect(textarea().value).toBe('Hallo');
    act(() => composer.insertText('Welt'));
    expect(textarea().value).toBe('Hallo Welt');
  });

  it('setDraft replaces the text', () => {
    render(<Plain />);
    act(() => composer.insertText('alt'));
    act(() => composer.setDraft('neu'));
    expect(textarea().value).toBe('neu');
  });

  it('chatAbout puts the label as text', async () => {
    render(<Plain />);
    await act(async () => { await composer.chatAbout({ type: 'task', id: '7', label: 'Bug 7' }, { text: 'Was ist los?' }); });
    expect(textarea().value).toBe('@Bug 7 Was ist los?');
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(document.activeElement).toBe(textarea());
  });

  it('clear empties it', () => {
    render(<Plain />);
    act(() => composer.insertText('Hallo'));
    act(() => composer.clear());
    expect(textarea().value).toBe('');
  });

  it('runs a batch in order: clear, then text', () => {
    render(<Plain />);
    act(() => composer.insertText('alt'));
    act(() => {
      composer.clear();
      composer.insertText('neu');
    });
    expect(textarea().value).toBe('neu');
  });
});
