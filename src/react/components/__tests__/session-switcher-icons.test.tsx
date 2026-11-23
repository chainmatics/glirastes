// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_SWITCHER_ICONS, SessionSwitcher, useSessionLock } from '../session-switcher.js';
import { ChatWindowVisibilityContext } from '../chat-window-visibility.js';
import { ChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';
import * as reactEntry from '../../index.js';

afterEach(() => { cleanup(); });

function chat(overrides: Partial<ChatContextValue> = {}): ChatContextValue {
  return {
    sessionsSupported: true,
    sessions: [{ id: 'a', title: 'Open orders' }, { id: 'b', title: 'Customers' }],
    activeSessionId: 'a',
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
const mount = (props: React.ComponentProps<typeof SessionSwitcher>, value = chat()) =>
  render(<ChatContext.Provider value={value}><SessionSwitcher {...props} /></ChatContext.Provider>);

describe('SessionSwitcher icons', () => {
  it.each(['list', 'dropdown'] as const)('own icons replace the defaults (%s)', variant => {
    mount({ variant, icons: { newChat: <svg data-testid="new" />, rename: <svg data-testid="rename" />, delete: <svg data-testid="delete" /> } });
    if (variant === 'dropdown') fireEvent.click(document.querySelector('[data-element="trigger"]')!);
    const plus = document.querySelector('[data-element="plus"]')!;
    expect(plus.getAttribute('aria-hidden')).toBe('true');
    expect(within(plus as HTMLElement).getByTestId('new')).toBeTruthy();
    expect(plus.textContent).toBe('');
    expect(screen.getByRole('button', { name: 'New chat' })).toBeTruthy();
    const edits = Array.from(document.querySelectorAll('[data-element="row-edit"]'));
    expect(edits).toHaveLength(2);
    expect(edits.every(button => button.querySelector('[data-testid="rename"]') && button.getAttribute('aria-label') === 'Rename conversation')).toBe(true);
    const deletes = Array.from(document.querySelectorAll('[data-element="row-delete"]'));
    expect(deletes.every(button => button.querySelector('[data-testid="delete"]') && button.getAttribute('aria-label') === 'Delete conversation')).toBe(true);
  });

  it('a partial set keeps the other defaults', () => {
    mount({ variant: 'list', icons: { rename: <svg data-testid="rename" /> } });
    expect(document.querySelector('[data-element="plus"]')!.textContent).toBe('+');
    expect(document.querySelector('[data-element="row-delete"] polyline')).not.toBeNull();
  });

  it.each([false, null] as const)('rename and delete %s keep the default icons, never an empty button', value => {
    mount({ variant: 'list', icons: { rename: value, delete: value } });
    expect(document.querySelector('[data-element="row-edit"] svg')).not.toBeNull();
    expect(document.querySelector('[data-element="row-delete"] svg')).not.toBeNull();
  });

  it('newChat={false} drops the plus, the button keeps its name', () => {
    mount({ variant: 'list', icons: { newChat: false } });
    expect(document.querySelector('[data-element="plus"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'New chat' }).textContent).toBe('New chat');
  });

  it('the defaults are the plus character and the shipped SVGs', () => {
    expect(DEFAULT_SESSION_SWITCHER_ICONS.newChat).toBe('+');
    expect(DEFAULT_SESSION_SWITCHER_ICONS.rename).toBeTruthy();
    expect(DEFAULT_SESSION_SWITCHER_ICONS.delete).toBeTruthy();
    expect(reactEntry.DEFAULT_SESSION_SWITCHER_ICONS).toBe(DEFAULT_SESSION_SWITCHER_ICONS);
    expect(reactEntry.useSessionLock).toBe(useSessionLock);
  });
});

describe('useSessionLock', () => {
  const wrap = (value: ChatContextValue, visible?: boolean) => ({ children }: { children: ReactNode }) =>
    <ChatContext.Provider value={value}>
      {visible === undefined ? children : <ChatWindowVisibilityContext.Provider value={visible}>{children}</ChatWindowVisibilityContext.Provider>}
    </ChatContext.Provider>;

  it('is open while nothing runs and the panel is visible', () => {
    const { result } = renderHook(() => useSessionLock(), { wrapper: wrap(chat()) });
    expect(result.current).toEqual({ visible: true, sessionChangeBlocked: false, locked: false });
  });

  it('follows isSessionChangeBlocked, not isLoading, when the context has it', () => {
    // isLoading also covers a session that is not ready; the lock does not.
    const { result } = renderHook(() => useSessionLock(), { wrapper: wrap(chat({ isLoading: true, isSessionChangeBlocked: false })) });
    expect(result.current).toEqual({ visible: true, sessionChangeBlocked: false, locked: false });
    const blocked = renderHook(() => useSessionLock(), { wrapper: wrap(chat({ isSessionChangeBlocked: true })) });
    expect(blocked.result.current).toEqual({ visible: true, sessionChangeBlocked: true, locked: true });
  });

  it('falls back to isLoading for a context without isSessionChangeBlocked', () => {
    const { result } = renderHook(() => useSessionLock(), { wrapper: wrap(chat({ isLoading: true, isSessionChangeBlocked: undefined })) });
    expect(result.current).toEqual({ visible: true, sessionChangeBlocked: true, locked: true });
  });

  it('a hidden chat window locks', () => {
    const { result } = renderHook(() => useSessionLock(), { wrapper: wrap(chat(), false) });
    expect(result.current).toEqual({ visible: false, sessionChangeBlocked: false, locked: true });
  });

  it('the built-in switcher disables exactly when the lock says so', () => {
    mount({ variant: 'list' }, chat({ isLoading: true, isSessionChangeBlocked: false }));
    expect((screen.getByRole('button', { name: 'Customers' }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    mount({ variant: 'list' }, chat({ isSessionChangeBlocked: true }));
    expect((screen.getByRole('button', { name: 'Customers' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
