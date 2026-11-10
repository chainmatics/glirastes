// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantLayoutProvider,
  DEFAULT_ASSISTANT_LAYOUT_KEY,
  parseAssistantLayout,
  defaultAssistantLayout,
  useAssistantLayout,
} from '../assistant-layout.js';
import { AssistantShell, AssistantToggle, DE_ASSISTANT_SHELL_LABELS } from '../assistant-shell.js';

// Node ships its own localStorage stub, so the tests bring a working one.
let store = new Map<string, string>();
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  });
  vi.stubGlobal('PointerEvent', MouseEvent);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const frame = () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
function State() {
  const { open, mode, defaultMode, collapsed, width } = useAssistantLayout();
  return <output data-testid="state">{JSON.stringify({ open, mode, defaultMode, collapsed, width })}</output>;
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!);
function mount(props: Partial<React.ComponentProps<typeof AssistantShell>> = {}) {
  return render(<AssistantLayoutProvider>
    <div><main data-assistant-main><AssistantToggle /></main><State />
      <AssistantShell onClear={() => {}} {...props}><textarea aria-label="Draft" /></AssistantShell></div>
  </AssistantLayoutProvider>);
}

describe('assistant layout', () => {
  it.each([null, '{', 'null', '[]', '42', '{"open":"yes","mode":"other","width":"wide"}'])('falls back on invalid storage %s', raw => {
    expect(parseAssistantLayout(raw)).toEqual(defaultAssistantLayout());
  });

  it('reopens a closed detached window as a detached window', async () => {
    mount(); await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(state()).toMatchObject({ open: true, mode: 'sidebar' });
    fireEvent.click(screen.getByRole('button', { name: 'Detach as window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(state()).toMatchObject({ open: true, mode: 'floating' });
    // Docking is remembered the same way.
    fireEvent.click(screen.getByRole('button', { name: 'Dock right' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(state()).toMatchObject({ open: true, mode: 'sidebar' });
  });

  it('remembers the detached layout across reloads', async () => {
    const view = mount(); await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Detach as window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await frame();
    view.unmount();
    mount(); await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(screen.getByRole('complementary')).toHaveProperty('dataset.mode', 'floating');
    expect(JSON.parse(localStorage.getItem(DEFAULT_ASSISTANT_LAYOUT_KEY)!)).toMatchObject({ defaultMode: 'floating' });
  });

  it('sets the opening layout without moving an open assistant', async () => {
    function Controls() {
      const ui = useAssistantLayout();
      return <><button onClick={() => ui.setDefaultMode('floating')}>Default window</button><button onClick={ui.openChat}>Open</button><button onClick={ui.closeChat}>Close</button><State /></>;
    }
    render(<AssistantLayoutProvider storageKey={null}><Controls /></AssistantLayoutProvider>);
    fireEvent.click(screen.getByText('Open'));
    fireEvent.click(screen.getByText('Default window'));
    expect(state()).toMatchObject({ mode: 'sidebar', defaultMode: 'floating' });
    fireEvent.click(screen.getByText('Close'));
    fireEvent.click(screen.getByText('Open'));
    expect(state().mode).toBe('floating');
  });
});

describe('AssistantShell', () => {
  it('collapses to a rail, keeps the draft and exposes the docked width', async () => {
    mount(); await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.getByRole('complementary').style.width).toBe('44px');
    fireEvent.click(screen.getByRole('button', { name: 'Expand AI assistant' }));
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveProperty('value', 'My draft');
    expect(document.documentElement.style.getPropertyValue('--assistant-right-inset')).toBe('420px');
  });

  it('opens the detached window bottom right with eight resize handles', async () => {
    mount(); await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Detach as window' }));
    const shell = screen.getByRole('complementary');
    expect([shell.style.left, shell.style.top, shell.style.width]).toEqual(['588px', '96px', '420px']);
    expect(shell.querySelectorAll('[data-resize-edge]')).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'AI assistant' })).toBeTruthy();
  });

  it('takes the app icons, labels, classes and button component', async () => {
    mount({
      labels: DE_ASSISTANT_SHELL_LABELS,
      icons: { detach: <i data-testid="detach-icon" /> },
      classNames: { root: 'my-shell', header: 'my-header' },
      headerStart: <button>Menu</button>,
      renderButton: ({ action, label, title, onClick, children }) =>
        <button className={`app-btn app-${action}`} aria-label={label} title={title} onClick={onClick}>{children}</button>,
    });
    await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    const shell = screen.getByRole('complementary', { name: 'KI-Assistent' });
    expect(shell.className).toBe('my-shell');
    expect(shell.querySelector('header')!.className).toBe('my-header');
    expect(shell.querySelector('header')!.contains(screen.getByRole('button', { name: 'Menu' }))).toBe(true);
    const detach = screen.getByRole('button', { name: 'Als Fenster lösen' });
    expect(detach.className).toBe('app-btn app-detach');
    expect(detach.contains(screen.getByTestId('detach-icon'))).toBe(true);
    expect(detach.title).toBe('Als Fenster lösen (Alt+Shift+D)');
  });

  it('switches layout and collapse with the shared shortcuts', async () => {
    mount(); await frame();
    fireEvent.keyDown(window, { key: 'i', code: 'KeyI', ctrlKey: true });
    expect(state()).toMatchObject({ open: true, mode: 'sidebar' });
    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', altKey: true, shiftKey: true });
    expect(state().mode).toBe('floating');
    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC', altKey: true, shiftKey: true });
    expect(state()).toMatchObject({ mode: 'sidebar', collapsed: true });
  });
});
