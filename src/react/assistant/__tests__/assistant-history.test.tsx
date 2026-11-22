// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLayoutProvider, useAssistantLayout, type AssistantLayoutMode } from '../assistant-layout.js';
import { AssistantShell, DE_ASSISTANT_SHELL_LABELS } from '../assistant-shell.js';
import { ChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';

let store = new Map<string, string>();
let narrow = false;
let listeners = new Set<() => void>();
beforeEach(() => {
  store = new Map();
  narrow = false;
  listeners = new Set();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  });
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('max-width: 899.98px') ? narrow : false; },
    media: query,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ALL: AssistantLayoutMode[] = ['sidebar', 'floating', 'fullscreen'];
const frame = () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
function chat(overrides: Partial<ChatContextValue> = {}): ChatContextValue {
  return {
    sessionsSupported: true,
    sessions: [{ id: 'a', title: 'Open orders', updatedAt: 2 }, { id: 'b', title: 'Customers', updatedAt: 1 }],
    activeSessionId: 'a',
    isSessionsLoading: false,
    isLoading: false,
    isSessionChangeBlocked: false,
    switchSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => null),
    removeSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}),
    clear: vi.fn(),
    locale: DEFAULT_LOCALE,
    ...overrides,
  } as unknown as ChatContextValue;
}
function Probe() {
  const ui = useAssistantLayout();
  return <div>
    <output data-testid="state">{JSON.stringify({ open: ui.open, mode: ui.mode })}</output>
    {(['sidebar', 'floating', 'fullscreen'] as const).map(mode => <button key={mode} onClick={() => ui.setMode(mode)}>to {mode}</button>)}
    <button onClick={ui.openChat}>open it</button>
  </div>;
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!);
const go = (mode: AssistantLayoutMode) => act(() => { fireEvent.click(screen.getByText(`to ${mode}`, { selector: 'button' })); });
async function mount(value: ChatContextValue = chat(), props: Partial<React.ComponentProps<typeof AssistantShell>> = {}) {
  render(<ChatContext.Provider value={value}><AssistantLayoutProvider>
    <Probe />
    <div><main data-assistant-main>Page</main>
      <AssistantShell modes={ALL} {...props}><textarea aria-label="Draft" /></AssistantShell></div>
  </AssistantLayoutProvider></ChatContext.Provider>);
  await frame();
}
const column = () => document.querySelector<HTMLElement>('[data-element="history"]');
const frameEl = () => document.querySelector<HTMLElement>('[data-element="frame"]')!;

