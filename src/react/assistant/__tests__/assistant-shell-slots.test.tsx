// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLayoutProvider, useAssistantLayout, type AssistantLayoutMode } from '../assistant-layout.js';
import {
  AssistantShell,
  AssistantToggle,
  type AssistantHistoryPaneProps,
  type AssistantModeMenuRenderProps,
} from '../assistant-shell.js';
import { ChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';

let narrow = false;
let listeners = new Set<() => void>();
beforeEach(() => {
  narrow = false;
  listeners = new Set();
  const store = new Map<string, string>();
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
  </div>;
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!);
const go = (mode: AssistantLayoutMode) => act(() => { fireEvent.click(screen.getByText(`to ${mode}`, { selector: 'button' })); });
async function mount(props: Partial<React.ComponentProps<typeof AssistantShell>> = {}, value: ChatContextValue = chat()) {
  render(<ChatContext.Provider value={value}><AssistantLayoutProvider storageKey={null}>
    <Probe />
    <div><main data-assistant-main><AssistantToggle /></main>
      <AssistantShell modes={ALL} {...props}><textarea aria-label="Draft" /></AssistantShell></div>
  </AssistantLayoutProvider></ChatContext.Provider>);
  await frame();
  fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
  await frame();
}
const column = () => document.querySelector<HTMLElement>('[data-element="history"]');

describe('layout menu slot', () => {
  it('showModeMenu={false} drops the menu and its key handling, full screen stays a mode', async () => {
    await mount({ showModeMenu: false });
    expect(document.querySelector('[data-element="mode-picker"]')).toBeNull();
    expect(document.querySelector('[data-action="mode"]')).toBeNull();
    // Detach and dock do not come back: the app controls the layout itself.
    expect(screen.queryByRole('button', { name: 'Detach as window' })).toBeNull();
    const header = document.querySelector('header')!;
    for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => { header.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(screen.queryByRole('menu')).toBeNull();
    await go('fullscreen');
    expect(state()).toMatchObject({ mode: 'fullscreen' });
    // The layout shortcut still leaves full screen.
    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', altKey: true, shiftKey: true });
    expect(state()).toMatchObject({ mode: 'sidebar' });
  });

  it('renderModeMenu replaces the menu and gets what the built-in one uses', async () => {
    const seen: AssistantModeMenuRenderProps[] = [];
    const renderModeMenu = (props: AssistantModeMenuRenderProps) => {
      seen.push(props);
      return <select aria-label={props.label} title={props.title} value={props.current}
        onChange={event => props.setMode(event.target.value as AssistantLayoutMode)}>
        {props.modes.map(mode => <option key={mode} value={mode}>{props.entries[mode].label}</option>)}
      </select>;
    };
    await mount({ renderModeMenu, labels: { layout: 'View' } });
    expect(document.querySelector('[data-element="mode-picker"]')).toBeNull();
    const select = screen.getByRole('combobox', { name: 'View' }) as HTMLSelectElement;
    expect(select.closest('header')).not.toBeNull();
    expect(select.title).toMatch(/^View \(/);
    const last = seen.at(-1)!;
    expect(last.modes).toEqual(ALL);
    expect(last.current).toBe('sidebar');
    expect(last.entries.fullscreen.label).toBe('Full screen');
    expect(last.entries.sidebar.icon).toBeTruthy();
    fireEvent.change(select, { target: { value: 'fullscreen' } });
    expect(state()).toMatchObject({ mode: 'fullscreen' });
    expect(seen.at(-1)!.current).toBe('fullscreen');
  });

  it('showModeMenu={false} wins over renderModeMenu', async () => {
    const renderModeMenu = vi.fn(() => <span>own menu</span>);
    await mount({ showModeMenu: false, renderModeMenu });
    expect(screen.queryByText('own menu')).toBeNull();
    expect(renderModeMenu).not.toHaveBeenCalled();
  });

  it('without full screen in modes the detach and dock buttons stay and renderModeMenu is not used', async () => {
    const renderModeMenu = vi.fn(() => <span>own menu</span>);
    await mount({ modes: ['sidebar', 'floating'], renderModeMenu });
    expect(renderModeMenu).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Detach as window' })).toBeTruthy();
  });
});

describe('history pane as a render function', () => {
  it('gets open, drawer and close in the wide column', async () => {
    const seen: AssistantHistoryPaneProps[] = [];
    await mount({ historyPane: pane => { seen.push(pane); return <p>Own pane</p>; } });
    await go('fullscreen');
    expect(within(column()!).getByText('Own pane')).toBeTruthy();
    expect(seen.at(-1)).toMatchObject({ open: true, drawer: false });
    fireEvent.click(screen.getByRole('button', { name: 'Hide chats' }));
    expect(seen.at(-1)).toMatchObject({ open: false, drawer: false });
  });

  it('close() closes the drawer and focuses the composer', async () => {
    narrow = true;
    await mount({ historyPane: ({ close, open, drawer }) =>
      <button type="button" data-open={open} data-drawer-mode={drawer} onClick={() => close()}>Pick project</button> });
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    await frame();
    const pick = screen.getByRole('button', { name: 'Pick project' });
    expect(pick.dataset.open).toBe('true');
    expect(pick.dataset.drawerMode).toBe('true');
    expect(document.activeElement).toBe(pick);
    fireEvent.click(pick);
    expect(column()!.hidden).toBe(true);
    expect(document.querySelector('[data-element="frame"]')!.hasAttribute('inert')).toBe(false);
    await frame();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Draft' }));
    expect(state()).toMatchObject({ mode: 'fullscreen' });
  });

  it("close('toggle') gives focus back to the chats toggle", async () => {
    narrow = true;
    await mount({ historyPane: ({ close }) => <button type="button" onClick={() => close('toggle')}>Done</button> });
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await frame();
    expect(column()!.hidden).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show chats' }));
  });

  it('close() in the wide column keeps the column and focuses the composer, like a pick', async () => {
    await mount({ historyPane: ({ close }) => <button type="button" onClick={() => close()}>Pick project</button> });
    await go('fullscreen');
    screen.getByRole('button', { name: 'Pick project' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Pick project' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Draft' })));
    expect(column()!.hidden).toBe(false);
  });

  it('a render function shows a column without several chats and keeps the plain header title', async () => {
    await mount({ historyPane: () => <p>Own pane</p> }, chat({ sessionsSupported: false }));
    await go('fullscreen');
    expect(within(column()!).getByText('Own pane')).toBeTruthy();
    expect(document.querySelector('header [data-element="title"]')!.textContent).toBe('AI assistant');
  });
});

describe('history title slot', () => {
  it('historyTitle replaces the title element', async () => {
    await mount({ historyTitle: <h2 data-testid="own-title">Projects</h2> });
    await go('fullscreen');
    expect(column()!.querySelector('[data-element="history-title"]')).toBeNull();
    expect(within(column()!).getByTestId('own-title').textContent).toBe('Projects');
    expect(column()!.firstElementChild).toBe(screen.getByTestId('own-title'));
  });

  it('historyTitle={false} removes it, null keeps the default', async () => {
    await mount({ historyTitle: false });
    await go('fullscreen');
    expect(column()!.querySelector('[data-element="history-title"]')).toBeNull();
    expect(within(column()!).getByRole('navigation', { name: 'Chats' })).toBeTruthy();
    cleanup();
    await mount({ historyTitle: null });
    await go('fullscreen');
    expect(column()!.querySelector('[data-element="history-title"]')!.textContent).toBe('Chats');
  });

  it('historyTitle as a function can close the drawer', async () => {
    narrow = true;
    await mount({ historyTitle: ({ close, drawer }) => <div>Chats {drawer && <button type="button" onClick={() => close('toggle')}>Close chats</button>}</div> });
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Close chats' }));
    await frame();
    expect(column()!.hidden).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show chats' }));
  });

  it('classNames.history goes on the column', async () => {
    await mount({ classNames: { history: 'my-column' } });
    await go('fullscreen');
    expect(column()!.className).toBe('my-column');
  });
});

describe('session icons through the shell icons', () => {
  it('the header switcher and the chat column use the shell icons', async () => {
    const icons = {
      newChat: <svg data-testid="icon-new" />,
      rename: <svg data-testid="icon-rename" />,
      delete: <svg data-testid="icon-delete" />,
    };
    await mount({ icons });
    fireEvent.click(document.querySelector('header [data-element="trigger"]')!);
    const popover = document.querySelector<HTMLElement>('header [data-element="popover"]')!;
    expect(within(popover).getByTestId('icon-new').closest('[data-element="plus"]')).not.toBeNull();
    expect(within(popover).getAllByTestId('icon-rename')).toHaveLength(2);
    expect(within(popover).getAllByTestId('icon-delete')).toHaveLength(2);
    await go('fullscreen');
    expect(within(column()!).getByTestId('icon-new')).toBeTruthy();
    expect(within(column()!).getAllByTestId('icon-rename')).toHaveLength(2);
    expect(within(column()!).getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(within(column()!).getAllByRole('button', { name: 'Rename conversation' })).toHaveLength(2);
  });
});
