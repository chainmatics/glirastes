// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLayoutProvider, useAssistantLayout, type AssistantLayoutMode } from '../assistant-layout.js';
import { AssistantShell, AssistantToggle } from '../assistant-shell.js';
import { SessionSwitcher } from '../../components/session-switcher.js';
import { ChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';

// Pins the DOM an app gets when it sets none of the shell's slots. The snapshot
// was recorded before the slots existed; it must not change while they are added.

let narrow = false;
beforeEach(() => {
  narrow = false;
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
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const frame = () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
function chat(overrides: Partial<ChatContextValue> = {}): ChatContextValue {
  return {
    sessionsSupported: true,
    // Without timestamps, so the snapshot does not depend on the time zone.
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
    ...overrides,
  } as unknown as ChatContextValue;
}
function Go() {
  const ui = useAssistantLayout();
  return <>{(['sidebar', 'floating', 'fullscreen'] as const).map(mode => <button key={mode} onClick={() => ui.setMode(mode)}>to {mode}</button>)}</>;
}
async function mount(value: ChatContextValue, modes?: AssistantLayoutMode[]) {
  render(<ChatContext.Provider value={value}><AssistantLayoutProvider storageKey={null}>
    <Go />
    <div><main data-assistant-main><AssistantToggle /></main>
      <AssistantShell modes={modes}><textarea aria-label="Draft" /></AssistantShell></div>
  </AssistantLayoutProvider></ChatContext.Provider>);
  await frame();
}
const go = (mode: AssistantLayoutMode) => act(() => { fireEvent.click(screen.getByText(`to ${mode}`, { selector: 'button' })); });
/** useId values depend on what rendered before; numbered by first appearance they stay comparable. */
function html() {
  const ids = new Map<string, string>();
  return document.body.innerHTML.replace(/_r_[0-9a-z]+_|«r[0-9a-z]+»|:r[0-9a-z]+:/g, id => {
    if (!ids.has(id)) ids.set(id, `_id${ids.size + 1}_`);
    return ids.get(id)!;
  });
}

describe('default DOM without the new slots', () => {
  it('sidebar with the header session switcher open', async () => {
    await mount(chat());
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    await frame();
    expect(html()).toMatchSnapshot('sidebar');
    fireEvent.click(document.querySelector('[data-element="trigger"]')!);
    expect(html()).toMatchSnapshot('sidebar dropdown open');
  });

  it('collapsed rail and floating window', async () => {
    await mount(chat());
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    await frame();
    expect(html()).toMatchSnapshot('rail');
    await go('floating');
    await frame();
    expect(html()).toMatchSnapshot('floating');
  });

  it('full screen with chat column and layout menu', async () => {
    await mount(chat(), ['sidebar', 'floating', 'fullscreen']);
    await go('fullscreen');
    await frame();
    expect(html()).toMatchSnapshot('fullscreen');
    fireEvent.keyDown(screen.getByRole('button', { name: /^Layout: / }), { key: 'ArrowDown' });
    await frame();
    expect(html()).toMatchSnapshot('fullscreen layout menu open');
  });

  it('full screen drawer below 900 px', async () => {
    narrow = true;
    await mount(chat(), ['sidebar', 'floating', 'fullscreen']);
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Show chats' }));
    await frame();
    expect(html()).toMatchSnapshot('drawer open');
  });

  it('a chat without several conversations', async () => {
    await mount(chat({ sessionsSupported: false }), ['sidebar', 'floating', 'fullscreen']);
    await go('fullscreen');
    await frame();
    expect(html()).toMatchSnapshot('fullscreen without sessions');
  });

  it('full screen with the column hidden in the wide view', async () => {
    await mount(chat(), ['sidebar', 'floating', 'fullscreen']);
    await go('fullscreen');
    fireEvent.click(screen.getByRole('button', { name: 'Hide chats' }));
    await frame();
    expect(html()).toMatchSnapshot('fullscreen column hidden');
  });

  it('full screen with the drawer closed below 900 px', async () => {
    narrow = true;
    await mount(chat(), ['sidebar', 'floating', 'fullscreen']);
    await go('fullscreen');
    await frame();
    expect(html()).toMatchSnapshot('drawer closed');
  });

  it('locked while a reply streams', async () => {
    await mount(chat({ isLoading: true, isSessionChangeBlocked: true }), ['sidebar', 'floating', 'fullscreen']);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    await frame();
    expect(html()).toMatchSnapshot('sidebar locked');
    await go('fullscreen');
    await frame();
    expect(html()).toMatchSnapshot('fullscreen locked');
  });

  it('rename and delete confirmation in the chat column', async () => {
    await mount(chat(), ['sidebar', 'floating', 'fullscreen']);
    await go('fullscreen');
    await frame();
    fireEvent.click(screen.getAllByRole('button', { name: 'Rename conversation' })[0]!);
    expect(html()).toMatchSnapshot('fullscreen renaming');
    fireEvent.keyDown(document.querySelector('[data-element="row-title-input"]')!, { key: 'Escape' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete conversation' })[0]!);
    expect(html()).toMatchSnapshot('fullscreen delete confirmation');
  });

  it('full screen as the only layout', async () => {
    await mount(chat(), ['fullscreen']);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    await frame();
    await frame();
    expect(html()).toMatchSnapshot('fullscreen only');
  });

  it('floating window with the layout menu', async () => {
    await mount(chat(), ['sidebar', 'floating', 'fullscreen']);
    await go('floating');
    await frame();
    expect(html()).toMatchSnapshot('floating with layout menu');
  });

  it('standalone session switchers', () => {
    render(<ChatContext.Provider value={chat()}><SessionSwitcher variant="list" /><SessionSwitcher /></ChatContext.Provider>);
    fireEvent.click(document.querySelector('[data-element="trigger"]')!);
    expect(html()).toMatchSnapshot('standalone list and dropdown');
  });
});
