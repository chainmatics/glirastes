// @vitest-environment jsdom
import React, { useMemo } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiChatProviderConfig,
  ChatCompletionProvider,
  ChatTransport,
  ChatTriggerDefinition,
  MentionResult,
  RichMentionInputHandle,
} from '../../types.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import { MentionInput } from '../mention-input.js';
import { useChatComposer, type ChatComposer } from '../../composer/chat-composer.js';
import { RichMentionInput } from '../rich-mention-input.js';

function transport(status: ChatTransport['status'] = 'ready'): ChatTransport {
  return {
    messages: [],
    status,
    error: null,
    sendMessage: vi.fn(async () => {}),
    stop: vi.fn(),
    setMessages: vi.fn(),
    addToolApprovalResponse: vi.fn(async () => {}),
  };
}

const prompts: ChatCompletionProvider = {
  id: 'prompts',
  trigger: '/',
  search: () => [
    { id: 'sum', type: 'prompt', label: 'Zusammenfassen', select: 'text', insertText: 'Fasse den Auftrag zusammen' },
    { id: 'templates', type: 'prompt', label: 'Vorlagen' },
  ],
};
const templates: ChatCompletionProvider = {
  id: 'templates',
  trigger: '/',
  search: ({ query }) => [{ id: 'mail', type: 'template', label: `Mail ${query}`.trim(), select: 'text' }],
};
const tickets: ChatCompletionProvider = {
  id: 'tickets',
  trigger: '#',
  search: () => [
    { id: '7', type: 'ticket', label: 'Bug sieben' },
    { id: '8', type: 'ticket', label: 'Bug acht', select: 'chip' },
    { id: '9', type: 'ticket', label: 'Bug neun', select: 'run' },
  ],
};

interface ComposerProps {
  chat: ChatTransport;
  triggers?: ChatTriggerDefinition[];
  onCompletionSelect?: AiChatProviderConfig['onCompletionSelect'];
}

