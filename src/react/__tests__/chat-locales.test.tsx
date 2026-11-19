// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { useChatContext } from '../provider/chat-context.js';
import type { ChatLocale, ChatTransport, ChatTransportDataHandler } from '../types.js';

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

  it('carries the activity log keys too, per key with the built-in fallback', async () => {
    const activity = {
      activityRunningLabel: '{label} trwa',
      activityRunningProgressLabel: '{count} gotowe, {label} trwa',
      activityStepCountLabel: '{count} razy',
      activitySummarySeparator: ' · ',
    };
    const polish = await textsFor('pl', { locales: { pl: activity } });
    expect(polish).toMatchObject(activity);
    cleanup();
    const german = await textsFor('de', { locales: { de: { activityRunningProgressLabel: '{count} fertig, {label}…' } } });
    expect(german.activityRunningProgressLabel).toBe('{count} fertig, {label}…');
    expect(german.activityRunningLabel).toBe('{label}…');
    expect(german.activityStepCountLabel).toBe('×{count}');
    expect(german.activitySummarySeparator).toBe(', ');
  });

  it('is the chat of before without locales', async () => {
    const german = await textsFor('de', {});
    expect(german.approveButton).toBe('Ausführen');
    const polish = await textsFor('pl', {});
    expect(polish.approveButton).toBe('Approve');
  });
});

describe('the chat language: page first, the server tool wording only without one', () => {
  const pl: Partial<ChatLocale> = {
    activityWorkingLabel: 'Pracuje',
    activityWaitingLabel: 'Czeka na zgodę',
    activityDoneLabel: '{count} kroki wykonane',
    activityDoneOneLabel: '1 krok wykonany',
    activityFailedLabel: '{count} nieudane',
    activityDeclinedLabel: '{count} odrzucone',
    activityExpectedLabel: '{count} bez wyniku',
    activityRunningLabel: '{label}…',
    activityRunningProgressLabel: '{count} gotowe, {label}…',
    activityStepCountLabel: '×{count}',
    activitySummarySeparator: ', ',
    activityApprovalNotUsedDetail: 'Zgoda nie mogła zostać użyta',
  };

  async function textsAfterTurn(
    lang: string,
    props: Partial<React.ComponentProps<typeof AiChatProvider>>,
    presentationLocale = 'de-DE',
  ): Promise<ChatLocale> {
    const handlers = new Set<ChatTransportDataHandler>();
    const withData: ChatTransport = {
      ...transport(),
      subscribeToData: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    };
    document.documentElement.lang = lang;
    seen = undefined;
    render(<AiChatProvider transport={withData} {...props}><Probe /></AiChatProvider>);
    await waitFor(() => expect(seen).toBeDefined());
    await new Promise((settled) => setTimeout(settled, 0));
    act(() => {
      handlers.forEach((handler) => handler({
        type: 'data-tool-presentation',
        data: { locale: presentationLocale, tools: { tasks_list: { label: 'Aufgaben lesen' } } },
      }));
    });
    return seen!;
  }

  it('shows a Polish page its own activity texts although the server words its tools in German', async () => {
    const texts = await textsAfterTurn('pl', { locales: { pl } });
    expect(texts).toMatchObject(pl);
    expect(texts.approveButton).toBe('Approve');
  });

  it('falls back per #106 for a page language without texts, not to the server language', async () => {
    const texts = await textsAfterTurn('pl', {});
    expect(texts.activityDoneLabel).toBe('{count} steps done');
  });

  it('follows the server wording on a page without lang', async () => {
    const texts = await textsAfterTurn('', {});
    expect(texts.activityDoneLabel).toBe('{count} Schritte ausgeführt');
  });

  it("keeps the order before 0.18.0 with languageSource: 'server'", async () => {
    const texts = await textsAfterTurn('pl', { locales: { pl }, languageSource: 'server' });
    expect(texts.activityDoneLabel).toBe('{count} Schritte ausgeführt');
  });

  it('lets the language the app states win over the page and the server', async () => {
    const texts = await textsAfterTurn('de', { locales: { pl }, language: 'pl-PL' });
    expect(texts.activityDoneLabel).toBe('{count} kroki wykonane');
    cleanup();
    const server = await textsAfterTurn('de', { locales: { pl }, language: 'pl', languageSource: 'server' });
    expect(server.activityDoneLabel).toBe('{count} kroki wykonane');
  });
});
