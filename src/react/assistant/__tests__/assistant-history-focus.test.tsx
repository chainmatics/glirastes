// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantLayoutProvider, useAssistantLayout } from '../assistant-layout.js';
import { AssistantShell } from '../assistant-shell.js';
import { ChatContext, type ChatContextValue } from '../../provider/chat-context.js';
import { DEFAULT_LOCALE } from '../../provider/ai-chat-provider.js';

// Focus after a pick in the full-screen chat list. The "base" tests use no new
// prop; their expectations were recorded on the code before the shell slots.

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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

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
function FullScreen() {
  const ui = useAssistantLayout();
  return <button type="button" onClick={() => ui.setMode('fullscreen')}>to fullscreen</button>;
}

/** Mounts the default shell (no new prop) in the document or in a shadow root; returns that root. */
async function mount(composer: ReactNode, { shadow = false, props = {} }: { shadow?: boolean; props?: Record<string, unknown> } = {}) {
  let root: Document | ShadowRoot = document;
  let container: HTMLElement | undefined;
  if (shadow) {
    const host = document.createElement('div');
    document.body.append(host);
    root = host.attachShadow({ mode: 'open' });
    container = document.createElement('div');
    root.append(container);
  }
  const view = render(<ChatContext.Provider value={chat()}><AssistantLayoutProvider storageKey={null}>
    <FullScreen />
    <div><main data-assistant-main>Page</main>
      <AssistantShell modes={['sidebar', 'floating', 'fullscreen']} {...props}>{composer}</AssistantShell></div>
  </AssistantLayoutProvider></ChatContext.Provider>, container ? { container } : undefined);
  await frame();
  fireEvent.click(within(view.container).getByRole('button', { name: 'to fullscreen' }));
  await frame();
  return { root, scope: within(view.container), container: view.container };
}
/** Picks "Customers" in the chat list (opening the drawer first below 900 px). */
async function pick({ scope, container }: Awaited<ReturnType<typeof mount>>) {
  if (narrow) fireEvent.click(scope.getByRole('button', { name: 'Show chats' }));
  await frame();
  // By element: Testing Library's role query misses the open drawer inside a shadow root.
  const row = Array.from(container.querySelectorAll<HTMLElement>('[data-element="row-main"]')).find(button => button.textContent === 'Customers')!;
  row.focus();
  fireEvent.click(row);
  await frame();
  await frame();
}
/** What has focus in that root, as `tag:name`. */
function active(root: Document | ShadowRoot): string {
  const element = root.activeElement as HTMLElement | null;
  if (!element || element === document.body) return 'body';
  return `${element.tagName.toLowerCase()}:${element.getAttribute('aria-label') ?? element.textContent}`;
}

describe('base behaviour after a pick, unchanged', () => {
  for (const narrowView of [false, true]) {
    const where = narrowView ? 'drawer' : 'wide column';
    it(`textarea composer in a shadow root (${where})`, async () => {
      narrow = narrowView;
      const view = await mount(<textarea aria-label="Draft" />, { shadow: true });
      await pick(view);
      expect(active(view.root)).toBe('textarea:Draft');
    });

    it(`disabled textarea composer (${where})`, async () => {
      narrow = narrowView;
      const view = await mount(<textarea aria-label="Draft" disabled />);
      await pick(view);
      // Recorded on the base: focus() on the disabled textarea does nothing, focus stays on the picked row.
      expect(active(view.root)).toMatchInlineSnapshot(`"button:Customers"`);
    });

    it(`disabled textarea composer under a clarification input (${where})`, async () => {
      narrow = narrowView;
      const view = await mount(<><input aria-label="Clarification answer" /><textarea aria-label="Draft" disabled /></>);
      await pick(view);
      expect(active(view.root)).toMatchInlineSnapshot(`"button:Customers"`);
    });
  }
});

describe('editor search over the whole shell, as on base', () => {
  it.each([false, true])('an editor in the header is focused as on base (narrow %s)', async narrowView => {
    narrow = narrowView;
    const view = await mount(<textarea aria-label="Draft" />, { props: { headerActions: <textarea aria-label="Header note" /> } });
    await pick(view);
    // Recorded on the base: the first editor or textarea of the shell in DOM order.
    expect(active(view.root)).toMatchInlineSnapshot(`"textarea:Header note"`);
  });

  it.each([false, true])('an editor in the column is not focused after a pick (narrow %s)', async narrowView => {
    narrow = narrowView;
    const view = await mount(<textarea aria-label="Draft" />, {
      props: { historyPane: ({ close }: { close(): void }) => <div><textarea aria-label="Pane note" /><button type="button" onClick={() => close()}>Pick project</button></div> },
    });
    if (narrowView) fireEvent.click(view.scope.getByRole('button', { name: 'Show chats' }));
    await frame();
    fireEvent.click(Array.from(view.container.querySelectorAll<HTMLElement>('[data-element="history"] button')).find(b => b.textContent === 'Pick project')!);
    await frame();
    await frame();
    expect(active(view.root)).toBe('textarea:Draft');
  });
});

describe('new: composers the base did not find', () => {
  const composers: Array<[string, ReactNode]> = [
    ['marked input', <input key="c" aria-label="Draft" data-glirastes-composer />],
    ['input in a marked wrapper', <div key="c" data-glirastes-composer><input type="checkbox" aria-label="Option" /><input aria-label="Draft" /></div>],
    ['marked focusable host', <div key="c" role="textbox" tabIndex={0} aria-label="Draft" data-glirastes-composer />],
  ];
  for (const shadow of [false, true]) {
    for (const narrowView of [false, true]) {
      for (const [kind, composer] of composers) {
        it(`${kind}${shadow ? ' in a shadow root' : ''} (${narrowView ? 'drawer' : 'wide column'})`, async () => {
          narrow = narrowView;
          const view = await mount(<><input aria-label="Clarification answer" />{composer}</>, { shadow });
          await pick(view);
          expect(active(view.root)).toMatch(/:Draft$/);
        });
      }
    }
  }

  it.each([false, true])('an unmarked input is not taken for the composer, focus goes to the toggle (narrow %s)', async narrowView => {
    narrow = narrowView;
    const view = await mount(<input aria-label="Clarification answer" />);
    await pick(view);
    expect(active(view.root)).toBe(`button:${narrowView ? 'Show chats' : 'Hide chats'}`);
  });

  it.each(['readonly', 'image', 'checkbox', 'disabled'])('a %s input in a marked wrapper is skipped', async kind => {
    const input = kind === 'readonly' ? <input aria-label="Skip" readOnly />
      : kind === 'disabled' ? <input aria-label="Skip" disabled />
      : <input aria-label="Skip" type={kind} />;
    const view = await mount(<div data-glirastes-composer>{input}</div>);
    await pick(view);
    expect(active(view.root)).toBe('button:Hide chats');
  });

  it('close() from an own pane follows the same order in a shadow root', async () => {
    narrow = true;
    const view = await mount(<input aria-label="Draft" data-glirastes-composer />, {
      shadow: true,
      props: { historyPane: ({ close }: { close(): void }) => <button type="button" onClick={() => close()}>Pick project</button> },
    });
    fireEvent.click(view.scope.getByRole('button', { name: 'Show chats' }));
    await frame();
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-element="history"] button')!);
    await waitFor(() => expect(active(view.root)).toBe('input:Draft'));
  });
});
