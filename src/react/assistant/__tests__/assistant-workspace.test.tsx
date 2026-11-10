// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLayoutProvider, useAssistantLayout } from '../assistant-layout.js';
import { AssistantToggle } from '../assistant-shell.js';
import { AssistantWorkspace } from '../assistant-workspace.js';

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

describe('AssistantWorkspace', () => {
  it('is the whole integration: page with a toggle anywhere, docked or detached chat', async () => {
    render(<AssistantWorkspace chat={<textarea aria-label="Draft" />}>
      <header><AssistantToggle /></header>
      <p>Page</p>
    </AssistantWorkspace>);
    await frame();
    const page = screen.getByText('Page');
    expect(page.closest('[data-assistant-main]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    const shell = screen.getByRole('complementary', { name: 'AI assistant' });
    expect(shell.getAttribute('data-mode')).toBe('sidebar');
    // Docked: the shell is the page's sibling in one row.
    expect(shell.parentElement).toBe(page.closest('[data-assistant-main]')!.parentElement);
    expect(screen.getByRole('textbox', { name: 'Draft' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Detach as window' }));
    expect(shell.getAttribute('data-mode')).toBe('floating');
  });

  it('opens detached by default when the app prefers a window, and passes shell options through', async () => {
    render(<AssistantWorkspace chat={<span>Chat</span>} defaultMode="floating" storageKey={null}
      labels={{ toggle: 'Frag die KI', title: 'Assistent' }} showBubble={false}>
      <AssistantToggle label="Frag die KI" />
    </AssistantWorkspace>);
    await frame();
    expect(screen.queryByRole('button', { name: 'Assistent' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Frag die KI' }));
    expect(screen.getByRole('complementary', { name: 'Assistent' }).getAttribute('data-mode')).toBe('floating');
    expect(store.size).toBe(0);
  });

  it('joins a layout provider the app already has, e.g. to open the chat from elsewhere', async () => {
    function OpenFromOutside() { return <button onClick={useAssistantLayout().openChat}>Elsewhere</button>; }
    render(<AssistantLayoutProvider storageKey={null}>
      <OpenFromOutside />
      <AssistantWorkspace chat={<span>Chat</span>}><p>Page</p></AssistantWorkspace>
    </AssistantLayoutProvider>);
    await frame();
    fireEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.getByRole('complementary', { name: 'AI assistant' }).style.display).toBe('flex');
  });
});