function Composer({ chat, triggers, onCompletionSelect }: ComposerProps) {
  const providers = useMemo(() => [prompts, templates, tickets], []);
  return (
    <AiChatProvider
      transport={chat}
      completionProviders={providers}
      triggers={triggers}
      onCompletionSelect={onCompletionSelect}
    >
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

const chip = (editor: HTMLElement, id: string) => editor.querySelector(`[data-mention-id="${id}"]`);
const option = (label: string) => screen.getByRole('option', { name: label });

describe('completion pick behavior (select)', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    cleanup();
  });

  it("'text' replaces trigger and query with insertText as plain text", async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Bitte /zus');
    await waitFor(() => expect(option('Zusammenfassen')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(editor.textContent).toBe('Bitte Fasse den Auftrag zusammen');
    expect(editor.querySelector('[data-mention-id]')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    const selection = window.getSelection()!;
    expect(selection.getRangeAt(0).startOffset).toBe('Bitte Fasse den Auftrag zusammen'.length);

    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Bitte Fasse den Auftrag zusammen' }));
  });

  it("'run' inserts the chip and sends once", async () => {
    const chat = transport();
    render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Siehe #bug');
    await waitFor(() => expect(option('Bug neun')).toBeTruthy());
    fireEvent.click(option('Bug neun'));

    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(chat.sendMessage).toHaveBeenCalledWith({ text: 'Siehe {{mention:ticket:9:Bug neun}}' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("'run' while a turn streams sends nothing and keeps the chip", async () => {
    const chat = transport();
    const { rerender } = render(<Composer chat={chat} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Siehe #bug');
    await waitFor(() => expect(option('Bug neun')).toBeTruthy());
    const streaming = { ...chat, status: 'streaming' as const };
    rerender(<Composer chat={streaming} />);
    fireEvent.click(option('Bug neun'));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(chip(editor, '9')).not.toBeNull();
  });

  it('a sub-list: onCompletionSelect opens the list of another provider and returns true', async () => {
    // The recipe instead of a `list` pick kind.
    const onCompletionSelect = vi.fn<NonNullable<AiChatProviderConfig['onCompletionSelect']>>((item, { trigger, controls }) => {
      if (item.id !== 'templates') return undefined;
      controls.openCompletion({ trigger, source: 'templates' });
      return true;
    });
    render(<Composer chat={transport()} onCompletionSelect={onCompletionSelect} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Bitte /vor');
    await waitFor(() => expect(option('Vorlagen')).toBeTruthy());
    fireEvent.click(option('Vorlagen'));

    // One trigger in place of `/vor`, and only the `templates` provider's entries.
    await waitFor(() => expect(option('Mail')).toBeTruthy());
    expect(editor.textContent).toBe('Bitte /');
    expect(screen.queryByRole('option', { name: 'Zusammenfassen' })).toBeNull();

    // Typing on searches the sub-list only.
    typeInto(editor, 'Bitte /ang');
    await waitFor(() => expect(option('Mail ang')).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Zusammenfassen' })).toBeNull();

    fireEvent.click(option('Mail ang'));
    expect(editor.textContent).toBe('Bitte Mail ang');
    expect(onCompletionSelect).toHaveBeenCalledTimes(2);
  });

  it('a sub-list closed untouched leaves the text before the pick', async () => {
    const onCompletionSelect = vi.fn<NonNullable<AiChatProviderConfig['onCompletionSelect']>>((item, { trigger, controls }) => {
      if (item.id !== 'templates') return undefined;
      controls.openCompletion({ trigger, source: 'templates' });
      return true;
    });
    render(<Composer chat={transport()} onCompletionSelect={onCompletionSelect} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Bitte /vor');
    await waitFor(() => expect(option('Vorlagen')).toBeTruthy());
    fireEvent.click(option('Vorlagen'));
    await waitFor(() => expect(option('Mail')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(editor.textContent).toBe('Bitte ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it("an item's select overrides the trigger default", async () => {
    render(<Composer chat={transport()} triggers={[{ char: '#', select: 'text' }]} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, '#bug');
    await waitFor(() => expect(option('Bug sieben')).toBeTruthy());
    fireEvent.click(option('Bug sieben'));
    // The trigger default: no insertText, so the label as text.
    expect(editor.textContent).toBe('Bug sieben');
    expect(chip(editor, '7')).toBeNull();

    typeInto(editor, '#bug');
    await waitFor(() => expect(option('Bug acht')).toBeTruthy());
    fireEvent.click(option('Bug acht'));
    expect(chip(editor, '8')).not.toBeNull();
  });

  it('onCompletionSelect returning true skips the built-in behavior and closes the list', async () => {
    const onCompletionSelect = vi.fn(() => true);
    const chat = transport();
    render(<Composer chat={chat} onCompletionSelect={onCompletionSelect} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Siehe #bug');
    await waitFor(() => expect(option('Bug neun')).toBeTruthy());
    fireEvent.click(option('Bug neun'));

    expect(onCompletionSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: '9', type: 'ticket', select: 'run' }),
      expect.objectContaining({
        trigger: '#',
        query: 'bug',
        controls: expect.objectContaining({ submit: expect.any(Function), setText: expect.any(Function) }),
      }),
    );
    expect(chip(editor, '9')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    // The app handled it: the typed trigger and query go, the caret stays where they were.
    expect(editor.textContent).toBe('Siehe ');
    const range = window.getSelection()!.getRangeAt(0);
    expect(editor.contains(range.startContainer)).toBe(true);
    expect(range.startOffset).toBe('Siehe '.length);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('onCompletionSelect returning true removes a trigger opened by openCompletion, with its space', async () => {
    const onCompletionSelect = vi.fn(() => true);
    let composer: ChatComposer | null = null;
    function Grab() { composer = useChatComposer(); return null; }
    render(
      <AiChatProvider transport={transport()} completionProviders={[tickets]} onCompletionSelect={onCompletionSelect}>
        <MentionInput />
        <Grab />
      </AiChatProvider>,
    );
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });
    typeInto(editor, 'Siehe');
    act(() => { composer!.openCompletion({ trigger: '#' }); });
    await waitFor(() => expect(option('Bug sieben')).toBeTruthy());
    expect(editor.textContent).toBe('Siehe #');
    fireEvent.click(option('Bug sieben'));

    expect(onCompletionSelect).toHaveBeenCalledTimes(1);
    expect(editor.textContent).toBe('Siehe');
    expect(window.getSelection()!.getRangeAt(0).startOffset).toBe('Siehe'.length);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('onCompletionSelect that appends text and returns true still loses the typed trigger', async () => {
    const onCompletionSelect = vi.fn<NonNullable<AiChatProviderConfig['onCompletionSelect']>>((item, { controls }) => {
      controls.appendText(item.label);
      return true;
    });
    render(<Composer chat={transport()} onCompletionSelect={onCompletionSelect} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, 'Siehe #bu');
    await waitFor(() => expect(option('Bug sieben')).toBeTruthy());
    fireEvent.click(option('Bug sieben'));

    expect(editor.textContent).toBe('Siehe Bug sieben');
    const range = window.getSelection()!.getRangeAt(0);
    expect(editor.contains(range.startContainer)).toBe(true);
    expect(range.startContainer.nodeType).toBe(Node.TEXT_NODE);
    expect(range.startOffset).toBe('Siehe '.length);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a handled pick in the middle of the text leaves one space', async () => {
    render(<Composer chat={transport()} onCompletionSelect={() => true} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    editor.textContent = 'Siehe #bu weiter';
    const range = document.createRange();
    range.setStart(editor.firstChild!, 'Siehe #bu'.length);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.input(editor);
    await waitFor(() => expect(option('Bug sieben')).toBeTruthy());
    fireEvent.click(option('Bug sieben'));

    expect(editor.textContent).toBe('Siehe weiter');
    expect(window.getSelection()!.getRangeAt(0).startOffset).toBe('Siehe '.length);
  });

  it('onCompletionSelect returning nothing keeps the built-in behavior', async () => {
    const onCompletionSelect = vi.fn(() => undefined);
    render(<Composer chat={transport()} onCompletionSelect={onCompletionSelect} />);
    const editor = screen.getByRole('textbox', { name: 'Type a message...' });

    typeInto(editor, '#bug');
    await waitFor(() => expect(option('Bug sieben')).toBeTruthy());
    fireEvent.click(option('Bug sieben'));

    expect(onCompletionSelect).toHaveBeenCalledTimes(1);
    expect(chip(editor, '7')).not.toBeNull();
  });
});

describe('standalone RichMentionInput pick behavior', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    cleanup();
  });

  const results: MentionResult[] = [
    { id: '9', type: 'ticket', label: 'Bug neun', select: 'run' },
  ];

  it("'run' submits once with the chip", async () => {
    const onSubmit = vi.fn();
    render(<RichMentionInput onSearch={() => results} onSubmit={onSubmit} triggers={['#']} />);
    const editor = screen.getByRole('textbox');

    typeInto(editor, 'Siehe #bug');
    await waitFor(() => expect(option('Bug neun')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('Siehe #bug-neun', [
      expect.objectContaining({ id: '9', type: 'ticket', prefix: '#' }),
    ]);
  });

  it("'run' on a disabled input submits nothing and keeps the chip", async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<RichMentionInput onSearch={() => results} onSubmit={onSubmit} triggers={['#']} />);
    const editor = screen.getByRole('textbox');

    typeInto(editor, '#bug');
    await waitFor(() => expect(option('Bug neun')).toBeTruthy());
    rerender(<RichMentionInput onSearch={() => results} onSubmit={onSubmit} triggers={['#']} disabled />);
    fireEvent.click(option('Bug neun'));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(chip(editor, '9')).not.toBeNull();
  });

  it("'run' with commandPills={false} sends the command mention", async () => {
    const onSubmit = vi.fn();
    const command: MentionResult[] = [{ id: 'done', type: 'command', label: 'Erledigte filtern', select: 'run' }];
    render(<RichMentionInput onSearch={() => command} onSubmit={onSubmit} commandPills={false} />);
    const editor = screen.getByRole('textbox');

    typeInto(editor, '/erl');
    await waitFor(() => expect(option('Erledigte filtern')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('/erledigte-filtern', [
      expect.objectContaining({ id: 'done', type: 'command', prefix: '/' }),
    ]);
  });

  it('an unknown select (such as the dropped list kind) inserts a pill', async () => {
    const onSearch = vi.fn((): MentionResult[] => [{ id: '5', type: 'ticket', label: 'Bug fuenf', select: 'list' as never }]);
    render(<RichMentionInput onSearch={onSearch} triggers={['#']} />);
    const editor = screen.getByRole('textbox');

    typeInto(editor, '#bug');
    await waitFor(() => expect(option('Bug fuenf')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(chip(editor, '5')).not.toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('a pending debounced search does not reopen the list after a text pick', async () => {
    const onSearch = vi.fn((): MentionResult[] => [{ id: 't', type: 'prompt', label: 'Vorlage', select: 'text' }]);
    render(<RichMentionInput onSearch={onSearch} />);
    const editor = screen.getByRole('textbox');

    typeInto(editor, '/vo');
    await waitFor(() => expect(option('Vorlage')).toBeTruthy());
    // Typing schedules a search; the pick happens inside its debounce window.
    typeInto(editor, '/vor');
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(editor.textContent).toBe('Vorlage');

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('a handler that inserts a mention through the handle loses the typed trigger, the pill stays', async () => {
    const ref = React.createRef<RichMentionInputHandle>();
    const onCompletionSelect = vi.fn((item: { id: string; type: string; label: string }) => {
      ref.current!.insertMention({ id: item.id, type: item.type, label: item.label, displayName: item.label, prefix: '#', slug: 'bug-neun' });
      return true;
    });
    render(<RichMentionInput ref={ref} onSearch={() => results} triggers={['#']} onCompletionSelect={onCompletionSelect} />);
    const editor = screen.getByRole('textbox');

    typeInto(editor, 'Siehe #bu');
    await waitFor(() => expect(option('Bug neun')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(chip(editor, '9')).not.toBeNull();
    expect(editor.textContent).not.toContain('#bu');
  });

  it('takes onCompletionSelect with trigger and query', async () => {
    const onCompletionSelect = vi.fn(() => true);
    render(<RichMentionInput onSearch={() => results} triggers={['#']} onCompletionSelect={onCompletionSelect} />);
    const editor = screen.getByRole('textbox');

    typeInto(editor, '#bug');
    await waitFor(() => expect(option('Bug neun')).toBeTruthy());
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(onCompletionSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: '9' }),
      { trigger: '#', query: 'bug' },
    );
    expect(chip(editor, '9')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(editor.textContent).toBe('');
  });
});
