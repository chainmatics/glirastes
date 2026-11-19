// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../provider/ai-chat-provider.js';
import { useChatContext } from '../provider/chat-context.js';
import { AiChatPanel } from '../components/ai-chat-panel.js';
import { useVercelAiChatTransport, type UseVercelAiChatTransportOptions } from '../transports/vercel.js';
import type { AiChatProviderConfig, ChatTransport } from '../types.js';

const sent: Array<Record<string, string>> = [];
let chunks: unknown[] = [];

function stream(): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  });
}

const textAnswer = [
  { type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'Done.' }, { type: 'text-end', id: 't' }, { type: 'finish-step' }, { type: 'finish' },
];

beforeEach(() => {
  sent.length = 0;
  chunks = textAnswer;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return stream();
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.lang = '';
});

let transport: ChatTransport;
function Probe(props: { options?: Partial<UseVercelAiChatTransportOptions> }) {
  transport = useVercelAiChatTransport({ endpoint: '/api/chat', ...props.options });
  return null;
}

describe('the Vercel transport names the chat language', () => {
  it('sends Content-Language only once a provider set a valid language, and lets the app header win', async () => {
    render(<Probe />);
    await act(async () => { await transport.sendMessage({ text: 'one' }); });
    expect(sent[0]).not.toHaveProperty('content-language');
    act(() => transport.setRequestLanguage!('pl-PL'));
    await act(async () => { await transport.sendMessage({ text: 'two' }); });
    expect(sent[1]!['content-language']).toBe('pl-PL');
    act(() => transport.setRequestLanguage!('pl, en'));
    await act(async () => { await transport.sendMessage({ text: 'three' }); });
    expect(sent[2]).not.toHaveProperty('content-language');
    cleanup();
    render(<Probe options={{ headers: () => ({ 'Content-Language': 'de', authorization: 'Bearer t' }) }} />);
    act(() => transport.setRequestLanguage!('pl'));
    await act(async () => { await transport.sendMessage({ text: 'four' }); });
    expect(sent[3]).toMatchObject({ 'content-language': 'de', authorization: 'Bearer t' });
  });
});

/** A provider on the real Vercel transport, as `VercelAiChat` composes them. */
function Chat(props: Partial<AiChatProviderConfig>) {
  const chatTransport = useVercelAiChatTransport({ endpoint: '/api/chat' });
  return (
    <AiChatProvider transport={chatTransport} approvalDisplay={{ open: 'inline' }} {...props}>
      <Send />
      <AiChatPanel />
    </AiChatProvider>
  );
}

let send: ((text: string) => Promise<void>) | undefined;
function Send() {
  const { send: sendText } = useChatContext();
  send = async (text) => { sendText(text); };
  return null;
}

async function turn(lang: string, props: Partial<AiChatProviderConfig> = {}) {
  document.documentElement.lang = lang;
  render(<Chat {...props} />);
  // The page language is read after mount.
  await new Promise((settled) => setTimeout(settled, 0));
  await act(async () => { await send!('Hello'); });
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  return sent.at(-1)!;
}

describe('the chat language from the page to the server', () => {
  it('names the page language in each request, no app code needed', async () => {
    expect((await turn('pl'))['content-language']).toBe('pl');
  });

  it('names the language the app states, also for an embed region', async () => {
    expect((await turn('pl', { language: 'de-AT' }))['content-language']).toBe('de-AT');
  });

  it('sends none with sendLanguage: false, with languageSource: server, or without a language', async () => {
    expect(await turn('pl', { sendLanguage: false })).not.toHaveProperty('content-language');
    cleanup();
    expect(await turn('pl', { languageSource: 'server' })).not.toHaveProperty('content-language');
    cleanup();
    expect(await turn('')).not.toHaveProperty('content-language');
  });

  it('shows the step and the approval card with the labels the server words in the sent language', async () => {
    // What the handler answers for `Content-Language: pl` with Polish labels (tool-presentation.test.ts).
    chunks = [
      { type: 'start' },
      {
        type: 'data-tool-presentation',
        data: { locale: 'pl', tools: { tasks_list: { label: 'Pokaż zadania' }, tasks_delete: { label: 'Usuń zadanie' } } },
        transient: true,
      },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'tasks_list', input: {} },
      { type: 'tool-output-available', toolCallId: 'c1', output: { success: true } },
      { type: 'tool-input-available', toolCallId: 'c2', toolName: 'tasks_delete', input: { id: 't1' } },
      { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'c2' },
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    const headers = await turn('pl');
    expect(headers['content-language']).toBe('pl');
    await waitFor(() => expect(document.querySelector('[data-component="approval-card"]')).not.toBeNull());
    const steps = Array.from(document.querySelectorAll('[data-element="activity-step"] [data-element="label"]')).map((node) => node.textContent);
    expect(steps).toEqual(['Pokaż zadania', 'Usuń zadanie']);
    expect(document.querySelector('[data-component="approval-card"]')!.textContent).toContain('Usuń zadanie');
    expect(screen.queryByText(/tasks_delete/)).toBeNull();
  });
});
