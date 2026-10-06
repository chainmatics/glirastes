// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseChatCommandMessage } from '../../contracts/chat-command.js';
import type { ChatInteractionsData } from '../../contracts/chat-interactions.js';
import type { ChatTransport } from '../../react/types.js';
import { defineChatEntity, defineGlirastesChatElement, type GlirastesChatElement } from '../index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const data: ChatInteractionsData = {
  schemaVersion: 1,
  entities: [],
  commands: [
    { id: 'open.overview', label: { de: 'Übersicht öffnen', en: 'Open Overview' }, run: { kind: 'ui', tool: 'ui.navigate', args: { destination: '/overview' } } },
  ],
};

const task = defineChatEntity({
  type: 'task',
  label: 'Task',
  search: () => [{ id: '7', label: 'Release prüfen' }],
  resolve: (id) => (id === '7' ? { id: '7', label: 'Release prüfen' } : undefined),
  actions: [{ id: 'task.tasks.complete', label: 'Complete', entityArg: 'taskId', run: { kind: 'tool', tool: 'tasks.complete' } }],
});

function transport(): ChatTransport & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    messages: [], status: 'ready', error: null,
    sendMessage: vi.fn(async () => {}), stop: vi.fn(), setMessages: vi.fn(), addToolApprovalResponse: vi.fn(async () => {}),
  };
}

async function mount(configure: (element: GlirastesChatElement) => void) {
  defineGlirastesChatElement();
  const element = document.createElement('glirastes-chat') as GlirastesChatElement;
  const chat = transport();
  element.transport = chat;
  configure(element);
  const errors: string[] = [];
  element.addEventListener('glirastes-chat:error', (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
  await act(async () => { document.body.append(element); });
  return { element, chat, errors, editor: () => element.shadowRoot!.querySelector<HTMLElement>('[data-element="editor"]')! };
}

/**
 * jsdom keeps no selection inside a shadow root. Chromium does, behind the
 * non-standard `ShadowRoot.getSelection()` that the composer reads; this
 * stands in for it.
 */
function installShadowSelection(): void {
  let current: Range | null = null;
  const selection = {
    get rangeCount() { return current ? 1 : 0; },
    getRangeAt: () => current!,
    removeAllRanges: () => { current = null; },
    addRange: (range: Range) => { current = range; },
  };
  Object.defineProperty(ShadowRoot.prototype, 'getSelection', { configurable: true, value: () => selection });
}

function typeInto(editor: HTMLElement, text: string) {
  editor.textContent = text;
  const range = document.createRange();
  range.setStart(editor.firstChild!, text.length);
  range.collapse(true);
  const selection = (editor.getRootNode() as ShadowRoot & { getSelection(): Selection }).getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  installShadowSelection();
});
afterEach(async () => {
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  await act(async () => { document.body.replaceChildren(); });
  document.documentElement.removeAttribute('lang');
  Reflect.deleteProperty(ShadowRoot.prototype, 'getSelection');
  vi.unstubAllGlobals();
});

describe('<glirastes-chat> chat interactions', () => {
  it('loads derived commands from the endpoint and runs one without the model, like React', async () => {
    const fetch = vi.fn(async () => Response.json(data));
    vi.stubGlobal('fetch', fetch);
    document.documentElement.setAttribute('lang', 'de');
    const { chat, editor } = await mount((node) => {
      node.setAttribute('endpoint', '/chat');
      node.setAttribute('interactions', '');
    });
    expect(fetch).toHaveBeenCalledWith('/chat', expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
    await waitFor(() => expect(editor()).toBeTruthy());
    typeInto(editor(), '/über');
    await waitFor(() => expect(editor().getAttribute('aria-activedescendant')).toBeTruthy());
    const option = editor().getRootNode() as ShadowRoot;
    expect(option.querySelector('[role="option"]')?.textContent).toBe('Übersicht öffnen');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(editor().textContent).toBe('/ubersicht-offnen '));
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)).toEqual({
      invocation: { commandId: 'open.overview', tool: 'ui.navigate', args: { destination: '/overview' } },
      label: '/Übersicht öffnen',
    });
  });

  it('takes entities through the JS API, with their actions and mentions by id', async () => {
    const { element, chat, editor } = await mount((node) => { node.defineEntity(task); });
    typeInto(editor(), '@rel');
    await waitFor(() => expect(element.shadowRoot!.querySelector('[role="group"]')).toBeTruthy());
    fireEvent.keyDown(editor(), { key: 'ArrowRight' });
    fireEvent.keyDown(editor(), { key: 'Enter' });
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledTimes(1));
    expect(parseChatCommandMessage(chat.sendMessage.mock.calls[0]![0].text as string)?.invocation)
      .toEqual({ commandId: 'task.tasks.complete', tool: 'tasks.complete', args: { taskId: '7' } });
    let added = false;
    await act(async () => { added = await element.mentionEntity('task', '7'); });
    expect(added).toBe(true);
    await waitFor(() => expect(editor().querySelector('[data-mention-id="7"]')).toBeTruthy());
    expect(await element.mentionEntity('task', 'missing')).toBe(false);
  });

  it('refuses invalid definitions and reports interactions it cannot load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const { element, errors } = await mount((node) => {
      node.setAttribute('endpoint', '/chat');
      node.setAttribute('interactions', '/chat/interactions');
    });
    await waitFor(() => expect(errors).toEqual(['Chat interactions unavailable']));
    expect(() => element.defineCommand({ id: 'bad id', label: 'x', run: { kind: 'tool', tool: 'x' } })).toThrow(/commands\[0\]\.id/);
    element.interactions = data;
    expect(element.interactions).toEqual(data);
  });
});
