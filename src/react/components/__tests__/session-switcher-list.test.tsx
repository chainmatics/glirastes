// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionSwitcher } from '../session-switcher.js';
import { ChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import { deChatLocale } from '../../locale-de.js';

afterEach(() => { cleanup(); });

function chat(overrides: Partial<ChatContextValue> = {}): ChatContextValue {
  return {
    sessionsSupported: true,
    sessions: [
      { id: 'old', title: 'Old chat', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'new', title: 'Newest chat with a rather long title', updatedAt: '2026-03-01T00:00:00Z' },
      { id: 'mid', title: 'Middle chat', updatedAt: '2026-02-01T00:00:00Z' },
    ],
    activeSessionId: 'mid',
    isSessionsLoading: false,
    isLoading: false,
    isSessionChangeBlocked: false,
    switchSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => null),
    removeSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    locale: DEFAULT_LOCALE,
    ...overrides,
  } as unknown as ChatContextValue;
}
const mount = (value: ChatContextValue, props: React.ComponentProps<typeof SessionSwitcher> = {}) =>
  render(<ChatContext.Provider value={value}><SessionSwitcher {...props} /></ChatContext.Provider>);
const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-element="row-main"]'));

describe('SessionSwitcher variant="list"', () => {
  it('the dropdown is unchanged', () => {
    const { container } = mount(chat());
    const root = container.firstElementChild!;
    expect(root.tagName).toBe('DIV');
    expect(root.hasAttribute('data-variant')).toBe(false);
    expect(root.innerHTML).toBe(
      '<button type="button" data-element="trigger" aria-haspopup="listbox" aria-expanded="false">'
      + '<span data-element="trigger-title">Middle chat</span>'
      + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>'
      + '</button>');
  });

  it('the list shows every chat newest first with the active one marked', () => {
    mount(chat(), { variant: 'list' });
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    expect(nav.dataset.variant).toBe('list');
    const list = within(nav).getByRole('list', { name: 'Recent chats' });
    expect(list.getAttribute('data-element')).toBe('session-list');
    expect(rows().map(row => row.textContent)).toEqual(['Newest chat with a rather long title', 'Middle chat', 'Old chat']);
    const active = rows()[1]!;
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(active.title).toBe('Middle chat');
    expect(active.closest('li')!.hasAttribute('data-active')).toBe(true);
    expect(rows()[0]!.hasAttribute('aria-current')).toBe(false);
    const edit = within(active.closest('li')!).getByRole('button', { name: 'Rename conversation' });
    expect(edit.getAttribute('aria-describedby')).toBe(active.querySelector('[data-element="row-title"]')!.id);
    expect(document.querySelector('[data-element="row-subtitle"]')).toBeNull();
  });

  it('a pick switches the chat and calls onSelect', async () => {
    const value = chat();
    const onSelect = vi.fn();
    mount(value, { variant: 'list', onSelect });
    fireEvent.click(rows()[2]!);
    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
    expect(value.switchSession).toHaveBeenCalledWith('old');
  });

  it('new chat creates one and calls onSelect', async () => {
    const value = chat();
    const onSelect = vi.fn();
    mount(value, { variant: 'list', onSelect });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
    expect(value.createSession).toHaveBeenCalledOnce();
  });

  it('the dropdown calls onSelect after a pick too', async () => {
    const value = chat();
    const onSelect = vi.fn();
    mount(value, { onSelect });
    fireEvent.click(screen.getByRole('button', { name: /Middle chat/ }));
    fireEvent.click(screen.getByText('Old chat').closest('[role="option"]')!);
    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
  });

  it('arrow keys move between new chat and the chats', () => {
    mount(chat(), { variant: 'list' });
    const newChat = screen.getByRole('button', { name: 'New chat' });
    newChat.focus();
    fireEvent.keyDown(newChat, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows()[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(rows()[2]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(newChat);
    fireEvent.keyDown(newChat, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows()[2]);
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(newChat);
  });

  it('rename and delete work in the list', async () => {
    const value = chat();
    mount(value, { variant: 'list' });
    const row = rows()[2]!.closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Rename conversation' }));
    const input = screen.getByPlaceholderText('Conversation title');
    fireEvent.change(input, { target: { value: 'Planning' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(value.renameSession).toHaveBeenCalledWith('old', 'Planning'));
    fireEvent.click(within(rows()[2]!.closest('li')!).getByRole('button', { name: 'Delete conversation' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(value.removeSession).toHaveBeenCalledWith('old'));
  });

  it('Escape in the rename input does not leak', () => {
    const parent = vi.fn();
    render(<ChatContext.Provider value={chat()}><div onKeyDown={e => parent(e.key)}>
      <SessionSwitcher variant="list" />
    </div></ChatContext.Provider>);
    fireEvent.click(within(rows()[0]!.closest('li')!).getByRole('button', { name: 'Rename conversation' }));
    const input = screen.getByPlaceholderText('Conversation title');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(parent).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Conversation title')).toBeNull();
  });

  it('locked while a reply streams', () => {
    mount(chat({ isSessionChangeBlocked: true }), { variant: 'list' });
    const buttons = within(screen.getByRole('navigation')).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('German texts', () => {
    mount(chat({ locale: { ...DEFAULT_LOCALE, ...deChatLocale } }), { variant: 'list' });
    const nav = screen.getByRole('navigation', { name: 'Chats' });
    expect(within(nav).getByRole('list', { name: 'Letzte Chats' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Neuer Chat' })).toBeTruthy();
  });

  it('without sessions the list renders nothing', () => {
    const { container } = mount(chat({ sessionsSupported: false }), { variant: 'list' });
    expect(container.innerHTML).toBe('');
  });

  it('shows the empty text without chats', () => {
    mount(chat({ sessions: [] }), { variant: 'list' });
    expect(document.querySelector('li[data-element="empty"]')!.textContent).toBe('No conversations yet');
  });
});
