// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { useChatContext } from '../provider/chat-context.js';
import type { ChatLocale, ChatTransport } from '../types.js';

afterEach(() => {
  cleanup();
  document.documentElement.lang = '';
});

function transport(): ChatTransport {
  return {
    messages: [],
    status: 'ready',
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

let seen: ChatLocale | undefined;
function Probe() {
  seen = useChatContext().locale;
  return null;
}

async function textsFor(lang: string, props: Partial<React.ComponentProps<typeof AiChatProvider>>): Promise<ChatLocale> {
  document.documentElement.lang = lang;
  seen = undefined;
  render(<AiChatProvider transport={transport()} {...props}><Probe /></AiChatProvider>);
  // The page language is read after mount.
  await waitFor(() => expect(seen).toBeDefined());
  await new Promise((settled) => setTimeout(settled, 0));
  return seen!;
}

describe('the chat texts per language (locales)', () => {
  const pl = { sendButton: 'Wyślij', approvalCollidingIdWarning: 'Ten identyfikator: {candidates}.' };

  it('takes the app table of the page language and falls back per key to English', async () => {
    const texts = await textsFor('pl-PL', { locales: { pl } });
    expect(texts.sendButton).toBe('Wyślij');
    expect(texts.approvalCollidingIdWarning).toBe('Ten identyfikator: {candidates}.');
    expect(texts.approveButton).toBe('Approve');
  });

  it('keeps the built-in German texts where a German table is partial', async () => {
    const texts = await textsFor('de-AT', { locales: { pl, de: { sendButton: 'Los' } } });
    expect(texts.sendButton).toBe('Los');
    expect(texts.approveButton).toBe('Ausführen');
  });

  it('lets the language-free locale win for every language', async () => {
    const texts = await textsFor('pl', { locales: { pl }, locale: { sendButton: 'Send it' } });
    expect(texts.sendButton).toBe('Send it');
  });

  it('is the chat of before without locales', async () => {
    const german = await textsFor('de', {});
    expect(german.approveButton).toBe('Ausführen');
    const polish = await textsFor('pl', {});
    expect(polish.approveButton).toBe('Approve');
  });
});
