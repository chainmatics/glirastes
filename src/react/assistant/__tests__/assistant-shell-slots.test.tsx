// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
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
type ShellProps = Partial<React.ComponentProps<typeof AssistantShell>>;
function tree(props: ShellProps, value: ChatContextValue, composer: ReactNode) {
  return <ChatContext.Provider value={value}><AssistantLayoutProvider storageKey={null}>
    <Probe />
    <div><main data-assistant-main><AssistantToggle /></main>
      <AssistantShell modes={ALL} {...props}>{composer}</AssistantShell></div>
  </AssistantLayoutProvider></ChatContext.Provider>;
}
async function mount(props: ShellProps = {}, value: ChatContextValue = chat(), composer: ReactNode = <textarea aria-label="Draft" />) {
  const view = render(tree(props, value, composer));
  await frame();
  fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
  await frame();
  return { rerender: async (next: ShellProps) => { view.rerender(tree(next, value, composer)); await frame(); } };
}
const column = () => document.querySelector<HTMLElement>('[data-element="history"]');

/** Keys on the header and each of its buttons, where the built-in trigger sits, that something prevented. */
function capturedHeaderKeys(): string[] {
  const captured: string[] = [];
  const header = document.querySelector('header')!;
  for (const target of [header, ...Array.from(header.querySelectorAll('button'))]) {
    for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => { target.dispatchEvent(event); });
      if (event.defaultPrevented) captured.push(`${key} on ${target.getAttribute('aria-label') ?? target.tagName}`);
      // Close a menu a key opened, so the next key starts from the same state.
      if (document.querySelector('[role="menu"]')) act(() => { fireEvent.pointerDown(document.body); });
    }
  }
  return captured;
}

