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

describe('a pick in the built-in list: base, except the declared cases', () => {
  // `base`: what had focus after the pick on the base code (0.24.1), recorded there; the same in
  // the wide column and in the drawer. Options sit before it.
  type Options = { shadow?: boolean; props?: Record<string, unknown> };
  const scenarios: Array<[string, ReactNode, Options, string] | [string, ReactNode, string]> = [
    ['textarea', <textarea aria-label="Draft" />, 'textarea:Draft'],
    ['textarea in a shadow root', <textarea aria-label="Draft" />, { shadow: true }, 'textarea:Draft'],
    ['disabled textarea', <textarea aria-label="Draft" disabled />, 'button:Customers'],
    ['disabled textarea under a clarification input', <><input aria-label="Clarification answer" /><textarea aria-label="Draft" disabled /></>, 'button:Customers'],
    ['editor in the header', <textarea aria-label="Draft" />, { props: { headerActions: <textarea aria-label="Header note" /> } }, 'textarea:Header note'],
    ['no composer', <p>No composer</p>, 'button:+New chat'],
    ['input only', <input aria-label="Draft" />, 'button:+New chat'],
    ['marked input', <input aria-label="Draft" data-glirastes-composer />, 'button:+New chat'],
    ['marked input in a shadow root', <input aria-label="Draft" data-glirastes-composer />, { shadow: true }, 'button:+New chat'],
    ['contenteditable="false" editor (a disabled RichMentionInput)', <div role="textbox" tabIndex={0} aria-label="Draft" contentEditable={false} />, 'button:+New chat'],
    ['plaintext-only editor', <div role="textbox" tabIndex={0} aria-label="Draft" contentEditable="plaintext-only" suppressContentEditableWarning />, 'button:+New chat'],
    ['input in a marked wrapper', <div data-glirastes-composer><input type="checkbox" aria-label="Option" /><input aria-label="Draft" /></div>, 'button:+New chat'],
    ['marked focusable host', <div role="textbox" tabIndex={0} aria-label="Draft" data-glirastes-composer />, 'button:+New chat'],
    ['marked input under a clarification input', <><input aria-label="Clarification answer" /><input aria-label="Draft" data-glirastes-composer /></>, 'button:+New chat'],
    ['marked input with a disabled textarea', <><textarea aria-label="Note" disabled /><input aria-label="Draft" data-glirastes-composer /></>, 'button:Customers'],
    ['unmarked input above a textarea', <><input aria-label="Clarification answer" /><textarea aria-label="Draft" /></>, 'textarea:Draft'],
    ['queued message editor above the composer', <><textarea aria-label="Queued edit" /><textarea aria-label="Draft" /></>, 'textarea:Queued edit'],
    ['editor in the header, no composer', <p>No composer</p>, { props: { headerActions: <textarea aria-label="Header note" /> } }, 'textarea:Header note'],
    ['editor (contenteditable) composer', <div role="textbox" tabIndex={0} aria-label="Draft" contentEditable suppressContentEditableWarning />, 'div:Draft'],
  ];
  // The declared change: where the base found no editor or textarea outside the column it focused
  // the first button of the shell ("New chat" in the column). Only these scenarios differ.
  const TOGGLE = '{toggle}';
  const declared: Record<string, string> = {
    'no composer': TOGGLE,
    'input only': TOGGLE,
    'contenteditable="false" editor (a disabled RichMentionInput)': TOGGLE,
    'plaintext-only editor': TOGGLE,
    'marked input': 'input:Draft',
    'marked input in a shadow root': 'input:Draft',
    'input in a marked wrapper': 'input:Draft',
    'marked focusable host': 'div:Draft',
    'marked input under a clarification input': 'input:Draft',
  };
  it('every declared case is a scenario whose base focused the first shell button', () => {
    for (const kind of Object.keys(declared)) {
      expect(scenarios.find(scenario => scenario[0] === kind)?.at(-1), kind).toBe('button:+New chat');
    }
    // And every such scenario is declared: nothing changes silently.
    expect(scenarios.filter(scenario => scenario.at(-1) === 'button:+New chat').map(scenario => scenario[0]).sort()).toEqual(Object.keys(declared).sort());
  });
  for (const narrowView of [false, true]) {
    for (const scenario of scenarios) {
      const [kind, composer] = scenario;
      const options = scenario.length === 4 ? scenario[2] : undefined;
      const base = scenario[scenario.length - 1] as string;
      it(`${kind} (${narrowView ? 'drawer' : 'wide column'})`, async () => {
        narrow = narrowView;
        const view = await mount(composer, options);
        await pick(view);
        const toggle = `button:${narrowView ? 'Show chats' : 'Hide chats'}`;
        expect(active(view.root)).toBe(declared[kind]?.replace(TOGGLE, toggle) ?? base);
      });
    }
  }
});

