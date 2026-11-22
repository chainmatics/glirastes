// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLayoutProvider, useAssistantLayout, type AssistantLayoutMode } from '../assistant-layout.js';
import { AssistantShell, AssistantToggle } from '../assistant-shell.js';

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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('lang'); });

const frame = () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
function Probe() {
  const ui = useAssistantLayout();
  const go = (mode: AssistantLayoutMode) => () => ui.setMode(mode);
  return <div data-testid="probe">
    <output data-testid="state">{JSON.stringify({ open: ui.open, mode: ui.mode, defaultMode: ui.defaultMode })}</output>
    <button onClick={go('sidebar')}>to sidebar</button>
    <button onClick={go('floating')}>to floating</button>
    <button onClick={go('fullscreen')}>to fullscreen</button>
  </div>;
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!);
const go = (mode: AssistantLayoutMode) => act(() => { fireEvent.click(screen.getByText(`to ${mode}`, { selector: 'button' })); });
async function mount(child: React.ReactNode = <textarea aria-label="Draft" />) {
  render(<AssistantLayoutProvider>
    <Probe />
    <div><main data-assistant-main><AssistantToggle /></main>
      <AssistantShell onClear={() => {}} modes={['sidebar', 'floating', 'fullscreen']}>{child}</AssistantShell></div>
  </AssistantLayoutProvider>);
  await frame();
}
const shell = () => screen.getByRole('complementary', { hidden: true });
const main = () => document.querySelector<HTMLElement>('[data-assistant-main]')!;
const escape = (target: Element) => fireEvent.keyDown(target, { key: 'Escape' });

describe('full screen in the assistant shell', () => {
  it('full screen covers the viewport as a modal dialog', async () => {
    await mount();
    await go('fullscreen');
    const aside = shell();
    expect(aside.dataset.mode).toBe('fullscreen');
    expect(aside.style.position).toBe('fixed');
    expect(aside.style.inset).toBe('0px');
    const dialog = screen.getByRole('dialog', { name: 'AI assistant' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('data-element')).toBe('frame');
    expect(document.querySelector('[data-component="assistant-shell-resize"]')).toBeNull();
    expect(document.querySelector('[data-resize-edge]')).toBeNull();
    expect(document.querySelector('[data-component="assistant-shell-window-handle"]')).toBeNull();
    expect(document.querySelector('[data-component="assistant-bubble"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Detach as window' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dock right' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear chat' })).toBeTruthy();
    expect(dialog.querySelector('header')!.hasAttribute('tabindex')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--assistant-right-inset')).toBe('0px');
    expect(main().hasAttribute('inert')).toBe(true);
    expect(main().hidden).toBe(false);
  });

  it.each(['sidebar', 'floating'] as const)('Escape returns to the layout it came from (%s)', async from => {
    await mount();
    await go(from);
    await go('fullscreen');
    escape(screen.getByRole('textbox', { name: 'Draft' }));
    expect(state()).toMatchObject({ open: true, mode: from });
    expect(main().hasAttribute('inert')).toBe(false);
  });

  it('Escape in an open completion list stays in full screen', async () => {
    await mount(<textarea aria-label="Draft" onKeyDown={e => { if (e.key === 'Escape') e.preventDefault(); }} />);
    await go('fullscreen');
    escape(screen.getByRole('textbox', { name: 'Draft' }));
    expect(state()).toMatchObject({ mode: 'fullscreen' });
  });

  it('the layout shortcut leaves full screen', async () => {
    await mount();
    await go('fullscreen');
    fireEvent.keyDown(window, { key: 'd', code: 'KeyD', altKey: true, shiftKey: true });
    expect(state()).toMatchObject({ open: true, mode: 'sidebar' });
  });

  it('mod+I closes from full screen and reopens in the previous layout', async () => {
    await mount();
    await go('floating');
    await go('fullscreen');
    fireEvent.keyDown(window, { key: 'i', code: 'KeyI', ctrlKey: true, metaKey: false });
    if (state().open) fireEvent.keyDown(window, { key: 'i', code: 'KeyI', metaKey: true });
    expect(state()).toMatchObject({ open: false });
    expect(main().hasAttribute('inert')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(state()).toMatchObject({ open: true, mode: 'floating' });
  });

  it('same composer in every layout', async () => {
    await mount();
    const draft = screen.getByRole('textbox', { name: 'Draft', hidden: true }) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: 'keep me' } });
    for (const mode of ['fullscreen', 'floating', 'sidebar'] as const) {
      await go(mode);
      expect(screen.getByRole('textbox', { name: 'Draft', hidden: true })).toBe(draft);
      expect(draft.value).toBe('keep me');
    }
  });

  it('German page names the dialog in German', async () => {
    document.documentElement.lang = 'de';
    await mount();
    await go('fullscreen');
    expect(screen.getByRole('dialog', { name: 'KI-Assistent' })).toBeTruthy();
  });

  it.each(['sidebar', 'floating'] as const)('without full screen the frame has no dialog role (%s)', async mode => {
    await mount();
    await go(mode);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(state()).toMatchObject({ open: true, mode });
    expect(screen.queryByRole('dialog')).toBeNull();
    const frameEl = document.querySelector('[data-element="frame"]')!;
    expect(frameEl.hasAttribute('role')).toBe(false);
    expect(frameEl.hasAttribute('aria-modal')).toBe(false);
  });
});