describe('layout menu slot', () => {
  it('the key check sees the built-in menu capturing keys', async () => {
    await mount();
    expect(capturedHeaderKeys()).toContain('ArrowDown on Layout: Sidebar');
  });

  it('showModeMenu={false} drops the menu and its key handling, full screen stays a mode', async () => {
    await mount({ showModeMenu: false });
    expect(document.querySelector('[data-element="mode-picker"]')).toBeNull();
    expect(document.querySelector('[data-action="mode"]')).toBeNull();
    // Detach and dock do not come back: the app controls the layout itself.
    expect(screen.queryByRole('button', { name: 'Detach as window' })).toBeNull();
    expect(capturedHeaderKeys()).toEqual([]);
    await go('fullscreen');
    expect(capturedHeaderKeys()).toEqual([]);
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

describe('render function slots are components', () => {
  function Counter({ name, onMount }: { name: string; onMount?: () => void }) {
    const [count, setCount] = useState(0);
    useEffect(() => { onMount?.(); }, [onMount]);
    return <button type="button" onClick={() => setCount(n => n + 1)}>{name} {count}</button>;
  }

  it('hooks in historyPane and historyTitle survive mode changes; the column state resets when full screen is left', async () => {
    const pane = () => { const [n, set] = useState(0); return <button type="button" onClick={() => set(n + 1)}>pane {n}</button>; };
    const title = () => { const [n, set] = useState(0); useEffect(() => {}, [n]); return <button type="button" onClick={() => set(n + 1)}>title {n}</button>; };
    await mount({ historyPane: pane, historyTitle: title });
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'pane 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'title 0' }));
    // Hiding the column keeps it rendered, so state stays.
    fireEvent.click(screen.getByRole('button', { name: 'Hide chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(screen.getByRole('button', { name: 'pane 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'title 1' })).toBeTruthy();
    await go('floating');
    expect(screen.queryByRole('button', { name: /^pane/ })).toBeNull();
    await go('fullscreen');
    // Unmounted outside full screen: a fresh column.
    expect(screen.getByRole('button', { name: 'pane 0' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'title 0' })).toBeTruthy();
  });

  it('render functions run only while their part is shown', async () => {
    const historyTitle = vi.fn(() => <span>own title</span>);
    const historyPane = vi.fn(() => <span>own pane</span>);
    await mount({ historyTitle, historyPane });
    expect(historyTitle).not.toHaveBeenCalled();
    expect(historyPane).not.toHaveBeenCalled();
    await go('fullscreen');
    expect(historyTitle).toHaveBeenCalled();
    expect(historyPane).toHaveBeenCalled();
  });

  it('a hook in renderModeMenu survives runtime changes of modes and showModeMenu', async () => {
    const mounted = vi.fn();
    const renderModeMenu = (props: AssistantModeMenuRenderProps) => <Counter name={`menu ${props.current}`} onMount={mounted} />;
    const hooked = (props: AssistantModeMenuRenderProps) => { const [n, set] = useState(0); return <button type="button" onClick={() => set(n + 1)}>{props.current} {n}</button>; };
    const view = await mount({ renderModeMenu: hooked });
    fireEvent.click(screen.getByRole('button', { name: 'sidebar 0' }));
    await go('fullscreen');
    expect(screen.getByRole('button', { name: 'fullscreen 1' })).toBeTruthy();
    await view.rerender({ renderModeMenu: hooked, showModeMenu: false });
    expect(screen.queryByRole('button', { name: /^fullscreen \d/ })).toBeNull();
    await view.rerender({ renderModeMenu: hooked });
    expect(screen.getByRole('button', { name: 'fullscreen 0' })).toBeTruthy();
    await view.rerender({ renderModeMenu: hooked, modes: ['sidebar', 'floating'] });
    expect(screen.queryByRole('button', { name: /^(sidebar|floating|fullscreen) \d/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Detach as window' })).toBeTruthy();
    await view.rerender({ renderModeMenu });
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it('showModeMenu turned off at runtime removes an open built-in menu and its keys', async () => {
    const view = await mount();
    fireEvent.click(screen.getByRole('button', { name: /^Layout: / }));
    expect(screen.getByRole('menu')).toBeTruthy();
    await view.rerender({ showModeMenu: false });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.querySelector('[data-element="mode-picker"]')).toBeNull();
    await view.rerender({});
    expect(screen.getByRole('button', { name: /^Layout: / }).getAttribute('aria-expanded')).toBe('false');
  });

  it('switching between panes with hooks inside one stable function keeps their state apart', async () => {
    function PaneA() { const [n, set] = useState(0); return <button type="button" onClick={() => set(n + 1)}>A {n}</button>; }
    function PaneB() { const [n] = useState(100); useEffect(() => {}, []); return <span>B {n}</span>; }
    let route: 'a' | 'b' = 'a';
    const historyPane = () => route === 'a' ? <PaneA /> : <PaneB />;
    const view = await mount({ historyPane });
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'A 0' }));
    route = 'b';
    await view.rerender({ historyPane });
    expect(screen.getByText('B 100')).toBeTruthy();
    route = 'a';
    await view.rerender({ historyPane });
    expect(screen.getByRole('button', { name: 'A 0' })).toBeTruthy();
  });

  it('close, modes and entries keep their identity between renders', async () => {
    const closes = new Set<unknown>();
    const modeLists = new Set<unknown>();
    const entryMaps = new Set<unknown>();
    await mount({
      historyPane: ({ close }) => { closes.add(close); return <p>pane</p>; },
      renderModeMenu: ({ modes, entries }) => { modeLists.add(modes); entryMaps.add(entries); return <span>menu</span>; },
    });
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Hide chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(closes.size).toBe(1);
    expect(modeLists.size).toBe(1);
    expect(entryMaps.size).toBe(1);
  });
});

describe('focus after close()', () => {
  const composers: Array<[string, ReactNode, string]> = [
    ['textarea', <textarea key="c" aria-label="Draft" />, 'Draft'],
    ['marked input', <input key="c" aria-label="Draft" data-glirastes-composer />, 'Draft'],
    ['own composer', <><input aria-label="Search filter" /><div key="c" role="textbox" tabIndex={0} aria-label="Draft" data-glirastes-composer /></>, 'Draft'],
  ];
  for (const narrowView of [true, false]) {
    for (const [kind, composer, name] of composers) {
      it(`${narrowView ? 'drawer' : 'wide column'} with a ${kind} composer`, async () => {
        narrow = narrowView;
        await mount({ historyPane: ({ close }) => <button type="button" onClick={() => close()}>Pick project</button> }, chat(), composer);
        await go('fullscreen');
        if (narrowView) fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
        await frame();
        screen.getByRole('button', { name: 'Pick project' }).focus();
        fireEvent.click(screen.getByRole('button', { name: 'Pick project' }));
        await frame();
        expect(document.activeElement).toBe(screen.getByRole('textbox', { name }));
      });
    }
  }

  it.each([true, false])('without a composer focus goes to the chats toggle, never into the pane (narrow %s)', async narrowView => {
    narrow = narrowView;
    await mount({ historyPane: ({ close }) => <button type="button" onClick={() => close()}>Pick project</button> }, chat(), <p>No composer</p>);
    await go('fullscreen');
    if (narrowView) fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    await frame();
    screen.getByRole('button', { name: 'Pick project' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Pick project' }));
    await frame();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: narrowView ? 'Show chats' : 'Hide chats' }));
  });

  it('a pick in the built-in list with a marked input composer focuses it', async () => {
    narrow = true;
    await mount({}, chat(), <input aria-label="Draft" data-glirastes-composer />);
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Customers' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Draft' })));
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
