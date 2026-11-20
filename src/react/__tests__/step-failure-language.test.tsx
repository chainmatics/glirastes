// @vitest-environment jsdom

import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider, DEFAULT_LOCALE } from '../provider/ai-chat-provider.js';
import { useChatContext } from '../provider/chat-context.js';
import { deChatLocale } from '../locale-de.js';
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
  await waitFor(() => expect(seen).toBeDefined());
  await new Promise((settled) => setTimeout(settled, 0));
  return seen!;
}

const ENGLISH = 'Endpoint failed ({status})';
const GERMAN = 'Endpunkt fehlgeschlagen ({status})';

/** An app's own full English table, written before the failure keys existed. */
const { activityFailureEndpointFailed: _dropped, ...withoutFailureKeys } = DEFAULT_LOCALE;
const ownEnglish: Partial<ChatLocale> = Object.fromEntries(
  Object.entries(withoutFailureKeys).filter(([key]) => !key.startsWith('activityFailure')),
);
const ownGerman: Partial<ChatLocale> = Object.fromEntries(
  Object.entries(deChatLocale).filter(([key]) => !key.startsWith('activityFailure'))
    .map(([key, text]) => [key, key.startsWith('activity') ? `${text} ` : text]),
);

describe('which table the failure details of a step follow', () => {
  it('a chat without its own texts: the built-in texts of the page language', async () => {
    expect((await textsFor('de', {})).activityFailureEndpointFailed).toBe(GERMAN);
    cleanup();
    expect((await textsFor('en', {})).activityFailureEndpointFailed).toBe(ENGLISH);
  });

  it("an app's own full English locale on a German page stays English, as before", async () => {
    const texts = await textsFor('de', { locale: ownEnglish });
    expect(texts.activityFailedLabel).toBe('{count} failed');
    expect(texts.activityFailureEndpointFailed).toBe(ENGLISH);
  });

  it("an app's own German locale on a German page stays as before, German once the app states the language", async () => {
    expect((await textsFor('de', { locale: ownGerman })).activityFailureEndpointFailed).toBe(ENGLISH);
    cleanup();
    expect((await textsFor('de', { locale: ownGerman, language: 'de' })).activityFailureEndpointFailed).toBe(GERMAN);
  });

  it("an app's own locale that sets no activity text keeps the built-in texts of the language", async () => {
    expect((await textsFor('de', { locale: { sendButton: 'Los' } })).activityFailureEndpointFailed).toBe(GERMAN);
  });

  it('a spread built-in German locale carries the German texts', async () => {
    expect((await textsFor('de', { locale: { ...deChatLocale, sendButton: 'Los' } })).activityFailureEndpointFailed).toBe(GERMAN);
  });

  it("the app's own failure keys win, also beside its own activity texts", async () => {
    const own = { ...ownEnglish, activityFailureEndpointFailed: 'Service down ({status})' };
    expect((await textsFor('de', { locale: own })).activityFailureEndpointFailed).toBe('Service down ({status})');
  });

  it('locales: an own German table with activity texts stays English without a stated language', async () => {
    const de = { activityFailedLabel: '{count} kaputt' };
    expect((await textsFor('de', { locales: { de } })).activityFailureEndpointFailed).toBe(ENGLISH);
    cleanup();
    expect((await textsFor('de', { locales: { de }, language: 'de' })).activityFailureEndpointFailed).toBe(GERMAN);
    cleanup();
    expect((await textsFor('de', { locales: { de: { sendButton: 'Los' } } })).activityFailureEndpointFailed).toBe(GERMAN);
  });

  it('locales.pl: a language without built-in texts gets English, or the app\'s own keys', async () => {
    expect((await textsFor('pl', { locales: { pl: { activityFailedLabel: '{count} błędów' } } })).activityFailureEndpointFailed)
      .toBe(ENGLISH);
    cleanup();
    expect((await textsFor('pl', { locales: { pl: { activityFailureEndpointFailed: 'Błąd ({status})' } } }))
      .activityFailureEndpointFailed).toBe('Błąd ({status})');
  });
});