/** Mounts an own column whose "Pick project" button calls the new `close()`. */
const closingPane = { historyPane: ({ close }: { close(): void }) => <div><textarea aria-label="Pane note" /><button type="button" onClick={() => close()}>Pick project</button></div> };
async function closeFromPane(view: Awaited<ReturnType<typeof mount>>) {
  if (narrow) fireEvent.click(view.scope.getByRole('button', { name: 'Show chats' }));
  await frame();
  const button = Array.from(view.container.querySelectorAll<HTMLElement>('[data-element="history"] button')).find(b => b.textContent === 'Pick project')!;
  button.focus();
  fireEvent.click(button);
  await frame();
  await frame();
}

describe("close() of a render-function pane: the new lookup", () => {
  it.each([false, true])('the first editor or textarea outside the column, header included (narrow %s)', async narrowView => {
    narrow = narrowView;
    const view = await mount(<textarea aria-label="Draft" />, { props: { ...closingPane, headerActions: <textarea aria-label="Header note" /> } });
    await closeFromPane(view);
    expect(active(view.root)).toBe('textarea:Header note');
  });

  it.each([false, true])('an editor in the column itself is skipped (narrow %s)', async narrowView => {
    narrow = narrowView;
    const view = await mount(<textarea aria-label="Draft" />, { props: closingPane });
    await closeFromPane(view);
    expect(active(view.root)).toBe('textarea:Draft');
  });

  it.each([false, true])('a disabled textarea gets focus() as on base: focus stays (narrow %s)', async narrowView => {
    narrow = narrowView;
    const view = await mount(<><input aria-label="Clarification answer" /><textarea aria-label="Draft" disabled /></>, { props: closingPane });
    await closeFromPane(view);
    expect(active(view.root)).toBe('button:Pick project');
  });

  const composers: Array<[string, ReactNode]> = [
    ['marked input', <input key="c" aria-label="Draft" data-glirastes-composer />],
    ['input in a marked wrapper', <div key="c" data-glirastes-composer><input type="checkbox" aria-label="Option" /><input aria-label="Draft" /></div>],
    ['marked focusable host', <div key="c" role="textbox" tabIndex={0} aria-label="Draft" data-glirastes-composer />],
  ];
  const noEditorPane = { historyPane: ({ close }: { close(): void }) => <button type="button" onClick={() => close()}>Pick project</button> };
  for (const shadow of [false, true]) {
    for (const narrowView of [false, true]) {
      for (const [kind, composer] of composers) {
        it(`${kind}${shadow ? ' in a shadow root' : ''} (${narrowView ? 'drawer' : 'wide column'})`, async () => {
          narrow = narrowView;
          const view = await mount(<><input aria-label="Clarification answer" />{composer}</>, { shadow, props: noEditorPane });
          await closeFromPane(view);
          expect(active(view.root)).toMatch(/:Draft$/);
        });
      }
    }
  }

  it.each([false, true])('an unmarked input is not taken for the composer, focus goes to the toggle (narrow %s)', async narrowView => {
    narrow = narrowView;
    const view = await mount(<input aria-label="Clarification answer" />, { props: noEditorPane });
    await closeFromPane(view);
    expect(active(view.root)).toBe(`button:${narrowView ? 'Show chats' : 'Hide chats'}`);
  });

  it.each(['readonly', 'image', 'checkbox', 'disabled'])('a %s input in a marked wrapper is skipped', async kind => {
    const input = kind === 'readonly' ? <input aria-label="Skip" readOnly />
      : kind === 'disabled' ? <input aria-label="Skip" disabled />
      : <input aria-label="Skip" type={kind} />;
    const view = await mount(<div data-glirastes-composer>{input}</div>, { props: noEditorPane });
    await closeFromPane(view);
    expect(active(view.root)).toBe('button:Hide chats');
  });
});
