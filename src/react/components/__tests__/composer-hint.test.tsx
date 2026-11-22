// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatComposer, type ChatComposer } from '../../composer/chat-composer.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatCompletionProvider, ChatLocale, ChatTransport, ComposerConfig } from '../../types.js';
import { ChatInput } from '../chat-input.js';
import { MentionInput } from '../mention-input.js';

function transport(): ChatTransport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const people: ChatCompletionProvider = { id: 'people', trigger: '@', search: () => [{ id: '1', type: 'user', label: 'Ann' }] };
const commands: ChatCompletionProvider = { id: 'cmds', trigger: '/', search: () => [{ id: 'h', type: 'command', label: 'Help' }] };

let composer: ChatComposer;
function Grab() {
  composer = useChatComposer();
  return null;
}

function Setup({ config, language, locale, completion = true }: {
  config?: ComposerConfig;
  language?: string;
  locale?: Partial<ChatLocale>;
  completion?: boolean;
}) {
  const chat = useMemo(() => transport(), []);
  const providers = useMemo(() => [people, commands], []);
  return (
    <AiChatProvider
      transport={chat}
      {...(completion ? { completionProviders: providers } : {})}
      {...(config ? { composer: config } : {})}
      {...(language ? { language } : {})}
      {...(locale ? { locale } : {})}
    >
      <Grab />
      {completion ? <MentionInput /> : <ChatInput />}
    </AiChatProvider>
  );
}

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  const range = document.createRange();
  range.setStart(editor.firstChild!, text.length);
  range.collapse(true);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.input(editor);
}

const hint = () => document.querySelector('[data-component="composer-hint"]');

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
});

describe('composer hint line', () => {
  it('no hint without composer.hint', () => {
    render(<Setup />);
    expect(hint()).toBeNull();
  });

  it('composer.hint shows send and new line in the chat language', () => {
    const { unmount } = render(<Setup config={{ hint: true }} language="de" />);
    expect(hint()!.getAttribute('aria-hidden')).toBe('true');
    expect(hint()!.textContent).toBe('↵ Senden · ⇧ ↵ Zeilenumbruch');
    expect(hint()!.querySelector('[data-hint="compose"]')!.innerHTML)
      .toBe('<kbd>↵</kbd> Senden · <kbd>⇧ ↵</kbd> Zeilenumbruch');
    unmount();
    render(<Setup config={{ hint: true }} />);
    expect(hint()!.textContent).toBe('↵ Send · ⇧ ↵ New line');
  });

  it('is the last child of the composer wrapper', () => {
    render(<Setup config={{ hint: true }} />);
    expect(document.querySelector('[data-component="mention-input"]')!.lastElementChild).toBe(hint());
  });

  it('the hint switches while a completion list is open and back after Escape', async () => {
    render(<Setup config={{ hint: true }} language="de" />);
    const editor = screen.getByRole('textbox');
    typeInto(editor, '@an');
    await waitFor(() => expect(hint()!.querySelector('[data-hint="completion"]')).not.toBeNull());
    expect(hint()!.textContent).toBe('↑ ↓ Navigieren · ↵ Vorschlag übernehmen · Esc Schließen');
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(hint()!.querySelector('[data-hint="compose"]')).not.toBeNull());
  });

  it('list opened by openCompletion', async () => {
    render(<Setup config={{ hint: true }} />);
    act(() => composer.openCompletion({ trigger: '/' }));
    await waitFor(() => expect(hint()!.querySelector('[data-hint="completion"]')).not.toBeNull());
    expect(hint()!.textContent).toBe('↑ ↓ Navigate · ↵ Pick suggestion · Esc Close');
  });

  it('the plain input shows the compose hint', () => {
    render(<Setup config={{ hint: true }} completion={false} />);
    expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA');
    const form = document.querySelector('[data-component="chat-input"]')!;
    expect(form.lastElementChild).toBe(hint());
    expect(hint()!.textContent).toBe('↵ Send · ⇧ ↵ New line');
  });

  it('locale overrides the hint texts', () => {
    render(<Setup config={{ hint: true }} locale={{ composerHintSend: 'Abschicken' }} />);
    expect(hint()!.textContent).toBe('↵ Abschicken · ⇧ ↵ New line');
  });
});
