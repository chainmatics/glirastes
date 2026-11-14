// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineChatCommand, defineChatEntity } from '../../interactions/definitions.js';
import { AiChatProvider } from '../../provider/ai-chat-provider.js';
import type { ChatComponents, ChatTransport, MentionDropdownItemProps } from '../../types.js';
import { MentionInput } from '../mention-input.js';

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: (query) => [{ id: '7', label: 'Release prüfen' }].filter((item) => item.label.toLowerCase().startsWith(query.toLowerCase())),
  resolve: (id) => (id === '7' ? { id: '7', label: 'Release prüfen' } : undefined),
});

const commands = [
  defineChatCommand({ id: 'open.overview', label: 'Open Overview', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } }),
  defineChatCommand({ id: 'open.tasks', label: 'Open Tasks', run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/tasks' } } }),
];

type Transport = ChatTransport & { sendMessage: ReturnType<typeof vi.fn> };

function transport(): Transport {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

function Provider({ chat, components, children }: { chat: ChatTransport; components?: ChatComponents; children: ReactNode }) {
  const interactions = useMemo(() => ({ entities: [task], commands }), []);
  return <AiChatProvider transport={chat} chatInteractions={interactions} components={components}>{children}</AiChatProvider>;
}

function Item({ result, onClick, optionProps }: MentionDropdownItemProps) {
  return <button type="button" {...optionProps} data-testid="app-item" onClick={onClick}>{result.label}</button>;
}

function Other({ result, onClick, optionProps }: MentionDropdownItemProps) {
  return <button type="button" {...optionProps} data-testid="other-item" onClick={onClick}>{result.label}</button>;
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

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  cleanup();
  vi.restoreAllMocks();
});

describe('MentionInput slots', () => {
  it('renders the app item for suggestions, from the prop and from the provider', async () => {
    const first = render(<Provider chat={transport()}><MentionInput components={{ DropdownItem: Item }} /></Provider>);
    typeInto(screen.getByRole('textbox'), '/open');
    await waitFor(() => expect(screen.getAllByTestId('app-item')).toHaveLength(2));
    expect(screen.getAllByTestId('app-item').every((item) => item.getAttribute('role') === 'option')).toBe(true);
    first.unmount();

    const second = render(<Provider chat={transport()} components={{ MentionDropdownItem: Item }}><MentionInput /></Provider>);
    typeInto(screen.getByRole('textbox'), '/open');
    await waitFor(() => expect(screen.getAllByTestId('app-item')).toHaveLength(2));
    second.unmount();

    render(<Provider chat={transport()} components={{ MentionDropdownItem: Other }}><MentionInput components={{ DropdownItem: Item }} /></Provider>);
    typeInto(screen.getByRole('textbox'), '/open');
    await waitFor(() => expect(screen.getAllByTestId('app-item')).toHaveLength(2));
    expect(screen.queryByTestId('other-item')).toBeNull();
  });

  it('hands the composer to extra actions', async () => {
    const { container } = render(
      <Provider chat={transport()}>
        <MentionInput renderActions={(composer) => <button type="button" onClick={() => composer.appendText('diktiert')}>mic</button>} />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'mic' }));
    expect(screen.getByRole('textbox').textContent).toBe('diktiert');
    const buttons = [...container.querySelectorAll('form button')];
    const send = container.querySelector('[data-action="send"]')!;
    expect(buttons.indexOf(screen.getByRole('button', { name: 'mic' }))).toBeLessThan(buttons.indexOf(send));
    await waitFor(() => expect(send).toHaveProperty('disabled', false));
  });

  it('replaces the send and stop buttons', async () => {
    const chat = transport();
    const { container } = render(
      <Provider chat={chat}>
        <MentionInput renderSubmit={(composer) => <button type="submit" aria-label="Senden" disabled={!composer.canSend} />} />
      </Provider>,
    );
    expect(container.querySelector('[data-action="send"]')).toBeNull();
    typeInto(screen.getByRole('textbox'), 'Hallo');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Senden' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Senden' }));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
  });

  it('starts with a reference and a text', async () => {
    const chat = transport();
    const { container } = render(
      <Provider chat={chat}>
        <MentionInput initialMentions={[{ id: '7', type: 'task', label: 'Release prüfen' }]} initialValue="Was ist offen?" />
      </Provider>,
    );
    expect(container.querySelector('[data-mention-id="7"]')).not.toBeNull();
    expect(screen.getByRole('textbox').textContent).toContain('Was ist offen?');
    const send = container.querySelector('[data-action="send"]') as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    const text = chat.sendMessage.mock.calls[0]![0].text as string;
    expect(text).toContain('mention:task:7');
    expect(text).toContain('Was ist offen?');
  });

  it('applies the class names', () => {
    const { container } = render(<Provider chat={transport()}><MentionInput inputClassName="box" editorClassName="edit" /></Provider>);
    expect(container.querySelector('[data-component="rich-mention-input"]')!.classList.contains('box')).toBe(true);
    expect(container.querySelector('[data-element="editor"]')!.classList.contains('edit')).toBe(true);
  });

  it('renders the same composer without the new props', () => {
    const { container } = render(<Provider chat={transport()}><MentionInput /></Provider>);
    expect(container.querySelector('[data-component="mention-input"][data-mode="providers"] form > [data-component="rich-mention-input"]')).not.toBeNull();
    expect(container.querySelector('[data-action="send"]')!.textContent).toBe('Send');
  });
});