describe('history column in full screen', () => {
  it('full screen shows the chat list next to the conversation', async () => {
    await mount();
    await go('fullscreen');
    const col = column()!;
    expect(col.hidden).toBe(false);
    expect(within(col).getByRole('navigation', { name: 'Chats' })).toBeTruthy();
    expect(col.querySelector('[data-element="history-title"]')!.textContent).toBe('Chats');
    expect(col.nextElementSibling).toBe(frameEl());
    const header = frameEl().querySelector('header')!;
    const title = header.querySelector('[data-element="title"]')!;
    expect(title.textContent).toBe('Open orders');
    expect(title.getAttribute('title')).toBe('Open orders');
    expect(header.querySelector('[data-component="session-switcher"]')).toBeNull();
  });

  it('the full-screen dialog contains the chat column and the conversation', async () => {
    await mount();
    await go('fullscreen');
    const dialog = screen.getByRole('dialog', { name: 'AI assistant' });
    expect(dialog.contains(column())).toBe(true);
    expect(dialog.contains(frameEl())).toBe(true);
    expect(column()!.hasAttribute('role')).toBe(false);
  });

  it('the toggle hides and shows the column', async () => {
    await mount();
    await go('fullscreen');
    const toggle = screen.getByRole('button', { name: 'Hide chats' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(column()!.id);
    expect(toggle.closest('header')!.firstElementChild).toBe(toggle);
    fireEvent.click(toggle);
    expect(column()!.hidden).toBe(true);
    expect(column()!.hasAttribute('inert')).toBe(true);
    const show = screen.getByRole('button', { name: 'Show chats' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(show);
    expect(column()!.hidden).toBe(false);
    expect(column()!.hasAttribute('inert')).toBe(false);
  });

  it.each(['sidebar', 'floating'] as const)('no column outside full screen (%s)', async mode => {
    await mount();
    await go(mode);
    fireEvent.click(screen.getByText('open it'));
    expect(column()).toBeNull();
    expect(screen.queryByRole('button', { name: /chats$/ })).toBeNull();
    expect(frameEl().querySelector('header [data-component="session-switcher"]')).not.toBeNull();
  });

  it('no column without several chats', async () => {
    await mount(chat({ sessionsSupported: false }));
    await go('fullscreen');
    expect(column()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hide chats' })).toBeNull();
  });

  it('no column with historyPane={false}', async () => {
    await mount(chat(), { historyPane: false });
    await go('fullscreen');
    expect(column()).toBeNull();
    expect(frameEl().querySelector('header [data-component="session-switcher"]')).not.toBeNull();
  });

  it('an own historyPane replaces the list', async () => {
    await mount(chat({ sessionsSupported: false }), { historyPane: <p>Own pane</p> });
    await go('fullscreen');
    expect(within(column()!).getByText('Own pane')).toBeTruthy();
    expect(within(column()!).queryByRole('navigation')).toBeNull();
  });

  it('narrow screens open the list as a drawer', async () => {
    narrow = true;
    await mount();
    await go('fullscreen');
    expect(column()!.hidden).toBe(true);
    expect(document.querySelector('[data-element="history-backdrop"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(column()!.hidden).toBe(false);
    expect(column()!.style.position).toBe('absolute');
    expect(column()!.getAttribute('role')).toBe('dialog');
    expect(column()!.getAttribute('aria-modal')).toBe('true');
    expect(column()!.getAttribute('aria-label')).toBe('Chats');
    await frame();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New chat' }));
    expect(frameEl().hasAttribute('inert')).toBe(true);
    expect(document.querySelector('[data-element="history-backdrop"]')).not.toBeNull();
    fireEvent.click(document.querySelector('[data-element="history-backdrop"]')!);
    expect(column()!.hidden).toBe(true);
    expect(column()!.hasAttribute('role')).toBe(false);
    expect(frameEl().hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show chats' }));
  });

  it('drawer escape', async () => {
    narrow = true;
    await mount();
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    await frame();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(column()!.hidden).toBe(true);
    expect(state()).toMatchObject({ mode: 'fullscreen' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show chats' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(state()).toMatchObject({ mode: 'sidebar' });
  });

  it('Escape in the delete dialog does not close the drawer', async () => {
    narrow = true;
    await mount();
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    await frame();
    fireEvent.click(within(column()!).getAllByRole('button', { name: 'Delete conversation' })[0]!);
    const dialog = screen.getByRole('alertdialog');
    fireEvent.keyDown(within(dialog).getAllByRole('button')[0]!, { key: 'Escape' });
    expect(column()!.hidden).toBe(false);
    expect(state()).toMatchObject({ mode: 'fullscreen' });
  });

  it('a pick closes the drawer and focuses the composer', async () => {
    narrow = true;
    const value = chat();
    await mount(value);
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Customers' }));
    await waitFor(() => expect(column()!.hidden).toBe(true));
    expect(value.switchSession).toHaveBeenCalledWith('b');
    await frame();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Draft' }));
  });

  it('a pick in the wide column focuses the composer', async () => {
    await mount();
    await go('fullscreen');
    await frame();
    screen.getByRole('button', { name: 'Customers' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Customers' }));
    await frame();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Draft' })));
    expect(column()!.hidden).toBe(false);
  });

  it('growing past 900 px closes the drawer', async () => {
    narrow = true;
    await mount();
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(frameEl().hasAttribute('inert')).toBe(true);
    narrow = false;
    act(() => { listeners.forEach(listener => listener()); });
    expect(frameEl().hasAttribute('inert')).toBe(false);
    expect(document.querySelector('[data-element="history-backdrop"]')).toBeNull();
    expect(column()!.hidden).toBe(false);
    expect(column()!.style.position).not.toBe('absolute');
  });

  it('the conversation is not remounted when the column appears', async () => {
    await mount();
    await go('sidebar');
    fireEvent.click(screen.getByText('open it'));
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    await go('fullscreen');
    expect(column()).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBe(draft);
  });

  it('German labels', async () => {
    await mount(chat(), { labels: DE_ASSISTANT_SHELL_LABELS });
    await go('fullscreen');
    expect(screen.getByRole('button', { name: 'Chats ausblenden' })).toBeTruthy();
  });
});
