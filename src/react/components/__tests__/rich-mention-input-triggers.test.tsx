// @vitest-environment jsdom
import React, { useMemo } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatCompletionProvider, ChatTransport, ChatTriggerDefinition } from '../../types.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { MentionInput } from '../mention-input.js';
import { RichMentionInput } from '../rich-mention-input.js';

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

const tickets: ChatCompletionProvider = {
  id: 'tickets',
  trigger: '#',
  search: ({ query }) => [{ id: '7', type: 'ticket', label: `Bug ${query}` }],
};
const people: ChatCompletionProvider = {
  id: 'people',
  trigger: '@',
  search: () => [{ id: '42', type: 'user', label: 'Alice Doe' }],
};
const commands: ChatCompletionProvider = {
  id: 'commands',
  trigger: '/',
  search: () => [{ id: 'done', type: 'command', label: 'Erledigte filtern' }],
};

function Composer({ chat, triggers }: { chat: ChatTransport; triggers?: ChatTriggerDefinition[] }) {
  const providers = useMemo(() => [tickets, people, commands], []);
  return (
    <AiChatProvider transport={chat} completionProviders={providers} triggers={triggers}>
      <MentionInput />
    </AiChatProvider>
  );
}

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  const range = document.createRange();
  range.setStart(editor.firstChild!, text.length);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}

const chipPrefix = (editor: HTMLElement, id: string) =>
  editor.querySelector(`[data-mention-id="${id}"] [data-element="prefix"]`)?.textContent;

describe('configurable composer triggers', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    cleanup();
  });

  it('opens a # provider list and inserts a chip with the # prefix', async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Siehe #bug');
    await waitFor(() => expect(screen.getByText('Bug bug')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chipPrefix(editor, '7')).toBe('#'));
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({
      text: 'Siehe {{mention:ticket:7:Bug bug}}',
    }));
  });

  it('uses the prefix of an explicit trigger definition', async () => {
    const chat = transport();
    render(<Composer chat={chat} triggers={[{ char: '#', prefix: 'T-', label: 'Tickets' }]} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, '#bug');
    await waitFor(() => expect(screen.getByText('Bug bug')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chipPrefix(editor, '7')).toBe('T-'));
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({
      text: '{{mention:ticket:7:Bug bug}}',
    }));
  });

  it('does not open a list for a trigger char inside a word', async () => {
    render(<Composer chat={transport()} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    for (const text of ['mail#bug', 'mail@host', 'a/b']) {
      typeInto(editor, text);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(screen.queryByRole('listbox')).toBeNull();
    }
  });

  it('keeps the @ and / lists unchanged', async () => {
    render(<Composer chat={transport()} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, '@al');
    await waitFor(() => expect(screen.getByText('Alice Doe')).toBeTruthy());
    expect(screen.queryByText(/^Bug/)).toBeNull();
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chipPrefix(editor, '42')).toBe('@'));

    typeInto(editor, '/er');
    await waitFor(() => expect(screen.getByText('Erledigte filtern')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(
      editor.querySelector('[data-mention-kind="command"] [data-element="prefix"]')?.textContent,
    ).toBe('/'));
  });

  it('rejects an invalid trigger definition when the provider renders', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Composer chat={transport()} triggers={[{ char: '##' }]} />)).toThrow(
      /Invalid chat trigger "##"/,
    );
    error.mockRestore();
  });

  it('accepts trigger definitions on a standalone editor', async () => {
    const onSearch = vi.fn(() => [{ id: '1', type: 'tag', label: 'Urgent' }]);
    render(<RichMentionInput onSearch={onSearch} triggers={['@', { char: '#', prefix: 'tag:' }]} placeholder="Edit" />);
    const editor = screen.getByRole('textbox', { name: 'Edit' });

    typeInto(editor, '#ur');
    await waitFor(() => expect(screen.getByText('Urgent')).toBeTruthy());
    expect(onSearch).toHaveBeenCalledWith('ur', '#');
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chipPrefix(editor, '1')).toBe('tag:'));
  });
});
