// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLayoutProvider, DEFAULT_ASSISTANT_LAYOUT_KEY, useAssistantLayout, type AssistantLayoutMode } from '../assistant-layout.js';
import { AssistantShell, AssistantToggle, DE_ASSISTANT_SHELL_LABELS, type AssistantShellButtonProps } from '../assistant-shell.js';

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

const ALL: AssistantLayoutMode[] = ['sidebar', 'floating', 'fullscreen'];
const frame = () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
function State() {
  const { open, mode, defaultMode } = useAssistantLayout();
  return <output data-testid="state">{JSON.stringify({ open, mode, defaultMode })}</output>;
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!);
async function mount(props: Partial<React.ComponentProps<typeof AssistantShell>> = {}, open = true) {
  const view = render(<AssistantLayoutProvider>
    <div><main data-assistant-main><AssistantToggle /></main><State />
      <AssistantShell onClear={() => {}} {...props}><textarea aria-label="Draft" /></AssistantShell></div>
  </AssistantLayoutProvider>);
  await frame();
  if (open) fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
  return view;
}
const trigger = () => screen.getByRole('button', { name: /^Layout: / });
const entries = () => screen.getAllByRole('menuitemradio').map(item => item.textContent);
const key = (target: Element, k: string) => fireEvent.keyDown(target, { key: k });

describe('layout menu', () => {
  it('default modes keep the detach and dock buttons', async () => {
    await mount();
    expect(document.querySelector('[data-action="mode"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Detach as window' }).hasAttribute('aria-expanded')).toBe(false);
  });

  it('with full screen a layout menu replaces detach and dock', async () => {
    await mount({ modes: ALL });
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('title')).toMatch(/^Layout \(/);
    expect(screen.queryByRole('button', { name: 'Detach as window' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeTruthy();
  });

  it('the menu switches layouts by keyboard', async () => {
    await mount({ modes: ALL });
    key(trigger(), 'ArrowDown');
    const menu = screen.getByRole('menu', { name: 'Layout' });
    expect(trigger().getAttribute('aria-controls')).toBe(menu.id);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Sidebar' }));
    expect(screen.getByRole('menuitemradio', { name: 'Sidebar' }).getAttribute('aria-checked')).toBe('true');
    key(document.activeElement!, 'ArrowDown');
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Full screen' }));
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Sidebar' }));
    key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Full screen' }));
    key(document.activeElement!, 'Enter');
    expect(state()).toMatchObject({ open: true, mode: 'fullscreen' });
    expect(screen.queryByRole('menu')).toBeNull();
    key(trigger(), 'ArrowDown');
    expect(screen.getByRole('menuitemradio', { name: 'Full screen' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Full screen' }));
    key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Sidebar' }));
  });

  it('ArrowUp opens on the last entry', async () => {
    await mount({ modes: ALL });
    key(trigger(), 'ArrowUp');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Full screen' }));
  });

  it('Escape closes the menu and keeps full screen', async () => {
    await mount({ modes: ALL });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Full screen' }));
    expect(state()).toMatchObject({ mode: 'fullscreen' });
    key(trigger(), 'Enter');
    key(document.activeElement!, 'Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(state()).toMatchObject({ mode: 'fullscreen' });
    key(trigger(), 'Escape');
    expect(state()).toMatchObject({ mode: 'sidebar' });
  });

  it('outside click and Tab close the menu', async () => {
    await mount({ modes: ALL });
    fireEvent.click(trigger());
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    key(trigger(), 'ArrowDown');
    expect(document.activeElement!.getAttribute('role')).toBe('menuitemradio');
    key(document.activeElement!, 'Tab');
    expect(screen.queryByRole('menu')).toBeNull();
    // Focus is back on the trigger before the browser's Tab moves on from it.
    expect(document.activeElement).toBe(trigger());
  });

  it('renderButton draws the trigger with expanded and controls', async () => {
    const seen: AssistantShellButtonProps[] = [];
    const renderButton = (props: AssistantShellButtonProps) => {
      if (props.action === 'mode') seen.push(props);
      return <button type="button" aria-label={props.label} aria-expanded={props.expanded} onClick={props.onClick}>{props.children}</button>;
    };
    await mount({ modes: ALL, renderButton });
    expect(seen.at(-1)).toMatchObject({ action: 'mode', expanded: false, controls: undefined });
    fireEvent.click(trigger());
    expect(seen.at(-1)).toMatchObject({ action: 'mode', expanded: true, controls: screen.getByRole('menu').id });
  });

  it('German labels', async () => {
    await mount({ modes: ALL, labels: DE_ASSISTANT_SHELL_LABELS });
    const button = screen.getByRole('button', { name: 'Ansicht: Seitenleiste' });
    fireEvent.click(button);
    expect(screen.getByRole('menu', { name: 'Ansicht' })).toBeTruthy();
    expect(entries()).toEqual(['Seitenleiste', 'Fenster', 'Vollbild']);
  });

  it('one mode means no layout control and no layout shortcut', async () => {
    await mount({ modes: ['sidebar'] });
    expect(screen.queryByRole('button', { name: 'Detach as window' })).toBeNull();
    expect(document.querySelector('[data-action="mode"]')).toBeNull();
    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', altKey: true, shiftKey: true });
    expect(state()).toMatchObject({ mode: 'sidebar' });
  });

  it('stored mode outside modes falls back to the first one', async () => {
    store.set(DEFAULT_ASSISTANT_LAYOUT_KEY, JSON.stringify({ open: false, mode: 'floating', defaultMode: 'floating', collapsed: false, width: 420 }));
    await mount({ modes: ['sidebar'] }, false);
    await frame();
    expect(state()).toMatchObject({ mode: 'sidebar', defaultMode: 'sidebar' });
  });

  it('a stored open full screen outside modes returns to defaultMode', async () => {
    store.set(DEFAULT_ASSISTANT_LAYOUT_KEY, JSON.stringify({ open: true, mode: 'fullscreen', defaultMode: 'floating', collapsed: false, width: 420 }));
    await mount({}, false);
    await frame();
    expect(state()).toMatchObject({ open: true, mode: 'floating' });
  });

  it('menu follows the order of modes', async () => {
    await mount({ modes: ['fullscreen', 'sidebar'] });
    fireEvent.click(trigger());
    expect(entries()).toEqual(['Full screen', 'Sidebar']);
  });
});
