// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLayoutProvider, DEFAULT_ASSISTANT_LAYOUT_KEY, useAssistantLayout } from '../assistant-layout.js';
import { AssistantShell } from '../assistant-shell.js';
import { AssistantWorkspace } from '../assistant-workspace.js';

let store = new Map<string, string>();
let rowWidth = 1000;
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  });
  // Only the row that holds page and shell has a width; everything else measures 0.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.matches('[data-row], [data-component="assistant-workspace"]') ? rowWidth : 0; },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
  document.documentElement.style.removeProperty('--assistant-right-inset');
});

const frame = () => act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
function Width() {
  return <output data-testid="width">{useAssistantLayout().width}</output>;
}
async function mount(width: number, props: Partial<React.ComponentProps<typeof AssistantShell>> = {}, limits: { minWidth?: number } = {}) {
  store.set(DEFAULT_ASSISTANT_LAYOUT_KEY, JSON.stringify({ open: true, mode: 'sidebar', defaultMode: 'sidebar', collapsed: false, width }));
  render(<AssistantLayoutProvider {...limits}>
    <div data-row><main data-assistant-main>Page</main><Width />
      <AssistantShell onClear={() => {}} {...props}><textarea aria-label="Draft" /></AssistantShell></div>
  </AssistantLayoutProvider>);
  await frame();
}
const shell = () => screen.getByRole('complementary');
const inset = () => document.documentElement.style.getPropertyValue('--assistant-right-inset');

describe('docked width next to the page', () => {
  it('without minPageWidth the sidebar may take everything up to maxWidth', async () => {
    rowWidth = 1000;
    await mount(800);
    expect(shell().style.width).toBe('800px');
  });

  it('minPageWidth keeps the page usable', async () => {
    rowWidth = 1000;
    await mount(800, { minPageWidth: 520 });
    expect(shell().style.width).toBe('480px');
    expect(inset()).toBe('480px');
    expect(screen.getByTestId('width').textContent).toBe('800');
  });

  it('never below minWidth', async () => {
    rowWidth = 900;
    await mount(800, { minPageWidth: 520 }, { minWidth: 400 });
    expect(shell().style.width).toBe('400px');
  });

  it('the resize handle announces the width that can render', async () => {
    rowWidth = 1000;
    await mount(800, { minPageWidth: 520 });
    const handle = screen.getByRole('separator');
    expect(handle.getAttribute('aria-valuemax')).toBe('480');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(screen.getByTestId('width').textContent).toBe('480');
  });

  it('below narrowWidth the assistant still fills the row', async () => {
    rowWidth = 800;
    await mount(500, { minPageWidth: 520 });
    expect(screen.getByRole('main', { hidden: true }).hidden).toBe(true);
  });

  it('AssistantWorkspace passes minPageWidth through', async () => {
    rowWidth = 1000;
    store.set(DEFAULT_ASSISTANT_LAYOUT_KEY, JSON.stringify({ open: true, mode: 'sidebar', defaultMode: 'sidebar', collapsed: false, width: 800 }));
    render(<AssistantWorkspace chat={<textarea aria-label="Draft" />} minPageWidth={520} onClear={() => {}}>Page</AssistantWorkspace>);
    await frame();
    expect(shell().style.width).toBe('480px');
  });
});
