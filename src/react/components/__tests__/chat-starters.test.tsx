// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatCompletionProvider, ChatMessage, ChatTransport, ComposerConfig, SuggestionsConfig } from '../../types.js';
import { AiChatPanel } from '../ai-chat-panel.js';

function transport(status: ChatTransport['status'] = 'ready', messages: ChatMessage[] = []): ChatTransport {
  return {
    messages, status, error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const people: ChatCompletionProvider = { id: 'people', trigger: '@', search: () => [] };

function Panel({ chat, composer, suggestions, completion = true, language }: {
  chat: ChatTransport;
  composer?: ComposerConfig;
  suggestions?: SuggestionsConfig;
  completion?: boolean;
  language?: string;
}) {
  const providers = useMemo(() => [people], []);
  return (
    <AiChatProvider
      transport={chat}
      {...(completion ? { completionProviders: providers } : {})}
      {...(composer ? { composer } : {})}
      {...(suggestions ? { suggestions } : {})}
      {...(language ? { language } : {})}
    >
      <AiChatPanel />
    </AiChatProvider>
  );
}

const group = () => document.querySelector('[data-component="chat-starters"]');
const editor = () => screen.getByRole('textbox');
const editorText = (completion = true) => (completion ? editor().textContent : (editor() as HTMLTextAreaElement).value);
const flushFrame = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await flushFrame();
  cleanup();
});

describe('starter chips', () => {
  it('no starters without config; the empty state is unchanged', () => {
    render(<Panel chat={transport()} />);
    expect(group()).toBeNull();
  });

  it('starters show on an empty chat and disappear after the first message', () => {
    const composer: ComposerConfig = { starters: ['Was ist neu?', { label: 'Zusammenfassen' }] };
    const { rerender } = render(<Panel chat={transport()} composer={composer} language="de" />);
    const starters = group()!;
    expect(starters.getAttribute('role')).toBe('group');
    expect(starters.getAttribute('aria-label')).toBe('Vorschläge');
    const buttons = screen.getAllByRole('button', { name: /Was ist neu\?|Zusammenfassen/ });
    expect(buttons.map((button) => button.getAttribute('type'))).toEqual(['button', 'button']);
    expect(buttons.every((button) => button.getAttribute('data-element') === 'starter')).toBe(true);
    const message: ChatMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hallo' }] } as ChatMessage;
    rerender(<Panel chat={transport('ready', [message])} composer={composer} language="de" />);
    expect(group()).toBeNull();
  });

  it('a click puts the prompt into an empty composer and focuses it', async () => {
    const chat = transport();
    render(<Panel chat={chat} composer={{ starters: [{ label: 'Zusammenfassen', prompt: 'Fasse den Auftrag zusammen' }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zusammenfassen' }));
    expect(editorText()).toBe('Fasse den Auftrag zusammen');
    await flushFrame();
    expect(document.activeElement).toBe(editor());
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('a click with text already in the composer appends the prompt', () => {
    render(<Panel chat={transport()} composer={{ starters: ['Zusammenfassen'] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zusammenfassen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zusammenfassen' }));
    expect(editorText()).toBe('Zusammenfassen Zusammenfassen');
  });

  it('send: true sends the prompt', () => {
    const chat = transport();
    render(<Panel chat={chat} composer={{ starters: [{ label: 'Neu', prompt: 'Was ist neu?', send: true }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Neu' }));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect((vi.mocked(chat.sendMessage).mock.calls[0]![0] as { text: string }).text).toBe('Was ist neu?');
  });

  it('locked composer', () => {
    const chat = transport('streaming');
    render(<Panel chat={chat} composer={{ starters: ['Hallo', { label: 'Senden', send: true }] }} />);
    const buttons = Array.from(group()!.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('string icon goes through renderIcon', () => {
    const renderIcon = vi.fn((name: string) => <i data-icon={name} />);
    render(<Panel chat={transport()} composer={{ starters: [{ label: 'Neu', icon: 'sparkle' }, { label: 'Alt', icon: <b data-testid="el" /> }], renderIcon }} />);
    const icon = group()!.querySelector('[data-element="starter-icon"]')!;
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.querySelector('i[data-icon="sparkle"]')).not.toBeNull();
    expect(renderIcon).toHaveBeenCalledWith('sparkle', { type: 'starter' });
    expect(screen.getByRole('button', { name: 'Alt' }).contains(screen.getByTestId('el'))).toBe(true);
  });

  it('description is the title', () => {
    render(<Panel chat={transport()} composer={{ starters: [{ label: 'Neu', description: 'Neuigkeiten der Woche' }] }} />);
    expect(screen.getByRole('button', { name: 'Neu' }).getAttribute('title')).toBe('Neuigkeiten der Woche');
  });

  it('staticChips are hidden on an empty chat while starters show', () => {
    const suggestions: SuggestionsConfig = { staticChips: ['A'] };
    const { unmount } = render(<Panel chat={transport()} suggestions={suggestions} />);
    expect(document.querySelector('[data-component="suggestion-bar"]')).not.toBeNull();
    unmount();
    render(<Panel chat={transport()} suggestions={suggestions} composer={{ starters: ['Neu'] }} />);
    expect(document.querySelector('[data-component="suggestion-bar"]')).toBeNull();
  });

  it('works in the plain input', () => {
    render(<Panel chat={transport()} completion={false} composer={{ starters: [{ label: 'Neu', prompt: 'Was ist neu?' }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Neu' }));
    expect(editorText(false)).toBe('Was ist neu?');
  });
});
