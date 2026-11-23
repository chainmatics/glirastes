// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLayoutProvider, useAssistantLayout, type AssistantLayoutMode } from '../assistant-layout.js';
import { AssistantShell } from '../assistant-shell.js';
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const frame = () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
function chat(): ChatContextValue {
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
    clear: vi.fn(),
    locale: DEFAULT_LOCALE,
  } as unknown as ChatContextValue;
}
function Go() {
  const ui = useAssistantLayout();
  return <>
    {(['sidebar', 'floating', 'fullscreen'] as const).map(mode => <button key={mode} type="button" onClick={() => ui.setMode(mode)}>to {mode}</button>)}
  </>;
}
type ShellProps = Partial<React.ComponentProps<typeof AssistantShell>>;
const tree = (props: ShellProps) => <ChatContext.Provider value={chat()}><AssistantLayoutProvider storageKey={null}>
  <Go />
  <div><main data-assistant-main>Page</main>
    <AssistantShell modes={['sidebar', 'floating', 'fullscreen']} {...props}><textarea aria-label="Draft" /></AssistantShell></div>
</AssistantLayoutProvider></ChatContext.Provider>;
async function mount(props: ShellProps = {}) {
  const view = render(tree(props));
  await frame();
  return view;
}
const go = async (mode: AssistantLayoutMode) => { act(() => { fireEvent.click(screen.getByText(`to ${mode}`, { selector: 'button' })); }); await frame(); };
const breakpoint = async (isNarrow: boolean) => { narrow = isNarrow; act(() => { listeners.forEach(listener => listener()); }); await frame(); };
const column = () => document.querySelector<HTMLElement>('[data-element="history"]')!;

describe('drawer state attributes (stable)', () => {
  it('wide column, hidden column, closed and open drawer', async () => {
    await mount();
    await go('fullscreen');
    const toggle = () => document.querySelector<HTMLElement>('[data-action="history"]')!;
    const backdrop = () => document.querySelector('[data-element="history-backdrop"]');
    const state = () => ({
      drawer: column().getAttribute('data-drawer'),
      hidden: column().hasAttribute('hidden'),
      inert: column().hasAttribute('inert'),
      role: column().getAttribute('role'),
      modal: column().getAttribute('aria-modal'),
      expanded: toggle().getAttribute('aria-expanded'),
      backdrop: backdrop() !== null,
      frameInert: document.querySelector('[data-element="frame"]')!.hasAttribute('inert'),
    });
    expect(state()).toEqual({ drawer: null, hidden: false, inert: false, role: null, modal: null, expanded: 'true', backdrop: false, frameInert: false });
    fireEvent.click(toggle());
    expect(state()).toEqual({ drawer: null, hidden: true, inert: true, role: null, modal: null, expanded: 'false', backdrop: false, frameInert: false });
    await breakpoint(true);
    expect(state()).toEqual({ drawer: 'true', hidden: true, inert: true, role: null, modal: null, expanded: 'false', backdrop: false, frameInert: false });
    fireEvent.click(toggle());
    expect(state()).toEqual({ drawer: 'true', hidden: false, inert: false, role: 'dialog', modal: 'true', expanded: 'true', backdrop: true, frameInert: true });
  });

  it('classNames.historyBackdrop goes on the backdrop; without it the backdrop has no class', async () => {
    narrow = true;
    await mount({ classNames: { historyBackdrop: 'my-backdrop' } });
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(document.querySelector('[data-element="history-backdrop"]')!.className).toBe('my-backdrop');
    cleanup();
    await mount();
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    expect(document.querySelector('[data-element="history-backdrop"]')!.hasAttribute('class')).toBe(false);
  });
});
